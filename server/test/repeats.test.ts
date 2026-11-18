// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Richer repeats (9.5): every N, several weekdays, the n-th or last weekday, a number of times,
// skipped occurrences; the same rules at Google (RRULE), Outlook (Graph patterns) and CalDAV
// (overrides and EXDATE); invitations DreyMail sends for its own events.

import { describe, expect, it } from 'vitest';
import { describeRepeat, findJoinUrl, occurrences, ruleOf, type CalendarEvent } from '../../shared/calendar.js';
import {
  eventsOf,
  excludeOccurrenceIcs,
  fieldsOfIcs,
  itipFromStored,
  newEventIcs,
  occurrencesOf,
  overrideOccurrenceIcs,
  parseIcal,
  repeatFromRule,
  requestIcs,
  updateEventIcs,
  vtimezone,
  type EventFields,
} from '../src/calendar/ical.js';
import { graphRecurrence, repeatFromGraph } from '../src/calendar/remote.js';

const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e1',
  calendarId: 'c1',
  title: 'Standup',
  // Monday, March 2, 2026, 9:00 in New York.
  start: '2026-03-02T14:00:00.000Z',
  end: '2026-03-02T14:15:00.000Z',
  allDay: false,
  location: '',
  notes: '',
  recurrence: 'none',
  until: null,
  timeZone: 'America/New_York',
  ...over,
});
const days = (list: { occurrenceStart: string }[]) => list.map((o) => o.occurrenceStart.slice(0, 10));
const range = (a: string, b: string) => [Date.parse(`${a}T00:00:00Z`), Date.parse(`${b}T00:00:00Z`)] as const;

describe('repeats of DreyMail events', () => {
  it('repeats every N days, weeks and months', () => {
    expect(days(occurrences(ev({ recurrence: 'daily', interval: 3 }), ...range('2026-03-01', '2026-03-12')))).toEqual(['2026-03-02', '2026-03-05', '2026-03-08', '2026-03-11']);
    expect(days(occurrences(ev({ recurrence: 'weekly', interval: 2 }), ...range('2026-03-01', '2026-04-15')))).toEqual(['2026-03-02', '2026-03-16', '2026-03-30', '2026-04-13']);
    expect(days(occurrences(ev({ recurrence: 'monthly', interval: 3 }), ...range('2026-03-01', '2027-01-01')))).toEqual(['2026-03-02', '2026-06-02', '2026-09-02', '2026-12-02']);
  });

  it('repeats on several weekdays, keeping 9:00 across the daylight-saving change', () => {
    const list = occurrences(ev({ recurrence: 'weekly', byDay: [1, 3, 5] }), ...range('2026-03-01', '2026-03-14'));
    expect(days(list)).toEqual(['2026-03-02', '2026-03-04', '2026-03-06', '2026-03-09', '2026-03-11', '2026-03-13']);
    // New York moves to summer time on March 8: 9:00 is 14:00 UTC before and 13:00 UTC after.
    expect(list[0]!.occurrenceStart).toBe('2026-03-02T14:00:00.000Z');
    expect(list[3]!.occurrenceStart).toBe('2026-03-09T13:00:00.000Z');
  });

  it('repeats on the n-th or last weekday of the month, and ends after a number of times', () => {
    // March 2 is the first Monday of March.
    expect(days(occurrences(ev({ recurrence: 'monthly', monthlyBy: 'weekday' }), ...range('2026-03-01', '2026-07-01')))).toEqual(['2026-03-02', '2026-04-06', '2026-05-04', '2026-06-01']);
    const last = ev({ start: '2026-03-30T13:00:00.000Z', end: '2026-03-30T14:00:00.000Z', recurrence: 'monthly', monthlyBy: 'last' });
    expect(days(occurrences(last, ...range('2026-03-01', '2026-07-01')))).toEqual(['2026-03-30', '2026-04-27', '2026-05-25', '2026-06-29']);
    expect(occurrences(ev({ recurrence: 'daily', count: 4 }), ...range('2026-03-01', '2026-04-01'))).toHaveLength(4);
  });

  it('leaves skipped occurrences out and ends on the until day', () => {
    const e = ev({ recurrence: 'daily', until: '2026-03-06', exdates: ['2026-03-04T14:00:00.000Z'] });
    expect(days(occurrences(e, ...range('2026-03-01', '2026-04-01')))).toEqual(['2026-03-02', '2026-03-03', '2026-03-05', '2026-03-06']);
  });

  it('writes and describes the rule', () => {
    const wall = Date.UTC(2026, 2, 2, 9);
    expect(ruleOf({ recurrence: 'weekly', until: null, byDay: [1, 2, 3, 4, 5] }, wall)).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(ruleOf({ recurrence: 'yearly', until: '2030-01-01', monthlyBy: 'weekday' }, wall)).toBe('FREQ=YEARLY;BYMONTH=3;BYDAY=1MO;UNTIL=20300101');
    expect(describeRepeat({ recurrence: 'weekly', until: null, byDay: [1, 2, 3, 4, 5] }, wall)).toBe('Every week on weekdays');
    expect(describeRepeat({ recurrence: 'monthly', until: null, interval: 2, monthlyBy: 'last' }, wall)).toBe('Every 2 months on the last Monday');
    expect(describeRepeat({ recurrence: 'daily', until: null, count: 5 }, wall)).toBe('Every day, 5 times');
  });
});

describe('rules from providers', () => {
  const start = { ms: Date.UTC(2026, 2, 2, 14), allDay: false, wall: Date.UTC(2026, 2, 2, 9), toUtc: (w: number) => w + 5 * 3_600_000 };
  it('reads RRULEs into the editor, or says it cannot', () => {
    expect(repeatFromRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10', start)).toMatchObject({ recurrence: 'weekly', interval: 2, byDay: [1, 3], count: 10 });
    expect(repeatFromRule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', start)).toMatchObject({ recurrence: 'weekly', byDay: [1, 2, 3, 4, 5] });
    expect(repeatFromRule('FREQ=MONTHLY;BYDAY=1MO', start)).toMatchObject({ recurrence: 'monthly', monthlyBy: 'weekday' });
    expect(repeatFromRule('FREQ=MONTHLY;BYDAY=-1MO', start)).toMatchObject({ monthlyBy: 'last' });
    expect(repeatFromRule('FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1', start)).toBeNull();
    expect(repeatFromRule('FREQ=WEEKLY;UNTIL=20260331T045959Z', start)).toMatchObject({ until: '2026-03-30' });
  });

  it('turns repeats into Outlook patterns and back', () => {
    const local = new Date(Date.UTC(2026, 2, 2, 9));
    const weekly = graphRecurrence({ recurrence: 'weekly', until: '2026-06-30', interval: 2, byDay: [1, 3] }, local)!;
    expect(weekly).toEqual({ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'sunday' }, range: { type: 'endDate', startDate: '2026-03-02', endDate: '2026-06-30' } });
    const monthly = graphRecurrence({ recurrence: 'monthly', until: null, monthlyBy: 'weekday', count: 6 }, local)!;
    expect(monthly).toEqual({ pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['monday'], index: 'first' }, range: { type: 'numbered', startDate: '2026-03-02', numberOfOccurrences: 6 } });
    expect(repeatFromGraph(weekly, local)).toMatchObject({ recurrence: 'weekly', interval: 2, byDay: [1, 3], until: '2026-06-30' });
    expect(repeatFromGraph(monthly, local)).toMatchObject({ recurrence: 'monthly', monthlyBy: 'weekday', count: 6 });
    expect(repeatFromGraph({ pattern: { type: 'absoluteMonthly', dayOfMonth: 15 }, range: { type: 'noEnd' } }, local)).toBeNull();
  });
});

describe('CalDAV series', () => {
  const base: EventFields = { title: 'Standup', location: '', notes: '', start: '2026-03-02T14:00:00.000Z', end: '2026-03-02T14:15:00.000Z', allDay: false, recurrence: 'weekly', until: null, byDay: [1, 3], timeZone: 'America/New_York', reminder: 10 };

  it('writes a time zone definition, an alarm, and reads the whole series back', () => {
    const { ics } = newEventIcs(base);
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toContain('TRIGGER:-PT10M');
    expect(fieldsOfIcs(ics)).toMatchObject({ recurrence: 'weekly', byDay: [1, 3], reminder: 10, timeZone: 'America/New_York', editable: true });
  });

  it('changes one occurrence and leaves another out', () => {
    const { ics } = newEventIcs(base);
    const wed = Date.parse('2026-03-04T14:00:00.000Z');
    const mon = Date.parse('2026-03-09T13:00:00.000Z');
    const moved = overrideOccurrenceIcs(ics, wed, { ...base, title: 'Standup (late)', start: '2026-03-04T16:00:00.000Z', end: '2026-03-04T16:15:00.000Z' });
    expect(moved).toContain('RECURRENCE-ID;TZID=America/New_York:20260304T090000');
    const skipped = excludeOccurrenceIcs(moved, mon);
    expect(skipped).toContain('EXDATE;TZID=America/New_York:20260309T090000');
    const cal = parseIcal(skipped)[0]!;
    const list = occurrencesOf(eventsOf(cal), Date.parse('2026-03-01T00:00:00Z'), Date.parse('2026-03-12T00:00:00Z'));
    expect(list.map((o) => [new Date(o.start).toISOString(), o.event.title])).toEqual([
      ['2026-03-02T14:00:00.000Z', 'Standup'],
      ['2026-03-04T16:00:00.000Z', 'Standup (late)'],
      ['2026-03-11T13:00:00.000Z', 'Standup'],
    ]);
  });

  it('asks the server to leave the guests to DreyMail, and emails them without that', () => {
    const f = { ...base, organizer: { email: 'me@example.com', name: 'Me' }, attendees: [{ email: 'ada@example.com', name: 'Ada', status: 'needs-action' as const }] };
    const { ics } = newEventIcs(f, 'u1@dreymail', { clientSchedules: true });
    expect(ics.replace(/\r\n /g, '')).toMatch(/ATTENDEE;CN=Ada;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;SCHEDULE-AGENT=CLIENT:mailto:ada@example.com/);
    const mail = itipFromStored(ics, 'REQUEST');
    expect(mail).toContain('METHOD:REQUEST');
    expect(mail).not.toContain('SCHEDULE-AGENT');
    expect(mail).not.toContain('VALARM');
    expect(itipFromStored(ics, 'CANCEL')).toContain('STATUS:CANCELLED');
    // Keeping the guest list when the editor doesn't send one.
    expect(updateEventIcs(ics, { ...base, title: 'Renamed' })).toContain('mailto:ada@example.com');
  });
});

describe('invitations from DreyMail events', () => {
  it('is an iTIP request with the organizer, guests and a zone', () => {
    const ics = requestIcs(
      'abc@dreymail',
      { title: 'Review', location: 'https://teams.microsoft.com/l/meetup-join/xyz', notes: '', start: '2026-11-20T15:00:00.000Z', end: '2026-11-20T16:00:00.000Z', allDay: false, recurrence: 'weekly', until: null, timeZone: 'Europe/Copenhagen', organizer: { email: 'me@example.com', name: 'Me' }, attendees: [{ email: 'bo@example.com', name: '', status: 'needs-action', optional: true }] },
      'REQUEST',
      2,
    );
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('ORGANIZER;CN=Me:mailto:me@example.com');
    expect(ics).toContain('ROLE=OPT-PARTICIPANT');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('TZID:Europe/Copenhagen');
    expect(ics).toContain('DTSTART;TZID=Europe/Copenhagen:20261120T160000');
  });

  it('makes zones that agree with the real offsets', () => {
    const z = vtimezone('Europe/Copenhagen', 2026)!;
    const text = JSON.stringify(z);
    expect(text).toContain('BYMONTH=3;BYDAY=-1SU');
    expect(text).toContain('BYMONTH=10;BYDAY=-1SU');
    expect(text).toContain('19700329T020000');
  });

  it('finds meeting links', () => {
    expect(findJoinUrl('Room 4', 'Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d.')).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d');
    expect(findJoinUrl('https://us02web.zoom.us/j/123456?pwd=abc')).toBe('https://us02web.zoom.us/j/123456?pwd=abc');
    expect(findJoinUrl('https://example.com/x')).toBeNull();
  });
});

describe('show as and free/busy (10.2)', () => {
  it('writes and reads "show as" in iCalendar', async () => {
    const { showAsOf } = await import('../src/calendar/ical.js');
    const { ics } = newEventIcs({ title: 'Lunch', location: '', notes: '', start: '2026-03-02T12:00:00.000Z', end: '2026-03-02T13:00:00.000Z', allDay: false, recurrence: 'none', until: null, showAs: 'away' });
    expect(ics).toContain('X-MICROSOFT-CDO-BUSYSTATUS:OOF');
    expect(showAsOf(parseIcal(ics)[0]!.children.find((c) => c.name === 'VEVENT')!)).toBe('away');
    expect(fieldsOfIcs(ics)).toMatchObject({ showAs: 'away' });
  });

  it("reads colleagues' busy times from Outlook", async () => {
    const { OutlookCalendar } = await import('../src/calendar/remote.js');
    const http = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          value: [
            { scheduleId: 'Ada@Corp.com', scheduleItems: [{ status: 'busy', start: { dateTime: '2026-11-18T14:00:00.0000000' }, end: { dateTime: '2026-11-18T15:00:00.0000000' } }, { status: 'free', start: { dateTime: '2026-11-18T16:00:00' }, end: { dateTime: '2026-11-18T17:00:00' } }] },
            { scheduleId: 'bob@else.com', error: { message: 'The mailbox was not found' } },
          ],
        }),
    });
    const o = new OutlookCalendar(async () => 't', http as never);
    const r = await o.freeBusy(['ada@corp.com', 'bob@else.com'], Date.parse('2026-11-18T00:00:00Z'), Date.parse('2026-11-19T00:00:00Z'));
    expect(r['ada@corp.com']).toEqual({ busy: [{ start: '2026-11-18T14:00:00.000Z', end: '2026-11-18T15:00:00.000Z', status: 'busy' }] });
    expect(r['bob@else.com']?.error).toBe('Not found in Outlook');
  });
});
