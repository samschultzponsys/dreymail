// dreymail. Copyright (C) 2026 samschultzponsys.
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

describe('renewal reminder for the Outlook client secret', () => {
  it("goes in every Superadmin's calendar two weeks ahead, and moves when the date changes", async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com', DREYMAIL_REGISTRATION: 'open' }), { store, logger: false, cacheFile: null });
    const register = async (username: string) => {
      const res = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username, password: 'a long password' }, headers: { 'x-dreymail': '1' } });
      return `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`;
    };
    const sam = await register('sam'); // first user: Superadmin
    await register('ann');
    await register('bob');
    const users = Object.fromEntries(store.listUsers().map((u) => [u.username, u.id]));
    store.db.prepare("UPDATE users SET role_id = 'superadmin' WHERE id = ?").run(users.ann!);

    const save = (secretExpires: string) =>
      ctx!.app.inject({ method: 'PUT', url: '/api/admin/microsoft', headers: { cookie: sam, 'x-dreymail': '1' }, payload: { clientId: 'cid', clientSecret: 's3cret', tenant: 'common', secretExpires } });
    const reminders = () =>
      store.db
        .prepare("SELECT c.owner_id, e.title, e.start_at FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE e.ical_uid = 'dreymail-reminder-microsoft-secret'")
        .all() as { owner_id: string; title: string; start_at: number }[];

    const res = await save('2028-11-16');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ secretExpires: '2028-11-16' });
    let r = reminders();
    expect(r.map((x) => x.owner_id).sort()).toEqual([users.ann, users.sam].sort());
    expect(r.every((x) => new Date(x.start_at).toISOString().slice(0, 10) === '2028-11-02')).toBe(true);
    expect(r[0]!.title).toBe("Renew DreyMail's Outlook client secret");

    // A new secret, a new date: moved, not added.
    await save('2030-01-20');
    r = reminders();
    expect(r).toHaveLength(2);
    expect(new Date(r[0]!.start_at).toISOString().slice(0, 10)).toBe('2030-01-06');
    // It shows in their calendar.
    const events = (await ctx!.app.inject({ method: 'GET', url: '/api/events?from=2030-01-01T00:00:00.000Z&to=2030-02-01T00:00:00.000Z', headers: { cookie: sam } })).json() as { title: string }[];
    expect(events.map((e) => e.title)).toContain("Renew DreyMail's Outlook client secret");
  });
});
