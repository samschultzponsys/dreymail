// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Auto-replies (out of office, sick, on leave, …): the server answers new mail in the inboxes an
// auto-reply covers (all mailboxes, or chosen mailboxes and groups), optionally between two
// dates. Following RFC 3834, it never answers mailing lists, bulk mail, other automatic mail or
// no-reply addresses, and each sender gets it at most once per interval.

import crypto from 'node:crypto';
import type { AutoReply, AutoReplyInput } from '../../shared/types.js';
import type { Store } from './db.js';
import type { ImapPool } from './imap/pool.js';

interface Row {
  id: string;
  user_id: string;
  name: string;
  subject: string;
  body: string;
  enabled: number;
  starts_at: number | null;
  ends_at: number | null;
  all_mailboxes: number;
  account_ids: string;
  group_ids: string;
  interval_days: number;
  created_at: number;
  updated_at: number;
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const list = (json: string): string[] => {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const view = (r: Row): AutoReply => ({
  id: r.id,
  name: r.name,
  subject: r.subject,
  body: r.body,
  enabled: r.enabled === 1,
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  allMailboxes: r.all_mailboxes === 1,
  accountIds: list(r.account_ids),
  groupIds: list(r.group_ids),
  intervalDays: r.interval_days,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

/** Header lines of a message, unfolded, by lowercase name (first occurrence wins). */
export function parseHeaders(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(i + 1).trim());
  }
  return out;
}

const NO_REPLY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|listserv|majordomo)([+.-].*)?@/i;

/**
 * Why a message must not get an auto-reply, or null if it may. RFC 3834: not to automatic mail,
 * mailing lists or bulk mail; plus Microsoft's suppress header, spam flags and no-reply senders.
 */
export function skipReason(headers: Map<string, string>, sender: string, ownAddress: string): string | null {
  const auto = headers.get('auto-submitted')?.toLowerCase();
  if (auto && auto !== 'no') return 'automatic';
  if (/\b(bulk|list|junk|auto_reply)\b/i.test(headers.get('precedence') ?? '')) return 'bulk';
  if (headers.has('list-id') || headers.has('list-unsubscribe') || headers.has('list-post')) return 'list';
  if (/\b(all|oof|autoreply)\b/i.test(headers.get('x-auto-response-suppress') ?? '')) return 'suppressed';
  if (/^yes/i.test(headers.get('x-spam-flag') ?? '') || headers.get('x-spam-status')?.toLowerCase().startsWith('yes')) return 'spam';
  if ((headers.get('return-path') ?? '').replace(/\s/g, '') === '<>') return 'bounce';
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return 'automatic';
  if (!sender || NO_REPLY.test(sender)) return 'no-reply';
  if (sender.toLowerCase() === ownAddress.toLowerCase()) return 'own';
  return null;
}

export const fill = (template: string, original: { subject: string }) => template.replace(/\{subject\}/g, original.subject || '(no subject)');

/** Most messages an account answers per hour, whatever happens (a loop or a flood). */
const HOURLY_LIMIT = 60;

export interface AutoReplyDeps {
  store: Store;
  pool: ImapPool;
  send: (userId: string, accountId: string, r: { to: string; subject: string; text: string; inReplyTo: string | null }) => Promise<void>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

export class AutoReplies {
  private readonly sentAt = new Map<string, number[]>();

  constructor(private readonly deps: AutoReplyDeps) {}

  private get db() {
    return this.deps.store.db;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  list(userId: string): AutoReply[] {
    return (this.db.prepare('SELECT * FROM auto_replies WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as Row[]).map(view);
  }

  get(userId: string, id: string): AutoReply | null {
    const r = this.db.prepare('SELECT * FROM auto_replies WHERE user_id = ? AND id = ?').get(userId, id) as unknown as Row | undefined;
    return r ? view(r) : null;
  }

  /** Creates (no id) or replaces an auto-reply. Mailboxes and groups that aren't the user's are dropped. */
  save(userId: string, input: AutoReplyInput, id?: string): AutoReply | null {
    const before = id ? this.get(userId, id) : null;
    if (id && !before) return null;
    const accounts = new Set(this.deps.store.listAccounts(userId).map((a) => a.id));
    const groups = new Set(this.deps.store.listGroups(userId).map((g) => g.id));
    const now = this.now();
    const row = {
      name: input.name,
      subject: input.subject,
      body: input.body,
      enabled: input.enabled ? 1 : 0,
      starts_at: input.startsAt ? Date.parse(input.startsAt) : null,
      ends_at: input.endsAt ? Date.parse(input.endsAt) : null,
      all_mailboxes: input.allMailboxes ? 1 : 0,
      account_ids: JSON.stringify([...new Set(input.accountIds)].filter((a) => accounts.has(a))),
      group_ids: JSON.stringify([...new Set(input.groupIds)].filter((g) => groups.has(g))),
      interval_days: input.intervalDays,
    };
    const newId = id ?? crypto.randomUUID();
    if (before) {
      this.db
        .prepare(
          `UPDATE auto_replies SET name = ?, subject = ?, body = ?, enabled = ?, starts_at = ?, ends_at = ?, all_mailboxes = ?, account_ids = ?, group_ids = ?,
             interval_days = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
        )
        .run(row.name, row.subject, row.body, row.enabled, row.starts_at, row.ends_at, row.all_mailboxes, row.account_ids, row.group_ids, row.interval_days, now, newId, userId);
      // Switched on again: a new absence, so everyone may get it again.
      if (!before.enabled && input.enabled) this.db.prepare('DELETE FROM auto_reply_log WHERE reply_id = ?').run(newId);
    } else {
      this.db
        .prepare(
          `INSERT INTO auto_replies (id, user_id, name, subject, body, enabled, starts_at, ends_at, all_mailboxes, account_ids, group_ids, interval_days, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId, userId, row.name, row.subject, row.body, row.enabled, row.starts_at, row.ends_at, row.all_mailboxes, row.account_ids, row.group_ids, row.interval_days, now, now);
    }
    return this.get(userId, newId);
  }

  remove(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM auto_replies WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
  }

  /** Users with an auto-reply that is on and not over yet (their inboxes are watched). */
  users(): string[] {
    return (this.db.prepare('SELECT DISTINCT user_id FROM auto_replies WHERE enabled = 1 AND (ends_at IS NULL OR ends_at > ?)').all(this.now()) as { user_id: string }[]).map((r) => r.user_id);
  }

  /**
   * The auto-reply that answers for this mailbox right now. The most specific wins: one naming
   * the mailbox, then one naming its group, then one for all mailboxes; among equals, the most
   * recently changed.
   */
  activeFor(userId: string, accountId: string): AutoReply | null {
    const now = this.now();
    const groupId = this.deps.store.listAccounts(userId).find((a) => a.id === accountId)?.groupId ?? null;
    const rank = (r: AutoReply) => (r.accountIds.includes(accountId) ? 3 : groupId && r.groupIds.includes(groupId) ? 2 : r.allMailboxes ? 1 : 0);
    const live = this.list(userId).filter(
      (r) => r.enabled && rank(r) > 0 && (!r.startsAt || Date.parse(r.startsAt) <= now) && (!r.endsAt || Date.parse(r.endsAt) > now),
    );
    live.sort((a, b) => rank(b) - rank(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return live[0] ?? null;
  }

  private underLimit(accountId: string): boolean {
    const now = this.now();
    const recent = (this.sentAt.get(accountId) ?? []).filter((t) => now - t < 3_600_000);
    this.sentAt.set(accountId, recent);
    return recent.length < HOURLY_LIMIT;
  }

  /**
   * New mail in a mailbox's INBOX: answer what should be answered. Reads the headers first (so the
   * messages may be moved right after this returns); sending happens in the background.
   */
  async handleNew(userId: string, accountId: string, mail: { uid: number; from: { address: string } | null; subject: string; messageId?: string | null }[]): Promise<void> {
    const reply = this.activeFor(userId, accountId);
    if (!reply || mail.length === 0) return;
    const account = this.deps.store.listAccounts(userId).find((a) => a.id === accountId);
    if (!account) return;
    const headers = await this.deps.pool.withMailbox(userId, accountId, 'INBOX', async (client) => {
      const out = new Map<number, Map<string, string>>();
      const fields = ['auto-submitted', 'precedence', 'list-id', 'list-unsubscribe', 'list-post', 'x-auto-response-suppress', 'x-spam-flag', 'x-spam-status', 'return-path', 'x-autoreply', 'x-autorespond'];
      for await (const m of client.fetch(mail.map((m) => m.uid).join(','), { uid: true, headers: fields }, { uid: true })) {
        out.set(m.uid, parseHeaders(m.headers?.toString('utf8') ?? ''));
      }
      return out;
    });
    const due: { to: string; subject: string; messageId: string | null }[] = [];
    const since = this.now() - reply.intervalDays * 86_400_000;
    for (const m of mail) {
      const sender = m.from?.address?.trim() ?? '';
      const h = headers.get(m.uid);
      if (!h || skipReason(h, sender, account.email)) continue;
      const key = sender.toLowerCase();
      if (due.some((d) => d.to.toLowerCase() === key)) continue;
      const last = this.db.prepare('SELECT sent_at FROM auto_reply_log WHERE reply_id = ? AND account_id = ? AND sender = ?').get(reply.id, accountId, key) as { sent_at: number } | undefined;
      if (last && last.sent_at > since) continue;
      due.push({ to: sender, subject: m.subject, messageId: m.messageId ?? null });
    }
    void (async () => {
      for (const d of due) {
        if (!this.underLimit(accountId)) {
          this.deps.log?.('auto-reply hourly limit reached', { accountId });
          return;
        }
        try {
          await this.deps.send(userId, accountId, { to: d.to, subject: fill(reply.subject, d), text: fill(reply.body, d), inReplyTo: d.messageId });
          this.sentAt.get(accountId)!.push(this.now());
          this.db
            .prepare('INSERT INTO auto_reply_log (reply_id, account_id, sender, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT (reply_id, account_id, sender) DO UPDATE SET sent_at = excluded.sent_at')
            .run(reply.id, accountId, d.to.toLowerCase(), this.now());
        } catch (err) {
          this.deps.log?.('auto-reply failed', { accountId, error: (err as Error).message });
        }
      }
    })();
  }
}
