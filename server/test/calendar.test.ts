// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mayOccur, occurrences, type CalendarEvent } from '../../shared/calendar.js';
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

async function register(username: string) {
  const res = await ctx!.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username, password: 'a long password' }, headers: { 'x-dreymail': '1' } });
  return { cookie: `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`, 'x-dreymail': '1' };
}
async function start() {
  const store = new Store(':memory:', new Keyring(secret).credentialKey);
  ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com', DREYMAIL_REGISTRATION: 'open' }), { store, logger: false });
  return { store, sam: await register('sam'), eve: await register('eve') };
}
const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) => {
  const res = await ctx!.app.inject({ method, url, headers, payload: (payload ?? (method === 'GET' || method === 'DELETE' ? undefined : {})) as never });
  return { status: res.statusCode, body: res.json() as any };
};

const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e',
  calendarId: 'c',
  title: 'T',
  start: '2026-03-02T09:00:00.000Z',
  end: '2026-03-02T10:00:00.000Z',
  allDay: false,
  location: '',
  notes: '',
  recurrence: 'none',
  until: null,
  ...over,
});

describe('repeating events', () => {
  it('expands daily, weekly, monthly and yearly repeats within the range', () => {
    const from = Date.parse('2026-03-01T00:00:00Z');
    const to = Date.parse('2026-04-01T00:00:00Z');
    expect(occurrences(ev({ recurrence: 'weekly' }), from, to)).toHaveLength(5);
    expect(occurrences(ev({ recurrence: 'daily', until: '2026-03-05' }), from, to)).toHaveLength(4);
    expect(occurrences(ev({ recurrence: 'monthly' }), from, Date.parse('2027-03-01T00:00:00Z'))).toHaveLength(12);
    expect(occurrences(ev({ recurrence: 'yearly' }), from, Date.parse('2030-01-01T00:00:00Z'))).toHaveLength(4);
    // Only occurrences inside the range.
    const later = occurrences(ev({ recurrence: 'weekly' }), Date.parse('2026-03-20T00:00:00Z'), to);
    expect(later.map((o) => o.occurrenceStart.slice(0, 10))).toEqual(['2026-03-23', '2026-03-30']);
  });

  it('skips months without the day, and keeps all-day events on their dates', () => {
    const monthly = occurrences(ev({ start: '2026-01-31T09:00:00.000Z', end: '2026-01-31T10:00:00.000Z', recurrence: 'monthly' }), Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-08-01T00:00:00Z'));
    expect(monthly.length).toBe(4); // Jan, Mar, May, Jul
    const birthday = ev({ allDay: true, start: '2026-03-08T00:00:00.000Z', end: '2026-03-09T00:00:00.000Z', recurrence: 'yearly' });
    const years = occurrences(birthday, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2029-01-01T00:00:00Z'));
    expect(years.map((o) => o.occurrenceStart)).toEqual(['2026-03-08T00:00:00.000Z', '2027-03-08T00:00:00.000Z', '2028-03-08T00:00:00.000Z']);
  });

  it('the server filter keeps anything that may happen in the range', () => {
    expect(mayOccur(ev({}), Date.parse('2026-03-02T09:30:00Z'), Date.parse('2026-03-03T00:00:00Z'))).toBe(true);
    expect(mayOccur(ev({}), Date.parse('2026-03-03T00:00:00Z'), Date.parse('2026-03-04T00:00:00Z'))).toBe(false);
    expect(mayOccur(ev({ recurrence: 'weekly' }), Date.parse('2027-01-01T00:00:00Z'), Date.parse('2027-02-01T00:00:00Z'))).toBe(true);
    expect(mayOccur(ev({ recurrence: 'weekly', until: '2026-03-20' }), Date.parse('2026-05-01T00:00:00Z'), Date.parse('2026-06-01T00:00:00Z'))).toBe(false);
  });
});

describe('calendars', () => {
  it('makes a first calendar, and shares view or edit with other DreyMail users', async () => {
    const { sam, eve } = await start();
    const mine = await call('GET', '/api/calendars', sam);
    expect(mine.body).toMatchObject([{ name: 'Personal', access: 'owner', visible: true }]);
    const calId = mine.body[0].id as string;

    const people = await call('GET', '/api/calendars/people', sam);
    expect(people.body.map((p: { name: string }) => p.name)).toEqual(['eve']);
    const eveId = people.body[0].id as string;

    const event = { calendarId: calId, title: 'Standup', start: '2026-03-02T09:00:00.000Z', end: '2026-03-02T09:15:00.000Z', recurrence: 'weekly' };
    const created = await call('POST', '/api/events', sam, event);
    expect(created.status).toBe(200);
    const range = '/api/events?from=2026-04-01T00:00:00.000Z&to=2026-05-01T00:00:00.000Z';
    expect((await call('GET', range, sam)).body).toHaveLength(1);

    // Not shared yet: Eve sees nothing and can't add.
    expect((await call('GET', range, eve)).body).toEqual([]);
    expect((await call('POST', '/api/events', eve, event)).status).toBe(403);

    // Shared to view.
    await call('PUT', `/api/calendars/${calId}/shares`, sam, { shares: [{ userId: eveId, canEdit: false }] });
    const eveCals = (await call('GET', '/api/calendars', eve)).body as { id: string; access: string; ownerName: string }[];
    expect(eveCals.find((c) => c.id === calId)).toMatchObject({ access: 'view', ownerName: 'sam' });
    expect((await call('GET', range, eve)).body).toHaveLength(1);
    expect((await call('PUT', `/api/events/${created.body.id}`, eve, { ...event, title: 'Mine now' })).status).toBe(404);
    expect((await call('PUT', `/api/calendars/${calId}`, eve, { name: 'x', color: '#000000' })).status).toBe(403);
    expect((await call('PUT', `/api/calendars/${calId}/shares`, eve, { shares: [] })).status).toBe(403);

    // Hiding it is per person.
    await call('PUT', `/api/calendars/${calId}/visible`, eve, { visible: false });
    expect((await call('GET', range, eve)).body).toEqual([]);
    expect((await call('GET', range, sam)).body).toHaveLength(1);
    await call('PUT', `/api/calendars/${calId}/visible`, eve, { visible: true });

    // Edit access.
    await call('PUT', `/api/calendars/${calId}/shares`, sam, { shares: [{ userId: eveId, canEdit: true }] });
    expect((await call('PUT', `/api/events/${created.body.id}`, eve, { ...event, title: 'Moved' })).body.title).toBe('Moved');

    // Eve leaves; Sam's calendar stays.
    await call('DELETE', `/api/calendars/${calId}`, eve);
    expect((await call('GET', range, eve)).body).toEqual([]);
    expect((await call('GET', range, sam)).body[0].title).toBe('Moved');

    // Deleting the calendar deletes its events.
    await call('DELETE', `/api/calendars/${calId}`, sam);
    expect((await call('GET', range, sam)).body).toEqual([]);
  });

  it('checks events and mailbox grouping', async () => {
    const { sam, eve } = await start();
    const calId = (await call('GET', '/api/calendars', sam)).body[0].id as string;
    expect((await call('POST', '/api/events', sam, { calendarId: calId, title: 'Back to the future', start: '2026-03-02T10:00:00.000Z', end: '2026-03-02T09:00:00.000Z' })).status).toBe(400);
    expect((await call('GET', '/api/events?from=2026-01-01T00:00:00.000Z&to=2028-01-01T00:00:00.000Z', sam)).status).toBe(400);
    // Can't group under someone else's (or a missing) mailbox.
    expect((await call('POST', '/api/calendars', sam, { name: 'Work', color: '#3b82f6', accountId: 'nope' })).status).toBe(404);
    const made = await call('POST', '/api/calendars', sam, { name: 'Work', color: '#3b82f6' });
    expect(made.body.map((c: { name: string }) => c.name)).toEqual(['Personal', 'Work']);
    // Someone else's event id is "not found".
    const e = await call('POST', '/api/events', sam, { calendarId: calId, title: 'Mine', start: '2026-03-02T09:00:00.000Z', end: '2026-03-02T10:00:00.000Z' });
    expect((await call('DELETE', `/api/events/${e.body.id}`, eve)).status).toBe(404);
    expect((await call('DELETE', `/api/events/${e.body.id}`, sam)).status).toBe(200);
  });
});
