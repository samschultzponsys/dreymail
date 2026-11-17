// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { normalizeZones, serialize, storableIcs, describeRule, eventsOf, expandRule, newEventIcs, occurrencesOf, parseIcal, replyIcs, simpleRecurrence, updateEventIcs, wallToUtc, utcToWall } from '../src/calendar/ical.js';

const cal = (body: string) => parseIcal(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`)[0]!;
const iso = (ms: number) => new Date(ms).toISOString();

describe('iCalendar times', () => {
  it('reads UTC, IANA, Windows and all-day times', () => {
    const c = cal(
      'BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261116T090000Z\r\nDTEND:20261116T100000Z\r\nSUMMARY:Plain\\, simple\r\nEND:VEVENT\r\n' +
        'BEGIN:VEVENT\r\nUID:b\r\nDTSTART;TZID=America/New_York:20260710T090000\r\nDURATION:PT30M\r\nEND:VEVENT\r\n' +
        'BEGIN:VEVENT\r\nUID:c\r\nDTSTART;TZID="Pacific Standard Time":20261201T090000\r\nDTEND;TZID="Pacific Standard Time":20261201T100000\r\nEND:VEVENT\r\n' +
        'BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261226\r\nEND:VEVENT\r\n',
    );
    const [a, b, c2, d] = eventsOf(c);
    expect(a!.title).toBe('Plain, simple');
    expect(iso(b!.start.ms)).toBe('2026-07-10T13:00:00.000Z'); // EDT
    expect(b!.end - b!.start.ms).toBe(30 * 60_000);
    expect(iso(c2!.start.ms)).toBe('2026-12-01T17:00:00.000Z'); // PST
    expect(d!.allDay).toBe(true);
    expect(iso(d!.start.ms)).toBe('2026-12-24T00:00:00.000Z');
    expect(iso(d!.end)).toBe('2026-12-26T00:00:00.000Z');
  });

  it("uses the file's VTIMEZONE for names it doesn't know", () => {
    const c = cal(
      'BEGIN:VTIMEZONE\r\nTZID:Custom Zone\r\nBEGIN:STANDARD\r\nDTSTART:16011104T020000\r\nRRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010311T020000\r\nRRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n' +
        'BEGIN:VEVENT\r\nUID:s\r\nDTSTART;TZID=Custom Zone:20260710T090000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=Custom Zone:20260110T090000\r\nEND:VEVENT\r\n',
    );
    const [summer, winter] = eventsOf(c);
    expect(iso(summer!.start.ms)).toBe('2026-07-10T13:00:00.000Z');
    expect(iso(winter!.start.ms)).toBe('2026-01-10T14:00:00.000Z');
  });

  it('converts between wall time and UTC across daylight saving', () => {
    expect(iso(wallToUtc(Date.UTC(2026, 2, 9, 9), 'America/Chicago'))).toBe('2026-03-09T14:00:00.000Z');
    expect(iso(utcToWall(Date.parse('2026-03-09T14:00:00Z'), 'America/Chicago'))).toBe('2026-03-09T09:00:00.000Z');
  });
});

describe('repeat rules', () => {
  const ev = (rule: string, start = 'DTSTART;TZID=America/New_York:20261102T090000', extra = '') =>
    eventsOf(cal(`BEGIN:VEVENT\r\nUID:r\r\n${start}\r\nDURATION:PT1H\r\nRRULE:${rule}\r\n${extra}END:VEVENT\r\n`));

  it('keeps local time across a daylight-saving change', () => {
    const occ = occurrencesOf(ev('FREQ=WEEKLY;COUNT=3', 'DTSTART;TZID=America/New_York:20261026T090000'), Date.parse('2026-10-01Z'), Date.parse('2026-12-01Z'));
    expect(occ.map((o) => iso(o.start))).toEqual(['2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-09T14:00:00.000Z']);
  });

  it('weekly on several days, every other week', () => {
    const occ = occurrencesOf(ev('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261130T235959Z'), Date.parse('2026-11-01Z'), Date.parse('2027-01-01Z'));
    expect(occ.map((o) => iso(o.start).slice(0, 10))).toEqual(['2026-11-02', '2026-11-04', '2026-11-16', '2026-11-18', '2026-11-30']);
  });

  it('monthly on the 2nd Tuesday and the last Friday; EXDATE and changed occurrences', () => {
    const second = occurrencesOf(ev('FREQ=MONTHLY;BYDAY=2TU;COUNT=3', 'DTSTART:20261110T150000Z'), 0, Date.parse('2028-01-01Z'));
    expect(second.map((o) => iso(o.start).slice(0, 10))).toEqual(['2026-11-10', '2026-12-08', '2027-01-12']);
    const last = occurrencesOf(ev('FREQ=MONTHLY;BYDAY=-1FR;COUNT=2', 'DTSTART:20261127T150000Z'), 0, Date.parse('2028-01-01Z'));
    expect(last.map((o) => iso(o.start).slice(0, 10))).toEqual(['2026-11-27', '2026-12-25']);
    const withEx = eventsOf(
      cal(
        'BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261102T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEXDATE:20261103T090000Z\r\nSUMMARY:Daily\r\nEND:VEVENT\r\n' +
          'BEGIN:VEVENT\r\nUID:x\r\nRECURRENCE-ID:20261104T090000Z\r\nDTSTART:20261104T120000Z\r\nDURATION:PT1H\r\nSUMMARY:Moved\r\nEND:VEVENT\r\n',
      ),
    );
    const occ = occurrencesOf(withEx, 0, Date.parse('2027-01-01Z'));
    expect(occ.map((o) => `${iso(o.start).slice(5, 13)} ${o.event.title}`)).toEqual(['11-02T09 Daily', '11-04T12 Moved', '11-05T09 Daily']);
  });

  it('yearly all-day birthdays, and 31st-of-month skipping', () => {
    const bday = occurrencesOf(ev('FREQ=YEARLY', 'DTSTART;VALUE=DATE:20240229'), 0, Date.parse('2029-01-01Z'));
    expect(bday.map((o) => iso(o.start).slice(0, 10))).toEqual(['2024-02-29', '2028-02-29']);
    const r = eventsOf(cal('BEGIN:VEVENT\r\nUID:m\r\nDTSTART:20260131T090000Z\r\nRRULE:FREQ=MONTHLY;COUNT=3\r\nEND:VEVENT\r\n'))[0]!;
    expect(expandRule(r.rrule!, r.start, 0, 0, Date.parse('2027-01-01Z'), new Set()).map((t) => iso(t).slice(0, 10))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
  });

  it('maps simple rules to DreyMail repeats and describes complex ones', () => {
    const e = ev('FREQ=WEEKLY;UNTIL=20261231T235959Z')[0]!;
    expect(simpleRecurrence(e.rrule!, e.start)).toEqual({ recurrence: 'weekly', until: '2026-12-31' });
    expect(simpleRecurrence('FREQ=WEEKLY;BYDAY=MO,WE', e.start)).toBeNull();
    expect(describeRule('FREQ=MONTHLY;BYDAY=2TU;UNTIL=20270101T000000Z')).toBe('Repeats every month on 2nd Tue until Jan 1, 2027');
  });
});

describe('writing', () => {
  it('makes, edits (keeping other properties) and re-reads events', () => {
    const { uid, ics } = newEventIcs({ title: 'Lunch; with Ada', location: 'Café', notes: 'line1\nline2', start: '2026-11-16T17:00:00.000Z', end: '2026-11-16T18:00:00.000Z', allDay: false, recurrence: 'weekly', until: '2026-12-31', timeZone: 'America/Los_Angeles' });
    expect(ics).toContain('DTSTART;TZID=America/Los_Angeles:20261116T090000');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;UNTIL=20270101T075959Z');
    const withAlarm = ics.replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nX-KEEP:yes\r\nEND:VEVENT');
    const edited = updateEventIcs(withAlarm, { title: 'Lunch moved', location: '', notes: '', start: '2026-11-17T17:00:00.000Z', end: '2026-11-17T18:00:00.000Z', allDay: false, recurrence: 'none', until: null });
    expect(edited).toContain('X-KEEP:yes');
    expect(edited).toContain('BEGIN:VALARM');
    expect(edited.slice(edited.indexOf('BEGIN:VEVENT'))).not.toContain('RRULE');
    const [e] = eventsOf(parseIcal(edited)[0]!);
    expect(e).toMatchObject({ uid, title: 'Lunch moved', sequence: 1 });
    expect(iso(e!.start.ms)).toBe('2026-11-17T17:00:00.000Z');
    const [orig] = eventsOf(parseIcal(ics)[0]!);
    expect(orig!.title).toBe('Lunch; with Ada');
    expect(orig!.description).toBe('line1\nline2');
  });

  it('stores invitations with time zones a CalDAV server understands', () => {
    const c = cal(
      'METHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART;TZID=Eastern Standard Time:20261120T140000\r\nDTEND;TZID=Mars/Olympus:20261120T150000\r\nEXDATE;TZID=America/Chicago:20261127T140000\r\nEND:VEVENT\r\n',
    );
    const out = storableIcs(c);
    expect(out).not.toContain('METHOD');
    expect(out).toContain('DTSTART;TZID=America/New_York:20261120T140000');
    expect(out).toContain('DTEND:20261120T150000Z'); // unknown zone: written as UTC
    expect(out).toContain('EXDATE;TZID=America/Chicago:20261127T140000');
    // A zone the file defines is left alone.
    const defined = cal('BEGIN:VTIMEZONE\r\nTZID:Eastern Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T000000\r\nTZOFFSETTO:-0500\r\nTZOFFSETFROM:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:d\r\nDTSTART;TZID=Eastern Standard Time:20261120T140000\r\nEND:VEVENT\r\n');
    expect(serialize(normalizeZones(defined))).toContain('DTSTART;TZID=Eastern Standard Time:20261120T140000');
  });

  it('answers an invitation with an iTIP REPLY', () => {
    const [invite] = eventsOf(
      cal('BEGIN:VEVENT\r\nUID:inv-1\r\nSEQUENCE:2\r\nDTSTART:20261120T150000Z\r\nDTEND:20261120T160000Z\r\nSUMMARY:Planning\r\nORGANIZER;CN=Boss:mailto:boss@example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Sam@Example.com\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:other@example.com\r\nEND:VEVENT\r\n'),
    );
    expect(invite!.organizer).toEqual({ email: 'boss@example.com', name: 'Boss', status: 'NEEDS-ACTION' });
    expect(invite!.attendees.map((a) => a.email)).toEqual(['sam@example.com', 'other@example.com']);
    const reply = replyIcs(invite!, { email: 'sam@example.com', name: 'Sam' }, 'ACCEPTED');
    expect(reply).toContain('METHOD:REPLY');
    expect(reply).toContain('UID:inv-1');
    expect(reply).toContain('SEQUENCE:2');
    expect(reply).toContain('ATTENDEE;PARTSTAT=ACCEPTED;CN=Sam:mailto:sam@example.com');
    expect(reply).not.toContain('other@example.com');
  });
});
