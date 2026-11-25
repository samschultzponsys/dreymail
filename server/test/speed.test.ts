// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SpeedView } from '../../shared/speed.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { SpeedStats, speedMetricOf } from '../src/speed.js';

/** Settings → Server → Speed (DreyMail 14.5). */

describe('speed statistics', () => {
  it('gives the typical, slow (1 in 20) and slowest time of the most recent 500', () => {
    const s = new SpeedStats();
    for (let i = 1; i <= 100; i++) s.record('open', i);
    s.record('open', -5);
    s.record('open', Number.NaN);
    const row = s.view().rows.find((r) => r.metric === 'open')!;
    expect(row).toMatchObject({ count: 100, median: 51, p95: 96, max: 100 });
    for (let i = 0; i < 600; i++) s.record('list', i < 100 ? 10_000 : 5);
    // Only the most recent 500 count for the times; all of them for the count.
    expect(s.view().rows.find((r) => r.metric === 'list')).toMatchObject({ count: 600, median: 5, max: 5 });
    expect(s.view().rows.find((r) => r.metric === 'send')).toMatchObject({ count: 0, median: null });
  });

  it('tells lists from searches, and counts only what succeeded', () => {
    expect(speedMetricOf('GET', '/api/message', {}, 200)).toBe('open');
    expect(speedMetricOf('GET', '/api/messages', { accountId: 'a', folder: 'INBOX' }, 200)).toBe('list');
    expect(speedMetricOf('GET', '/api/messages', { cursor: 'x' }, 200)).toBe('list');
    expect(speedMetricOf('GET', '/api/messages', { q: 'invoice' }, 200)).toBe('search');
    expect(speedMetricOf('GET', '/api/messages', { filter: JSON.stringify({ where: 'all' }) }, 200)).toBe('search');
    expect(speedMetricOf('GET', '/api/messages', { filter: JSON.stringify({ flagged: true }) }, 200)).toBe('search');
    expect(speedMetricOf('GET', '/api/messages', { q: 'invoice', quick: '1' }, 200)).toBeNull();
    expect(speedMetricOf('GET', '/api/attachment', {}, 200)).toBe('attachment');
    expect(speedMetricOf('POST', '/api/messages/actions', {}, 200)).toBe('action');
    expect(speedMetricOf('POST', '/api/send', {}, 200)).toBe('send');
    expect(speedMetricOf('GET', '/api/message', {}, 404)).toBeNull();
    expect(speedMetricOf('GET', '/api/me', {}, 200)).toBeNull();
    expect(speedMetricOf('GET', undefined, {}, 200)).toBeNull();
  });
});

describe('speed in the server', () => {
  let ctx: App | null = null;
  afterEach(async () => {
    await ctx?.app.close();
    ctx = null;
  });

  it('takes startup times from signed-in apps and shows them to administrators only', async () => {
    const secret = crypto.randomBytes(48).toString('base64');
    const config = loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_REGISTRATION: 'open' });
    ctx = await buildApp(config, { store: new Store(':memory:', new Keyring(secret).credentialKey), logger: false });
    const register = async (username: string) => {
      const res = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username, password: 'a long password' }, headers: { 'x-dreymail': '1' } });
      return `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`;
    };
    const admin = await register('ada'); // the first user administers the server
    const user = await register('bob');
    const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) => ctx!.app.inject({ method, url, payload, headers: { cookie, 'x-dreymail': '1' } });

    expect((await call(user, 'POST', '/api/speed/startup', { ms: 812.4, remembered: true })).statusCode).toBe(200);
    expect((await call(user, 'POST', '/api/speed/startup', { ms: 1900, remembered: false })).statusCode).toBe(200);
    expect((await call(user, 'POST', '/api/speed/startup', { ms: -1, remembered: true })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/speed/startup', payload: { ms: 5, remembered: true }, headers: { 'x-dreymail': '1' } })).statusCode).toBe(401);

    expect((await call(user, 'GET', '/api/admin/speed')).statusCode).toBe(403);
    const view = (await call(admin, 'GET', '/api/admin/speed')).json() as SpeedView;
    expect(view.rows.find((r) => r.metric === 'startup')).toMatchObject({ count: 1, median: 812 });
    expect(view.rows.find((r) => r.metric === 'startupNew')).toMatchObject({ count: 1, median: 1900 });
  });
});
