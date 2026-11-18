// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarEvent, CalendarView } from '../../shared/calendar.js';
import { buildApp, type App } from '../src/app.js';
import { findInvite, inviteView } from '../src/calendar/invites.js';
import { GoogleCalendar, OutlookCalendar, RemoteCalendarError, type Http } from '../src/calendar/remote.js';
import { CalendarService, type CalendarRow } from '../src/calendar/service.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { parseRaw } from '../src/mail/parse.js';
import type { FetchLike } from '../src/oauth/microsoft.js';

const secret = crypto.randomBytes(48).toString('base64');

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}
/** A fake HTTP API: `routes` answers "METHOD /path" (query ignored) with JSON. */
function fakeApi(routes: Record<string, (s: Seen) => unknown>) {
  const seen: Seen[] = [];
  const http: Http = async (url, init) => {
    const u = new URL(url);
    const s: Seen = { method: init.method, url: u, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    seen.push(s);
    const key = `${init.method} ${u.pathname}`;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: `no route ${key}` } }), headers: { get: () => null } };
    const out = handler(s);
    if (out instanceof Response) return { ok: out.ok, status: out.status, text: () => out.text(), headers: out.headers };
    return { ok: true, status: 200, text: async () => (out === undefined ? '' : JSON.stringify(out)), headers: { get: () => null } };
  };
  return { http, seen };
}

describe('Google Calendar', () => {
  it('lists calendars, reads expanded events and writes changes', async () => {
    const api = fakeApi({
      'GET /calendar/v3/users/me/calendarList': () => ({
        items: [
          { id: 'sam@gmail.com', summary: 'sam@gmail.com', summaryOverride: 'Sam', backgroundColor: '#9fe1e7', accessRole: 'owner', selected: true },
          { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays', backgroundColor: '#16a765', accessRole: 'reader' },
        ],
      }),
      'GET /calendar/v3/calendars/sam%40gmail.com/events': () => ({
        items: [
          { id: 'e1', summary: 'Dentist', start: { dateTime: '2026-11-18T15:00:00-05:00' }, end: { dateTime: '2026-11-18T16:00:00-05:00' } },
          { id: 'e2_20261116', summary: 'Standup', recurringEventId: 'e2', start: { dateTime: '2026-11-16T09:00:00-05:00' }, end: { dateTime: '2026-11-16T09:15:00-05:00' } },
          { id: 'e3', summary: 'Trip', start: { date: '2026-11-20' }, end: { date: '2026-11-23' } },
          { id: 'gone', status: 'cancelled' },
        ],
      }),
      'POST /calendar/v3/calendars/sam%40gmail.com/events': () => ({ id: 'new1' }),
      'PATCH /calendar/v3/calendars/sam%40gmail.com/events/e2_20261116': () => ({}),
    });
    const g = new GoogleCalendar(async () => 'tok', api.http);
    expect(await g.listCalendars()).toEqual([
      { remoteId: 'sam@gmail.com', name: 'Sam', color: '#9fe1e7', writable: true, visibleByDefault: true },
      { remoteId: 'en.usa#holiday@group.v.calendar.google.com', name: 'Holidays', color: '#16a765', writable: false, visibleByDefault: false },
    ]);
    expect(api.seen[0]!.headers.authorization).toBe('Bearer tok');
    const events = await g.events('sam@gmail.com', Date.parse('2026-11-15T00:00:00Z'), Date.parse('2026-11-22T00:00:00Z'));
    expect(events.map((e) => [e.title, e.start, e.allDay, e.instance])).toEqual([
      ['Dentist', '2026-11-18T20:00:00.000Z', false, false],
      ['Standup', '2026-11-16T14:00:00.000Z', false, true],
      ['Trip', '2026-11-20T00:00:00.000Z', true, false],
    ]);
    expect(api.seen[1]!.url.searchParams.get('singleEvents')).toBe('true');

    await g.create('sam@gmail.com', { title: 'Gym', location: '', notes: '', start: '2026-11-17T12:00:00.000Z', end: '2026-11-17T13:00:00.000Z', allDay: false, recurrence: 'weekly', until: null, timeZone: 'America/Chicago' });
    expect(api.seen.at(-1)!.body).toMatchObject({ summary: 'Gym', start: { dateTime: '2026-11-17T12:00:00.000Z', timeZone: 'America/Chicago' }, recurrence: ['RRULE:FREQ=WEEKLY'] });
    // One occurrence: no recurrence field, so the series stays as it is.
    await g.update('sam@gmail.com', 'e2_20261116', { title: 'Standup (late)', location: '', notes: '', start: '2026-11-16T15:00:00.000Z', end: '2026-11-16T15:15:00.000Z', allDay: false, recurrence: 'none', until: null }, true);
    expect(api.seen.at(-1)!.body.recurrence).toBeUndefined();
  });

  it('answers invitations through Google (which tells the organizer)', async () => {
    const api = fakeApi({
      'GET /calendar/v3/calendars/primary/events': () => ({ items: [{ id: 'inv1', attendees: [{ email: 'boss@example.com' }, { email: 'sam@gmail.com', self: true, responseStatus: 'needsAction' }] }] }),
      'GET /calendar/v3/calendars/primary/events/inv1': () => ({ id: 'inv1', attendees: [{ email: 'boss@example.com' }, { email: 'sam@gmail.com', self: true, responseStatus: 'needsAction' }] }),
      'PATCH /calendar/v3/calendars/primary/events/inv1': () => ({}),
    });
    const g = new GoogleCalendar(async () => 'tok', api.http);
    expect(await g.findInvite('uid-1')).toEqual({ eventId: 'inv1', answer: null });
    expect(api.seen[0]!.url.searchParams.get('iCalUID')).toBe('uid-1');
    await g.answerInvite('inv1', 'accepted');
    const patch = api.seen.at(-1)!;
    expect(patch.url.searchParams.get('sendUpdates')).toBe('all');
    expect(patch.body.attendees[1]).toEqual({ email: 'sam@gmail.com', self: true, responseStatus: 'accepted' });
  });

  it('explains missing calendar access and a disabled API', async () => {
    const scope = fakeApi({ 'GET /calendar/v3/users/me/calendarList': () => new Response(JSON.stringify({ error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } }), { status: 403 }) });
    const err = await new GoogleCalendar(async () => 't', scope.http).listCalendars().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCalendarError);
    expect((err as RemoteCalendarError).reconnect).toBe(true);
    const off = fakeApi({ 'GET /calendar/v3/users/me/calendarList': () => new Response(JSON.stringify({ error: { message: 'Google Calendar API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } }), { status: 403 }) });
    await expect(new GoogleCalendar(async () => 't', off.http).listCalendars()).rejects.toThrow(/Google Calendar API is turned off/);
  });
});

describe('Outlook calendar (Microsoft Graph)', () => {
  it('reads events in UTC and writes local times with the time zone', async () => {
    const api = fakeApi({
      'GET /v1.0/me/calendars': () => ({ value: [{ id: 'c1', name: 'Calendar', color: 'auto', hexColor: '#3f51b5', canEdit: true, isDefaultCalendar: true }, { id: 'c2', name: 'Birthdays', color: 'lightPink', canEdit: false }] }),
      'GET /v1.0/me/calendars/c1/calendarView': () => ({
        value: [
          { id: 'o1', subject: 'Review', start: { dateTime: '2026-11-16T15:00:00.0000000' }, end: { dateTime: '2026-11-16T16:00:00.0000000' }, type: 'occurrence', body: { content: ' notes ' }, location: { displayName: 'Room 4' } },
          { id: 'a1', subject: 'Off', isAllDay: true, start: { dateTime: '2026-11-27T00:00:00.0000000' }, end: { dateTime: '2026-11-28T00:00:00.0000000' } },
          { id: 'x', subject: 'Canceled', isCancelled: true, start: { dateTime: '2026-11-16T15:00:00' }, end: { dateTime: '2026-11-16T16:00:00' } },
        ],
      }),
      'POST /v1.0/me/calendars/c1/events': () => ({ id: 'n1' }),
      'GET /v1.0/me/events': () => ({ value: [{ id: 'm1', responseStatus: { response: 'tentativelyAccepted' } }] }),
      'POST /v1.0/me/events/m1/decline': () => undefined,
    });
    const o = new OutlookCalendar(async () => 'tok', api.http);
    const cals = await o.listCalendars();
    expect(cals.map((c) => [c.name, c.color, c.writable, c.visibleByDefault])).toEqual([
      ['Calendar', '#3f51b5', true, true],
      ['Birthdays', '#e06aa6', false, false],
    ]);
    const events = await o.events('c1', Date.parse('2026-11-15T00:00:00Z'), Date.parse('2026-12-01T00:00:00Z'));
    expect(api.seen.at(-1)!.headers.prefer).toContain('outlook.timezone="UTC"');
    expect(events.map((e) => [e.title, e.start, e.allDay, e.instance, e.notes, e.location])).toEqual([
      ['Review', '2026-11-16T15:00:00.000Z', false, true, 'notes', 'Room 4'],
      ['Off', '2026-11-27T00:00:00.000Z', true, false, '', ''],
    ]);
    await o.create('c1', { title: 'Weekly sync', location: 'Teams', notes: '', start: '2026-11-17T17:00:00.000Z', end: '2026-11-17T17:30:00.000Z', allDay: false, recurrence: 'weekly', until: '2026-12-31', timeZone: 'America/Los_Angeles' });
    expect(api.seen.at(-1)!.body).toMatchObject({
      subject: 'Weekly sync',
      start: { dateTime: '2026-11-17T09:00:00', timeZone: 'America/Los_Angeles' },
      recurrence: { pattern: { type: 'weekly', daysOfWeek: ['tuesday'] }, range: { type: 'endDate', startDate: '2026-11-17', endDate: '2026-12-31' } },
    });
    expect(await o.findInvite("it's-uid")).toEqual({ eventId: 'm1', answer: 'tentative' });
    expect(api.seen.at(-1)!.url.searchParams.get('$filter')).toBe("iCalUId eq 'it''s-uid'");
    await o.answerInvite('m1', 'declined');
    expect(api.seen.at(-1)!.body).toEqual({ sendResponse: true });
  });
});

// ---- through the app ---------------------------------------------------------------------------

let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

describe('provider calendars in the calendar', () => {
  it('mirrors the calendar list, shows events and writes changes for a Google mailbox', async () => {
    const tokenFetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'g-at', expires_in: 3600 }), text: async () => '' });
    let lists = 0;
    const api = fakeApi({
      'GET /calendar/v3/users/me/calendarList': () => (lists++, { items: [{ id: 'primary-id', summary: 'Sam', backgroundColor: '#9fe1e7', accessRole: 'owner', selected: true }, { id: 'hol', summary: 'Holidays', accessRole: 'reader' }] }),
      'GET /calendar/v3/calendars/primary-id/events': () => ({ items: [{ id: 'e1', summary: 'Dentist', start: { dateTime: '2026-11-18T15:00:00Z' }, end: { dateTime: '2026-11-18T16:00:00Z' } }] }),
      'PATCH /calendar/v3/calendars/primary-id/events/e1': () => ({}),
      'DELETE /calendar/v3/calendars/primary-id/events/e1': () => undefined,
    });
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com', DREYMAIL_REGISTRATION: 'open', DREYMAIL_GOOGLE_CLIENT_ID: 'id', DREYMAIL_GOOGLE_CLIENT_SECRET: 's' }), {
      store,
      logger: false,
      cacheFile: null,
      googleFetch: tokenFetch,
      calendarFetch: api.http,
    });
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
    const headers = { cookie: `dm_session=${res.cookies.find((c) => c.name === 'dm_session')!.value}`, 'x-dreymail': '1' };
    const user = store.listUsers()[0]!;
    const gmail = store.saveGoogleAccount(user.id, { email: 'sam@gmail.com', name: 'Gmail', displayName: 'Sam', color: '#ef4444', refreshToken: 'rt' });

    const cals = (await ctx.app.inject({ method: 'GET', url: '/api/calendars', headers })).json() as CalendarView[];
    expect(cals.map((c) => [c.name, c.source, c.accountId, c.visible, c.access])).toEqual([
      ['Personal', 'local', null, true, 'owner'],
      ['Sam', 'google', gmail.id, true, 'owner'],
      ['Holidays', 'google', gmail.id, false, 'view'],
    ]);
    // The list isn't fetched again within a few minutes, unless asked.
    await ctx.app.inject({ method: 'GET', url: '/api/calendars', headers });
    expect(lists).toBe(1);
    await ctx.app.inject({ method: 'GET', url: '/api/calendars?refresh=1', headers });
    expect(lists).toBe(2);

    const range = '/api/events?from=2026-11-15T00:00:00.000Z&to=2026-11-22T00:00:00.000Z';
    const events = (await ctx.app.inject({ method: 'GET', url: range, headers })).json() as CalendarEvent[];
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev).toMatchObject({ title: 'Dentist', calendarId: cals[1]!.id });
    expect(ev.id).toContain('~');

    const put = await ctx.app.inject({ method: 'PUT', url: `/api/events/${ev.id}`, headers, payload: { ...ev, title: 'Dentist (moved)', timeZone: 'America/New_York' } });
    expect(put.statusCode).toBe(200);
    expect(api.seen.at(-1)).toMatchObject({ method: 'PATCH', body: { summary: 'Dentist (moved)' } });
    // Not into another calendar, and not someone else's.
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/events/${ev.id}`, headers, payload: { ...ev, calendarId: cals[0]!.id } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/events', headers, payload: { ...ev, calendarId: cals[2]!.id } })).statusCode).toBe(403);
    // Provider calendars can't be shared or deleted in DreyMail; only recolored.
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/calendars/${cals[1]!.id}/shares`, headers, payload: { shares: [] } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/calendars/${cals[1]!.id}`, headers })).statusCode).toBe(400);
    const recolored = (await ctx.app.inject({ method: 'PUT', url: `/api/calendars/${cals[1]!.id}`, headers, payload: { name: 'ignored', color: '#123456' } })).json() as CalendarView[];
    expect(recolored[1]).toMatchObject({ name: 'Sam', color: '#123456' });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/events/${ev.id}`, headers })).statusCode).toBe(200);

    const sources = (await ctx.app.inject({ method: 'GET', url: '/api/calendar-sources', headers })).json();
    expect(sources).toEqual([{ id: gmail.id, kind: 'google', name: 'Gmail', accountId: gmail.id, error: null, reconnect: false }]);
  });
});

// ---- invitations ---------------------------------------------------------------------------------

const INVITE = (method: string) =>
  Buffer.from(
    [
      'From: Boss <boss@example.com>',
      'To: sam@example.com',
      'Subject: Invitation: Planning',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'You are invited.',
      '--b',
      `Content-Type: text/calendar; charset=utf-8; method=${method}`,
      '',
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `METHOD:${method}`,
      'BEGIN:VEVENT',
      'UID:plan-1@example.com',
      'SEQUENCE:0',
      'DTSTART;TZID=W. Europe Standard Time:20261120T150000',
      'DTEND;TZID=W. Europe Standard Time:20261120T160000',
      'RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=4',
      'SUMMARY:Planning',
      'LOCATION:Room 2',
      'ORGANIZER;CN=Boss:mailto:boss@example.com',
      'ATTENDEE;CN=Sam;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:sam@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
      '--b--',
      '',
    ].join('\r\n'),
  );

describe('invitations', () => {
  it('finds the invitation in a message', async () => {
    const view = inviteView(findInvite(await parseRaw(INVITE('REQUEST'))));
    expect(view).toMatchObject({
      method: 'REQUEST',
      uid: 'plan-1@example.com',
      title: 'Planning',
      start: '2026-11-20T14:00:00.000Z',
      location: 'Room 2',
      organizer: { email: 'boss@example.com', name: 'Boss' },
      repeats: 'Repeats every week on Fri, 4 times',
    });
    expect(view!.attendees).toEqual([{ email: 'sam@example.com', name: 'Sam', status: 'NEEDS-ACTION' }]);
  });

  it('answers by email for IMAP mailboxes and adds accepted events to the chosen calendar', async () => {
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    const user = store.upsertUser('local', 'sam', '', 'Sam');
    const acc = store.createAccount(user.id, {
      name: 'Work',
      displayName: 'Sam',
      email: 'sam@example.com',
      color: '#22d3ee',
      imap: { host: 'imap.example.com', port: 993, tls: 'tls', user: 'sam', password: 'x' },
      smtp: { host: 'smtp.example.com', port: 465, tls: 'tls', user: 'sam', password: 'x' },
      appendSent: false,
    });
    const calId = crypto.randomUUID();
    store.db.prepare('INSERT INTO calendars (id, owner_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').run(calId, user.id, 'Personal', '#22d3ee', 1);
    const sent: { to: string; subject: string; ics: string }[] = [];
    const svc = new CalendarService({
      store,
      google: {} as never,
      microsoft: {} as never,
      mail: { getParsed: async () => parseRaw(INVITE('REQUEST')) } as never,
      compose: { sendInvitationReply: async (_u: string, _a: string, r: { to: string; subject: string; ics: string }) => void sent.push(r) } as never,
      http: (async () => {
        throw new Error('no network');
      }) as never,
      blockPrivateHosts: false,
      maxMessageBytes: 1e7,
    });
    const ref = { accountId: acc.id, folder: 'INBOX', uid: 1, uidValidity: '1' };
    const canUse = (id: string) => (store.db.prepare('SELECT * FROM calendars WHERE id = ?').get(id) as CalendarRow | undefined) ?? null;

    const state = await svc.answer(user.id, ref, 'accepted', calId, canUse);
    expect(state).toEqual({ answer: 'accepted', calendar: 'Personal', viaProvider: false, removable: true });
    expect(sent[0]).toMatchObject({ to: 'boss@example.com', subject: 'Accepted: Planning' });
    expect(sent[0]!.ics).toContain('ATTENDEE;PARTSTAT=ACCEPTED;CN=Sam:mailto:sam@example.com');
    const copies = store.db.prepare('SELECT title, start_at, recurrence, repeat_count, reminder, notes FROM calendar_events WHERE ical_uid = ?').all('plan-1@example.com') as { title: string; start_at: number; recurrence: string; notes: string }[];
    expect(copies).toHaveLength(1);
    // Every week, 4 times: DreyMail's own repeats hold that now (9.5), with the usual reminder.
    expect(copies[0]).toMatchObject({ title: 'Planning', start_at: Date.parse('2026-11-20T14:00:00Z'), recurrence: 'weekly', repeat_count: 4, reminder: 15 });
    expect(copies[0]!.notes).not.toContain('Repeats every');

    // Answering again replaces the copy; declining removes it.
    await svc.answer(user.id, ref, 'tentative', calId, canUse);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE ical_uid = ?').get('plan-1@example.com')).toEqual({ n: 1 });
    const declined = await svc.answer(user.id, ref, 'declined', null, canUse);
    expect(declined).toMatchObject({ answer: 'declined', calendar: null, removable: false });
    expect(sent.map((s) => s.subject)).toEqual(['Accepted: Planning', 'Tentative: Planning', 'Declined: Planning']);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE ical_uid = ?').get('plan-1@example.com')).toEqual({ n: 0 });

    // A cancellation removes what was added.
    await svc.answer(user.id, ref, 'accepted', calId, canUse);
    await svc.removeInvite(user.id, 'plan-1@example.com');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE ical_uid = ?').get('plan-1@example.com')).toEqual({ n: 0 });
    expect(await svc.inviteState(user.id, acc.id, 'plan-1@example.com')).toMatchObject({ answer: null, removable: false });
  });
});

describe('proposing a new time (10.8)', () => {
  it('emails a COUNTER as a guest, and moves your own event when you accept one', async () => {
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
    const acc = store.createAccount(user.id, { name: 'Mail', displayName: 'Sam', email: 'sam@example.com', color: '#22d3ee', imap: { host: 'i', port: 993, tls: 'tls', user: 's', password: 'p' }, smtp: { host: 's', port: 465, tls: 'tls', user: 's', password: 'p' }, appendSent: true } as never);
    const sent: { to: string[]; method: string; ics: string }[] = [];
    let message = INVITE('REQUEST');
    const svc = new CalendarService({
      store,
      google: {} as never,
      microsoft: {} as never,
      mail: { getParsed: async () => parseRaw(message) } as never,
      compose: { sendInvitation: async (_u: string, _a: string, r: { to: string[]; method: string; ics: string }) => void sent.push(r) } as never,
      http: (async () => {
        throw new Error('no network');
      }) as never,
      blockPrivateHosts: false,
      maxMessageBytes: 1e7,
    });
    const ref = { accountId: acc.id, folder: 'INBOX', uid: 1, uidValidity: '1' };
    await svc.propose(user.id, ref, { answer: 'tentative', start: Date.parse('2026-11-20T16:00:00Z'), end: Date.parse('2026-11-20T17:00:00Z'), comment: 'After lunch?' });
    expect(sent[0]).toMatchObject({ to: ['boss@example.com'], method: 'COUNTER' });
    expect(sent[0]!.ics).toContain('DTSTART:20261120T160000Z');
    expect(sent[0]!.ics).toContain('PARTSTAT=TENTATIVE');

    // Now Sam organizes "plan-1" in DreyMail, and the boss proposes 16:00 back.
    const calId = crypto.randomUUID();
    store.db.prepare('INSERT INTO calendars (id, owner_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').run(calId, user.id, 'Work', '#22d3ee', 1);
    svc.local.insert({ calendarId: calId, title: 'Planning', start: '2026-11-20T14:00:00.000Z', end: '2026-11-20T15:00:00.000Z', allDay: false, location: '', notes: '', recurrence: 'none', until: null, attendees: [{ email: 'boss@example.com', name: 'Boss', status: 'needs-action' }] }, user.id, { email: 'sam@example.com', name: 'Sam' }, 'plan-1@example.com');
    message = Buffer.from(INVITE('COUNTER').toString().replace('DTSTART;TZID=W. Europe Standard Time:20261120T150000', 'DTSTART:20261120T160000Z').replace('DTEND;TZID=W. Europe Standard Time:20261120T160000', 'DTEND:20261120T170000Z').replace('ATTENDEE;CN=Sam;PARTSTAT=NEEDS-ACTION', 'ATTENDEE;CN=Boss;PARTSTAT=TENTATIVE').replace('mailto:sam@example.com', 'mailto:boss@example.com'));
    expect(await svc.answerCounter(user.id, ref, true)).toEqual({ moved: true });
    const row = store.db.prepare('SELECT start_at FROM calendar_events WHERE ical_uid = ?').get('plan-1@example.com') as { start_at: number };
    expect(new Date(row.start_at).toISOString()).toBe('2026-11-20T16:00:00.000Z');
    expect(sent.at(-1)).toMatchObject({ to: ['boss@example.com'], method: 'REQUEST' });
    // Declining tells the guest.
    await svc.answerCounter(user.id, ref, false);
    expect(sent.at(-1)).toMatchObject({ to: ['boss@example.com'], method: 'DECLINECOUNTER' });
  });
});
