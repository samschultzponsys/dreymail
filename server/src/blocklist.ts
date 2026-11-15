// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Blocked senders: per mailbox, an address (or a whole domain written as "@example.com") whose
// mail goes to Junk, now and whenever more arrives. Needs no AI.

import type { Store } from './db.js';
import type { MailService } from './imap/mail.js';
import type { ImapPool } from './imap/pool.js';

export interface BlockedSender {
  accountId: string;
  address: string;
  createdAt: string;
}

export function normaliseBlock(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, '$1');
  if (/^@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return s;
  if (/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return s;
  return null;
}

export const blocks = (address: string, entry: string) => {
  const a = address.toLowerCase();
  if (!entry.startsWith('@')) return a === entry;
  // A domain blocks its subdomains too.
  const domain = a.slice(a.lastIndexOf('@') + 1);
  const d = entry.slice(1);
  return domain === d || domain.endsWith(`.${d}`);
};

export class Blocklist {
  constructor(
    private readonly deps: { store: Store; pool: ImapPool; mail: MailService },
  ) {}

  private get db() {
    return this.deps.store.db;
  }

  list(userId: string): BlockedSender[] {
    return (this.db.prepare('SELECT account_id, address, created_at FROM blocked_senders WHERE user_id = ? ORDER BY created_at DESC').all(userId) as {
      account_id: string;
      address: string;
      created_at: number;
    }[]).map((r) => ({ accountId: r.account_id, address: r.address, createdAt: new Date(r.created_at).toISOString() }));
  }

  /** Users with any blocked sender (their inboxes are watched). */
  users(): string[] {
    return (this.db.prepare('SELECT DISTINCT user_id FROM blocked_senders').all() as { user_id: string }[]).map((r) => r.user_id);
  }

  private entries(userId: string, accountId: string): string[] {
    return (this.db.prepare('SELECT address FROM blocked_senders WHERE user_id = ? AND account_id = ?').all(userId, accountId) as { address: string }[]).map((r) => r.address);
  }

  async add(userId: string, accountId: string, address: string): Promise<number> {
    this.db.prepare('INSERT OR IGNORE INTO blocked_senders (user_id, account_id, address, created_at) VALUES (?, ?, ?, ?)').run(userId, accountId, address, Date.now());
    // What's already in the inbox from them goes to Junk too.
    const { uids, uidValidity } = await this.deps.pool.withMailbox(userId, accountId, 'INBOX', async (client, mailbox) => ({
      uids: ((await client.search({ from: address.replace(/^@/, '') }, { uid: true })) || []).filter(Boolean),
      uidValidity: mailbox.uidValidity.toString(),
    }));
    if (uids.length) await this.toJunk(userId, accountId, uidValidity, uids);
    return uids.length;
  }

  remove(userId: string, accountId: string, address: string): boolean {
    return this.db.prepare('DELETE FROM blocked_senders WHERE user_id = ? AND account_id = ? AND address = ?').run(userId, accountId, address).changes > 0;
  }

  private async toJunk(userId: string, accountId: string, uidValidity: string, uids: number[]) {
    const junk = (await this.deps.mail.specialFolder(userId, accountId, 'junk')) ?? (await this.deps.pool.withClient(userId, accountId, async (c) => (await c.mailboxCreate(['Junk'])).path));
    await this.deps.mail.applyAction(userId, accountId, 'INBOX', uidValidity, uids, { type: 'move', destination: junk });
  }

  /** New mail: blocked senders' messages go to Junk. Returns the UIDs that stay. */
  async handleNew(userId: string, accountId: string, mail: { uid: number; uidValidity: string; from: { address: string } | null }[]): Promise<number[]> {
    const entries = this.entries(userId, accountId);
    if (!entries.length) return mail.map((m) => m.uid);
    const hit = mail.filter((m) => m.from?.address && entries.some((e) => blocks(m.from!.address, e)));
    if (hit.length) await this.toJunk(userId, accountId, hit[0]!.uidValidity, hit.map((m) => m.uid)).catch(() => undefined);
    return mail.filter((m) => !hit.includes(m)).map((m) => m.uid);
  }
}
