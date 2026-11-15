// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Against a real CalDAV server, only when one is given:
//   DREYMAIL_TEST_CALDAV_URL=http://127.0.0.1:5232/ DREYMAIL_TEST_CALDAV_USER=sam DREYMAIL_TEST_CALDAV_PASSWORD=… npx vitest run server/test/caldav-live.test.ts
// The account needs one empty event calendar (the test adds and removes its own events).

import { describe, expect, it } from 'vitest';
import { CalDavCalendar, type Http } from '../src/calendar/remote.js';

const url = process.env.DREYMAIL_TEST_CALDAV_URL;
const live = describe.skipIf(!url);

live('CalDAV server', () => {
  const dav = new CalDavCalendar(url ?? '', process.env.DREYMAIL_TEST_CALDAV_USER ?? '', process.env.DREYMAIL_TEST_CALDAV_PASSWORD ?? '', fetch as unknown as Http, async () => {});
  const from = Date.parse('2026-11-01T00:00:00Z');
  const to = Date.parse('2026-12-01T00:00:00Z');

  it('finds calendars, and adds, reads, changes and deletes events', async () => {
    const cals = await dav.listCalendars();
    expect(cals.length).toBeGreaterThan(0);
    const cal = cals[0]!;
    expect(cal.writable).toBe(true);

    await dav.create(cal.remoteId, { title: 'One-off', location: 'Room 1', notes: 'n', start: '2026-11-16T15:00:00.000Z', end: '2026-11-16T16:00:00.000Z', allDay: false, recurrence: 'none', until: null });
    await dav.create(cal.remoteId, { title: 'Weekly', location: '', notes: '', start: '2026-11-02T14:00:00.000Z', end: '2026-11-02T14:30:00.000Z', allDay: false, recurrence: 'weekly', until: null, timeZone: 'America/New_York' });
    await dav.create(cal.remoteId, { title: 'Trip', location: '', notes: '', start: '2026-11-20T00:00:00.000Z', end: '2026-11-23T00:00:00.000Z', allDay: true, recurrence: 'none', until: null });

    let events = await dav.events(cal.remoteId, from, to);
    const one = events.find((e) => e.title === 'One-off')!;
    expect(one).toMatchObject({ start: '2026-11-16T15:00:00.000Z', location: 'Room 1', instance: false, readOnly: false });
    const weekly = events.filter((e) => e.title === 'Weekly');
    expect(weekly.map((e) => e.start)).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-09T14:00:00.000Z', '2026-11-16T14:00:00.000Z', '2026-11-23T14:00:00.000Z', '2026-11-30T14:00:00.000Z']);
    expect(weekly.every((e) => e.instance && e.readOnly)).toBe(true);
    expect(events.find((e) => e.title === 'Trip')).toMatchObject({ allDay: true, start: '2026-11-20T00:00:00.000Z', end: '2026-11-23T00:00:00.000Z' });

    await dav.update(cal.remoteId, one.remoteId, { title: 'Moved', location: '', notes: '', start: '2026-11-17T15:00:00.000Z', end: '2026-11-17T16:00:00.000Z', allDay: false, recurrence: 'none', until: null });
    events = await dav.events(cal.remoteId, from, to);
    expect(events.find((e) => e.remoteId === one.remoteId)).toMatchObject({ title: 'Moved', start: '2026-11-17T15:00:00.000Z' });

    // Clean up: delete everything this test made.
    const hrefs = new Set(events.map((e) => e.remoteId.split('#')[0]!));
    for (const h of hrefs) await dav.remove(cal.remoteId, h);
    expect(await dav.events(cal.remoteId, from, to)).toEqual([]);
  });

  it('refuses a wrong password', async () => {
    const wrong = new CalDavCalendar(url ?? '', process.env.DREYMAIL_TEST_CALDAV_USER ?? '', 'wrong-password', fetch as unknown as Http, async () => {});
    await expect(wrong.listCalendars()).rejects.toThrow(/username or password/);
  });
});
