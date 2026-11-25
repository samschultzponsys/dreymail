// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-25: whole messages decoded too (a pool of its own for opening them).

// Worker threads that read messages for the search index (DreyMail 13.0): every CPU thread the
// server has but one (at least two, at most eight), so indexing goes on in parallel while the server stays
// free for people using DreyMail. Where workers can't start (running from TypeScript sources, as in
// tests), messages are read on the server's own thread instead.

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ParsedEmail } from '../mail/parse.js';
import { parseRaw } from '../mail/parse.js';
import { messageTerms } from './textWorker.js';

interface Pending {
  resolve: (m: { terms?: string[] | null; email?: ParsedEmail; error?: string }) => void;
}

export class TextPool {
  private readonly workers: { w: Worker; busy: number }[] = [];
  private readonly pending = new Map<number, Pending>();
  private next = 1;

  // Every CPU thread but one (kept for the server itself), at least two, at most eight.
  constructor(size = Math.max(2, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1))) {
    const file = new URL('./textWorker.js', import.meta.url);
    if (!fs.existsSync(fileURLToPath(file))) return;
    for (let i = 0; i < size; i++) {
      try {
        const w = new Worker(file);
        w.unref();
        const slot = { w, busy: 0 };
        w.on('message', (m: { id: number; terms?: string[] | null; email?: ParsedEmail; error?: string }) => {
          slot.busy--;
          this.pending.get(m.id)?.resolve(m);
          this.pending.delete(m.id);
        });
        w.on('error', () => {
          const at = this.workers.indexOf(slot);
          if (at >= 0) this.workers.splice(at, 1);
        });
        this.workers.push(slot);
      } catch {
        break;
      }
    }
  }

  /** How many messages can be read at once. */
  get size(): number {
    return Math.max(1, this.workers.length);
  }

  /** The words of a message (null when it can't be read). */
  terms(raw: Buffer): Promise<string[] | null> {
    const slot = this.idlest();
    if (!slot) return messageTerms(raw);
    return this.send(slot, { raw }).then((m) => m.terms ?? null);
  }

  /** A whole message decoded (DreyMail 14.1), beside the server's own thread. */
  async parse(raw: Buffer): Promise<ParsedEmail> {
    const slot = this.idlest();
    if (!slot) return parseRaw(raw);
    const m = await this.send(slot, { raw, kind: 'parse' });
    if (!m.email) throw new Error(m.error ?? 'Unreadable message');
    return m.email;
  }

  private idlest() {
    return this.workers.reduce<{ w: Worker; busy: number } | null>((best, s) => (!best || s.busy < best.busy ? s : best), null);
  }

  private send(slot: { w: Worker; busy: number }, msg: { raw: Buffer; kind?: 'parse' }): Promise<{ terms?: string[] | null; email?: ParsedEmail; error?: string }> {
    const id = this.next++;
    slot.busy++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      slot.w.postMessage({ id, ...msg }, []);
    });
  }

  async close() {
    await Promise.all(this.workers.map((s) => s.w.terminate()));
    for (const p of this.pending.values()) p.resolve({ terms: null, error: 'Stopped' });
    this.pending.clear();
  }
}
