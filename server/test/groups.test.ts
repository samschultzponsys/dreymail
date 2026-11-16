// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountView, MailboxGroupView } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const secret = crypto.randomBytes(48).toString('base64');
let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

const acct = (store: Store, userId: string, name: string, color: string) =>
  store.createAccount(userId, {
    name,
    displayName: 'Sam',
    email: `${name}@example.com`,
    color,
    imap: { host: 'imap.example.com', port: 993, tls: 'tls', user: name, password: 'x' },
    smtp: { host: 'smtp.example.com', port: 465, tls: 'tls', user: name, password: 'x' },
    appendSent: true,
  });

describe('mailbox groups', () => {
  it('group mailboxes, share a color and icon, and switch notifications for all of them', async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com', DREYMAIL_REGISTRATION: 'open' }), { store, logger: false, cacheFile: null });
    const reg = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
    const headers = { cookie: `dm_session=${reg.cookies.find((c) => c.name === 'dm_session')!.value}`, 'x-dreymail': '1' };
    const userId = store.listUsers()[0]!.id;
    const work = acct(store, userId, 'work', '#3b82f6');
    const side = acct(store, userId, 'side', '#ef4444');
    const home = acct(store, userId, 'home', '#10b981');

    const made = await ctx.app.inject({ method: 'POST', url: '/api/groups', headers, payload: { name: 'Work', color: '#8b5cf6', icon: 'briefcase', notify: false, follow: true, accountIds: [work.id, side.id, 'not-mine'] } });
    expect(made.statusCode).toBe(200);
    const [group] = made.json() as MailboxGroupView[];
    expect(group).toMatchObject({ name: 'Work', accountIds: [work.id, side.id], notify: false });
    // Members took the group's color and icon; the other mailbox kept its own.
    const accounts = (await ctx.app.inject({ method: 'GET', url: '/api/accounts', headers })).json() as AccountView[];
    const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
    expect(byId[work.id]).toMatchObject({ color: '#8b5cf6', icon: 'briefcase', groupId: group!.id });
    expect(byId[home.id]).toMatchObject({ color: '#10b981', groupId: null });
    // Notifications follow the group.
    expect(store.notifiesFor(userId, work.id)).toBe(false);
    expect(store.notifiesFor(userId, home.id)).toBe(true);

    // Without "follow", a member keeps its own look; moving mailboxes out works.
    await ctx.app.inject({ method: 'PUT', url: `/api/groups/${group!.id}`, headers, payload: { name: 'Work', color: '#000000', icon: '', notify: true, follow: false, accountIds: [work.id] } });
    const after = Object.fromEntries(((await ctx.app.inject({ method: 'GET', url: '/api/accounts', headers })).json() as AccountView[]).map((a) => [a.id, a]));
    expect(after[work.id]!.color).toBe('#8b5cf6');
    expect(after[side.id]!.groupId).toBeNull();
    expect(store.notifiesFor(userId, work.id)).toBe(true);

    // Deleting the group keeps its mailboxes.
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/groups/${group!.id}`, headers })).json()).toEqual([]);
    expect(store.listAccounts(userId)).toHaveLength(3);
    expect(store.listAccounts(userId).every((a) => !a.groupId)).toBe(true);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/groups', headers, payload: { name: '', color: '#000000', icon: '', notify: true, follow: true, accountIds: [] } })).statusCode).toBe(400);
  });
});
