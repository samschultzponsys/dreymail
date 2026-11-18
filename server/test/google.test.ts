// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountView, GoogleSettingsView } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import type { FetchLike } from '../src/oauth/microsoft.js';

const secret = crypto.randomBytes(48).toString('base64');
const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

function fakeGoogle(scope?: string) {
  const seen: URLSearchParams[] = [];
  let n = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    const p = new URLSearchParams(init.body ?? '');
    seen.push(p);
    const json =
      p.get('grant_type') === 'authorization_code'
        ? { access_token: 'g-at-0', refresh_token: 'g-rt-1', id_token: `x.${b64u({ email: 'sam@gmail.com', name: 'Sam Schultz' })}.y`, expires_in: 3600, ...(scope ? { scope } : {}) }
        : { access_token: `g-at-${++n}`, expires_in: 3600 };
    return { ok: true, status: 200, json: async () => json, text: async () => '' };
  };
  return { seen, fetchImpl };
}

let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

describe('Gmail with Sign in with Google', () => {
  it('admin sets it up; signing in adds a Gmail account using IMAP/SMTP with OAuth', async () => {
    const g = fakeGoogle();
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com' }), { store, logger: false, cacheFile: null, googleFetch: g.fetchImpl });
    const reg = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
    const cookie = `dm_session=${reg.cookies.find((c) => c.name === 'dm_session')!.value}`;
    const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
      (await ctx!.app.inject({ method, url, payload: payload as object, headers: { cookie, 'x-dreymail': '1' } })).json() as Record<string, unknown>;

    expect(await call('GET', '/api/oauth/google')).toEqual({ available: false });
    const v = (await call('PUT', '/api/admin/google', { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-shh' })) as unknown as GoogleSettingsView;
    expect(v).toMatchObject({ configured: true, redirectUri: 'https://mail.example.com/oauth/google/callback' });
    expect(JSON.stringify(v)).not.toContain('GOCSPX-shh');

    const url = new URL(String((await call('POST', '/api/oauth/google/start', { color: '#ef4444' })).url));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toContain('https://mail.google.com/');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const back = await ctx.app.inject({ method: 'GET', url: `/oauth/google/callback?code=c&state=${url.searchParams.get('state')}`, headers: { cookie } });
    expect(back.headers.location).toMatch(/provider=google&outlook=added/);
    expect(g.seen[0]!.get('code_verifier')).toBeTruthy();

    const [account] = (await call('GET', '/api/accounts')) as unknown as AccountView[];
    expect(account).toMatchObject({ email: 'sam@gmail.com', name: 'Gmail', auth: 'google', appendSent: false, imap: { host: 'imap.gmail.com' }, smtp: { host: 'smtp.gmail.com', port: 465 } });
    const user = store.listUsers()[0]!;
    expect(store.getAccountSecret(user.id, account!.id)!.smtp.oauth).toMatchObject({ provider: 'google' });
    // The sign-in token is reused while fresh, then refreshed.
    expect(await ctx.google.accessToken(user.id, account!.id)).toBe('g-at-0');
  });

  it('a reconnect that allows contacts and tasks takes effect at once (11.0)', async () => {
    const g = fakeGoogle('openid email https://mail.google.com/ https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/tasks');
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com' }), { store, logger: false, cacheFile: null, googleFetch: g.fetchImpl });
    const reg = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
    const cookie = `dm_session=${reg.cookies.find((c) => c.name === 'dm_session')!.value}`;
    const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
      (await ctx!.app.inject({ method, url, payload: payload as object, headers: { cookie, 'x-dreymail': '1' } })).json() as Record<string, unknown>;
    await call('PUT', '/api/admin/google', { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-shh' });
    const url = new URL(String((await call('POST', '/api/oauth/google/start', { color: '#ef4444', allow: ['contacts', 'tasks'] })).url));
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/contacts');
    await ctx.app.inject({ method: 'GET', url: `/oauth/google/callback?code=c&state=${url.searchParams.get('state')}`, headers: { cookie } });
    const [account] = (await call('GET', '/api/accounts')) as unknown as AccountView[];
    const user = store.listUsers()[0]!;
    const before = g.seen.length;
    expect(await ctx.google.allowed(user.id, account!.id, 'contacts')).toBe(true);
    expect(await ctx.google.allowed(user.id, account!.id, 'tasks')).toBe(true);
    expect(await ctx.google.allowed(user.id, account!.id, 'directory')).toBe(false);
    // Known from the sign-in itself: no refresh needed.
    expect(g.seen.length).toBe(before);
  });
});
