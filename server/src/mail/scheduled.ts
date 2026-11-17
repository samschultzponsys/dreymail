// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Send later, and the few seconds "undo send" waits: the composed message (with attachments) is
// sealed in the database and sent when due, by the server, whether or not any browser is open.

import crypto from 'node:crypto';
import type { ComposePayload, ScheduledSend, SendResult } from '../../../shared/types.js';
import type { Store } from '../db.js';

export interface OutgoingFile {
  filename: string;
  contentType: string;
  content: Buffer;
}

type Sender = (userId: string, payload: ComposePayload, files: OutgoingFile[]) => Promise<SendResult>;

const context = (id: string) => `scheduled-send:${id}`;

export class ScheduledSends {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly send: Sender,
    private readonly log?: (msg: string, extra?: Record<string, unknown>) => void,
  ) {}

  private get db() {
    return this.store.db;
  }

  /** Check every 10 seconds. A send cut off by a restart is not retried blindly (it may have gone out). */
  start() {
    this.db.prepare("UPDATE scheduled_sends SET status = 'failed', error = 'DreyMail restarted while sending; check Sent before sending again' WHERE status = 'sending'").run();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  schedule(userId: string, payload: ComposePayload, files: OutgoingFile[], sendAt: number): ScheduledSend {
    const id = crypto.randomUUID();
    const message = this.store.sealSecret(context(id), JSON.stringify({ payload, files: files.map((f) => ({ ...f, content: f.content.toString('base64') })) }));
    this.db
      .prepare('INSERT INTO scheduled_sends (id, user_id, account_id, send_at, subject, recipients, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, payload.accountId, sendAt, payload.subject.slice(0, 300), payload.to.slice(0, 500), message, Date.now());
    return this.list(userId).find((s) => s.id === id)!;
  }

  list(userId: string): ScheduledSend[] {
    return (this.db.prepare('SELECT id, account_id, send_at, subject, recipients, status, error, created_at FROM scheduled_sends WHERE user_id = ? ORDER BY send_at').all(userId) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      sendAt: new Date(Number(r.send_at)).toISOString(),
      subject: String(r.subject),
      to: String(r.recipients),
      status: r.status as ScheduledSend['status'],
      error: String(r.error),
      createdAt: new Date(Number(r.created_at)).toISOString(),
    }));
  }

  /**
   * Undo: cancel a message that hasn't started sending and hand back what was composed (with its
   * attachments, base64), so it can be opened again. Null if it is already going out or gone.
   */
  takeBack(userId: string, id: string): { payload: ComposePayload; files: { filename: string; contentType: string; content: string }[] } | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT message FROM scheduled_sends WHERE id = ? AND user_id = ? AND status != 'sending'").get(id, userId) as { message: string } | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare('DELETE FROM scheduled_sends WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return JSON.parse(this.store.openSecret(context(id), row.message)) as { payload: ComposePayload; files: { filename: string; contentType: string; content: string }[] };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already done */
      }
      throw err;
    }
  }

  /** Cancel a message that hasn't started sending. */
  cancel(userId: string, id: string): boolean {
    return this.db.prepare("DELETE FROM scheduled_sends WHERE id = ? AND user_id = ? AND status != 'sending'").run(id, userId).changes > 0;
  }

  sendNow(userId: string, id: string): boolean {
    const n = this.db.prepare("UPDATE scheduled_sends SET send_at = ?, status = 'pending', error = '' WHERE id = ? AND user_id = ? AND status != 'sending'").run(Date.now(), id, userId).changes;
    if (n) void this.tick();
    return n > 0;
  }

  /** Send what's due. A call while a check runs waits for that check instead of starting another. */
  tick(): Promise<void> {
    this.running ??= this.work().finally(() => (this.running = null));
    return this.running;
  }

  private async work() {
    {
      const due = this.db.prepare("SELECT id, user_id, message FROM scheduled_sends WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT 20").all(Date.now()) as {
        id: string;
        user_id: string;
        message: string;
      }[];
      for (const row of due) {
        // Claim it, so a second tick can't send it twice.
        if (this.db.prepare("UPDATE scheduled_sends SET status = 'sending' WHERE id = ? AND status = 'pending'").run(row.id).changes === 0) continue;
        try {
          const { payload, files } = JSON.parse(this.store.openSecret(context(row.id), row.message)) as { payload: ComposePayload; files: { filename: string; contentType: string; content: string }[] };
          await this.send(row.user_id, payload, files.map((f) => ({ ...f, content: Buffer.from(f.content, 'base64') })));
          this.db.prepare('DELETE FROM scheduled_sends WHERE id = ?').run(row.id);
        } catch (err) {
          this.db.prepare("UPDATE scheduled_sends SET status = 'failed', error = ? WHERE id = ?").run((err as Error).message.slice(0, 500), row.id);
          this.log?.('scheduled send failed', { id: row.id, error: (err as Error).message });
        }
      }
    }
  }
}
