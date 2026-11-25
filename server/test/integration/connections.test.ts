// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AccountView, ListResponse, Me } from '../../../shared/types.js';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { Keyring } from '../../src/crypto.js';
import { Store } from '../../src/db.js';

/**
 * Connections per mailbox (DreyMail 14.5): never more than DREYMAIL_IMAP_CONNECTIONS at once, the
 * inbox watcher included, even while searching many folders; extra ones close when unused.
 */

const gm = inject('greenmail');
const USER = `conn-${crypto.randomUUID().slice(0, 6)}@example.com`;
const FOLDERS = ['Projects', 'Receipts', 'Travel', 'Family', 'Newsletters', 'Old'];
let ctx: App;
let cookie = '';
let account: AccountView;

const api = async <T,>(method: 'GET' | 'POST', url: string, body?: unknown) => {
  const res = await ctx.app.inject({ method, url, headers: { cookie, 'x-dreymail': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
  return res.json() as T;
};

beforeAll(async () => {
  const c = new ImapFlow({ host: gm.host, port: gm.imapPort, secure: false, doSTARTTLS: false, auth: { user: USER, pass: 'x' }, logger: false });
  c.on('error', () => {});
  await c.connect();
  for (const f of FOLDERS) {
    await c.mailboxCreate(f);
    for (let i = 0; i < 3; i++) await c.append(f, Buffer.from(`From: Kim <kim@example.com>\r\nTo: ${USER}\r\nSubject: ${f} ${i} lighthouse\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\nDate: ${new Date().toUTCString()}\r\n\r\nAbout the lighthouse.\r\n`));
  }
  await c.logout();
  const config = loadConfig({
    NODE_ENV: 'test',
    DREYMAIL_SECRET_KEY: crypto.randomBytes(48).toString('base64'),
    DREYMAIL_DEV_LOGIN: 'true',
    DREYMAIL_DATA_DIR: '/nonexistent-not-used',
    DREYMAIL_BASE_URL: 'http://localhost:8080',
    DREYMAIL_IMAP_CONNECTIONS: '5',
    // Extra connections close after min(1 minute, this): quick, for the test.
    DREYMAIL_IMAP_IDLE_TIMEOUT: '2',
    DREYMAIL_CACHE: 'false',
  });
  const store = new Store(':memory:', new Keyring(config.secretKey).credentialKey);
  ctx = await buildApp(config, { store, logger: false });
  await ctx.app.ready();
  const login = await ctx.app.inject({ method: 'GET', url: '/auth/dev-login' });
  cookie = `dm_session=${login.cookies.find((x) => x.name === 'dm_session')!.value}`;
  await api<Me>('GET', '/api/me');
  const server = (port: number) => ({ host: gm.host, port, tls: 'none' as const, user: USER, password: 'pw' });
  account = await api<AccountView>('POST', '/api/accounts', { name: 'C', displayName: 'C', email: USER, color: '#224466', imap: server(gm.imapPort), smtp: server(gm.smtpPort), appendSent: false });
});

afterAll(async () => {
  await ctx?.app.close();
});

describe('IMAP connections per mailbox', () => {
  it('searches many folders within the limit, and still finds everything', async () => {
    const userId = (await api<Me>('GET', '/api/me')).id;
    let most = 0;
    const sample = setInterval(() => (most = Math.max(most, ctx.pool.connectionCount(userId, account.id))), 2);
    try {
      const filter = encodeURIComponent(JSON.stringify({ where: 'all' }));
      const res = await api<ListResponse>('GET', `/api/messages?q=lighthouse&filter=${filter}&limit=50`);
      expect(res.messages).toHaveLength(FOLDERS.length * 3);
    } finally {
      clearInterval(sample);
    }
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(5);
  });

  it('closes extra connections once unused', async () => {
    const userId = (await api<Me>('GET', '/api/me')).id;
    const lanes = () => [...(ctx.pool as unknown as { conns: Map<string, { client: unknown }> }).conns.entries()].filter(([k, c]) => k.includes('#search') && c.client).length;
    const filter = encodeURIComponent(JSON.stringify({ where: 'all' }));
    await api<ListResponse>('GET', `/api/messages?q=lighthouse&filter=${filter}&limit=50`);
    expect(lanes()).toBeGreaterThan(0);
    const end = Date.now() + 10_000;
    while (lanes() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
    expect(lanes()).toBe(0);
    expect(ctx.pool.connectionCount(userId, account.id)).toBeLessThanOrEqual(2);
  });
});
