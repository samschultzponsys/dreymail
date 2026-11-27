// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MailCache } from '../src/cache/store.js';
import { CacheSync } from '../src/cache/sync.js';
import { Keyring } from '../src/crypto.js';
import { MailService } from '../src/imap/mail.js';
import type { ImapPool } from '../src/imap/pool.js';

/**
 * A list of a cached folder never waits long for a slow mail server (DreyMail 26.11): right after
 * the server started, an inbox list waited 28 s while it signed in again and checked a big mailbox.
 */
describe('listing a cached folder while the mail server is slow (26.11)', () => {
  it('answers from the copy after about 2 s', async () => {
    const k = new Keyring(crypto.randomBytes(48).toString('base64'));
    const cache = new MailCache(':memory:', { cacheKey: k.cacheKey, indexKey: k.cacheIndexKey });
    const state = { hang: false };
    const total = 120;
    const msg = (uid: number) => ({
      uid,
      seq: uid,
      flags: new Set<string>(),
      envelope: { subject: `m ${uid}`, from: [{ name: 'A', address: 'a@example.com' }], to: [], date: new Date(2026, 0, 1, 0, uid), messageId: `<${uid}@example.com>` },
      internalDate: new Date(2026, 0, 1, 0, uid),
      size: 100,
    });
    const pick = (range: string) => {
      const [lo, hi] = range.split(':');
      const top = hi === '*' ? total : Number(hi ?? lo);
      return Array.from({ length: total }, (_, i) => msg(i + 1)).filter((m) => m.uid >= Number(lo) && m.uid <= top);
    };
    const pool = {
      folders: async () => [],
      async withMailbox<T>(_u: string, _a: string, p: string, fn: (client: unknown, mailbox: unknown) => Promise<T>): Promise<T> {
        // The mail server not answering (signing in again, busy with a big mailbox).
        if (state.hang) return new Promise<T>(() => {});
        const mailbox = { path: p, exists: total, uidNext: total + 1, uidValidity: 5n, noModseq: true };
        const client = { mailbox, enabled: new Set<string>(), noop: async () => undefined, fetchAll: async (range: string) => pick(range), fetch: async function* () {}, search: async (q: { uid: string }) => pick(q.uid).map((m) => m.uid) };
        return fn(client, mailbox);
      },
    } as unknown as ImapPool;
    const sync = new CacheSync({
      cache,
      pool,
      config: { messagesPerFolder: 2000, messagesPerOtherFolder: 0, maxBodyBytes: 0, bodyBytesPerAccount: 0 },
      sentFolder: async () => null,
      isWatched: () => false,
      onChanged: () => {},
    });
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    await sync.idle();
    const f = cache.folder('u1', 'a1', 'INBOX')!;
    expect(cache.count(f)).toBe(total);
    // A copy the list doesn't trust alone (short of messages): it asks the mail server, which hangs.
    cache.removeMessages(f, cache.uids(f).filter((u) => u <= 20));
    state.hang = true;
    const mail = new MailService(pool, { cache, sync, maxBodyBytes: 0, bodyBytesPerAccount: 0 });
    const started = Date.now();
    const timing: Record<string, number | string> = {};
    const list = await mail.listMessages('u1', [{ accountId: 'a1', folder: 'INBOX' }], null, 50, { text: '', unread: false }, { timing });
    const took = Date.now() - started;
    expect(took).toBeLessThan(4000);
    expect(list.messages.length).toBe(50);
    expect(list.messages[0]!.subject).toBe('m 120');
    // Not the last page: a further page asks again.
    expect(list.cursor).not.toBeNull();
    expect(timing.from).toBe('copy (server slow)');
    void sync.stop();
    cache.close();
  }, 10_000);
});
