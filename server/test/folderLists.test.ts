// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountFolders } from '../../shared/types.js';
import { MailCache } from '../src/cache/store.js';
import { Keyring } from '../src/crypto.js';
import { MailService } from '../src/imap/mail.js';
import type { ImapPool } from '../src/imap/pool.js';

const keys = new Keyring(crypto.randomBytes(48).toString('base64'));
const cacheKeys = { cacheKey: keys.cacheKey, indexKey: keys.cacheIndexKey };
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A mail server whose folder list (and unread count) the test controls; counts the fetches. */
function fakePool() {
  const state = { unread: 3, calls: 0, delay: 0 };
  const pool = {
    folders: async () => {
      state.calls++;
      if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
      return [{ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', flags: new Set<string>(), specialUse: '\\Inbox', status: { unseen: state.unread, messages: 10 } }];
    },
  } as unknown as ImapPool;
  return { pool, state };
}
const deps = (cache: MailCache) => ({ cache, sync: {} as never, maxBodyBytes: 0, bodyBytesPerAccount: 0 });

describe('folder lists', () => {
  it('are kept in the encrypted cache and shown at once after a restart, then refreshed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fl-'));
    dirs.push(dir);
    const file = path.join(dir, 'cache.db');
    const { pool, state } = fakePool();

    const first = new MailService(pool, deps(new MailCache(file, cacheKeys)));
    const fresh = await first.listFolders('u1', 'a1');
    expect(fresh.folders[0]!.unread).toBe(3);
    expect(fresh.refreshing).toBeUndefined();
    // The file holds no readable folder names.
    expect(fs.readFileSync(file).includes(Buffer.from('"INBOX"'))).toBe(false);

    // "Restart" a minute later: a new service over the same cache file; the mail server is slow now.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    state.unread = 5;
    state.delay = 200;
    const cache = new MailCache(file, cacheKeys);
    const second = new MailService(pool, deps(cache));
    const started = Date.now();
    const instant = await second.listFolders('u1', 'a1');
    expect(Date.now() - started).toBeLessThan(150);
    expect(instant).toMatchObject({ refreshing: true });
    expect(instant.folders[0]!.unread).toBe(3); // the remembered list
    await new Promise((r) => setTimeout(r, 300));
    const after = (await second.listFolders('u1', 'a1')) as AccountFolders;
    expect(after.folders[0]!.unread).toBe(5);
    expect(after.refreshing).toBeUndefined();

    // New mail marks it out of date; the background refresh brings it up to date.
    state.unread = 6;
    state.delay = 0;
    second.foldersChanged('u1', 'a1');
    await second.refreshFolders('u1', 'a1');
    expect((await second.listFolders('u1', 'a1')).folders[0]!.unread).toBe(6);

    // Removing the mailbox forgets its list.
    cache.dropAccount('u1', 'a1');
    expect(cache.folderList('u1', 'a1')).toBeNull();
  });

  it('only one fetch at a time per mailbox, and none while the list is fresh', async () => {
    const { pool, state } = fakePool();
    const svc = new MailService(pool, null);
    await Promise.all([svc.listFolders('u', 'a'), svc.listFolders('u', 'a'), svc.listFolders('u', 'a')]);
    expect(state.calls).toBe(1);
    await svc.listFolders('u', 'a');
    await svc.refreshFolders('u', 'a');
    expect(state.calls).toBe(1);
  });
});
