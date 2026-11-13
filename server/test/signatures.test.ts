// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountInput, Signature } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const secret = crypto.randomBytes(48).toString('base64');
const account = (name: string): AccountInput => ({
  name,
  displayName: 'Sam',
  email: `${name.toLowerCase()}@example.com`,
  color: '#22d3ee',
  imap: { host: 'mail.example.com', port: 993, tls: 'tls', user: 'u', password: 'p' },
  smtp: { host: 'mail.example.com', port: 465, tls: 'tls', user: 'u', password: 'p' },
  appendSent: true,
});

function setup() {
  const store = new Store(':memory:', new Keyring(secret).credentialKey);
  const user = store.upsertUser('local', 'sam', '', 'Sam');
  const other = store.upsertUser('local', 'eve', '', 'Eve');
  const [gmail, purely] = [store.createAccount(user.id, account('Gmail')), store.createAccount(user.id, account('Purely'))];
  const eves = store.createAccount(other.id, account('Eve'));
  return { store, user, other, gmail, purely, eves };
}

describe('signatures in the store', () => {
  it('one signature can be shared by several accounts', () => {
    const { store, user, gmail, purely } = setup();
    const s = store.saveSignature(user.id, null, { name: 'Shared', html: '<p>Sam</p>', accountIds: [gmail.id, purely.id], onReplies: true })!;
    expect(s.accountIds.sort()).toEqual([gmail.id, purely.id].sort());
    expect(store.listSignatures(user.id)).toHaveLength(1);
  });

  it('an account uses one signature at most: ticking it elsewhere moves it', () => {
    const { store, user, gmail, purely } = setup();
    const a = store.saveSignature(user.id, null, { name: 'A', html: 'a', accountIds: [gmail.id, purely.id], onReplies: true })!;
    const b = store.saveSignature(user.id, null, { name: 'B', html: 'b', accountIds: [purely.id], onReplies: false })!;
    const byId = new Map(store.listSignatures(user.id).map((s) => [s.id, s]));
    expect(byId.get(a.id)!.accountIds).toEqual([gmail.id]);
    expect(byId.get(b.id)!.accountIds).toEqual([purely.id]);
    expect(byId.get(b.id)!.onReplies).toBe(false);
  });

  it("ignores other users' accounts and can't touch their signatures", () => {
    const { store, user, other, gmail, eves } = setup();
    const s = store.saveSignature(user.id, null, { name: 'Mine', html: 'x', accountIds: [gmail.id, eves.id], onReplies: true })!;
    expect(s.accountIds).toEqual([gmail.id]);
    expect(store.saveSignature(other.id, s.id, { name: 'Hijack', html: 'y', accountIds: [], onReplies: true })).toBeNull();
    expect(store.deleteSignature(other.id, s.id)).toBe(false);
    expect(store.listSignatures(user.id)[0]!.name).toBe('Mine');
  });

  it('goes away with its account link when the account is deleted, and can be deleted', () => {
    const { store, user, gmail } = setup();
    const s = store.saveSignature(user.id, null, { name: 'S', html: 'x', accountIds: [gmail.id], onReplies: true })!;
    store.deleteAccount(user.id, gmail.id);
    expect(store.listSignatures(user.id)[0]!.accountIds).toEqual([]);
    expect(store.deleteSignature(user.id, s.id)).toBe(true);
    expect(store.listSignatures(user.id)).toEqual([]);
  });
});

describe('signatures over HTTP', () => {
  let ctx: App | null = null;
  afterEach(async () => {
    await ctx?.app.close();
    ctx = null;
  });

  it('sanitizes the HTML before storing it', async () => {
    const config = loadConfig({ RATATOSKR_SECRET_KEY: secret });
    ctx = await buildApp(config, { store: new Store(':memory:', new Keyring(secret).credentialKey), logger: false });
    const reg = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-ratatoskr': '1' } });
    const cookie = `rk_session=${reg.cookies.find((c) => c.name === 'rk_session')!.value}`;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/signatures',
      headers: { cookie, 'x-ratatoskr': '1' },
      payload: { name: 'Evil', html: '<p onclick="x()">Hi<script>alert(1)</script><img src="/api/secret"></p>', accountIds: [], onReplies: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Signature).html).toBe('<p>Hi</p>');
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/signatures', headers: { cookie, 'x-ratatoskr': '1' }, payload: { name: '', html: '', accountIds: [] } });
    expect(bad.statusCode).toBe(400);
  });
});
