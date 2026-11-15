// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Connecting single sign-on to an existing account, against a small fake OIDC provider.

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SsoStatus } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** The fake provider signs in whoever `nextSubject` says, for the nonce the last sign-in asked for. */
let issuer = '';
let nextSubject = 'idp-user-1';
let lastNonce = '';
const idp = http.createServer((req, res) => {
  const url = new URL(req.url!, issuer);
  const json = (v: object) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(v));
  };
  if (url.pathname === '/.well-known/openid-configuration')
    return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'], subject_types_supported: ['public'] });
  if (url.pathname === '/jwks') return json({ keys: [jwk] });
  if (url.pathname === '/token') {
    const now = Math.floor(Date.now() / 1000);
    const head = b64u({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b64u({ iss: issuer, sub: nextSubject, aud: 'dreymail', nonce: lastNonce, iat: now, exp: now + 300, email: `${nextSubject}@example.com`, name: 'From SSO', preferred_username: nextSubject });
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return json({ access_token: 'at', token_type: 'Bearer', id_token: `${head}.${body}.${sig}`, expires_in: 300 });
  }
  res.statusCode = 404;
  res.end();
});

beforeAll(async () => {
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => idp.close(() => r())));

const secret = crypto.randomBytes(48).toString('base64');
let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

async function start() {
  const store = new Store(':memory:', new Keyring(secret).credentialKey);
  ctx = await buildApp(loadConfig({ NODE_ENV: 'test', DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'http://dm.test', OIDC_ISSUER_URL: issuer, OIDC_CLIENT_ID: 'dreymail', OIDC_CLIENT_SECRET: 's', DREYMAIL_PASSWORD_LOGIN: 'true', DREYMAIL_REGISTRATION: 'open' }), { store, logger: false });
  return store;
}
const cookies = (res: { cookies: { name: string; value: string }[] }) => Object.fromEntries(res.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
const header = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

/** One OIDC round trip through DreyMail; returns where it ended and the cookies it left. */
async function ssoRoundTrip(jar: Record<string, string>, link = false) {
  const start = await ctx!.app.inject({ method: 'GET', url: `/auth/login${link ? '?link=1' : ''}`, headers: { cookie: header(jar) } });
  expect(start.statusCode).toBe(302);
  const authorize = new URL(String(start.headers.location));
  lastNonce = authorize.searchParams.get('nonce')!;
  const after = { ...jar, ...cookies(start) };
  const back = await ctx!.app.inject({ method: 'GET', url: `/auth/callback?code=c1&state=${authorize.searchParams.get('state')}`, headers: { cookie: header(after) } });
  return { location: String(back.headers.location), jar: { ...after, ...cookies(back) } };
}

describe('connecting single sign-on to an account', () => {
  it('then signing in with it opens that account', async () => {
    const store = await start();
    const reg = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
    const sam = { dm_session: cookies(reg).dm_session! };
    const samId = store.listUsers()[0]!.id;
    const status = async (jar: Record<string, string>) => (await ctx!.app.inject({ method: 'GET', url: '/api/sso', headers: { cookie: header(jar) } })).json() as SsoStatus;
    expect(await status(sam)).toMatchObject({ available: true, connected: false });

    nextSubject = 'idp-sam';
    const linked = await ssoRoundTrip(sam, true);
    expect(linked.location).toBe('/?sso=connected');
    expect(await status(sam)).toMatchObject({ connected: true, canDisconnect: true });
    expect(store.listUsers()).toHaveLength(1); // no second account

    // A fresh browser signing in with SSO lands in Sam's account.
    const fresh = await ssoRoundTrip({});
    expect(fresh.location).toBe('/');
    const me = (await ctx!.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: header(fresh.jar) } })).json() as { id: string; name: string };
    expect(me.id).toBe(samId);
    expect(store.getUser(samId)!.username).toBe('sam'); // the account isn't renamed by the provider

    // Someone else at the provider still gets their own account.
    nextSubject = 'idp-eve';
    await ssoRoundTrip({});
    expect(store.listUsers()).toHaveLength(2);

    // Admin list shows it; disconnecting goes back to separate accounts.
    expect(store.identitiesOf(samId)).toHaveLength(1);
    expect((await ctx!.app.inject({ method: 'DELETE', url: '/api/sso', headers: { cookie: header(sam), 'x-dreymail': '1' } })).statusCode).toBe(200);
    nextSubject = 'idp-sam';
    const after = await ssoRoundTrip({});
    const who = (await ctx!.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: header(after.jar) } })).json() as { id: string };
    expect(who.id).not.toBe(samId);
  });

  it('moves an identity that already made its own account, and needs the account signed in', async () => {
    const store = await start();
    const reg = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
    const sam = { dm_session: cookies(reg).dm_session! };
    const samId = store.listUsers()[0]!.id;
    // Signed in with SSO before connecting: a separate, empty account.
    nextSubject = 'idp-early';
    const early = await ssoRoundTrip({});
    const earlyId = ((await ctx!.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: header(early.jar) } })).json() as { id: string }).id;
    expect(earlyId).not.toBe(samId);
    // Connecting moves it to Sam.
    expect((await ssoRoundTrip(sam, true)).location).toBe('/?sso=connected');
    const again = await ssoRoundTrip({});
    expect(((await ctx!.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: header(again.jar) } })).json() as { id: string }).id).toBe(samId);

    // Not signed in: no connecting, just the sign-in page.
    const anon = await ctx!.app.inject({ method: 'GET', url: '/auth/login?link=1' });
    expect(anon.headers.location).toBe('/login');
  });
});
