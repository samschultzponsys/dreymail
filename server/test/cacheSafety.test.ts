// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { ImapPool } from '../src/imap/pool.js';
import { CacheSync } from '../src/cache/sync.js';
import { MailCache } from '../src/cache/store.js';
import crypto from 'node:crypto';
import { Keyring } from '../src/crypto.js';

/**
 * The copy of a folder never loses messages because the mail server refused a request (DreyMail
 * 14.6): a refused SEARCH (Microsoft 365 throttling) was read as "no messages left" and emptied the
 * cached inbox, which the list then trusted.
 */

const keys = () => {
  const k = new Keyring(crypto.randomBytes(48).toString('base64'));
  return { cacheKey: k.cacheKey, indexKey: k.cacheIndexKey };
};

function setup(n: number) {
  const cache = new MailCache(':memory:', keys());
  const state = { refuse: false, empty: false };
  const msg = (uid: number) => ({ uid, seq: uid, flags: new Set<string>(['\\Seen']), envelope: { subject: `Message ${uid}`, from: [{ name: 'A', address: 'a@example.com' }], to: [], date: new Date(2026, 0, 1, 0, uid) }, internalDate: new Date(2026, 0, 1, 0, uid), size: 100 });
  const pick = (range: string) => {
    if (range.includes(',') || !range.includes(':')) return range.split(',').map(Number).filter((u) => u >= 1 && u <= n).map(msg);
    const [lo, hi] = range.split(':');
    const top = hi === '*' ? n : Number(hi);
    return Array.from({ length: n }, (_, i) => msg(i + 1)).filter((m) => m.uid >= Number(lo) && m.uid <= top);
  };
  const pool = {
    async folders() {
      return [];
    },
    async withMailbox<T>(_u: string, _a: string, p: string, fn: (client: unknown, mailbox: unknown) => Promise<T>): Promise<T> {
      const mailbox = { path: p, exists: n, uidNext: n + 1, uidValidity: 7n, noModseq: true };
      const client = {
        mailbox,
        enabled: new Set<string>(),
        noop: async () => undefined,
        fetchAll: async (range: string) => pick(range),
        fetch: async function* () {},
        // Throttled: refused (imapflow answers false), or answered with nothing.
        search: async (q: { uid: string }) => (state.refuse ? false : state.empty ? [] : pick(q.uid).map((m) => m.uid)),
      };
      return fn(client, mailbox);
    },
  } as unknown as ImapPool;
  const logs: string[] = [];
  const sync = new CacheSync({
    cache,
    pool,
    // Every check also checks the whole folder (normally every few minutes, in the background).
    config: { messagesPerFolder: 2000, messagesPerOtherFolder: 0, maxBodyBytes: 0, bodyBytesPerAccount: 0, fullCheckMs: 0 },
    sentFolder: async () => null,
    isWatched: () => false,
    onChanged: () => {},
    log: (m) => logs.push(m),
  });
  return { cache, sync, state, logs };
}

const count = (cache: MailCache) => cache.count(cache.folder('u1', 'a1', 'INBOX')!);

describe('the cached copy when the mail server refuses', () => {
  it('keeps every message when a search is refused or comes back empty', async () => {
    const { cache, sync, state, logs } = setup(300);
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    await sync.idle();
    expect(count(cache)).toBe(300);
    state.refuse = true;
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    await sync.idle();
    expect(count(cache)).toBe(300);
    expect(logs).toContain('mail cache sync failed');
    state.refuse = false;
    state.empty = true;
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    await sync.idle();
    expect(count(cache)).toBe(300);
  });

  it('never marks a folder complete because a search was refused while filling it', async () => {
    const { cache, sync, state } = setup(450);
    // The first chunk (200), then the filling of older messages is refused.
    state.refuse = true;
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    await sync.idle();
    const f = cache.folder('u1', 'a1', 'INBOX')!;
    expect(count(cache)).toBe(200);
    expect(f.complete).toBe(false);
    state.refuse = false;
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    await sync.idle();
    expect(count(cache)).toBe(450);
  });

  it('does not trust a copy that lost messages for listing, until it is filled again', async () => {
    const { cache, sync } = setup(300);
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    await sync.idle();
    const f = cache.folder('u1', 'a1', 'INBOX')!;
    expect(sync.isIntact(f)).toBe(true);
    cache.removeMessages(f, cache.uids(f).filter((u) => u <= 294));
    expect(sync.isIntact(cache.folder('u1', 'a1', 'INBOX')!)).toBe(false);
  });

  it('fills a copy that lost messages again, from scratch', async () => {
    const { cache, sync, logs } = setup(300);
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    await sync.idle();
    const f = cache.folder('u1', 'a1', 'INBOX')!;
    // As a sync before 14.6 left it: all but the newest 6 dropped, the folder still "complete".
    cache.removeMessages(f, cache.uids(f).filter((u) => u <= 294));
    expect(count(cache)).toBe(6);
    await sync.sync('u1', 'a1', 'INBOX', 'inbox');
    for (let i = 0; i < 20 && count(cache) < 300; i++) {
      await new Promise((r) => setTimeout(r, 50));
      await sync.idle();
    }
    expect(count(cache)).toBe(300);
    expect(logs).toContain('mail cache folder incomplete, filling it again');
  });
});
