// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isMailboxIcon, MAILBOX_ICONS } from '../../shared/mailboxIcons.js';
import type { AccountInput } from '../../shared/types.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

describe('mailbox icons', () => {
  it('every icon is one plain path the service worker and Android accept', () => {
    const entries = Object.entries(MAILBOX_ICONS);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    for (const [key, { label, path }] of entries) {
      expect(key).toMatch(/^[a-z0-9-]+$/);
      expect(label.length).toBeGreaterThan(0);
      // The same check web/public/sw.js makes before drawing.
      expect(path).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
      expect(path.length).toBeLessThan(4000);
      // Joined shapes never start relative to the previous one.
      expect(path).not.toMatch(/^m/);
    }
  });

  it('only known keys count', () => {
    expect(isMailboxIcon('briefcase')).toBe(true);
    expect(isMailboxIcon('toString')).toBe(false);
    expect(isMailboxIcon('<svg>')).toBe(false);
    expect(isMailboxIcon(undefined)).toBe(false);
  });

  it('is stored per mailbox and listed with it', () => {
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const sam = store.upsertUser('local', 'sam', '', 'Sam');
    const input: AccountInput = {
      name: 'Work',
      displayName: 'Sam',
      email: 'sam@example.com',
      color: '#ef4444',
      imap: { host: 'h', port: 993, tls: 'tls', user: 'u', password: 'p' },
      smtp: { host: 'h', port: 465, tls: 'tls', user: 'u', password: 'p' },
      appendSent: true,
    };
    const a = store.createAccount(sam.id, input);
    expect(a.icon).toBe('');
    store.setAccountIcon(sam.id, a.id, 'briefcase');
    expect(store.listAccounts(sam.id)[0]!.icon).toBe('briefcase');
    // Someone else can't change it.
    const eve = store.upsertUser('local', 'eve', '', 'Eve');
    store.setAccountIcon(eve.id, a.id, 'dog');
    expect(store.listAccounts(sam.id)[0]!.icon).toBe('briefcase');
  });
});

describe('uploaded mailbox pictures', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('upload makes it the icon; it can be shown, switched away from and removed', async () => {
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const secret = crypto.randomBytes(48).toString('base64');
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    const ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret }), { store, logger: false });
    try {
      const reg = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
      const cookie = `dm_session=${reg.cookies.find((c) => c.name === 'dm_session')!.value}`;
      const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object) => ctx.app.inject({ method, url, payload, headers: { cookie, 'x-dreymail': '1' } });
      const me = store.listUsers()[0]!;
      const a = store.createAccount(me.id, {
        name: 'Work', displayName: 'Sam', email: 'sam@example.com', color: '#ef4444',
        imap: { host: 'h', port: 993, tls: 'tls', user: 'u', password: 'p' },
        smtp: { host: 'h', port: 465, tls: 'tls', user: 'u', password: 'p' },
        appendSent: true,
      });
      expect((await call('PUT', `/api/accounts/${a.id}/icon`, { image: 'data:image/png;base64,AAAA' })).statusCode).toBe(400);
      const up = (await call('PUT', `/api/accounts/${a.id}/icon`, { image: PNG })).json() as { icon: string; iconImage: string };
      expect(up.icon).toBe('image');
      expect(up.iconImage).toMatch(new RegExp(`^/api/accounts/${a.id}/icon\\?v=\\d+$`));
      const img = await call('GET', up.iconImage);
      expect(img.headers['content-type']).toBe('image/png');
      // Picking a built-in icon keeps the picture for later.
      store.setAccountIcon(me.id, a.id, 'dog');
      expect(store.listAccounts(me.id)[0]).toMatchObject({ icon: 'dog', iconImage: up.iconImage });
      // Removing the picture while it's in use falls back to no icon; otherwise the icon stays.
      store.setAccountIcon(me.id, a.id, 'image');
      const gone = (await call('DELETE', `/api/accounts/${a.id}/icon`)).json() as { icon: string; iconImage: string | null };
      expect(gone).toMatchObject({ icon: '', iconImage: null });
      expect((await call('GET', `/api/accounts/${a.id}/icon`)).statusCode).toBe(404);
      expect((await call('PUT', '/api/accounts/nope/icon', { image: PNG })).statusCode).toBe(404);
    } finally {
      await ctx.app.close();
    }
  });
});
