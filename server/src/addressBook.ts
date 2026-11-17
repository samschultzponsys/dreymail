// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Address suggestions while writing: per mailbox, the people you've sent to and the people who
// wrote to you, from the mail cache (each folder's existing mail once, then new mail), plus every
// message you send. Which mailboxes' addresses are suggested is a preference (all by default, the
// sending mailbox, its group, or chosen mailboxes).

import type { DatabaseSync } from 'node:sqlite';
import type { MessageSummary, SpecialUse, SuggestScope } from '../../shared/types.js';
import type { Store } from './db.js';

/** Addresses kept per mailbox; the least used and oldest go first. */
const MAX_PER_ACCOUNT = 5000;
/** A message you sent counts this much more than one you received. */
const SENT_WEIGHT = 3;

/** Automated senders nobody wants to write to. */
const NOISE = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?)([._+-]|@)/i;

/** Folders whose senders count as people who wrote to you. */
const RECEIVED_IN = new Set<SpecialUse | null>(['inbox', 'archive', null]);

export interface Suggestion {
  name: string;
  address: string;
}

export class AddressBook {
  constructor(private readonly store: Store) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  /** The user's own addresses (never suggested). */
  private own(userId: string): Set<string> {
    return new Set(this.store.listAccounts(userId).map((a) => a.email.trim().toLowerCase()));
  }

  /** Count people in these messages: recipients of sent mail, senders of received mail. */
  harvest(userId: string, accountId: string, use: SpecialUse | null, messages: Pick<MessageSummary, 'from' | 'to' | 'date' | 'category'>[]) {
    if (messages.length === 0) return;
    const sent = use === 'sent';
    if (!sent && !RECEIVED_IN.has(use)) return; // Junk, Trash, Drafts, All mail, …
    const own = this.own(userId);
    const people: { address: string; name: string; at: number; sent: boolean }[] = [];
    for (const m of messages) {
      const at = Date.parse(m.date) || Date.now();
      if (sent) for (const a of m.to) people.push({ address: a.address, name: a.name, at, sent: true });
      else if (m.category !== 'newsletters' && m.category !== 'updates') {
        const a = m.from[0];
        if (a && !NOISE.test(a.address)) people.push({ address: a.address, name: a.name, at, sent: false });
      }
    }
    this.record(userId, accountId, people.filter((p) => p.address.includes('@') && !own.has(p.address.trim().toLowerCase())));
  }

  /** Mail you just sent from this mailbox. */
  sent(userId: string, accountId: string, recipients: { name: string; address: string }[]) {
    const own = this.own(userId);
    const now = Date.now();
    this.record(userId, accountId, recipients.filter((r) => !own.has(r.address.trim().toLowerCase())).map((r) => ({ ...r, at: now, sent: true })));
  }

  private record(userId: string, accountId: string, people: { address: string; name: string; at: number; sent: boolean }[]) {
    if (people.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO address_book (user_id, account_id, address, name, sent, received, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, account_id, address) DO UPDATE SET
         name = CASE WHEN excluded.name != '' AND (address_book.name = '' OR excluded.last_seen >= address_book.last_seen) THEN excluded.name ELSE address_book.name END,
         sent = address_book.sent + excluded.sent,
         received = address_book.received + excluded.received,
         last_seen = MAX(address_book.last_seen, excluded.last_seen)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const p of people) {
        const address = p.address.trim().toLowerCase().slice(0, 320);
        stmt.run(userId, accountId, address, p.name.trim().slice(0, 200), p.sent ? 1 : 0, p.sent ? 0 : 1, p.at);
      }
      this.db
        .prepare(
          `DELETE FROM address_book WHERE user_id = ? AND account_id = ? AND address NOT IN (
             SELECT address FROM address_book WHERE user_id = ? AND account_id = ?
             ORDER BY sent * ${SENT_WEIGHT} + received DESC, last_seen DESC LIMIT ${MAX_PER_ACCOUNT})`,
        )
        .run(userId, accountId, userId, accountId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The mailboxes whose addresses are suggested when writing from `fromAccountId`; null for all. */
  scope(userId: string, fromAccountId: string | null, scope: SuggestScope, chosen: string[]): string[] | null {
    if (scope === 'all') return null;
    const accounts = this.store.listAccounts(userId);
    if (scope === 'chosen') {
      const ids = chosen.filter((id) => accounts.some((a) => a.id === id));
      return ids.length ? ids : null;
    }
    const from = accounts.find((a) => a.id === fromAccountId);
    if (!from) return null;
    if (scope === 'group' && from.groupId) return accounts.filter((a) => a.groupId === from.groupId).map((a) => a.id);
    return [from.id];
  }

  /**
   * People matching what is being typed (start of the address, the name or a word of it first),
   * those you write to most first. The same address in several mailboxes counts once.
   */
  search(userId: string, query: string, accountIds: string[] | null, limit = 8): Suggestion[] {
    const q = query.trim().toLowerCase();
    if (q.length < 1) return [];
    const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const inScope = accountIds ? `AND account_id IN (${accountIds.map(() => '?').join(',')})` : '';
    const rows = this.db
      .prepare(
        `SELECT address, MAX(name) AS name, SUM(sent) AS sent, SUM(received) AS received, MAX(last_seen) AS last_seen,
                MAX(address LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\') AS starts
           FROM address_book
          WHERE user_id = ? ${inScope} AND (address LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')
          GROUP BY address
          ORDER BY starts DESC, SUM(sent) * ${SENT_WEIGHT} + SUM(received) DESC, MAX(last_seen) DESC
          LIMIT ?`,
      )
      .all(`${esc}%`, `${esc}%`, `% ${esc}%`, userId, ...(accountIds ?? []), `%${esc}%`, `%${esc}%`, limit) as { address: string; name: string | null }[];
    return rows.map((r) => ({ name: r.name ?? '', address: r.address }));
  }

  /**
   * Whether a folder's existing mail was counted already. Each folder's mail is counted once, from
   * the cache once it has filled; after that only new mail is, so nothing is counted twice (also
   * when the cache is cleared and fills again).
   */
  filled(accountId: string, folder: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM address_book_filled WHERE account_id = ? AND folder = ?').get(accountId, folder);
  }

  markFilled(accountId: string, folder: string) {
    this.db.prepare('INSERT OR REPLACE INTO address_book_filled (account_id, folder, filled_at) VALUES (?, ?, ?)').run(accountId, folder, Date.now());
  }

  /** Forget a mailbox's addresses (and fill it again from the cache next time). */
  forgetAccount(userId: string, accountId: string) {
    this.db.prepare('DELETE FROM address_book WHERE user_id = ? AND account_id = ?').run(userId, accountId);
    this.db.prepare('DELETE FROM address_book_filled WHERE account_id = ?').run(accountId);
  }
}
