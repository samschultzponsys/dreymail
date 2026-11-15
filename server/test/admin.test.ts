// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminUser, AuthMethods, LoginSettingsInput, LoginSettingsView, Me } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { ALL_PERMISSIONS, type Role } from '../../shared/permissions.js';

/** A 1×1 PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const secret = crypto.randomBytes(48).toString('base64');
let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

async function start(env: Record<string, string> = {}) {
  const config = loadConfig({ DREYMAIL_SECRET_KEY: secret, ...env });
  const store = new Store(':memory:', new Keyring(secret).credentialKey);
  ctx = await buildApp(config, { store, logger: false });
  return store;
}

async function register(username: string) {
  const res = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username, password: 'a long password' }, headers: { 'x-dreymail': '1' } });
  expect(res.statusCode).toBe(200);
  return `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`;
}

async function call<T>(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await ctx!.app.inject({ method, url, payload: payload as object, headers: { cookie, 'x-dreymail': '1' } });
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

const perms = async (cookie: string) => (await call<Me>(cookie, 'GET', '/api/me')).json;

describe('roles and permissions', () => {

  it('the first user is Superadmin with every right; later ones get the User role', async () => {
    await start({ DREYMAIL_REGISTRATION: 'open' });
    const sam = await register('sam');
    const eve = await register('eve');
    expect((await perms(sam)).role.id).toBe('superadmin');
    expect((await perms(sam)).permissions).toEqual(ALL_PERMISSIONS);
    expect(await perms(eve)).toMatchObject({ role: { id: 'user', name: 'User' }, permissions: ['mail.accounts', 'profile.picture'] });
    for (const url of ['/api/admin/users', '/api/admin/login', '/api/admin/roles', '/api/admin/firebase', '/api/admin/google', '/api/admin/microsoft']) {
      expect((await call(eve, 'GET', url)).status).toBe(403);
    }
  });

  it('DREYMAIL_ADMIN_USERS makes users Superadmins', async () => {
    await start({ DREYMAIL_ADMIN_USERS: 'Eve, someone@example.com', DREYMAIL_REGISTRATION: 'open' });
    await register('sam');
    const eve = await register('eve');
    expect((await perms(eve)).role.id).toBe('superadmin');
    const users = (await call<AdminUser[]>(eve, 'GET', '/api/admin/users')).json;
    expect(users.find((u) => u.username === 'eve')).toMatchObject({ roleId: 'superadmin', adminByEnv: true });
  });

  it('add a user with a role, reset their password, remove them', async () => {
    await start();
    const sam = await register('sam');
    let res = await call<AdminUser[]>(sam, 'POST', '/api/admin/users', { username: 'alice', password: 'another long password' });
    expect(res.status).toBe(200);
    const alice = res.json.find((u) => u.username === 'alice')!;
    expect(alice).toMatchObject({ login: 'password', roleId: 'user', accounts: 0 });
    expect((await call(sam, 'POST', '/api/admin/users', { username: 'alice', password: 'another long password' })).status).toBe(409);
    res = await call<AdminUser[]>(sam, 'PATCH', `/api/admin/users/${alice.id}`, { roleId: 'superadmin', password: 'a brand new password' });
    expect(res.json.find((u) => u.id === alice.id)!.roleId).toBe('superadmin');
    const login = await ctx!.app.inject({ method: 'POST', url: '/auth/password/login', payload: { username: 'alice', password: 'a brand new password' }, headers: { 'x-dreymail': '1' } });
    expect(login.statusCode).toBe(200);
    res = await call<AdminUser[]>(sam, 'DELETE', `/api/admin/users/${alice.id}`);
    expect(res.json.map((u) => u.username)).toEqual(['sam']);
  });

  it("can't remove yourself, change your own role, or leave no Superadmin", async () => {
    await start();
    const sam = await register('sam');
    const me = await perms(sam);
    expect((await call(sam, 'DELETE', `/api/admin/users/${me.id}`)).status).toBe(400);
    expect((await call(sam, 'PATCH', `/api/admin/users/${me.id}`, { roleId: 'user' })).status).toBe(400);
  });

  it('custom roles: flags take effect, nobody can grant more than they have', async () => {
    const store = await start({ DREYMAIL_REGISTRATION: 'open' });
    const sam = await register('sam');
    const eve = await register('eve');
    const eveId = (await perms(eve)).id;
    // A user manager: may add/remove users and give roles, nothing else.
    let roles = await call<{ roles: Role[] }>(sam, 'POST', '/api/admin/roles', { name: 'User manager', permissions: ['users.manage', 'roles.manage', 'bogus'] });
    const mgr = roles.json.roles.find((r) => r.name === 'User manager')!;
    expect(mgr.permissions).toEqual(['users.manage', 'roles.manage']);
    await call(sam, 'PATCH', `/api/admin/users/${eveId}`, { roleId: mgr.id });
    expect((await perms(eve)).permissions).toEqual(['users.manage', 'roles.manage']);
    expect((await call(eve, 'GET', '/api/admin/users')).status).toBe(200);
    expect((await call(eve, 'GET', '/api/admin/login')).status).toBe(403);
    // No mailbox rights in this role.
    expect((await call(eve, 'DELETE', '/api/accounts/x')).status).toBe(403);
    // Escalation attempts.
    const samId = (await perms(sam)).id;
    expect((await call(eve, 'POST', '/api/admin/roles', { name: 'Sneaky', permissions: ['signin.manage'] })).status).toBe(400);
    expect((await call(eve, 'PATCH', `/api/admin/users/${eveId}`, { roleId: 'superadmin' })).status).toBe(400);
    expect((await call(eve, 'PATCH', `/api/admin/users/${samId}`, { roleId: 'user' })).status).toBe(400);
    expect((await call(eve, 'DELETE', `/api/admin/users/${samId}`)).status).toBe(400);
    expect((await call(eve, 'PUT', '/api/admin/roles/superadmin', { name: 'x', permissions: [] })).status).toBe(400);
    // Deleting the role moves its users to the default role.
    roles = await call<{ roles: Role[] }>(sam, 'DELETE', `/api/admin/roles/${mgr.id}`);
    expect(roles.json.roles.map((r) => r.id)).toEqual(['superadmin', 'user']);
    expect(store.getUser(eveId)!.roleId).toBe('user');
    expect((await call(sam, 'DELETE', '/api/admin/roles/user')).status).toBe(400);
  });

  it('the default role is what new users get', async () => {
    await start({ DREYMAIL_REGISTRATION: 'open' });
    const sam = await register('sam');
    const r = await call<{ roles: Role[] }>(sam, 'POST', '/api/admin/roles', { name: 'Reader', permissions: [] });
    const reader = r.json.roles.find((x) => x.name === 'Reader')!;
    expect((await call(sam, 'PUT', '/api/admin/roles-default', { roleId: 'superadmin' })).status).toBe(400);
    expect((await call<{ defaultRole: string }>(sam, 'PUT', '/api/admin/roles-default', { roleId: reader.id })).json.defaultRole).toBe(reader.id);
    const eve = await register('eve');
    expect(await perms(eve)).toMatchObject({ role: { id: reader.id, name: 'Reader' }, permissions: [] });
    expect((await call(eve, 'PUT', '/api/me/picture', { image: PNG })).status).toBe(403);
  });
});

describe('profile pictures', () => {
  it('upload, show, remove; Gravatar can be turned off', async () => {
    await start({ DREYMAIL_REGISTRATION: 'open' });
    const sam = await register('sam');
    expect((await call(sam, 'PUT', '/api/me/picture', { image: 'data:image/png;base64,AAAA' })).status).toBe(400);
    expect((await call(sam, 'PUT', '/api/me/picture', { image: PNG.replace('image/png', 'image/jpeg') })).status).toBe(400);
    const up = await call<{ avatar: string }>(sam, 'PUT', '/api/me/picture', { image: PNG });
    expect(up.json.avatar).toMatch(/^\/api\/users\/[\w-]+\/picture\?v=\d+$/);
    const img = await ctx!.app.inject({ method: 'GET', url: up.json.avatar, headers: { cookie: sam } });
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect((await perms(sam)).hasPicture).toBe(true);
    await call(sam, 'DELETE', '/api/me/picture');
    // A password user without a mailbox has no address for Gravatar: initials.
    expect((await perms(sam)).avatar).toBeNull();
    await call(sam, 'PUT', '/api/me/gravatar', { on: false });
    expect((await perms(sam)).gravatar).toBe(false);
  });

  it("only users.pictures may change someone else's", async () => {
    await start({ DREYMAIL_REGISTRATION: 'open' });
    const sam = await register('sam');
    const eve = await register('eve');
    const samId = (await perms(sam)).id;
    const eveId = (await perms(eve)).id;
    expect((await call(eve, 'PUT', `/api/admin/users/${samId}/picture`, { image: PNG })).status).toBe(403);
    const res = await call<AdminUser[]>(sam, 'PUT', `/api/admin/users/${eveId}/picture`, { image: PNG });
    expect(res.json.find((u) => u.id === eveId)!.hasPicture).toBe(true);
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
    await start({ OIDC_ISSUER_URL: 'https://env.example.com/', OIDC_CLIENT_ID: 'from-env', DREYMAIL_PASSWORD_LOGIN: 'true' });
    const sam = await register('sam');
    const res = await call<LoginSettingsView>(sam, 'PUT', '/api/admin/login', loginInput({ oidcEnabled: false, issuerUrl: 'https://ui.example.com/', clientId: 'from-ui' }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ oidcEnabled: true, issuerUrl: 'https://env.example.com/', clientId: 'from-env' });
    expect(res.json.locked).toMatchObject({ issuerUrl: 'OIDC_ISSUER_URL', clientId: 'OIDC_CLIENT_ID', oidcEnabled: 'OIDC_ISSUER_URL', passwordLogin: 'DREYMAIL_PASSWORD_LOGIN' });
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
    const res = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'eve', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('upgrading to roles', () => {
  it('administrators of an older database become Superadmins, everyone else Users', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-roles-'));
    const file = path.join(dir, 'dreymail.db');
    const key = new Keyring(secret).credentialKey;
    let store = new Store(file, key);
    const sam = store.upsertUser('local', 'sam', '', 'Sam');
    const eve = store.upsertUser('local', 'eve', '', 'Eve');
    store.close();
    // Back to the database as 2.4 left it: admin flag, no role column.
    const db = new DatabaseSync(file);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    db.exec(`UPDATE users SET is_admin = (id = '${sam.id}'); ALTER TABLE users DROP COLUMN role_id; DROP TABLE roles; PRAGMA user_version = ${version - 1};`);
    db.close();
    store = new Store(file, key);
    expect(store.getUser(sam.id)!.roleId).toBe('superadmin');
    expect(store.getUser(eve.id)!.roleId).toBe('user');
    expect(store.listRoles().map((r) => r.name)).toEqual(['Superadmin', 'User']);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
