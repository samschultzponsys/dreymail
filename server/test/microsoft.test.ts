// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountView, MicrosoftSettingsView } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import type { FetchLike } from '../src/oauth/microsoft.js';

const secret = crypto.randomBytes(48).toString('base64');
const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims: object) => `${b64u({ alg: 'none' })}.${b64u(claims)}.sig`;

/** Fake Microsoft: token endpoint (code and refresh) and Graph sendMail. */
function fakeMicrosoft() {
  const calls: { url: string; params?: URLSearchParams; body?: string; auth?: string }[] = [];
  let refreshCount = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.startsWith('https://login.microsoftonline.com/')) {
      const params = new URLSearchParams(init.body ?? '');
      calls.push({ url, params });
      const json =
        params.get('grant_type') === 'authorization_code'
          ? params.get('code') === 'good-code' && params.get('code_verifier')
            ? { access_token: 'imap-at', refresh_token: 'rt-1', id_token: idToken({ email: 'sam@outlook.com', name: 'Sam Schultz' }), expires_in: 3600 }
            : { error: 'invalid_grant', error_description: 'AADSTS70008: The code expired.' }
          : { access_token: `${params.get('scope')?.includes('graph') ? 'graph' : 'imap'}-at-${++refreshCount}`, refresh_token: `rt-${refreshCount + 1}`, expires_in: 3600 };
      const ok = !('error' in json);
      return { ok, status: ok ? 200 : 400, json: async () => json, text: async () => JSON.stringify(json) };
    }
    calls.push({ url, body: init.body, auth: init.headers.authorization });
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
  };
  return { calls, fetchImpl };
}

let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

async function start(fetchImpl: FetchLike, env: Record<string, string> = {}) {
  const store = new Store(':memory:', new Keyring(secret).credentialKey);
  ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com', ...env }), {
    store,
    logger: false,
    cacheFile: null,
    microsoftFetch: fetchImpl,
  });
  const reg = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
  const cookie = `dm_session=${reg.cookies.find((c) => c.name === 'dm_session')!.value}`;
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const res = await ctx!.app.inject({ method, url, payload: payload as object, headers: { cookie, 'x-dreymail': '1' } });
    return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null, headers: res.headers };
  };
  return { call, cookie, store };
}

describe('Outlook / Microsoft 365 accounts', () => {
  it('needs the administrator to set up the Microsoft app first; the secret never comes back', async () => {
    const { call } = await start(fakeMicrosoft().fetchImpl);
    expect((await call('GET', '/api/oauth/microsoft')).json).toEqual({ available: false });
    expect((await call('POST', '/api/oauth/microsoft/start', {})).status).toBe(400);
    const saved = (await call('PUT', '/api/admin/microsoft', { clientId: 'app-id', clientSecret: 'shh-secret', tenant: '' })).json as unknown as MicrosoftSettingsView;
    expect(saved).toMatchObject({ configured: true, clientId: 'app-id', hasClientSecret: true, tenant: 'common', redirectUri: 'https://mail.example.com/oauth/microsoft/callback' });
    expect(JSON.stringify(saved)).not.toContain('shh-secret');
    expect((await call('GET', '/api/oauth/microsoft')).json).toEqual({ available: true });
  });

  it('signs in with Microsoft (PKCE) and adds the account: IMAP with OAuth, no copy appended to Sent', async () => {
    const ms = fakeMicrosoft();
    const { call, cookie, store } = await start(ms.fetchImpl, { DREYMAIL_MICROSOFT_CLIENT_ID: 'env-app', DREYMAIL_MICROSOFT_CLIENT_SECRET: 'env-secret' });
    const url = new URL(((await call('POST', '/api/oauth/microsoft/start', { color: '#0ea5e9' })).json as { url: string }).url);
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe('env-app');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('https://outlook.office.com/IMAP.AccessAsUser.All');
    expect(url.searchParams.get('scope')).toContain('https://graph.microsoft.com/Mail.Send');
    const state = url.searchParams.get('state')!;

    const back = await ctx!.app.inject({ method: 'GET', url: `/oauth/microsoft/callback?code=good-code&state=${state}`, headers: { cookie } });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toMatch(/^\/\?outlook=added&account=/);
    const accounts = (await call('GET', '/api/accounts')).json as unknown as AccountView[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ email: 'sam@outlook.com', name: 'Outlook', displayName: 'Sam Schultz', color: '#0ea5e9', auth: 'microsoft', appendSent: false });
    const user = store.listUsers()[0]!;
    const s = store.getAccountSecret(user.id, accounts[0]!.id)!;
    expect(s.imap).toMatchObject({ host: 'outlook.office365.com', port: 993, tls: 'tls', user: 'sam@outlook.com', oauth: { provider: 'microsoft' } });
    expect(store.getOAuthToken(user.id, accounts[0]!.id)).toBe('rt-1');
    // The same state can't be used twice.
    const again = await ctx!.app.inject({ method: 'GET', url: `/oauth/microsoft/callback?code=good-code&state=${state}`, headers: { cookie } });
    expect(again.headers.location).toMatch(/outlook=error/);
    // Editing only changes label, name and colour.
    const put = await call('PUT', `/api/accounts/${accounts[0]!.id}`, { ...accounts[0], name: 'Work', imap: { host: 'evil.example', port: 1, tls: 'none', user: 'x' }, smtp: { host: 'x', port: 1, tls: 'none', user: 'x' } });
    expect(put.json).toMatchObject({ name: 'Work', imap: { host: 'outlook.office365.com' } });
  });

  it('refreshes access tokens per resource, stores the rotated refresh token, and sends through Graph', async () => {
    const ms = fakeMicrosoft();
    const { call, cookie, store } = await start(ms.fetchImpl, { DREYMAIL_MICROSOFT_CLIENT_ID: 'a', DREYMAIL_MICROSOFT_CLIENT_SECRET: 'b' });
    const state = new URL(((await call('POST', '/api/oauth/microsoft/start', {})).json as { url: string }).url).searchParams.get('state')!;
    await ctx!.app.inject({ method: 'GET', url: `/oauth/microsoft/callback?code=good-code&state=${state}`, headers: { cookie } });
    const user = store.listUsers()[0]!;
    const account = store.listAccounts(user.id)[0]!;
    // Sending: a Graph token comes from the refresh token, and Microsoft's new refresh token is kept.
    await ctx!.microsoft.sendRaw(user.id, account.id, Buffer.from('Subject: hi\r\n\r\nhello'));
    const send = ms.calls.find((c) => c.url === 'https://graph.microsoft.com/v1.0/me/sendMail')!;
    expect(send.auth).toBe('Bearer graph-at-1');
    expect(Buffer.from(send.body!, 'base64').toString()).toBe('Subject: hi\r\n\r\nhello');
    expect(store.getOAuthToken(user.id, account.id)).toBe('rt-2');
    // The IMAP token from sign-in is still fresh: no new request.
    const before = ms.calls.length;
    expect(await ctx!.microsoft.accessToken(user.id, account.id, 'imap')).toBe('imap-at');
    expect(ms.calls.length).toBe(before);
  });

  it('a Microsoft error comes back to the app as a readable message', async () => {
    const { call, cookie } = await start(fakeMicrosoft().fetchImpl, { DREYMAIL_MICROSOFT_CLIENT_ID: 'a', DREYMAIL_MICROSOFT_CLIENT_SECRET: 'b' });
    const state = new URL(((await call('POST', '/api/oauth/microsoft/start', {})).json as { url: string }).url).searchParams.get('state')!;
    const back = await ctx!.app.inject({ method: 'GET', url: `/oauth/microsoft/callback?code=bad-code&state=${state}`, headers: { cookie } });
    expect(decodeURIComponent(String(back.headers.location))).toContain('AADSTS70008');
    const denied = await ctx!.app.inject({ method: 'GET', url: '/oauth/microsoft/callback?error=access_denied&error_description=The+user+declined', headers: { cookie } });
    expect(decodeURIComponent(String(denied.headers.location)).replace(/\+/g, ' ')).toContain('The user declined');
  });
});
