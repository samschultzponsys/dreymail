// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageSummary, StorageReport } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

/** A 1×1 PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const secret = crypto.randomBytes(48).toString('base64');
const imap = { host: 'imap.example.com', port: 993, tls: 'tls', user: 'u', password: 'p' };
const smtp = { host: 'smtp.example.com', port: 465, tls: 'tls', user: 'u', password: 'p' };

let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

async function register(username: string) {
  const res = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username, password: 'a long password' }, headers: { 'x-dreymail': '1' } });
  return `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`;
}

async function call<T>(cookie: string, method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await ctx!.app.inject({ method, url, payload: payload as object, headers: { cookie, 'x-dreymail': '1' } });
  return { status: res.statusCode, json: JSON.parse(res.body) as T };
}

function summary(accountId: string, folder: string, uid: number): MessageSummary {
  return {
    accountId, folder, uid, uidValidity: '1', messageId: `<${uid}@example.com>`, inReplyTo: null, references: [],
    subject: `Message ${uid}`, from: { name: 'A', address: 'a@example.com' }, to: [], date: new Date(2026, 0, 1).toISOString(),
    snippet: 'Hello there', seen: false, flagged: false, answered: false, draft: false, hasAttachments: false, size: 100,
  } as unknown as MessageSummary;
}

describe('Settings → Storage', () => {
  it('shows each user their mail cache per mailbox and their own data, to administrators only', async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_REGISTRATION: 'open' }), { store, logger: false });
    const sam = await register('sam');
    const eve = await register('eve');
    expect((await call(eve, 'GET', '/api/admin/storage')).status).toBe(403);

    const eveId = store.listUsers().find((u) => u.username === 'eve')!.id;
    const account = store.createAccount(eveId, { name: 'Work', email: 'eve@example.com', displayName: 'Eve', color: '#22d3ee', imap, smtp, appendSent: true } as never);
    expect((await call(sam, 'PUT', `/api/admin/users/${eveId}/picture`, { image: PNG })).status).toBe(200);
    const cache = ctx.cache!;
    const inbox = cache.resetFolder(eveId, account.id, 'INBOX', 'inbox', '1');
    const archive = cache.resetFolder(eveId, account.id, 'Archive', 'folder', '1');
    cache.putMessages(inbox, [1, 2, 3].map((uid) => ({ summary: summary(account.id, 'INBOX', uid), sortTime: uid, internalDate: null })));
    cache.putMessages(archive, [1].map((uid) => ({ summary: summary(account.id, 'Archive', uid), sortTime: uid, internalDate: null })));
    cache.putBody(inbox, 1, Buffer.alloc(5000, 'x'));

    const { status, json } = await call<StorageReport>(sam, 'GET', '/api/admin/storage');
    expect(status).toBe(200);
    expect(json.cacheEnabled).toBe(true);
    expect(json.files).toEqual([]); // both databases are in memory here
    // Largest first: Eve has the cache and the picture.
    const [first, second] = json.users;
    expect(first!.name).toBe('eve');
    expect(first!.mailboxes).toEqual([
      expect.objectContaining({ accountId: account.id, name: 'Work', email: 'eve@example.com', folders: 2, messages: 4, bodies: 1 }),
    ]);
    expect(first!.mailboxes[0]!.bodyBytes).toBeGreaterThan(5000); // encrypted, so a little more
    expect(first!.mailboxes[0]!.messageBytes).toBeGreaterThan(0);
    expect(first!.database.pictures).toBeGreaterThan(0);
    expect(first!.database.settings).toBeGreaterThan(0); // the user row and the mailbox
    expect(first!.total).toBe(
      first!.mailboxes[0]!.messageBytes + first!.mailboxes[0]!.bodyBytes + Object.values(first!.database).reduce((a, b) => a + b, 0),
    );
    expect(second).toMatchObject({ name: 'sam', mailboxes: [] });
    expect(second!.database.pictures).toBe(0);
  });

  it('clears the mail cache of one mailbox or all of a user, to administrators only', async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_REGISTRATION: 'open' }), { store, logger: false });
    const sam = await register('sam');
    const eve = await register('eve');
    const eveId = store.listUsers().find((u) => u.username === 'eve')!.id;
    const mk = (name: string) => store.createAccount(eveId, { name, email: `${name}@example.com`, displayName: 'Eve', color: '#22d3ee', imap, smtp, appendSent: true } as never);
    const [work, home] = [mk('work'), mk('home')];
    const cache = ctx.cache!;
    for (const a of [work, home]) {
      const f = cache.resetFolder(eveId, a.id, 'INBOX', 'inbox', '1');
      cache.putMessages(f, [{ summary: summary(a.id, 'INBOX', 1), sortTime: 1, internalDate: null }]);
      cache.putFolderList(eveId, a.id, { accountId: a.id, folders: [] });
    }
    // A mailbox removed meanwhile still shows (and can be cleared) until its copy is gone.
    cache.resetFolder(eveId, 'gone', 'INBOX', 'inbox', '1');

    expect((await call(eve, 'DELETE', `/api/admin/users/${eveId}/cache`)).status).toBe(403);
    expect((await call(sam, 'DELETE', '/api/admin/users/nobody/cache')).status).toBe(404);

    let r = await call<StorageReport>(sam, 'DELETE', `/api/admin/users/${eveId}/cache/${work.id}`);
    expect(r.status).toBe(200);
    expect(r.json.users.find((u) => u.id === eveId)!.mailboxes.map((m) => m.name ?? '(removed)').sort()).toEqual(['(removed)', 'home']);
    expect(cache.folderList(eveId, work.id)).toBeNull();
    expect(cache.folderList(eveId, home.id)).not.toBeNull();

    r = await call<StorageReport>(sam, 'DELETE', `/api/admin/users/${eveId}/cache`);
    expect(r.json.users.find((u) => u.id === eveId)!.mailboxes).toEqual([]);
    expect(cache.folders(eveId, home.id)).toEqual([]);
    // Their own data is untouched.
    expect(store.listAccounts(eveId).length).toBe(2);
  });
});
