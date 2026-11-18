// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Contacts and tasks (10.4): DreyMail's own through the API; Outlook's through Microsoft Graph.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { People } from '../src/people.js';

const secret = crypto.randomBytes(48).toString('base64');
let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

describe('contacts and tasks', () => {
  it("keep DreyMail's own, and suggest own contacts while writing", async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com', DREYMAIL_REGISTRATION: 'open' }), { store, logger: false });
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
    const headers = { cookie: `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`, 'x-dreymail': '1' };
    const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
      const r = await ctx!.app.inject({ method, url, headers, payload: payload as never });
      return { status: r.statusCode, body: r.json() as any };
    };
    const made = await call('POST', '/api/contacts', { name: 'Ada Lovelace', emails: ['ada@example.com', ' ada@example.com '], phones: ['+1 555 0100'], company: 'Analytical Engines' });
    expect(made.body).toMatchObject({ source: 'local', name: 'Ada Lovelace', emails: ['ada@example.com'] });
    expect((await call('GET', '/api/contacts')).body.contacts).toHaveLength(1);
    expect((await call('GET', '/api/recipients?q=lovel')).body).toEqual([{ name: 'Ada Lovelace', address: 'ada@example.com' }]);
    await call('PUT', `/api/contacts/${encodeURIComponent(made.body.id)}`, { ...made.body, title: 'Countess' });
    expect((await call('GET', '/api/contacts')).body.contacts[0].title).toBe('Countess');
    expect((await call('DELETE', `/api/contacts/${encodeURIComponent(made.body.id)}`)).status).toBe(200);

    const { lists } = (await call('GET', '/api/tasklists')).body;
    expect(lists).toEqual([expect.objectContaining({ source: 'local', name: 'Tasks' })]);
    const list = encodeURIComponent(lists[0].id);
    const a = (await call('POST', `/api/tasklists/${list}/tasks`, { title: 'Send the report', due: '2026-11-20' })).body;
    await call('POST', `/api/tasklists/${list}/tasks`, { title: 'Book flights' });
    await call('PUT', `/api/tasklists/${list}/tasks/${encodeURIComponent(a.id)}`, { ...a, done: true });
    expect((await call('GET', `/api/tasklists/${list}/tasks`)).body.map((t: { title: string; done: boolean }) => `${t.title}${t.done ? ' ✓' : ''}`)).toEqual(['Book flights', 'Send the report ✓']);
  });

  it('reads Outlook contacts and To Do through Graph, where allowed', async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
    const acc = store.saveMicrosoftAccount(user.id, { email: 'sam@corp.com', name: 'Work', displayName: 'Sam', color: '#0078d4', refreshToken: 'rt' });
    const calls: string[] = [];
    const p = new People({
      store,
      microsoft: { accessToken: async (_u: string, _a: string, what: string) => (what === 'tasks' ? 'tt' : Promise.reject(new Error('no consent'))) } as never,
      google: {} as never,
      fetch: async (url, init) => {
        calls.push(`${init.method} ${url}`);
        const body = url.includes('/todo/lists/') ? { value: [{ id: 'T1', title: 'Expenses', status: 'notStarted', dueDateTime: { dateTime: '2026-11-21T00:00:00.0000000' } }] } : { value: [{ id: 'L1', displayName: 'Work tasks' }] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      },
    });
    // Contacts not allowed: nothing asked, no error.
    expect(await p.contacts(user.id)).toEqual({ contacts: [], errors: [] });
    const { lists } = await p.lists(user.id);
    const outlook = lists.find((l) => l.source === 'microsoft')!;
    expect(outlook).toMatchObject({ name: 'Work tasks', accountId: acc.id });
    expect(await p.tasks(user.id, outlook.id)).toEqual([expect.objectContaining({ title: 'Expenses', due: '2026-11-21', done: false })]);
    expect(calls).toEqual(['GET https://graph.microsoft.com/v1.0/me/todo/lists', 'GET https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks?$top=200']);
  });
});
