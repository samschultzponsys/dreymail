// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MailCache } from '../src/cache/store.js';
import { CacheSync } from '../src/cache/sync.js';
import type { CacheConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import type { ImapPool, Lane } from '../src/imap/pool.js';

/** A tiny in-memory IMAP server: folders of messages with UIDs 1..n. */
function fakePool(folders: Record<string, number>) {
  const lanes: { path: string; lane: Lane }[] = [];
  const msg = (path: string, uid: number) => ({
    uid,
    seq: uid,
    flags: new Set<string>(),
    envelope: { subject: `${path} ${uid}`, from: [{ name: 'A', address: 'a@example.com' }], to: [], date: new Date(2026, 0, 1, 0, uid) },
    internalDate: new Date(2026, 0, 1, 0, uid),
    size: 100,
  });
  const pool = {
    async withMailbox<T>(_u: string, _a: string, path: string, fn: (client: unknown, mailbox: unknown) => Promise<T>, lane: Lane = 'main'): Promise<T> {
      lanes.push({ path, lane });
      const n = folders[path] ?? 0;
      const mailbox = { path, exists: n, uidNext: n + 1, uidValidity: 1n, noModseq: true };
      const all = Array.from({ length: n }, (_, i) => msg(path, i + 1));
      const pick = (range: string) => {
        const [lo, hi] = range.split(':');
        const top = hi === '*' ? n : Number(hi ?? lo);
        return all.filter((m) => m.uid >= Number(lo) && m.uid <= Math.max(top, Number(lo) > n ? n : top));
      };
      const client = {
        mailbox,
        enabled: new Set<string>(),
        noop: async () => undefined,
        fetchAll: async (range: string) => pick(range),
        search: async (q: { uid: string }) => pick(q.uid).map((m) => m.uid),
      };
      return fn(client, mailbox);
    },
  };
  return { pool: pool as unknown as ImapPool, lanes };
}

function setup(folders: Record<string, number>, config: Partial<CacheConfig> = {}) {
  const k = new Keyring(crypto.randomBytes(48).toString('base64'));
  const cache = new MailCache(':memory:', { cacheKey: k.cacheKey, indexKey: k.cacheIndexKey });
  const { pool, lanes } = fakePool(folders);
  const changed: string[] = [];
  const sync = new CacheSync({
    cache,
    pool,
    config: { messagesPerFolder: 2000, messagesPerOtherFolder: 500, maxBodyBytes: 0, bodyBytesPerAccount: 0, ...config },
    sentFolder: async () => 'Sent',
    cacheableFolders: async () => Object.keys(folders),
    isWatched: () => false,
    onChanged: (_u, _a, f) => changed.push(f),
  });
  return { cache, sync, lanes, changed };
}

const settle = async (sync: CacheSync) => {
  // The warm-up starts once the Sent folder is known; give it a few turns, then wait for the syncs.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await sync.idle();
  }
};

describe('filling the cache of every folder', () => {
  it('caches every folder of a mailbox in the background, the others on their own connection', async () => {
    const { cache, sync, lanes } = setup({ INBOX: 30, Sent: 10, Archive: 700, Junk: 3, Empty: 0 });
    sync.syncAccount('u1', 'a1');
    await settle(sync);
    const folders = Object.fromEntries(cache.folders('u1', 'a1').map((f) => [f.path, f]));
    expect(Object.keys(folders).sort()).toEqual(['Archive', 'Empty', 'INBOX', 'Junk', 'Sent']);
    expect(folders.INBOX!.role).toBe('inbox');
    expect(folders.Sent!.role).toBe('sent');
    expect(folders.Archive!.role).toBe('folder');
    // Other folders keep their own (smaller) number of the newest messages.
    expect(cache.count(folders.Archive!)).toBe(500);
    expect(cache.count(folders.Junk!)).toBe(3);
    expect(cache.page(folders.Archive!, null, 1, false)[0]!.summary.subject).toBe('Archive 700');
    expect(lanes.filter((l) => ['Archive', 'Junk', 'Empty'].includes(l.path)).every((l) => l.lane === 'sync')).toBe(true);
    expect(lanes.filter((l) => ['INBOX', 'Sent'].includes(l.path)).every((l) => l.lane === 'main')).toBe(true);
    // A listing waiting for a folder checks it on the main connection, not behind the filling.
    lanes.length = 0;
    await sync.beforeListing('u1', 'a1', ['Archive']);
    expect(lanes.filter((l) => l.path === 'Archive')[0]).toEqual({ path: 'Archive', lane: 'main' });
    sync.stop();
    cache.close();
  });

  it('drops folders that are gone from the server and skips recently synced ones', async () => {
    const folders: Record<string, number> = { INBOX: 1, Sent: 1, Old: 5, Kept: 5 };
    const { cache, sync, lanes } = setup(folders);
    sync.syncAccount('u1', 'a1');
    await settle(sync);
    delete folders.Old;
    lanes.length = 0;
    sync.syncAccount('u1', 'a1');
    await settle(sync);
    expect(cache.folders('u1', 'a1', 'folder').map((f) => f.path)).toEqual(['Kept']);
    // Kept was synced a moment ago: the warm-up leaves it alone.
    expect(lanes.some((l) => l.path === 'Kept')).toBe(false);
    sync.stop();
    cache.close();
  });

  it('starts caching a folder as soon as it is opened, and can be switched off', async () => {
    const on = setup({ INBOX: 1, Projects: 4 });
    on.sync.startFolder('u1', 'a1', 'Projects');
    await settle(on.sync);
    expect(on.cache.folder('u1', 'a1', 'Projects')?.role).toBe('folder');
    on.sync.stop();

    const off = setup({ INBOX: 1, Sent: 1, Projects: 4 }, { messagesPerOtherFolder: 0 });
    off.sync.syncAccount('u1', 'a1');
    off.sync.startFolder('u1', 'a1', 'Projects');
    await settle(off.sync);
    expect(off.cache.folders('u1', 'a1').map((f) => f.path).sort()).toEqual(['INBOX', 'Sent']);
    off.sync.stop();
  });
});
