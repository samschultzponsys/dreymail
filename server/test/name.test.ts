// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Me } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { capitalizeName } from '../src/routes/api.js';

describe('your name', () => {
  it('capitalises lower-case input and keeps deliberate mixed case', () => {
    expect(capitalizeName('sam')).toBe('Sam');
    expect(capitalizeName('  sam   schultz ')).toBe('Sam Schultz');
    expect(capitalizeName("mary-jane o'neil")).toBe("Mary-Jane O'Neil");
    expect(capitalizeName('McDonald')).toBe('McDonald');
    expect(capitalizeName('')).toBe('');
  });

  let ctx: App | null = null;
  afterEach(async () => {
    await ctx?.app.close();
    ctx = null;
  });

  it('is saved per user, shown as the name, and survives the provider name changing', async () => {
    const secret = crypto.randomBytes(48).toString('base64');
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret }), { store, logger: false, cacheFile: null });
    const reg = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
    const cookie = `dm_session=${reg.cookies.find((c) => c.name === 'dm_session')!.value}`;
    const put = await ctx.app.inject({ method: 'PUT', url: '/api/me/name', payload: { name: 'sam schultz' }, headers: { cookie, 'x-dreymail': '1' } });
    expect(put.json()).toEqual({ name: 'Sam Schultz' });
    const me = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json() as Me;
    expect(me).toMatchObject({ name: 'Sam Schultz', displayName: 'Sam Schultz' });
    // A provider (or anything else) updating `name` doesn't replace the chosen one.
    store.upsertUser('local', 'sam', '', 'sam');
    expect(((await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json() as Me).name).toBe('Sam Schultz');
  });
});
