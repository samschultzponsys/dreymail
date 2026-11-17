// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// This device's session (9.6): staying signed in (sliding sessions) and the idle app lock, which
// the server keeps (a locked device gets 423 until unlocked with a passkey).

import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const secret = crypto.randomBytes(48).toString('base64');
let ctx: App | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.app.close();
  ctx = null;
});

async function start() {
  const store = new Store(':memory:', new Keyring(secret).credentialKey);
  ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com', DREYMAIL_REGISTRATION: 'open' }), { store, logger: false });
  const res = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
  let cookie = res.cookies.find((c) => c.name === 'dm_session')!.value;
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const r = await ctx!.app.inject({ method, url, headers: { cookie: `dm_session=${cookie}`, 'x-dreymail': '1' }, payload: (payload ?? (method === 'GET' ? undefined : {})) as never });
    const next = r.cookies.find((c) => c.name === 'dm_session');
    if (next) cookie = next.value;
    return { status: r.statusCode, body: r.json() as any, cookie: next };
  };
  return { store, call };
}

describe('this device', () => {
  it('stays signed in on a trusted device (the cookie slides to 30 days)', async () => {
    const { call } = await start();
    expect((await call('GET', '/api/session')).body).toMatchObject({ trusted: false, lockAfter: 0, locked: false, hasPasskey: false });
    const r = await call('PUT', '/api/session', { trusted: true });
    expect(r.body.trusted).toBe(true);
    expect(r.cookie?.maxAge).toBe(30 * 24 * 3600);
    // A day later, using it slides the cookie again.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 86_400_000);
    const later = await call('GET', '/api/me');
    expect(later.status).toBe(200);
    expect(later.cookie?.maxAge).toBe(30 * 24 * 3600);
  });

  it('locks after the idle time and refuses everything but the unlock until a passkey unlocks it', async () => {
    const { store, call } = await start();
    // Locking needs a passkey to unlock with.
    expect((await call('PUT', '/api/session', { lockAfter: 5 })).status).toBe(400);
    const user = store.listUsers()[0]!;
    store.db.prepare('INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run('cred1', user.id, 'Laptop', new Uint8Array([1]), '[]', Date.now());
    expect((await call('PUT', '/api/session', { lockAfter: 5 })).body).toMatchObject({ lockAfter: 5, locked: false });
    expect((await call('GET', '/api/me')).status).toBe(200);
    // Background requests don't count as use; six minutes later the device is locked.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    const locked = await call('GET', '/api/me');
    expect(locked.status).toBe(423);
    expect(locked.body).toEqual({ error: 'DreyMail is locked', locked: true });
    // Still locked on the next request (the lock is in the session), and activity doesn't undo it.
    expect((await call('GET', '/api/accounts')).status).toBe(423);
    expect((await call('POST', '/api/session/active')).status).toBe(423);
    expect((await call('GET', '/api/session')).body.locked).toBe(true);
    // Unlocking asks for one of this user's passkeys.
    const opts = await call('POST', '/api/session/unlock/options');
    expect(opts.body.options.allowCredentials).toEqual([expect.objectContaining({ id: 'cred1' })]);
    expect((await call('POST', '/api/session/unlock', { response: { id: 'someone-else' } })).status).toBe(401);
  });
});
