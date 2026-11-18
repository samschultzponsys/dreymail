// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Follow-up flags, as in Outlook: a flagged message with a due date (or none). Kept by Message-ID
// per mailbox, so a follow-up stays with the message when it is moved; the flag itself is the IMAP
// \Flagged flag, so other mail apps see it too. Reminders come at the due time.

import type { FollowUp, MessageRef } from '../../../shared/types.js';
import type { Store } from '../db.js';

interface Row {
  account_id: string;
  message_id: string;
  folder: string;
  uid_validity: string;
  uid: number;
  subject: string;
  sender: string;
  due_at: number | null;
}

export class Followups {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  set(userId: string, ref: MessageRef, messageId: string, info: { subject: string; sender: string }, due: number | null) {
    this.db
      .prepare(
        `INSERT INTO followups (user_id, account_id, message_id, folder, uid_validity, uid, subject, sender, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, account_id, message_id) DO UPDATE SET folder = excluded.folder, uid_validity = excluded.uid_validity, uid = excluded.uid, subject = excluded.subject, sender = excluded.sender, due_at = excluded.due_at`,
      )
      .run(userId, ref.accountId, messageId, ref.folder, ref.uidValidity, ref.uid, info.subject.slice(0, 300), info.sender.slice(0, 300), due, Date.now());
  }

  clear(userId: string, accountId: string, messageId: string) {
    this.db.prepare('DELETE FROM followups WHERE user_id = ? AND account_id = ? AND message_id = ?').run(userId, accountId, messageId);
  }

  /** Unflagged or deleted here: their follow-ups end too. */
  clearRefs(userId: string, accountId: string, folder: string, uidValidity: string, uids: number[]) {
    for (const uid of uids) this.db.prepare('DELETE FROM followups WHERE user_id = ? AND account_id = ? AND folder = ? AND uid_validity = ? AND uid = ?').run(userId, accountId, folder, uidValidity, uid);
  }

  /** Due dates of messages in a list, by account and Message-ID (null: flagged for follow-up without a date). */
  lookup(userId: string): (accountId: string, messageId: string | null) => FollowUp | undefined {
    const rows = this.db.prepare('SELECT account_id, message_id, due_at FROM followups WHERE user_id = ?').all(userId) as unknown as Pick<Row, 'account_id' | 'message_id' | 'due_at'>[];
    const map = new Map(rows.map((r) => [`${r.account_id}\u0000${r.message_id}`, r.due_at]));
    return (accountId, messageId) => {
      if (!messageId || !map.has(`${accountId}\u0000${messageId}`)) return undefined;
      const due = map.get(`${accountId}\u0000${messageId}`);
      return { due: due ? new Date(due).toISOString() : null };
    };
  }

  /** Follow-ups with a due date between from and to (for reminders). */
  due(userId: string, from: number, to: number): (Row & { ref: MessageRef })[] {
    const rows = this.db.prepare('SELECT * FROM followups WHERE user_id = ? AND due_at IS NOT NULL AND due_at >= ? AND due_at < ?').all(userId, from, to) as unknown as Row[];
    return rows.map((r) => ({ ...r, ref: { accountId: r.account_id, folder: r.folder, uid: r.uid, uidValidity: r.uid_validity } }));
  }

  /** Everything flagged for follow-up, soonest first (no date last). */
  list(userId: string) {
    const rows = this.db.prepare('SELECT * FROM followups WHERE user_id = ? ORDER BY due_at IS NULL, due_at').all(userId) as unknown as Row[];
    return rows.map((r) => ({ ref: { accountId: r.account_id, folder: r.folder, uid: r.uid, uidValidity: r.uid_validity }, messageId: r.message_id, subject: r.subject, sender: r.sender, due: r.due_at ? new Date(r.due_at).toISOString() : null }));
  }

  users(): string[] {
    return (this.db.prepare('SELECT DISTINCT user_id FROM followups WHERE due_at IS NOT NULL').all() as { user_id: string }[]).map((r) => r.user_id);
  }
}
