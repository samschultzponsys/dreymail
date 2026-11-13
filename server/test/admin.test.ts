// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminUser, AuthMethods, LoginSettingsInput, LoginSettingsView, Me } from '../../shared/types.js';
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

async function start(env: Record<string, string> = {}) {
  const config = loadConfig({ RATATOSKR_SECRET_KEY: secret, ...env });
  const store = new Store(':memory:', new Keyring(secret).credentialKey);
  ctx = await buildApp(config, { store, logger: false });
  return store;
}

async function register(username: string) {
  const res = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username, password: 'a long password' }, headers: { 'x-ratatoskr': '1' } });
  expect(res.statusCode).toBe(200);
  return `rk_session=${res.cookies.find((c) => c.name === 'rk_session')!.value}`;
}

async function call<T>(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await ctx!.app.inject({ method, url, payload: payload as object, headers: { cookie, 'x-ratatoskr': '1' } });
  return { status: res.statusCode, json: (res.body ? JSON.parse(res.body) : null) as T };
}

const loginInput = (over: Partial<LoginSettingsInput> = {}): LoginSettingsInput => ({
  oidcEnabled: false,
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  clearClientSecret: false,
  scopes: '',
  label: '',
  passwordLogin: true,
  registration: 'open',
  ...over,
});

describe('administrators', () => {
  it('the first user is the administrator; later ones are not', async () => {
    await start({ RATATOSKR_REGISTRATION: 'open' });
    const sam = await register('sam');
    const eve = await register('eve');
    expect((await call<Me>(sam, 'GET', '/api/me')).json.admin).toBe(true);
    expect((await call<Me>(eve, 'GET', '/api/me')).json.admin).toBe(false);
    expect((await call(eve, 'GET', '/api/admin/users')).status).toBe(403);
    expect((await call(eve, 'GET', '/api/admin/login')).status).toBe(403);
  });

  it('DREYMAIL_ADMIN_USERS makes users administrators', async () => {
    await start({ DREYMAIL_ADMIN_USERS: 'Eve, someone@example.com', RATATOSKR_REGISTRATION: 'open' });
    await register('sam');
    const eve = await register('eve');
    expect((await call<Me>(eve, 'GET', '/api/me')).json.admin).toBe(true);
    const users = (await call<AdminUser[]>(eve, 'GET', '/api/admin/users')).json;
    expect(users.find((u) => u.username === 'eve')).toMatchObject({ admin: true, adminByEnv: true });
  });

  it('add a user, make them admin, reset their password, remove them', async () => {
    await start();
    const sam = await register('sam');
    let res = await call<AdminUser[]>(sam, 'POST', '/api/admin/users', { username: 'alice', password: 'another long password' });
    expect(res.status).toBe(200);
    const alice = res.json.find((u) => u.username === 'alice')!;
    expect(alice).toMatchObject({ login: 'password', admin: false, accounts: 0 });
    expect((await call(sam, 'POST', '/api/admin/users', { username: 'alice', password: 'another long password' })).status).toBe(409);
    res = await call<AdminUser[]>(sam, 'PATCH', `/api/admin/users/${alice.id}`, { admin: true, password: 'a brand new password' });
    expect(res.json.find((u) => u.id === alice.id)!.admin).toBe(true);
    const login = await ctx!.app.inject({ method: 'POST', url: '/auth/password/login', payload: { username: 'alice', password: 'a brand new password' }, headers: { 'x-ratatoskr': '1' } });
    expect(login.statusCode).toBe(200);
    res = await call<AdminUser[]>(sam, 'DELETE', `/api/admin/users/${alice.id}`);
    expect(res.json.map((u) => u.username)).toEqual(['sam']);
  });

  it("can't remove yourself or your own admin rights", async () => {
    await start();
    const sam = await register('sam');
    const me = (await call<Me>(sam, 'GET', '/api/me')).json;
    expect((await call(sam, 'DELETE', `/api/admin/users/${me.id}`)).status).toBe(400);
    expect((await call(sam, 'PATCH', `/api/admin/users/${me.id}`, { admin: false })).status).toBe(400);
  });
});

describe('sign-in settings in the UI', () => {
  it('turning OIDC on in the UI shows it on the login page; the secret is never sent back', async () => {
    await start();
    const sam = await register('sam');
    const res = await call<LoginSettingsView>(sam, 'PUT', '/api/admin/login', loginInput({
      oidcEnabled: true, issuerUrl: 'https://auth.example.com/', clientId: 'dreymail', clientSecret: 'top-secret', label: 'Authentik',
    }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ oidcEnabled: true, issuerUrl: 'https://auth.example.com/', hasClientSecret: true, label: 'Authentik' });
    expect(JSON.stringify(res.json)).not.toContain('top-secret');
    const methods = (await ctx!.app.inject({ method: 'GET', url: '/auth/methods' })).json() as AuthMethods;
    expect(methods.oidc).toEqual({ label: 'Authentik' });
    // A blank secret keeps the stored one.
    const again = await call<LoginSettingsView>(sam, 'PUT', '/api/admin/login', loginInput({ oidcEnabled: true, issuerUrl: 'https://auth.example.com/', clientId: 'dreymail' }));
    expect(again.json.hasClientSecret).toBe(true);
  });

  it('environment variables override the UI and show as locked', async () => {
    await start({ OIDC_ISSUER_URL: 'https://env.example.com/', OIDC_CLIENT_ID: 'from-env', RATATOSKR_PASSWORD_LOGIN: 'true' });
    const sam = await register('sam');
    const res = await call<LoginSettingsView>(sam, 'PUT', '/api/admin/login', loginInput({ oidcEnabled: false, issuerUrl: 'https://ui.example.com/', clientId: 'from-ui' }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ oidcEnabled: true, issuerUrl: 'https://env.example.com/', clientId: 'from-env' });
    expect(res.json.locked).toMatchObject({ issuerUrl: 'OIDC_ISSUER_URL', clientId: 'OIDC_CLIENT_ID', oidcEnabled: 'OIDC_ISSUER_URL', passwordLogin: 'RATATOSKR_PASSWORD_LOGIN' });
  });

  it('refuses to lock everyone out, or the admin who signed in with a password', async () => {
    await start();
    const sam = await register('sam');
    expect((await call(sam, 'PUT', '/api/admin/login', loginInput({ passwordLogin: false }))).status).toBe(400);
    const r = await call<{ error: string }>(sam, 'PUT', '/api/admin/login', loginInput({ passwordLogin: false, oidcEnabled: true, issuerUrl: 'https://auth.example.com/', clientId: 'x' }));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/signed in with a password/);
    expect((await call(sam, 'PUT', '/api/admin/login', loginInput({ oidcEnabled: true, issuerUrl: 'not a url', clientId: 'x' }))).status).toBe(400);
  });

  it('closing registration in the UI stops sign-ups', async () => {
    await start();
    const sam = await register('sam');
    await call(sam, 'PUT', '/api/admin/login', loginInput({ registration: 'open' }));
    await register('eve');
    await call(sam, 'PUT', '/api/admin/login', loginInput({ registration: 'closed' }));
    const res = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'eve', password: 'a long password' }, headers: { 'x-ratatoskr': '1' } });
    expect(res.statusCode).toBe(403);
  });
});
