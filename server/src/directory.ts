// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The company directory in address suggestions (DreyMail 10.3): people from Microsoft 365
// (Graph /me/people: colleagues and the organization's directory) and Google Workspace (the
// domain's directory), for mailboxes whose owner allowed it. Answers quickly or not at all: local
// suggestions never wait long for it.

import type { Store } from './db.js';
import type { GoogleAuth } from './oauth/google.js';
import type { MicrosoftAuth } from './oauth/microsoft.js';

export type DirectoryFetch = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DirectoryPerson {
  name: string;
  address: string;
}

const TIMEOUT = 1500;
/** After a refused token (permission not allowed), don't ask again for a while. */
const BACK_OFF = 10 * 60_000;

export class Directory {
  private readonly off = new Map<string, number>();
  private readonly memo = new Map<string, { at: number; people: DirectoryPerson[] }>();

  constructor(
    private readonly deps: {
      store: Store;
      microsoft: Pick<MicrosoftAuth, 'accessToken'>;
      google: Pick<GoogleAuth, 'accessToken' | 'allowed'>;
      fetch?: DirectoryFetch;
    },
  ) {}

  private get fetch(): DirectoryFetch {
    return this.deps.fetch ?? (fetch as unknown as DirectoryFetch);
  }

  /** Mailboxes that can search a directory: signed in with Microsoft or Google. */
  private sources(userId: string) {
    return this.deps.store.listAccounts(userId).filter((a) => (a.auth === 'microsoft' || (a.auth === 'google' && !/@(gmail|googlemail)\.com$/i.test(a.email))) && !a.sharedOf);
  }

  /** Whether directory search works for this mailbox (the user allowed it). */
  async available(userId: string, accountId: string): Promise<boolean> {
    const a = this.sources(userId).find((x) => x.id === accountId);
    if (!a) return false;
    try {
      const ok = a.auth === 'microsoft' ? !!(await this.deps.microsoft.accessToken(userId, a.id, 'people')) : await this.deps.google.allowed(userId, a.id, 'directory');
      // Allowed (again): search at once rather than after the back-off.
      if (ok) this.off.delete(a.id);
      return ok;
    } catch {
      return false;
    }
  }

  /** People matching `q` in the directories of the user's mailboxes (at most `limit`). */
  async search(userId: string, q: string, limit = 8): Promise<DirectoryPerson[]> {
    const query = q.trim();
    if (query.length < 2) return [];
    const key = `${userId}\u0000${query.toLowerCase()}`;
    const hit = this.memo.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.people;
    const now = Date.now();
    const results = await Promise.all(
      this.sources(userId).map(async (a) => {
        if ((this.off.get(a.id) ?? 0) > now) return [];
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT);
        try {
          return a.auth === 'microsoft' ? await this.microsoft(userId, a.id, query, ctl.signal) : await this.googleDir(userId, a.id, query, ctl.signal);
        } catch {
          return [];
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const out: DirectoryPerson[] = [];
    const seen = new Set<string>();
    for (const p of results.flat()) {
      const address = p.address.toLowerCase();
      if (!address.includes('@') || seen.has(address)) continue;
      seen.add(address);
      out.push({ name: p.name, address });
      if (out.length >= limit) break;
    }
    if (this.memo.size > 500) this.memo.clear();
    this.memo.set(key, { at: Date.now(), people: out });
    return out;
  }

  private async microsoft(userId: string, accountId: string, q: string, signal: AbortSignal): Promise<DirectoryPerson[]> {
    let token: string;
    try {
      token = await this.deps.microsoft.accessToken(userId, accountId, 'people');
    } catch {
      this.off.set(accountId, Date.now() + BACK_OFF);
      return [];
    }
    const url = `https://graph.microsoft.com/v1.0/me/people?$search=${encodeURIComponent(`"${q.replace(/"/g, '')}"`)}&$top=10&$select=displayName,scoredEmailAddresses`;
    const res = await this.fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal });
    if (!res.ok) return [];
    const j = (await res.json()) as { value?: { displayName?: string; scoredEmailAddresses?: { address?: string }[] }[] };
    return (j.value ?? []).flatMap((p) => (p.scoredEmailAddresses ?? []).slice(0, 1).map((e) => ({ name: p.displayName ?? '', address: e.address ?? '' })));
  }

  private async googleDir(userId: string, accountId: string, q: string, signal: AbortSignal): Promise<DirectoryPerson[]> {
    if (!(await this.deps.google.allowed(userId, accountId, 'directory').catch(() => false))) {
      this.off.set(accountId, Date.now() + BACK_OFF);
      return [];
    }
    const token = await this.deps.google.accessToken(userId, accountId);
    const params = new URLSearchParams({ query: q, readMask: 'names,emailAddresses', sources: 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', pageSize: '10' });
    const res = await this.fetch(`https://people.googleapis.com/v1/people:searchDirectoryPeople?${params}`, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal });
    if (!res.ok) return [];
    const j = (await res.json()) as { people?: { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[] }[] };
    return (j.people ?? []).flatMap((p) => (p.emailAddresses ?? []).slice(0, 1).map((e) => ({ name: p.names?.[0]?.displayName ?? '', address: e.value ?? '' })));
  }

  /** The user allowed it again (reconnected): try at once. */
  reset(accountId: string) {
    this.off.delete(accountId);
  }
}
