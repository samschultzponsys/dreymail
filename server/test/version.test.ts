// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { VersionInfo } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { displayVersion, isNewer, serverVersion, UpdateChecker } from '../src/version.js';

describe('version', () => {
  it('reads the server version and compares two-part versions', () => {
    expect(serverVersion()).toMatch(/^\d+\.\d$/);
    expect(displayVersion('2.0.0')).toBe('2.0');
    expect(isNewer('v2.1', '2.0')).toBe(true);
    expect(isNewer('v3.0', '2.9')).toBe(true);
    expect(isNewer('v2.0', '2.0')).toBe(false);
  });

  it('checks GitHub at most every few hours and can be switched off', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, json: async () => ({ tag_name: 'v9.1', html_url: 'https://example.test/r' }) };
    };
    const u = new UpdateChecker(true, fetchImpl);
    expect(await u.get()).toEqual({ version: '9.1', url: 'https://example.test/r' });
    await u.get();
    expect(calls).toBe(1);
    expect(await new UpdateChecker(false, fetchImpl).get()).toBeNull();
  });

  let ctx: App | null = null;
  afterEach(async () => {
    await ctx?.app.close();
    ctx = null;
  });

  it('tells administrators, and only them, about a newer image; serves the changelog', async () => {
    const secret = crypto.randomBytes(48).toString('base64');
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_REGISTRATION: 'open' }), {
      store: new Store(':memory:', new Keyring(secret).credentialKey),
      logger: false,
      cacheFile: null,
      updates: { get: async () => ({ version: '99.0', url: 'https://example.test/r' }) },
    });
    const login = async (u: string) => {
      const r = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: u, password: 'a long password' }, headers: { 'x-dreymail': '1' } });
      return `dm_session=${r.cookies.find((c) => c.name === 'dm_session')!.value}`;
    };
    const admin = await login('sam');
    const user = await login('eve');
    const get = async (cookie: string, url: string) => (await ctx!.app.inject({ method: 'GET', url, headers: { cookie } })).json() as Record<string, unknown>;
    expect((await get(admin, '/api/version')) as unknown as VersionInfo).toEqual({ version: serverVersion(), update: { version: '99.0', url: 'https://example.test/r' } });
    expect(((await get(user, '/api/version')) as unknown as VersionInfo).update).toBeNull();
    expect(String((await get(admin, '/api/changelog')).markdown)).toContain('## ');
  });
});
