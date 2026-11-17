// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Server settings in the UI (9.7): stored as environment-variable values, checked like the
// environment, under it (the environment wins and shows locked).

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { withStoredSettings } from '../src/serverSettings.js';

const secret = crypto.randomBytes(48).toString('base64');
let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

async function start(env: Record<string, string> = {}) {
  const store = new Store(':memory:', new Keyring(secret).credentialKey);
  const config = loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com', DREYMAIL_REGISTRATION: 'open', ...env });
  ctx = await buildApp(config, { store, logger: false });
  const res = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
  const headers = { cookie: `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`, 'x-dreymail': '1' };
  const call = async (method: 'GET' | 'PUT', url: string, payload?: unknown) => {
    const r = await ctx!.app.inject({ method, url, headers, payload: payload as never });
    return { status: r.statusCode, body: r.json() as any };
  };
  return { store, call, config };
}

describe('server settings', () => {
  it('saves new-mailbox defaults that apply at once, and checks values like the environment', async () => {
    const { call } = await start();
    const bad = await call('PUT', '/api/admin/server', { values: { DREYMAIL_DEFAULT_IMAP_PORT: 'lots' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('DREYMAIL_DEFAULT_IMAP_PORT must be a port number');
    const ok = await call('PUT', '/api/admin/server', { values: { DREYMAIL_DEFAULT_IMAP_HOST: 'imap.{username}.example', DREYMAIL_DEFAULT_MAIL_PASSWORD: 'shh', DREYMAIL_CACHE_MESSAGES: '3000' } });
    expect(ok.status).toBe(200);
    expect(ok.body.restartNeeded).toBe(true);
    const pw = ok.body.settings.find((s: { env: string }) => s.env === 'DREYMAIL_DEFAULT_MAIL_PASSWORD');
    expect(pw).toMatchObject({ value: '', isSet: true });
    const me = await call('GET', '/api/me');
    expect(me.body.accountDefaults.imap.host).toBe('imap.sam.example');
  });

  it('lets the environment win and shows it', async () => {
    const { call, store, config } = await start({ DREYMAIL_CACHE_MESSAGES: '900' });
    const r = await call('PUT', '/api/admin/server', { values: { DREYMAIL_CACHE_MESSAGES: '3000', DREYMAIL_MAX_UPLOAD_MB: '40' } });
    expect(r.body.settings.find((s: { env: string }) => s.env === 'DREYMAIL_CACHE_MESSAGES')).toMatchObject({ fromEnv: true, envValue: '900' });
    // At the next start: the stored upload limit, the environment's cache size.
    const next = withStoredSettings(config, store);
    expect(next.cache?.messagesPerFolder).toBe(900);
    expect(next.maxUploadBytes).toBe(40 * 1024 * 1024);
  });
});
