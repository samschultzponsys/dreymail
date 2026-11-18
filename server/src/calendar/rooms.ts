// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Meeting rooms (DreyMail 10.7): the organization's rooms from Microsoft 365 (Graph places, needs
// Place.Read.All, which an administrator approves once), and a list an administrator keeps in
// DreyMail (Settings → Server) for any other calendar, Google Workspace's room calendars included.
// A room is booked by inviting it as a resource; its free/busy comes like anyone's.

import type { Room } from '../../../shared/calendar.js';
import type { Store } from '../db.js';
import type { MicrosoftAuth } from '../oauth/microsoft.js';

export type RoomsFetch = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const SETTING = 'rooms';
const CACHE_MS = 10 * 60_000;

export class Rooms {
  private readonly cache = new Map<string, { at: number; rooms: Room[] }>();

  constructor(
    private readonly deps: { store: Store; microsoft: Pick<MicrosoftAuth, 'accessToken'>; fetch?: RoomsFetch },
  ) {}

  /** The administrator's list. */
  configured(): Room[] {
    const list = this.deps.store.getSetting<Room[]>(SETTING) ?? [];
    return list.map((r) => ({ email: r.email, name: r.name, capacity: r.capacity ?? null, building: r.building ?? '', source: 'list' as const }));
  }

  saveConfigured(list: Omit<Room, 'source'>[]) {
    const clean = list
      .map((r) => ({ email: r.email.trim().toLowerCase(), name: r.name.trim() || r.email.trim(), capacity: r.capacity && r.capacity > 0 ? Math.floor(r.capacity) : null, building: (r.building ?? '').trim() }))
      .filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
    this.deps.store.setSetting(SETTING, [...new Map(clean.map((r) => [r.email, r])).values()].slice(0, 500));
  }

  /** Whether Microsoft 365 rooms can be read for this user (an Outlook mailbox allowed it). */
  async microsoftAllowed(userId: string): Promise<{ accountId: string; allowed: boolean }[]> {
    const list = this.deps.store.listAccounts(userId).filter((a) => a.auth === 'microsoft' && !a.sharedOf);
    return Promise.all(
      list.map(async (a) => {
        try {
          await this.deps.microsoft.accessToken(userId, a.id, 'rooms');
          return { accountId: a.id, allowed: true };
        } catch {
          return { accountId: a.id, allowed: false };
        }
      }),
    );
  }

  /** Every room the user can book, the administrator's first, sorted by name. */
  async list(userId: string): Promise<Room[]> {
    const out = new Map<string, Room>();
    for (const r of this.configured()) out.set(r.email, r);
    for (const a of this.deps.store.listAccounts(userId).filter((x) => x.auth === 'microsoft' && !x.sharedOf)) {
      const hit = this.cache.get(a.id);
      let rooms = hit && Date.now() - hit.at < CACHE_MS ? hit.rooms : null;
      if (!rooms) {
        rooms = await this.microsoftRooms(userId, a.id).catch(() => []);
        this.cache.set(a.id, { at: Date.now(), rooms });
      }
      for (const r of rooms) if (!out.has(r.email)) out.set(r.email, r);
    }
    return [...out.values()].sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  }

  private async microsoftRooms(userId: string, accountId: string): Promise<Room[]> {
    let token: string;
    try {
      token = await this.deps.microsoft.accessToken(userId, accountId, 'rooms');
    } catch {
      return [];
    }
    const f = this.deps.fetch ?? (fetch as unknown as RoomsFetch);
    const res = await f('https://graph.microsoft.com/v1.0/places/microsoft.graph.room?$top=500', { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { value?: { emailAddress?: string; displayName?: string; capacity?: number; building?: string }[] };
    return (j.value ?? [])
      .filter((r) => r.emailAddress)
      .map((r) => ({ email: r.emailAddress!.toLowerCase(), name: r.displayName || r.emailAddress!, capacity: r.capacity ?? null, building: r.building ?? '', source: 'microsoft' as const }));
  }
}
