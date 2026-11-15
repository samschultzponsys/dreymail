// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// iCalendar (RFC 5545) for CalDAV calendars and invitations: parsing (keeping each property's raw
// line, so unknown properties survive an edit), time zones (IANA names, Windows names as Outlook
// sends them, and the VTIMEZONE in the file), repeat rules (RRULE with EXDATE and changed
// occurrences), and writing events and invitation answers (iTIP REPLY).

import crypto from 'node:crypto';
import type { Recurrence } from '../../../shared/calendar.js';

export interface IcalProp {
  name: string;
  params: Record<string, string>;
  value: string;
  /** The unfolded line, written back unchanged when the property isn't edited. */
  raw: string;
}

export interface IcalComponent {
  name: string;
  props: IcalProp[];
  children: IcalComponent[];
}

const DAY = 86_400_000;

// ---- parsing --------------------------------------------------------------------------------

function parseLine(line: string): IcalProp | null {
  let i = 0;
  let quoted = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const parts: string[] = [];
  let cur = '';
  quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0]!.toUpperCase(), params, value: line.slice(colon + 1), raw: line };
}

/** Parses an iCalendar file into its top-level components (normally one VCALENDAR). */
export function parseIcal(text: string): IcalComponent[] {
  const lines = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const roots: IcalComponent[] = [];
  const stack: IcalComponent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const c: IcalComponent = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      (stack.length ? stack[stack.length - 1]!.children : roots).push(c);
      stack.push(c);
      if (stack.length > 20) return roots;
    } else if (p.name === 'END') stack.pop();
    else stack[stack.length - 1]?.props.push(p);
  }
  return roots;
}

export const prop = (c: IcalComponent, name: string) => c.props.find((p) => p.name === name);
export const props = (c: IcalComponent, name: string) => c.props.filter((p) => p.name === name);

export function unescapeText(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}
export function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
}

// ---- time zones -------------------------------------------------------------------------------

/** Windows time zone names (as Outlook / Exchange invitations use them) → IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'SA Pacific Standard Time': 'America/Bogota',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Pacific SA Standard Time': 'America/Santiago',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Central Standard Time': 'Australia/Darwin',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Tasmania Standard Time': 'Australia/Hobart',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatter(tz: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tz)) {
    try {
      formatters.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    } catch {
      formatters.set(tz, null);
    }
  }
  return formatters.get(tz)!;
}

export const validTimeZone = (tz: string | undefined | null): tz is string => !!tz && formatter(tz) !== null;

/** The wall-clock time in `tz` at UTC `ms`, as a "wall" timestamp (its UTC fields are the local fields). */
export function utcToWall(ms: number, tz: string): number {
  const f = formatter(tz);
  if (!f) return ms;
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)])) as Record<string, number>;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) + (ms % 1000);
}

/** UTC time of a wall-clock time in `tz` (the earlier one when a fall-back hour repeats). */
export function wallToUtc(wall: number, tz: string): number {
  if (!formatter(tz)) return wall;
  const off1 = utcToWall(wall, tz) - wall;
  let t = wall - off1;
  const off2 = utcToWall(t, tz) - t;
  if (off2 !== off1) t = wall - off2;
  return t;
}

/** A time zone resolver for one file: IANA, Windows names, then the file's own VTIMEZONEs. */
export function zoneResolver(cal: IcalComponent | undefined): (tzid: string | undefined) => ((wall: number) => number) | null {
  const vtz = new Map<string, IcalComponent>();
  for (const c of cal?.children ?? []) if (c.name === 'VTIMEZONE') vtz.set(prop(c, 'TZID')?.value ?? '', c);
  return (tzid) => {
    if (!tzid) return null;
    const id = tzid.replace(/^\/+/, '').trim();
    const iana: string | undefined = validTimeZone(id) ? id : (WINDOWS_ZONES[id] ?? Object.entries(WINDOWS_ZONES).find(([k]) => tzid.includes(k))?.[1]);
    if (iana && validTimeZone(iana)) return (wall) => wallToUtc(wall, iana);
    const def = vtz.get(tzid) ?? vtz.get(id);
    if (def) return (wall) => wall - vtimezoneOffset(def, wall);
    return null;
  };
}

const offsetMs = (v: string | undefined) => {
  const m = /^([+-])(\d\d)(\d\d)(\d\d)?$/.exec(v?.trim() ?? '');
  return m ? (m[1] === '-' ? -1 : 1) * ((+m[2]! * 60 + +m[3]!) * 60 + +(m[4] ?? 0)) * 1000 : 0;
};

/** UTC offset of a VTIMEZONE at a wall time: the latest STANDARD/DAYLIGHT onset before it. */
function vtimezoneOffset(def: IcalComponent, wall: number): number {
  let best: { at: number; off: number } | null = null;
  for (const part of def.children) {
    const start = parseWall(prop(part, 'DTSTART')?.value ?? '');
    if (start === null) continue;
    const off = offsetMs(prop(part, 'TZOFFSETTO')?.value);
    const rrule = prop(part, 'RRULE')?.value;
    const year = new Date(wall).getUTCFullYear();
    const onsets = rrule ? [year - 1, year].flatMap((y) => yearlyOnset(rrule, start, y)) : [start];
    for (const at of onsets) if (at <= wall && at >= start && (!best || at > best.at)) best = { at, off };
  }
  return best?.off ?? offsetMs(prop(def.children[0] ?? def, 'TZOFFSETTO')?.value);
}

function yearlyOnset(rrule: string, start: number, year: number): number[] {
  const r = parseRule(rrule);
  const s = new Date(start);
  const month = r.bymonth[0] ?? s.getUTCMonth() + 1;
  const time = start - Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  const day = r.byday[0];
  if (day) {
    const d = nthWeekday(year, month - 1, day.weekday, day.n || 1);
    return d === null ? [] : [d + time];
  }
  return [Date.UTC(year, month - 1, s.getUTCDate()) + time];
}

/** "20261116T090000" / "20261116" as a wall timestamp; null if malformed. */
export function parseWall(v: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/.exec(v.trim());
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : null;
}

export interface IcalTime {
  /** UTC; for all-day values, midnight UTC of that date. */
  ms: number;
  allDay: boolean;
  /** The wall time the value was written in, and how to turn wall times into UTC (for repeats). */
  wall: number;
  toUtc: (wall: number) => number;
}

/** A DTSTART / DTEND / RECURRENCE-ID / EXDATE value. */
export function timeOf(p: IcalProp | undefined, resolve: ReturnType<typeof zoneResolver>, value = p?.value): IcalTime | null {
  if (!p || !value) return null;
  const wall = parseWall(value);
  if (wall === null) return null;
  const allDay = p.params.VALUE === 'DATE' || /^\d{8}$/.test(value.trim());
  if (allDay || /Z$/i.test(value.trim())) return { ms: wall, allDay, wall, toUtc: (w) => w };
  const zone = resolve(p.params.TZID);
  const toUtc = zone ?? ((w: number) => w); // floating times: treated as UTC
  return { ms: toUtc(wall), allDay: false, wall, toUtc };
}

export function parseDuration(v: string | undefined): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v?.trim() ?? '');
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ---- repeat rules -------------------------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

interface Rule {
  freq: string;
  interval: number;
  count: number | null;
  until: string | null;
  byday: { n: number; weekday: number }[];
  bymonthday: number[];
  bymonth: number[];
  bysetpos: number[];
}

export function parseRule(rule: string): Rule {
  const kv = Object.fromEntries(rule.replace(/^RRULE:/i, '').split(';').map((x) => x.split('=') as [string, string]).map(([k, v]) => [k?.toUpperCase(), v ?? '']));
  const ints = (v: string | undefined) => (v ? v.split(',').map(Number).filter((n) => Number.isFinite(n) && n !== 0) : []);
  return {
    freq: (kv.FREQ ?? '').toUpperCase(),
    interval: Math.max(1, Number(kv.INTERVAL) || 1),
    count: kv.COUNT ? Math.max(0, Number(kv.COUNT) || 0) : null,
    until: kv.UNTIL || null,
    byday: (kv.BYDAY ?? '')
      .split(',')
      .map((d) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ n: Number(m[1] ?? 0), weekday: WEEKDAYS.indexOf(m[2]!.toUpperCase()) })),
    bymonthday: ints(kv.BYMONTHDAY),
    bymonth: ints(kv.BYMONTH),
    bysetpos: ints(kv.BYSETPOS),
  };
}

/** The n-th (1-based; negative from the end) weekday of a month, as a UTC midnight; null if none. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number | null {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= daysIn(year, month) ? Date.UTC(year, month, day) : null;
  }
  const last = daysIn(year, month);
  const lastDay = new Date(Date.UTC(year, month, last)).getUTCDay();
  const day = last - ((lastDay - weekday + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? Date.UTC(year, month, day) : null;
}
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Candidate days (UTC midnights) of one month for MONTHLY/YEARLY rules. */
function monthDays(r: Rule, year: number, month: number, startDay: number): number[] {
  const out: number[] = [];
  if (r.bymonthday.length) {
    for (const d of r.bymonthday) {
      const day = d > 0 ? d : daysIn(year, month) + d + 1;
      if (day >= 1 && day <= daysIn(year, month)) out.push(Date.UTC(year, month, day));
    }
  } else if (r.byday.length) {
    for (const b of r.byday) {
      if (b.n) {
        const d = nthWeekday(year, month, b.weekday, b.n);
        if (d !== null) out.push(d);
      } else for (let d = nthWeekday(year, month, b.weekday, 1); d !== null && new Date(d).getUTCMonth() === month; d += 7 * DAY) out.push(d);
    }
  } else if (startDay <= daysIn(year, month)) out.push(Date.UTC(year, month, startDay));
  return out;
}

/**
 * Start times (UTC) of a repeating event's occurrences that overlap [from, to), at most `max`.
 * Works in the event's wall-clock time, so 9:00 stays 9:00 across daylight-saving changes.
 */
export function expandRule(rule: string, start: IcalTime, durationMs: number, from: number, to: number, exdates: Set<number>, max = 1000): number[] {
  const r = parseRule(rule);
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq)) return start.ms + durationMs > from && start.ms < to ? [start.ms] : [];
  const until = r.until ? untilMs(r.until, start) : Infinity;
  const s = new Date(start.wall);
  const timeOfDay = start.wall - Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  const out: number[] = [];
  let counted = 0;
  const weekStart = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - ((s.getUTCDay() + 6) % 7) * DAY; // Monday
  for (let k = 0; k < 10_000; k++) {
    let days: number[] = [];
    const step = k * r.interval;
    if (r.freq === 'DAILY') {
      const d = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + step);
      days = [d];
      const dd = new Date(d);
      if (r.byday.length && !r.byday.some((b) => b.weekday === dd.getUTCDay())) days = [];
      if (r.bymonthday.length && !r.bymonthday.includes(dd.getUTCDate())) days = [];
    } else if (r.freq === 'WEEKLY') {
      const w = weekStart + step * 7 * DAY;
      const wd = r.byday.length ? r.byday.map((b) => b.weekday) : [s.getUTCDay()];
      days = wd.map((x) => w + ((x + 6) % 7) * DAY);
    } else if (r.freq === 'MONTHLY') {
      const m = s.getUTCMonth() + step;
      days = monthDays(r, s.getUTCFullYear() + Math.floor(m / 12), ((m % 12) + 12) % 12, s.getUTCDate());
    } else {
      const y = s.getUTCFullYear() + step;
      const months = r.bymonth.length ? r.bymonth.map((m) => m - 1) : [s.getUTCMonth()];
      days = months.flatMap((m) => (r.bymonthday.length || r.byday.length ? monthDays(r, y, m, s.getUTCDate()) : s.getUTCDate() <= daysIn(y, m) ? [Date.UTC(y, m, s.getUTCDate())] : []));
    }
    if (r.bymonth.length && r.freq !== 'YEARLY') days = days.filter((d) => r.bymonth.includes(new Date(d).getUTCMonth() + 1));
    days.sort((a, b) => a - b);
    if (r.bysetpos.length) days = r.bysetpos.map((p) => days[p > 0 ? p - 1 : days.length + p]).filter((d): d is number => d !== undefined);
    let periodStart = Infinity;
    for (const day of days) {
      const wall = day + timeOfDay;
      periodStart = Math.min(periodStart, wall);
      if (wall < start.wall) continue;
      const utc = start.toUtc(wall);
      if (utc > until) return out;
      counted++;
      if (r.count !== null && counted > r.count) return out;
      if (utc >= to) return out;
      if (utc + durationMs > from && !exdates.has(utc)) {
        out.push(utc);
        if (out.length >= max) return out;
      }
    }
    if (days.length === 0 && r.freq !== 'DAILY' && k > 2000) break;
    if (Number.isFinite(periodStart) && start.toUtc(periodStart) > to + 400 * DAY) break;
  }
  return out;
}

function untilMs(v: string, start: IcalTime): number {
  const wall = parseWall(v);
  if (wall === null) return Infinity;
  if (/^\d{8}$/.test(v.trim())) return start.allDay ? wall : start.toUtc(wall + DAY - 1);
  return /Z$/i.test(v.trim()) ? wall : start.toUtc(wall);
}

/** The simple repeat DreyMail's own calendars can hold, or null if the rule is more than that. */
export function simpleRecurrence(rule: string, start: IcalTime): { recurrence: Recurrence; until: string | null } | null {
  const r = parseRule(rule);
  const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[r.freq] as Recurrence | undefined;
  if (!freq || r.interval !== 1 || r.count !== null || r.bymonthday.length || r.bysetpos.length || r.bymonth.length) return null;
  const sd = new Date(start.wall).getUTCDay();
  if (r.byday.length && !(freq === 'weekly' && r.byday.length === 1 && r.byday[0]!.weekday === sd && !r.byday[0]!.n)) return null;
  const until = r.until ? new Date(start.allDay ? untilMs(r.until, start) : utcToWallLocal(untilMs(r.until, start), start)).toISOString().slice(0, 10) : null;
  return { recurrence: freq, until };
}
/** The wall date of a UTC time for this event's zone (approximation through its start offset). */
const utcToWallLocal = (utc: number, start: IcalTime) => utc + (start.wall - start.ms);

/** "Repeats every week on Mon, Wed until Dec 1, 2026" for an invitation card. */
export function describeRule(rule: string): string {
  const r = parseRule(rule);
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  if (!unit) return 'Repeats';
  let text = `Repeats every ${r.interval > 1 ? `${r.interval} ${unit}s` : unit}`;
  if (r.byday.length) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const ord = (n: number) => (n === -1 ? 'last ' : n ? `${['', '1st', '2nd', '3rd', '4th', '5th'][n] ?? `${n}th`} ` : '');
    text += ` on ${r.byday.map((b) => ord(b.n) + names[b.weekday]).join(', ')}`;
  }
  if (r.count) text += `, ${r.count} times`;
  if (r.until) {
    const u = parseWall(r.until);
    if (u !== null) text += ` until ${new Date(u).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  }
  return text;
}

// ---- events ---------------------------------------------------------------------------------------

export interface IcalPerson {
  email: string;
  name: string;
  status: string;
}

export interface IcalEvent {
  uid: string;
  title: string;
  location: string;
  description: string;
  start: IcalTime;
  end: number;
  allDay: boolean;
  rrule: string | null;
  recurrenceId: number | null;
  exdates: Set<number>;
  status: string;
  sequence: number;
  organizer: IcalPerson | null;
  attendees: IcalPerson[];
  component: IcalComponent;
}

const personOf = (p: IcalProp): IcalPerson => ({
  email: p.value.replace(/^mailto:/i, '').trim().toLowerCase(),
  name: p.params.CN ?? '',
  status: (p.params.PARTSTAT ?? 'NEEDS-ACTION').toUpperCase(),
});

/** The VEVENTs of a calendar file, with times resolved to UTC. */
export function eventsOf(cal: IcalComponent): IcalEvent[] {
  const resolve = zoneResolver(cal);
  const out: IcalEvent[] = [];
  for (const c of cal.children) {
    if (c.name !== 'VEVENT') continue;
    const start = timeOf(prop(c, 'DTSTART'), resolve);
    if (!start) continue;
    const endT = timeOf(prop(c, 'DTEND'), resolve);
    const dur = parseDuration(prop(c, 'DURATION')?.value);
    const end = endT?.ms ?? start.ms + (dur ?? (start.allDay ? DAY : 0));
    const exdates = new Set<number>();
    for (const p of props(c, 'EXDATE')) for (const v of p.value.split(',')) {
      const t = timeOf(p, resolve, v);
      if (t) exdates.add(t.ms);
    }
    const rid = timeOf(prop(c, 'RECURRENCE-ID'), resolve);
    const organizer = prop(c, 'ORGANIZER');
    out.push({
      uid: prop(c, 'UID')?.value.trim() ?? '',
      title: unescapeText(prop(c, 'SUMMARY')?.value ?? ''),
      location: unescapeText(prop(c, 'LOCATION')?.value ?? ''),
      description: unescapeText(prop(c, 'DESCRIPTION')?.value ?? ''),
      start,
      end: Math.max(end, start.ms),
      allDay: start.allDay,
      rrule: prop(c, 'RRULE')?.value ?? null,
      recurrenceId: rid?.ms ?? null,
      exdates,
      status: (prop(c, 'STATUS')?.value ?? '').toUpperCase(),
      sequence: Number(prop(c, 'SEQUENCE')?.value) || 0,
      organizer: organizer ? personOf(organizer) : null,
      attendees: props(c, 'ATTENDEE').map(personOf),
      component: c,
    });
  }
  return out;
}

export interface Occurrence {
  event: IcalEvent;
  start: number;
  end: number;
  /** Part of a repeating series. */
  repeating: boolean;
}

/** Occurrences in [from, to): repeats expanded, with changed occurrences (RECURRENCE-ID) in place. */
export function occurrencesOf(events: IcalEvent[], from: number, to: number): Occurrence[] {
  const out: Occurrence[] = [];
  const overrides = new Map<string, Map<number, IcalEvent>>();
  for (const e of events) if (e.recurrenceId !== null) {
    if (!overrides.has(e.uid)) overrides.set(e.uid, new Map());
    overrides.get(e.uid)!.set(e.recurrenceId, e);
  }
  for (const e of events) {
    if (e.status === 'CANCELLED') continue;
    if (e.recurrenceId !== null) {
      // A changed occurrence: shown on its own (its master skips that date).
      if (e.end > from && e.start.ms < to) out.push({ event: e, start: e.start.ms, end: e.end, repeating: true });
      continue;
    }
    if (!e.rrule) {
      if (e.end > from && e.start.ms < to) out.push({ event: e, start: e.start.ms, end: e.end, repeating: false });
      continue;
    }
    const dur = e.end - e.start.ms;
    const changed = overrides.get(e.uid);
    for (const t of expandRule(e.rrule, e.start, dur, from, to, e.exdates)) {
      if (changed?.has(t)) continue;
      out.push({ event: e, start: t, end: t + dur, repeating: true });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- writing ----------------------------------------------------------------------------------------

/** Folds a content line at 75 octets (RFC 5545 §3.1), never inside a UTF-8 character. */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function serialize(c: IcalComponent): string {
  const lines: string[] = [];
  const walk = (x: IcalComponent) => {
    lines.push(`BEGIN:${x.name}`);
    for (const p of x.props) lines.push(fold(p.raw));
    for (const k of x.children) walk(k);
    lines.push(`END:${x.name}`);
  };
  walk(c);
  return `${lines.join('\r\n')}\r\n`;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const icalDate = (wall: number) => {
  const d = new Date(wall);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};
export const icalDateTime = (wall: number) => {
  const d = new Date(wall);
  return `${icalDate(wall)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};
const mk = (name: string, value: string, params: Record<string, string> = {}): IcalProp => {
  const p = Object.entries(params).map(([k, v]) => `;${k}=${/[;:,]/.test(v) ? `"${v}"` : v}`).join('');
  return { name, params, value, raw: `${name}${p}:${value}` };
};

export interface EventFields {
  title: string;
  location: string;
  notes: string;
  /** ISO; all-day events: midnight UTC of the first day and of the day after the last. */
  start: string;
  end: string;
  allDay: boolean;
  recurrence: Recurrence;
  until: string | null;
  /** IANA zone the event was made in (repeats keep their local time there). */
  timeZone?: string;
}

/** The RRULE for a simple repeat. */
export function ruleFor(f: EventFields): string | null {
  if (f.recurrence === 'none') return null;
  let rule = `FREQ=${f.recurrence.toUpperCase()}`;
  if (f.until) {
    const day = Date.parse(`${f.until}T00:00:00Z`);
    if (f.allDay) rule += `;UNTIL=${icalDate(day)}`;
    else {
      const endOfDay = day + DAY - 1000;
      const utc = validTimeZone(f.timeZone) ? wallToUtc(endOfDay, f.timeZone) : endOfDay;
      rule += `;UNTIL=${icalDateTime(utc)}Z`;
    }
  }
  return rule;
}

/** The properties DreyMail writes for an event's time and text. */
function eventProps(f: EventFields): IcalProp[] {
  const s = Date.parse(f.start);
  const e = Date.parse(f.end);
  const out: IcalProp[] = [mk('SUMMARY', escapeText(f.title))];
  const rule = ruleFor(f);
  if (f.allDay) {
    out.push(mk('DTSTART', icalDate(s), { VALUE: 'DATE' }), mk('DTEND', icalDate(Math.max(e, s + DAY)), { VALUE: 'DATE' }));
  } else if (rule && validTimeZone(f.timeZone) && f.timeZone !== 'UTC') {
    // Repeats keep their local time across daylight-saving changes.
    out.push(mk('DTSTART', icalDateTime(utcToWall(s, f.timeZone)), { TZID: f.timeZone }), mk('DTEND', icalDateTime(utcToWall(e, f.timeZone)), { TZID: f.timeZone }));
  } else out.push(mk('DTSTART', `${icalDateTime(s)}Z`), mk('DTEND', `${icalDateTime(e)}Z`));
  if (f.location) out.push(mk('LOCATION', escapeText(f.location)));
  if (f.notes) out.push(mk('DESCRIPTION', escapeText(f.notes)));
  if (rule) out.push(mk('RRULE', rule));
  return out;
}

const stamp = () => `${icalDateTime(Date.now())}Z`;

/** A new calendar object for CalDAV. */
export function newEventIcs(f: EventFields, uid = `${crypto.randomUUID()}@dreymail`): { uid: string; ics: string } {
  const cal: IcalComponent = {
    name: 'VCALENDAR',
    props: [mk('VERSION', '2.0'), mk('PRODID', '-//DreyMail//Calendar//EN')],
    children: [{ name: 'VEVENT', props: [mk('UID', uid), mk('DTSTAMP', stamp()), mk('CREATED', stamp()), ...eventProps(f), mk('SEQUENCE', '0')], children: [] }],
  };
  return { uid, ics: serialize(cal) };
}

/** An existing calendar object with DreyMail's fields changed; everything else (alarms, attendees…) kept. */
export function updateEventIcs(existing: string, f: EventFields): string {
  const cal = parseIcal(existing).find((c) => c.name === 'VCALENDAR');
  const ev = cal?.children.find((c) => c.name === 'VEVENT' && !prop(c, 'RECURRENCE-ID'));
  if (!cal || !ev) throw new Error('This event could not be read');
  const replaced = new Set(['SUMMARY', 'LOCATION', 'DESCRIPTION', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'EXDATE', 'RDATE', 'DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE']);
  const seq = (Number(prop(ev, 'SEQUENCE')?.value) || 0) + 1;
  ev.props = [...ev.props.filter((p) => !replaced.has(p.name)), ...eventProps(f), mk('DTSTAMP', stamp()), mk('LAST-MODIFIED', stamp()), mk('SEQUENCE', String(seq))];
  return serialize(cal);
}

/** IANA name for a Windows zone name (as Outlook writes them), if known. */
export const windowsZone = (id: string): string | undefined => WINDOWS_ZONES[id.replace(/^\/+/, '').trim()];

/**
 * Time zones a CalDAV server can understand: a TZID the file defines (VTIMEZONE) or an IANA name
 * stays; a Windows name becomes its IANA name; anything else becomes UTC. (A TZID a server can't
 * resolve can break the whole calendar there.)
 */
export function normalizeZones(cal: IcalComponent): IcalComponent {
  const defined = new Set(cal.children.filter((c) => c.name === 'VTIMEZONE').map((c) => prop(c, 'TZID')?.value ?? ''));
  const resolve = zoneResolver(cal);
  const timeProps = new Set(['DTSTART', 'DTEND', 'RECURRENCE-ID', 'EXDATE', 'RDATE', 'DUE']);
  const fix = (c: IcalComponent): IcalComponent => ({
    ...c,
    props: c.props.map((p) => {
      const tzid = p.params.TZID;
      if (!timeProps.has(p.name) || !tzid || defined.has(tzid) || validTimeZone(tzid)) return p;
      const iana = windowsZone(tzid);
      const { TZID: _drop, ...rest } = p.params;
      if (iana && validTimeZone(iana)) return mk(p.name, p.value, { ...rest, TZID: iana });
      const values = p.value.split(',').map((v) => timeOf(p, resolve, v)).filter((t): t is IcalTime => !!t);
      return mk(p.name, values.map((t) => `${icalDateTime(t.ms)}Z`).join(','), rest);
    }),
    children: c.name === 'VTIMEZONE' ? c.children : c.children.map(fix),
  });
  return fix(cal);
}

/** A calendar object for storing an invitation in CalDAV: without METHOD (CalDAV forbids it), with zones a server understands. */
export function storableIcs(invite: IcalComponent): string {
  const cal = normalizeZones(invite);
  return serialize({ ...cal, props: cal.props.filter((p) => p.name !== 'METHOD') });
}

export type PartStat = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

/** An iTIP REPLY (RFC 5546) answering an invitation as `me`. */
export function replyIcs(invite: IcalEvent, me: { email: string; name: string }, partstat: PartStat): string {
  const keep = ['UID', 'SEQUENCE', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID', 'SUMMARY', 'ORGANIZER'];
  const props: IcalProp[] = invite.component.props.filter((p) => keep.includes(p.name));
  props.push(mk('DTSTAMP', stamp()), mk('ATTENDEE', `mailto:${me.email}`, { PARTSTAT: partstat, ...(me.name ? { CN: me.name.replace(/"/g, '') } : {}) }));
  const cal: IcalComponent = {
    name: 'VCALENDAR',
    props: [mk('VERSION', '2.0'), mk('PRODID', '-//DreyMail//Calendar//EN'), mk('METHOD', 'REPLY')],
    children: [{ name: 'VEVENT', props, children: [] }],
  };
  return serialize(cal);
}
