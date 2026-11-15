// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/** DreyMail's own calendars: shareable between DreyMail users, optionally grouped under a mailbox. */

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface CalendarView {
  id: string;
  name: string;
  color: string;
  /** Mailbox it is grouped under in the calendar list (null = "My calendars"). */
  accountId: string | null;
  /** 'owner' for your own, else how it was shared with you. */
  access: 'owner' | 'edit' | 'view';
  ownerName: string;
  /** Shown in the calendar (the checkbox). */
  visible: boolean;
  /** People it is shared with (owner only). */
  shares: { userId: string; name: string; canEdit: boolean }[];
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  /** ISO times; for all-day events, midnight UTC of the first day and the day after the last. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  notes: string;
  recurrence: Recurrence;
  /** Last day a repeating event happens (YYYY-MM-DD), or null for no end. */
  until: string | null;
}

/** One occurrence in a range (a repeating event appears once per day it happens). */
export interface EventOccurrence extends CalendarEvent {
  /** Start of this occurrence (equals start for non-repeating events). */
  occurrenceStart: string;
  occurrenceEnd: string;
}

export type EventInput = Omit<CalendarEvent, 'id'>;

/**
 * Occurrences of an event between `from` and `to` (ms), counted in local time (so a weekly 9:00
 * meeting stays at 9:00 across daylight-saving changes; the browser runs this). Monthly events on
 * the 29th–31st skip months without that day; at most 500 occurrences per call.
 */
export function occurrences(e: CalendarEvent, from: number, to: number): EventOccurrence[] {
  const start = Date.parse(e.start);
  const end = Date.parse(e.end);
  const dur = Math.max(0, end - start);
  if (e.recurrence === 'none') return end > from && start < to ? [{ ...e, occurrenceStart: e.start, occurrenceEnd: e.end }] : [];
  // All-day events are stored on UTC midnights, so they repeat in UTC (no daylight-saving shift);
  // timed events repeat in local time.
  const utc = e.allDay;
  const [uy, um, ud] = (e.until ?? '').split('-').map(Number);
  const until = !e.until ? Infinity : utc ? Date.UTC(uy!, um! - 1, ud!, 23, 59, 59, 999) : new Date(uy!, um! - 1, ud!, 23, 59, 59, 999).getTime();
  const out: EventOccurrence[] = [];
  const s = new Date(start);
  const day = (d: Date) => (utc ? d.getUTCDate() : d.getDate());
  const month = (d: Date) => (utc ? d.getUTCMonth() : d.getMonth());
  for (let i = 0; out.length < 500 && i < 20000; i++) {
    const d = new Date(s);
    if (e.recurrence === 'daily' || e.recurrence === 'weekly') {
      const n = day(s) + (e.recurrence === 'daily' ? i : 7 * i);
      if (utc) d.setUTCDate(n);
      else d.setDate(n);
    } else if (e.recurrence === 'monthly') {
      if (utc) d.setUTCMonth(month(s) + i);
      else d.setMonth(month(s) + i);
      if (day(d) !== day(s)) continue; // e.g. the 31st in a 30-day month
    } else {
      if (utc) d.setUTCFullYear(s.getUTCFullYear() + i);
      else d.setFullYear(s.getFullYear() + i);
      if (month(d) !== month(s)) continue; // Feb 29 in a common year
    }
    const t = d.getTime();
    if (t > until || t >= to) break;
    if (t + dur > from) out.push({ ...e, occurrenceStart: new Date(t).toISOString(), occurrenceEnd: new Date(t + dur).toISOString() });
  }
  return out;
}

/** Could the event happen between `from` and `to` (ms)? The server's coarse filter. */
export function mayOccur(e: Pick<CalendarEvent, 'start' | 'end' | 'recurrence' | 'until'>, from: number, to: number): boolean {
  const start = Date.parse(e.start);
  if (e.recurrence === 'none') return Date.parse(e.end) > from && start < to;
  return start < to && (!e.until || Date.parse(`${e.until}T23:59:59.999Z`) + 86_400_000 >= from);
}
