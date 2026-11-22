// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The search index in the mail cache (12.3): words, keyed hashes, filling it in the background,
// and each mailbox's share of the user's space.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../shared/types.js';
import { cacheShares } from '../src/cacheBudget.js';
import { queryTerms, stem, termsOf } from '../src/cache/searchTerms.js';
import { MailCache, type CachedFolder } from '../src/cache/store.js';
import { CacheSync } from '../src/cache/sync.js';
import { Keyring } from '../src/crypto.js';
import type { ImapPool } from '../src/imap/pool.js';

const keys = () => {
  const k = new Keyring(crypto.randomBytes(48).toString('base64'));
  return { cacheKey: k.cacheKey, indexKey: k.cacheIndexKey };
};

function summary(f: CachedFolder, uid: number, subject: string, seen = false): MessageSummary {
  return {
    accountId: f.accountId,
    folder: f.path,
    uid,
    uidValidity: f.uidValidity,
    messageId: `<m${uid}@example.com>`,
    inReplyTo: null,
    references: [],
    subject,
    from: [{ name: 'Dylan Feenker', address: 'dylan@ponsys.example' }],
    to: [{ name: '', address: 'sam@example.com' }],
    date: new Date(Date.UTC(2026, 0, 1) + uid * 60_000).toISOString(),
    snippet: '',
    seen,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 1000,
  };
}

describe('search words', () => {
  it('lowercases, drops accents and simple endings', () => {
    expect(stem('printers')).toBe('printer');
    expect(stem('printing')).toBe('print');
    expect(stem('tickets')).toBe('ticket');
    expect(stem('boxes')).toBe('box');
    expect(stem('status')).toBe('status');
    expect([...termsOf('Café Printers — Ticket #91993, BOH back-up!')]).toEqual(['cafe', 'printer', 'ticket', '91993', 'boh', 'back', 'up']);
    expect(queryTerms('Thermal PRINTERS')).toEqual(['thermal', 'printer']);
    expect(queryTerms('!!')).toEqual([]);
  });
});

describe('the index in the cache', () => {
  it('finds messages by their headers at once and by their content once indexed, without storing the words', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-index-'));
    try {
      const file = path.join(dir, 'cache.db');
      const cache = new MailCache(file, keys());
      const f = cache.resetFolder('u1', 'a1', 'INBOX', 'inbox', '7');
      cache.updateFolder(f, { lowUid: 1, uidNext: 4, complete: true, syncedAt: Date.now() });
      const put = (s: MessageSummary) => cache.putMessages(f, [{ summary: s, sortTime: Date.parse(s.date), internalDate: s.date }]);
      put(summary(f, 1, 'BOH back up thermal printer'));
      put(summary(f, 2, 'Lunch on Friday', true));
      put(summary(f, 3, 'Re: printer quote'));
      expect(cache.search(f, ['printer'], null, 10).map((m) => m.summary.uid)).toEqual([3, 1]);
      expect(cache.search(f, ['printer', 'thermal'], null, 10).map((m) => m.summary.uid)).toEqual([1]);
      expect(cache.search(f, ['feenker'], null, 10)).toHaveLength(3); // the sender's name
      expect(cache.search(f, ['zebra'], null, 10)).toHaveLength(0);
      // Content: once indexed.
      expect(cache.indexState(f)).toEqual({ messages: 3, indexed: 0 });
      cache.indexBody(f, 2, 'The tip adjustments for checks 30004 and 30001 are done.');
      expect(cache.search(f, ['tip', '30004'], null, 10).map((m) => m.summary.uid)).toEqual([2]);
      expect(cache.search(f, ['tip'], null, 10, true)).toHaveLength(0); // unread only: 2 is read
      expect(cache.indexState(f)).toEqual({ messages: 3, indexed: 1 });
      // Paging: below a UID.
      expect(cache.search(f, ['printer'], 3, 10).map((m) => m.summary.uid)).toEqual([1]);
      const used = cache.accountBytes('u1', 'a1');
      expect(used.index).toBeGreaterThan(0);
      expect(used.count).toBe(3);
      cache.close();
      // Nothing readable in the file: not the words, not the subjects.
      const bytes = fs.readFileSync(file).toString('latin1') + (fs.existsSync(`${file}-wal`) ? fs.readFileSync(`${file}-wal`).toString('latin1') : '');
      for (const w of ['thermal', 'printer', 'adjustments', 'Feenker']) expect(bytes).not.toContain(w);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('filling the index', () => {
  function setup(n: number, budget: number) {
    const cache = new MailCache(':memory:', keys());
    const body = (uid: number) => Buffer.from(`Subject: Message ${uid}\r\n\r\nBody word${uid} and the common word quarterly.\r\n`);
    const pool = {
      async withMailbox<T>(_u: string, _a: string, p: string, fn: (client: unknown, mailbox: unknown) => Promise<T>): Promise<T> {
        const mailbox = { path: p, exists: n, uidNext: n + 1, uidValidity: 7n, noModseq: true };
        const msg = (uid: number) => ({ uid, seq: uid, flags: new Set<string>(), envelope: { subject: `Message ${uid}`, from: [{ name: 'A', address: 'a@example.com' }], to: [], date: new Date(2026, 0, 1, 0, uid) }, internalDate: new Date(2026, 0, 1, 0, uid), size: 100 });
        const pick = (range: string) => {
          if (range.includes(',') || !range.includes(':')) return range.split(',').map(Number).filter((u) => u >= 1 && u <= n).map(msg);
          const [lo, hi] = range.split(':');
          const top = hi === '*' ? n : Number(hi);
          return Array.from({ length: n }, (_, i) => msg(i + 1)).filter((m) => m.uid >= Number(lo) && m.uid <= top);
        };
        const client = {
          mailbox,
          enabled: new Set<string>(),
          noop: async () => undefined,
          fetchAll: async (range: string, q: { source?: unknown }) => pick(range).map((m) => (q.source ? { ...m, source: body(m.uid) } : m)),
          search: async (q: { uid: string }) => pick(q.uid).map((m) => m.uid),
        };
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
      budget: () => budget,
      textOf: async (raw) => raw.toString('utf8'),
    });
    return { cache, sync };
  }
  const settle = async (sync: CacheSync, cache: MailCache) => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await sync.idle();
      if (!sync.isIndexing('u1', 'a1')) {
        const f = cache.folder('u1', 'a1', 'INBOX');
        if (f && cache.indexState(f).indexed === cache.indexState(f).messages && cache.indexState(f).messages > 0) return;
      }
    }
  };

  it('reads and indexes every cached message in the background', async () => {
    const { cache, sync } = setup(60, 50 * 1024 * 1024);
    sync.syncAccount('u1', 'a1');
    await settle(sync, cache);
    const f = cache.folder('u1', 'a1', 'INBOX')!;
    expect(cache.indexState(f)).toEqual({ messages: 60, indexed: 60 });
    expect(cache.search(f, ['word42'], null, 10).map((m) => m.summary.uid)).toEqual([42]);
    expect(cache.search(f, ['quarterly'], null, 100)).toHaveLength(60);
  });

  it('answers word searches from the index, without the mail server searching', async () => {
    const { cache, sync } = setup(60, 50 * 1024 * 1024);
    sync.syncAccount('u1', 'a1');
    await settle(sync, cache);
    const { MailService } = await import('../src/imap/mail.js');
    const mail = new MailService(((sync as unknown as { deps: { pool: ImapPool } }).deps.pool), { cache, sync, maxBodyBytes: 0, bodyBytesPerAccount: 0 });
    const list = await mail.listMessages('u1', [{ accountId: 'a1', folder: 'INBOX' }], null, 20, { text: 'Word42', unread: false });
    expect(list.errors).toEqual([]);
    expect(list.messages.map((m) => m.uid)).toEqual([42]);
    const common = await mail.listMessages('u1', [{ accountId: 'a1', folder: 'INBOX' }], null, 20, { text: 'quarterly', unread: false });
    expect(common.messages).toHaveLength(20);
    expect(common.cursor).not.toBeNull();
  });

  it('stops where the mailbox has no space left', async () => {
    const { cache, sync } = setup(60, 1);
    sync.syncAccount('u1', 'a1');
    await settle(sync, cache);
    const f = cache.folder('u1', 'a1', 'INBOX')!;
    expect(cache.indexState(f).indexed).toBe(0);
  });
});

describe("each mailbox's share of the space", () => {
  it('is even by default, or as chosen', () => {
    expect([...cacheShares(['a', 'b', 'c', 'd']).values()]).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(Object.fromEntries(cacheShares(['a', 'b'], { mode: 'custom', shares: { a: 75, b: 25 } }))).toEqual({ a: 0.75, b: 0.25 });
    // Proportions, whatever the total; a mailbox not listed gets none; nothing chosen: even.
    expect(Object.fromEntries(cacheShares(['a', 'b', 'c'], { mode: 'custom', shares: { a: 30, b: 30 } }))).toEqual({ a: 0.5, b: 0.5, c: 0 });
    expect(Object.fromEntries(cacheShares(['a', 'b'], { mode: 'custom', shares: {} }))).toEqual({ a: 0.5, b: 0.5 });
  });
});
