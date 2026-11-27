// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MailCache } from '../src/cache/store.js';
import { CacheSync, FLAG_WINDOW } from '../src/cache/sync.js';
import { Keyring } from '../src/crypto.js';
import type { ImapPool, Lane } from '../src/imap/pool.js';

/**
 * Checking a cached folder on a server without CONDSTORE (Microsoft 365), DreyMail 26.11: a check
 * reads only the newest messages' flags and asks for the list of every UID only when the message
 * count says something was deleted; the whole folder is checked every few minutes in the background.
 */

function setup(total: number, fullCheckMs?: number) {
  const k = new Keyring(crypto.randomBytes(48).toString('base64'));
  const cache = new MailCache(':memory:', { cacheKey: k.cacheKey, indexKey: k.cacheIndexKey });
  const server = { uids: Array.from({ length: total }, (_, i) => i + 1), seen: new Set<number>() };
  const asked = { searches: 0, flagRanges: [] as string[], lanes: [] as Lane[] };
  const msg = (uid: number) => ({
    uid,
    seq: server.uids.indexOf(uid) + 1,
    flags: new Set(server.seen.has(uid) ? ['\\Seen'] : []),
    envelope: { subject: `m ${uid}`, from: [{ name: 'A', address: 'a@example.com' }], to: [], date: new Date(2026, 0, 1, 0, uid) },
    internalDate: new Date(2026, 0, 1, 0, uid),
    size: 100,
  });
  const byUid = (range: string) => {
    const [lo, hi] = range.split(':');
    const top = hi === '*' ? Infinity : Number(hi ?? lo);
    const found = server.uids.filter((u) => u >= Number(lo) && u <= top);
    // "n:*" always matches the newest message.
    return found.length || hi !== '*' ? found : server.uids.slice(-1);
  };
  const bySeq = (range: string) => {
    const [lo, hi] = range.split(':').map(Number);
    return server.uids.slice(lo! - 1, hi);
  };
  const pool = {
    async withMailbox<T>(_u: string, _a: string, p: string, fn: (client: unknown, mailbox: unknown) => Promise<T>, lane: Lane = 'main'): Promise<T> {
      asked.lanes.push(lane);
      const mailbox = { path: p, exists: server.uids.length, uidNext: Math.max(0, ...server.uids) + 1, uidValidity: 3n, noModseq: true };
      const client = {
        mailbox,
        enabled: new Set<string>(),
        noop: async () => undefined,
        fetchAll: async (range: string, query: { flags?: boolean; envelope?: boolean }, opts?: { uid?: boolean }) => {
          const uids = opts?.uid ? byUid(range) : bySeq(range);
          if (opts?.uid && query.flags && !query.envelope) asked.flagRanges.push(range);
          return uids.map(msg);
        },
        fetch: async function* () {},
        search: async (q: { uid: string }) => {
          asked.searches++;
          return byUid(q.uid);
        },
      };
      return fn(client, mailbox);
    },
  } as unknown as ImapPool;
  const sync = new CacheSync({
    cache,
    pool,
    config: { messagesPerFolder: 20000, messagesPerOtherFolder: 0, maxBodyBytes: 0, bodyBytesPerAccount: 0, fullCheckMs },
    sentFolder: async () => null,
    isWatched: () => false,
    onChanged: () => {},
  });
  const check = async () => {
    asked.searches = 0;
    asked.flagRanges.length = 0;
    asked.lanes.length = 0;
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    await sync.idle();
  };
  const folder = () => cache.folder('u1', 'a1', 'INBOX')!;
  return { cache, sync, server, asked, check, folder };
}

/** Fill the copy whole (the first fill takes the newest chunk; the rest comes in the background). */
async function filled(total: number, fullCheckMs?: number) {
  const s = setup(total, fullCheckMs);
  for (let i = 0; i < 30 && !(s.cache.folder('u1', 'a1', 'INBOX')?.complete ?? false); i++) await s.check();
  expect(s.cache.count(s.folder())).toBe(total);
  return s;
}

describe('checking a cached folder without CONDSTORE (26.11)', () => {
  it("reads only the newest messages' flags and skips the list of every UID when nothing was deleted", async () => {
    const { check, asked } = await filled(2000);
    await check();
    expect(asked.searches).toBe(0);
    expect(asked.flagRanges).toEqual([`${2000 - FLAG_WINDOW + 1}:*`]);
    expect(asked.lanes.every((l) => l === 'main')).toBe(true);
  });

  it('still sees a new message, and a change to a recent one, at once', async () => {
    const { check, server, cache, folder } = await filled(1000);
    server.uids.push(1001);
    server.seen.add(990);
    await check();
    expect(cache.count(folder())).toBe(1001);
    expect(cache.message(folder(), 990)!.summary.seen).toBe(true);
  });

  it('notices a message another mail client deleted, from the count', async () => {
    const { check, server, cache, folder, asked } = await filled(1000);
    server.uids = server.uids.filter((u) => u !== 10);
    await check();
    expect(asked.searches).toBe(1);
    expect(cache.message(folder(), 10)).toBeNull();
    expect(cache.count(folder())).toBe(999);
  });

  it('needs no list of every UID after DreyMail itself moved a message out', async () => {
    const { check, server, cache, folder, asked } = await filled(1000);
    server.uids = server.uids.filter((u) => u !== 500);
    cache.removeExpunged(folder(), [500]);
    expect(folder().exists).toBe(999);
    await check();
    expect(asked.searches).toBe(0);
    expect(cache.count(folder())).toBe(999);
  });

  it('checks the whole folder in the background every few minutes: older flags and deletions', async () => {
    const { check, server, cache, folder, asked } = await filled(2000, 0);
    server.seen.add(3);
    await check();
    // The check itself on the main connection, the whole folder on the background one.
    expect(asked.lanes).toContain('sync');
    expect(asked.flagRanges).toContain('1:*');
    expect(asked.searches).toBe(1);
    expect(cache.message(folder(), 3)!.summary.seen).toBe(true);
  });
});
