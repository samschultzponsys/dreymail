// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Repeat rules (RFC 5545 RRULE) and time zones, shared by the server (CalDAV, invitations,
// reminders) and the browser (DreyMail's own repeating events), so both expand repeats the same way:
// in the event's wall-clock time, so 9:00 stays 9:00 across daylight-saving changes.

export const DAY = 86_400_000;

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

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export interface Rule {
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
export function nthWeekday(year: number, month: number, weekday: number, n: number): number | null {
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
export const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

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
  const offset = start.wall - start.ms;
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
      // Far before the range the exact zone offset doesn't matter (it only decides what is shown):
      // skip the time zone lookup there.
      const approx = wall - offset;
      const utc = approx < from - 2 * DAY ? approx : start.toUtc(wall);
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
    if (Number.isFinite(periodStart) && periodStart - offset > to + 400 * DAY) break;
  }
  return out;
}

export function untilMs(v: string, start: IcalTime): number {
  const wall = parseWall(v);
  if (wall === null) return Infinity;
  if (/^\d{8}$/.test(v.trim())) return start.allDay ? wall : start.toUtc(wall + DAY - 1);
  return /Z$/i.test(v.trim()) ? wall : start.toUtc(wall);
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
