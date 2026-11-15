// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
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

async function start() {
  const store = new Store(':memory:', new Keyring(secret).credentialKey);
  ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com', DREYMAIL_REGISTRATION: 'open' }), { store, logger: false });
  const res = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
  return { store, cookie: `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}` };
}

describe('passkeys', () => {
  it('registration options are bound to the base URL host and exclude existing passkeys', async () => {
    const { cookie } = await start();
    const res = await ctx!.app.inject({ method: 'POST', url: '/api/passkeys/options', payload: {}, headers: { cookie, 'x-dreymail': '1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rp: { id: 'mail.example.com', name: 'DreyMail' }, authenticatorSelection: { residentKey: 'required' } });
    expect((await ctx!.app.inject({ method: 'GET', url: '/api/passkeys', headers: { cookie } })).json()).toEqual([]);
  });

  it('sign-in needs the CSRF header, a fresh challenge and a registered passkey', async () => {
    await start();
    expect((await ctx!.app.inject({ method: 'POST', url: '/auth/passkey/options', payload: {} })).statusCode).toBe(403);
    const opt = await ctx!.app.inject({ method: 'POST', url: '/auth/passkey/options', payload: {}, headers: { 'x-dreymail': '1' } });
    const { attempt, options } = opt.json() as { attempt: string; options: { rpId: string; challenge: string } };
    expect(options.rpId).toBe('mail.example.com');
    const unknown = await ctx!.app.inject({ method: 'POST', url: '/auth/passkey/verify', payload: { attempt, response: { id: 'not-registered' } }, headers: { 'x-dreymail': '1' } });
    expect(unknown.statusCode).toBe(401);
    // A challenge is good for one try only.
    const again = await ctx!.app.inject({ method: 'POST', url: '/auth/passkey/verify', payload: { attempt, response: { id: 'not-registered' } }, headers: { 'x-dreymail': '1' } });
    expect(again.statusCode).toBe(400);
  });

  it("can't delete someone else's passkey", async () => {
    const { store, cookie } = await start();
    const other = store.upsertUser('local', 'eve', '', 'Eve');
    store.db.prepare("INSERT INTO passkeys (id, user_id, public_key, name, created_at) VALUES ('k1', ?, X'00', 'Eve key', 1)").run(other.id);
    expect((await ctx!.app.inject({ method: 'DELETE', url: '/api/passkeys/k1', headers: { cookie, 'x-dreymail': '1' } })).statusCode).toBe(404);
    expect((await ctx!.app.inject({ method: 'GET', url: '/auth/methods' })).json()).toMatchObject({ passkeys: true });
  });
});
