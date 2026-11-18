// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// iCalendar (RFC 5545) for CalDAV calendars and invitations: parsing (keeping each property's raw
// line, so unknown properties survive an edit), time zones (IANA names, Windows names as Outlook
// sends them, and the VTIMEZONE in the file), repeat rules (RRULE with EXDATE and changed
// occurrences), and writing events and invitation answers (iTIP REPLY).

import crypto from 'node:crypto';
import { ruleOf, type Attendee, type AttendeeStatus, type MeetingKind, type Recurrence, type RepeatFields, type ShowAs } from '../../../shared/calendar.js';
import { DAY, daysIn, expandRule, icalDate, icalDateTime, nthWeekday, parseRule, parseWall, untilMs, utcToWall, validTimeZone, WEEKDAYS, wallToUtc, type IcalTime } from '../../../shared/rrule.js';

export { expandRule, icalDate, icalDateTime, parseRule, parseWall, utcToWall, validTimeZone, wallToUtc, type IcalTime };

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
  role?: string;
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
  ...(p.params.ROLE ? { role: p.params.ROLE.toUpperCase() } : {}),
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

const mk = (name: string, value: string, params: Record<string, string> = {}): IcalProp => {
  const p = Object.entries(params).map(([k, v]) => `;${k}=${/[;:,]/.test(v) ? `"${v}"` : v}`).join('');
  return { name, params, value, raw: `${name}${p}:${value}` };
};

export interface EventFields extends RepeatFields {
  title: string;
  location: string;
  notes: string;
  /** ISO; all-day events: midnight UTC of the first day and of the day after the last. */
  start: string;
  end: string;
  allDay: boolean;
  /** IANA zone the event was made in (repeats keep their local time there). */
  timeZone?: string;
  /** Minutes before the start (null: none; missing: leave the event's alarms as they are). */
  reminder?: number | null;
  /** Guests (missing: leave the guest list as it is). */
  attendees?: Attendee[];
  /** Who invites (written with the guests). */
  organizer?: { email: string; name: string } | null;
  /** Skipped occurrences of a repeating event (ISO starts). */
  exdates?: string[];
  /** Online meeting to make with the event (providers that offer one). */
  meeting?: MeetingKind | null;
  /** Busy (default), free, tentative, away, working elsewhere. */
  showAs?: ShowAs;
}

/** The event's start as a wall time in its zone (UTC fields = local fields). */
export function startWallOf(f: Pick<EventFields, 'start' | 'allDay' | 'timeZone'>): number {
  const s = Date.parse(f.start);
  return f.allDay || !validTimeZone(f.timeZone) ? s : utcToWall(s, f.timeZone);
}

/** The RRULE for an event's repeat (UNTIL in UTC for timed events, as RFC 5545 asks). */
export function ruleFor(f: EventFields): string | null {
  if (f.recurrence === 'none') return null;
  let untilValue: string | undefined;
  if (f.until && !f.count) {
    const day = Date.parse(`${f.until}T00:00:00Z`);
    if (f.allDay) untilValue = icalDate(day);
    else {
      const endOfDay = day + DAY - 1000;
      untilValue = `${icalDateTime(validTimeZone(f.timeZone) ? wallToUtc(endOfDay, f.timeZone) : endOfDay)}Z`;
    }
  }
  return ruleOf(f, startWallOf(f), untilValue);
}

/** A DreyMail repeat from an RRULE, or null when the rule is more than DreyMail's editor offers. */
export function repeatFromRule(rule: string, start: IcalTime): RepeatFields | null {
  const r = parseRule(rule);
  const freq = ({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' } as Record<string, Exclude<Recurrence, 'none'>>)[r.freq];
  if (!freq || r.bysetpos.length) return null;
  const s = new Date(start.wall);
  const out: RepeatFields = { recurrence: freq, until: null, interval: r.interval, count: r.count };
  if (r.until && !r.count) out.until = new Date(start.allDay ? untilMs(r.until, start) : untilMs(r.until, start) + (start.wall - start.ms)).toISOString().slice(0, 10);
  if (r.bymonth.length && !(freq === 'yearly' && r.bymonth.length === 1 && r.bymonth[0] === s.getUTCMonth() + 1)) return null;
  if (freq === 'daily') {
    if (r.bymonthday.length) return null;
    if (r.byday.length) {
      // "Every weekday" written as a daily rule: the same as weekly on those days.
      if (r.interval !== 1 || r.byday.some((b) => b.n)) return null;
      return { ...out, recurrence: 'weekly', byDay: r.byday.map((b) => b.weekday).sort() };
    }
    return out;
  }
  if (freq === 'weekly') {
    if (r.bymonthday.length || r.byday.some((b) => b.n)) return null;
    if (r.byday.length) out.byDay = [...new Set(r.byday.map((b) => b.weekday))].sort();
    return out;
  }
  if (r.bymonthday.length) return r.bymonthday.length === 1 && r.bymonthday[0] === s.getUTCDate() && !r.byday.length ? { ...out, monthlyBy: 'day' } : null;
  if (!r.byday.length) return { ...out, monthlyBy: 'day' };
  const b = r.byday[0]!;
  if (r.byday.length !== 1 || b.weekday !== s.getUTCDay()) return null;
  if (b.n === -1) return { ...out, monthlyBy: 'last' };
  if (b.n === Math.ceil(s.getUTCDate() / 7)) return { ...out, monthlyBy: 'weekday' };
  return null;
}

/** The simple repeat DreyMail's own calendars can hold, or null if the rule is more than that (kept for older callers). */
export function simpleRecurrence(rule: string, start: IcalTime): { recurrence: Recurrence; until: string | null } | null {
  const r = repeatFromRule(rule, start);
  if (!r || (r.interval ?? 1) !== 1 || r.count || r.byDay?.length || (r.monthlyBy && r.monthlyBy !== 'day')) return null;
  return { recurrence: r.recurrence, until: r.until };
}

/** A time value written like `like` (a DTSTART): a date, a time in its zone, or UTC. */
function timeLike(like: IcalProp | undefined, t: IcalTime | null, ms: number): IcalProp {
  if (!like || !t) return mk('X', `${icalDateTime(ms)}Z`);
  if (t.allDay) return mk('X', icalDate(ms), { VALUE: 'DATE' });
  if (like.params.TZID) {
    let wall = ms + (t.wall - t.ms);
    for (let i = 0; i < 3 && t.toUtc(wall) !== ms; i++) wall += ms - t.toUtc(wall);
    return mk('X', icalDateTime(wall), { TZID: like.params.TZID });
  }
  return mk('X', /Z$/i.test(like.value.trim()) ? `${icalDateTime(ms)}Z` : icalDateTime(ms));
}
const renamed = (p: IcalProp, name: string) => mk(name, p.value, p.params);

const PARTSTAT: Record<AttendeeStatus, string> = { 'needs-action': 'NEEDS-ACTION', accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' };
export const statusOfPartstat = (v: string): AttendeeStatus => (v === 'ACCEPTED' ? 'accepted' : v === 'TENTATIVE' ? 'tentative' : v === 'DECLINED' ? 'declined' : 'needs-action');
const cn = (name: string): Record<string, string> => (name ? { CN: name.replace(/["\r\n]/g, '') } : {});

/** ORGANIZER and ATTENDEE lines; `clientSchedules` asks a CalDAV server not to email them itself (RFC 6638). */
function peopleProps(f: Pick<EventFields, 'attendees' | 'organizer'>, clientSchedules = false): IcalProp[] {
  if (!f.attendees?.length || !f.organizer) return [];
  const agent: Record<string, string> = clientSchedules ? { 'SCHEDULE-AGENT': 'CLIENT' } : {};
  return [
    mk('ORGANIZER', `mailto:${f.organizer.email}`, { ...cn(f.organizer.name), ...agent }),
    ...f.attendees.map((a) =>
      mk('ATTENDEE', `mailto:${a.email}`, { ...cn(a.name), ROLE: a.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT', PARTSTAT: PARTSTAT[a.status] ?? 'NEEDS-ACTION', RSVP: 'TRUE', ...agent }),
    ),
  ];
}

/** A display alarm `min` minutes before the start. */
export function alarmOf(min: number): IcalComponent {
  return { name: 'VALARM', props: [mk('ACTION', 'DISPLAY'), mk('DESCRIPTION', 'Reminder'), mk('TRIGGER', min > 0 ? `-PT${Math.round(min)}M` : 'PT0S')], children: [] };
}

/** "Show as" of a VEVENT: Outlook's busy status, else TRANSP; undefined for busy. */
export function showAsOf(c: IcalComponent): ShowAs | undefined {
  const ms = prop(c, 'X-MICROSOFT-CDO-BUSYSTATUS')?.value.trim().toUpperCase();
  const map: Record<string, ShowAs> = { FREE: 'free', TENTATIVE: 'tentative', OOF: 'away', WORKINGELSEWHERE: 'elsewhere' };
  if (ms) return map[ms];
  return prop(c, 'TRANSP')?.value.trim().toUpperCase() === 'TRANSPARENT' ? 'free' : undefined;
}

/** Minutes before the start of an event's first display/audio alarm relative to the start, if any. */
export function reminderOf(c: IcalComponent): number | null {
  for (const a of c.children) {
    if (a.name !== 'VALARM') continue;
    const trig = prop(a, 'TRIGGER');
    if (!trig || trig.params.VALUE === 'DATE-TIME' || trig.params.RELATED === 'END') continue;
    const d = parseDuration(trig.value);
    if (d !== null && d <= 0) return Math.round(-d / 60_000);
  }
  return null;
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
  if (f.showAs) {
    // TRANSP is the standard; Outlook also reads its own busy status.
    out.push(mk('TRANSP', f.showAs === 'free' ? 'TRANSPARENT' : 'OPAQUE'));
    out.push(mk('X-MICROSOFT-CDO-BUSYSTATUS', { busy: 'BUSY', free: 'FREE', tentative: 'TENTATIVE', away: 'OOF', elsewhere: 'WORKINGELSEWHERE' }[f.showAs]));
  }
  if (rule) out.push(mk('RRULE', rule));
  if (rule && f.exdates?.length) {
    const ex = f.exdates.map((x) => Date.parse(x)).filter((x) => !Number.isNaN(x));
    if (ex.length) out.push(f.allDay ? mk('EXDATE', ex.map(icalDate).join(','), { VALUE: 'DATE' }) : mk('EXDATE', ex.map((x) => `${icalDateTime(x)}Z`).join(',')));
  }
  return out;
}

const stamp = () => `${icalDateTime(Date.now())}Z`;

/** A new calendar object for CalDAV. */
export function newEventIcs(f: EventFields, uid = `${crypto.randomUUID()}@dreymail`, opts: { clientSchedules?: boolean } = {}): { uid: string; ics: string } {
  const cal: IcalComponent = {
    name: 'VCALENDAR',
    props: [mk('VERSION', '2.0'), mk('PRODID', '-//DreyMail//Calendar//EN')],
    children: [
      ...zonesFor(f),
      {
        name: 'VEVENT',
        props: [mk('UID', uid), mk('DTSTAMP', stamp()), mk('CREATED', stamp()), ...eventProps(f), ...peopleProps(f, opts.clientSchedules), mk('SEQUENCE', '0')],
        children: f.reminder !== null && f.reminder !== undefined ? [alarmOf(f.reminder)] : [],
      },
    ],
  };
  return { uid, ics: serialize(cal) };
}

/** VTIMEZONEs for the zone an event's times are written in (Outlook needs them for repeats). */
function zonesFor(f: EventFields): IcalComponent[] {
  if (f.allDay || f.recurrence === 'none' || !validTimeZone(f.timeZone) || f.timeZone === 'UTC') return [];
  const z = vtimezone(f.timeZone, new Date(Date.parse(f.start)).getUTCFullYear());
  return z ? [z] : [];
}

/**
 * A VTIMEZONE for an IANA zone, worked out from its offsets in `year`: one STANDARD part, plus a
 * DAYLIGHT part with yearly rules (the n-th or last weekday of the month) when it has summer time.
 */
export function vtimezone(tz: string, year: number): IcalComponent | null {
  if (!validTimeZone(tz)) return null;
  const off = (t: number) => utcToWall(t, tz) - t;
  const fmtOff = (ms: number) => {
    const m = Math.round(Math.abs(ms) / 60_000);
    return `${ms < 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
  };
  // Find the moments the offset changes during the year.
  const changes: { at: number; from: number; to: number }[] = [];
  let t = Date.UTC(year, 0, 1);
  let o = off(t);
  for (let d = 1; d <= 366; d++) {
    const n = Date.UTC(year, 0, 1 + d);
    const on = off(n);
    if (on !== o) {
      let lo = n - DAY;
      let hi = n;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2);
        if (off(mid) === o) lo = mid;
        else hi = mid;
      }
      // Offsets change on whole minutes: the first minute after the last old-offset moment.
      changes.push({ at: Math.floor(lo / 60_000) * 60_000 + 60_000, from: o, to: on });
      o = on;
    }
    t = n;
  }
  const part = (name: string, c: { at: number; from: number; to: number } | null, fixed: number): IcalComponent => {
    if (!c) return { name, props: [mk('DTSTART', '19700101T000000'), mk('TZOFFSETFROM', fmtOff(fixed)), mk('TZOFFSETTO', fmtOff(fixed))], children: [] };
    const wall = c.at + c.from; // the local time the change happens, in the old offset
    const d = new Date(wall);
    const n = d.getUTCDate() + 7 > daysIn(d.getUTCFullYear(), d.getUTCMonth()) ? -1 : Math.ceil(d.getUTCDate() / 7);
    return {
      name,
      props: [
        mk('DTSTART', `1970${icalDateTime(wall).slice(4)}`),
        mk('TZOFFSETFROM', fmtOff(c.from)),
        mk('TZOFFSETTO', fmtOff(c.to)),
        mk('RRULE', `FREQ=YEARLY;BYMONTH=${d.getUTCMonth() + 1};BYDAY=${n}${WEEKDAYS[d.getUTCDay()]}`),
      ],
      children: [],
    };
  };
  const children: IcalComponent[] = [];
  if (changes.length >= 2) {
    const toSummer = changes.find((c) => c.to > c.from)!;
    const toWinter = changes.find((c) => c.to < c.from)!;
    children.push(part('STANDARD', toWinter, 0), part('DAYLIGHT', toSummer, 0));
  } else children.push(part('STANDARD', null, off(Date.UTC(year, 6, 1))));
  return { name: 'VTIMEZONE', props: [mk('TZID', tz)], children };
}

/** An existing calendar object with DreyMail's fields changed; everything else (attendees, overrides…) kept. */
export function updateEventIcs(existing: string, f: EventFields, opts: { clientSchedules?: boolean } = {}): string {
  const cal = parseIcal(existing).find((c) => c.name === 'VCALENDAR');
  const ev = cal?.children.find((c) => c.name === 'VEVENT' && !prop(c, 'RECURRENCE-ID'));
  if (!cal || !ev) throw new Error('This event could not be read');
  const replaced = new Set(['SUMMARY', 'LOCATION', 'DESCRIPTION', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RDATE', 'DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE']);
  if (f.showAs) replaced.add('TRANSP').add('X-MICROSOFT-CDO-BUSYSTATUS');
  // Skipped occurrences stay while the event repeats (they are written anew when DreyMail has them).
  if (f.recurrence === 'none' || f.exdates) replaced.add('EXDATE');
  if (f.attendees) replaced.add('ORGANIZER').add('ATTENDEE');
  const seq = (Number(prop(ev, 'SEQUENCE')?.value) || 0) + 1;
  ev.props = [...ev.props.filter((p) => !replaced.has(p.name)), ...eventProps(f), ...(f.attendees ? peopleProps(f, opts.clientSchedules) : []), mk('DTSTAMP', stamp()), mk('LAST-MODIFIED', stamp()), mk('SEQUENCE', String(seq))];
  if (f.reminder !== undefined) ev.children = [...ev.children.filter((c) => c.name !== 'VALARM'), ...(f.reminder !== null ? [alarmOf(f.reminder)] : [])];
  // A new zone needs its definition.
  const tz = f.timeZone;
  if (tz && !cal.children.some((c) => c.name === 'VTIMEZONE' && prop(c, 'TZID')?.value === tz)) cal.children = [...zonesFor(f), ...cal.children];
  // Overrides of occurrences that no longer exist would show up on their own: drop them when the series stops repeating.
  if (f.recurrence === 'none') cal.children = cal.children.filter((c) => !(c.name === 'VEVENT' && prop(c, 'RECURRENCE-ID')));
  return serialize(cal);
}

/** The master VEVENT of a calendar object and its start. */
function masterOf(cal: IcalComponent) {
  const ev = cal.children.find((c) => c.name === 'VEVENT' && !prop(c, 'RECURRENCE-ID'));
  if (!ev) throw new Error('This event could not be read');
  const resolve = zoneResolver(cal);
  return { ev, resolve, start: timeOf(prop(ev, 'DTSTART'), resolve) };
}

/** Changes one occurrence of a repeating event (a RECURRENCE-ID override; RFC 5545 §3.8.4.4). */
export function overrideOccurrenceIcs(existing: string, occurrenceStart: number, f: EventFields, opts: { clientSchedules?: boolean } = {}): string {
  const cal = parseIcal(existing).find((c) => c.name === 'VCALENDAR');
  if (!cal) throw new Error('This event could not be read');
  const { ev, resolve, start } = masterOf(cal);
  const rid = renamed(timeLike(prop(ev, 'DTSTART'), start, occurrenceStart), 'RECURRENCE-ID');
  const same = (c: IcalComponent) => c.name === 'VEVENT' && timeOf(prop(c, 'RECURRENCE-ID'), resolve)?.ms === occurrenceStart;
  const old = cal.children.find(same);
  const seq = Math.max(Number(prop(ev, 'SEQUENCE')?.value) || 0, Number(old && prop(old, 'SEQUENCE')?.value) || 0) + 1;
  const people = f.attendees ? peopleProps(f, opts.clientSchedules) : ev.props.filter((p) => p.name === 'ORGANIZER' || p.name === 'ATTENDEE');
  const one: IcalComponent = {
    name: 'VEVENT',
    props: [mk('UID', prop(ev, 'UID')?.value ?? ''), rid, ...eventProps({ ...f, recurrence: 'none', until: null, count: null }), ...people, mk('DTSTAMP', stamp()), mk('SEQUENCE', String(seq))],
    children: f.reminder !== undefined ? (f.reminder !== null ? [alarmOf(f.reminder)] : []) : ev.children.filter((c) => c.name === 'VALARM'),
  };
  cal.children = [...cal.children.filter((c) => !same(c)), one];
  return serialize(cal);
}

/** Leaves one occurrence out of a repeating event (EXDATE), dropping its override if it had one. */
export function excludeOccurrenceIcs(existing: string, occurrenceStart: number): string {
  const cal = parseIcal(existing).find((c) => c.name === 'VCALENDAR');
  if (!cal) throw new Error('This event could not be read');
  const { ev, resolve, start } = masterOf(cal);
  ev.props = [...ev.props.filter((p) => p.name !== 'DTSTAMP' && p.name !== 'SEQUENCE'), renamed(timeLike(prop(ev, 'DTSTART'), start, occurrenceStart), 'EXDATE'), mk('DTSTAMP', stamp()), mk('SEQUENCE', String((Number(prop(ev, 'SEQUENCE')?.value) || 0) + 1))];
  cal.children = cal.children.filter((c) => !(c.name === 'VEVENT' && timeOf(prop(c, 'RECURRENCE-ID'), resolve)?.ms === occurrenceStart));
  return serialize(cal);
}

/** A whole calendar object as DreyMail's editor shows it (the master's fields and repeat). */
export function fieldsOfIcs(existing: string): (EventFields & { uid: string; editable: boolean; organizer: { email: string; name: string } | null }) | null {
  const cal = parseIcal(existing).find((c) => c.name === 'VCALENDAR');
  if (!cal) return null;
  const e = eventsOf(cal).find((x) => x.recurrenceId === null);
  if (!e) return null;
  const rep = e.rrule ? repeatFromRule(e.rrule, e.start) : { recurrence: 'none' as const, until: null };
  return {
    uid: e.uid,
    title: e.title,
    location: e.location,
    notes: e.description,
    start: new Date(e.start.ms).toISOString(),
    end: new Date(e.end).toISOString(),
    allDay: e.allDay,
    ...(rep ?? { recurrence: 'none', until: null }),
    editable: !!rep,
    timeZone: zoneNameOf(prop(e.component, 'DTSTART')),
    reminder: reminderOf(e.component),
    ...(showAsOf(e.component) ? { showAs: showAsOf(e.component) } : {}),
    attendees: e.attendees.filter((a) => a.email !== e.organizer?.email).map((a) => ({ email: a.email, name: a.name, status: statusOfPartstat(a.status), optional: a.role === 'OPT-PARTICIPANT' || undefined })),
    organizer: e.organizer ? { email: e.organizer.email, name: e.organizer.name } : null,
    exdates: [...e.exdates].map((x) => new Date(x).toISOString()),
  };
}
const zoneNameOf = (p: IcalProp | undefined) => {
  const id = p?.params.TZID;
  if (!id) return undefined;
  const clean = id.replace(/^\/+/, '').trim();
  return validTimeZone(clean) ? clean : windowsZone(clean);
};

/**
 * An invitation (iTIP REQUEST), update or cancellation (CANCEL) for a DreyMail or CalDAV event
 * with guests, as the organizer sends it by email (RFC 5546).
 */
export function requestIcs(uid: string, f: EventFields, method: 'REQUEST' | 'CANCEL', sequence: number, only?: string[]): string {
  const attendees = only ? (f.attendees ?? []).filter((a) => only.includes(a.email)) : f.attendees;
  const cal: IcalComponent = {
    name: 'VCALENDAR',
    props: [mk('VERSION', '2.0'), mk('PRODID', '-//DreyMail//Calendar//EN'), mk('METHOD', method)],
    children: [
      ...zonesFor(f),
      {
        name: 'VEVENT',
        props: [
          mk('UID', uid),
          mk('DTSTAMP', stamp()),
          ...eventProps(f),
          ...peopleProps({ ...f, attendees }),
          mk('SEQUENCE', String(sequence)),
          mk('STATUS', method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'),
        ],
        children: method === 'REQUEST' && f.reminder !== null && f.reminder !== undefined ? [alarmOf(f.reminder)] : [],
      },
    ],
  };
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

/**
 * A stored calendar object (CalDAV) as an iTIP message to email the guests: METHOD added, alarms
 * and SCHEDULE-AGENT left out; a CANCEL marks the whole event canceled.
 */
export function itipFromStored(stored: string, method: 'REQUEST' | 'CANCEL'): string {
  const cal = parseIcal(stored).find((c) => c.name === 'VCALENDAR');
  if (!cal) throw new Error('This event could not be read');
  const clean = (c: IcalComponent): IcalComponent => ({
    ...c,
    props: c.props.map((p) => {
      if ((p.name !== 'ORGANIZER' && p.name !== 'ATTENDEE') || !p.params['SCHEDULE-AGENT']) return p;
      const { 'SCHEDULE-AGENT': _drop, ...rest } = p.params;
      return mk(p.name, p.value, rest);
    }),
    children: c.children.filter((k) => k.name !== 'VALARM').map(clean),
  });
  const out = clean(cal);
  out.props = [...out.props.filter((p) => p.name !== 'METHOD'), mk('METHOD', method)];
  if (method === 'CANCEL') {
    out.children = out.children.filter((c) => !(c.name === 'VEVENT' && prop(c, 'RECURRENCE-ID')));
    for (const ev of out.children.filter((c) => c.name === 'VEVENT'))
      ev.props = [...ev.props.filter((p) => p.name !== 'STATUS' && p.name !== 'SEQUENCE'), mk('STATUS', 'CANCELLED'), mk('SEQUENCE', String((Number(prop(ev, 'SEQUENCE')?.value) || 0) + 1))];
  }
  return serialize(out);
}

/** Guests of a stored calendar object (master), by address. */
export function guestsOfStored(stored: string): { organizer: string | null; attendees: string[] } {
  const cal = parseIcal(stored).find((c) => c.name === 'VCALENDAR');
  const e = cal ? eventsOf(cal).find((x) => x.recurrenceId === null) : undefined;
  return { organizer: e?.organizer?.email ?? null, attendees: (e?.attendees ?? []).map((a) => a.email).filter((a) => a !== e?.organizer?.email) };
}
