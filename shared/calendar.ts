// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/** DreyMail's own calendars: shareable between DreyMail users, optionally grouped under a mailbox. */

import { DAY, expandRule, utcToWall, validTimeZone, wallToUtc, type IcalTime } from './rrule.js';

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** Monthly and yearly repeats: on the start's day of the month, its weekday ("2nd Tuesday") or the last such weekday. */
export type MonthlyBy = 'day' | 'weekday' | 'last';

/** How an event repeats (DreyMail's own events, and series at providers). */
export interface RepeatFields {
  recurrence: Recurrence;
  /** Last day a repeating event happens (YYYY-MM-DD, in the event's time zone), or null for no end. */
  until: string | null;
  /** Every N days, weeks, months or years (default 1). */
  interval?: number;
  /** Weekly: the weekdays (0 = Sunday … 6 = Saturday); default the start's weekday. */
  byDay?: number[];
  /** Monthly and yearly (default 'day'). */
  monthlyBy?: MonthlyBy;
  /** Ends after this many times (null or missing: no limit). */
  count?: number | null;
}

export type AttendeeStatus = 'needs-action' | 'accepted' | 'tentative' | 'declined';

export interface Attendee {
  email: string;
  name: string;
  status: AttendeeStatus;
  /** Optional rather than required. */
  optional?: boolean;
  /** A meeting room or other resource (DreyMail 10.7). */
  resource?: boolean;
}

/** A meeting room that can be booked (DreyMail 10.7): from Microsoft 365, or the administrator's list. */
export interface Room {
  email: string;
  name: string;
  capacity?: number | null;
  building?: string;
  source: 'microsoft' | 'list';
}

/** How the event shows to others looking at your free/busy times (Outlook's "Show as") (DreyMail 10.2). */
export type ShowAs = 'busy' | 'free' | 'tentative' | 'away' | 'elsewhere';
export const SHOW_AS_LABELS: Record<ShowAs, string> = { busy: 'Busy', free: 'Free', tentative: 'Tentative', away: 'Away', elsewhere: 'Working elsewhere' };

/** An online meeting made with the event: Microsoft Teams (Outlook / Microsoft 365) or Google Meet. */
export type MeetingKind = 'teams' | 'meet';

/** Reminder choices, in minutes before the start (Outlook's list). */
export const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 240, 720, 1440, 2880, 10080] as const;
export const DEFAULT_REMINDER = 15;

export function reminderLabel(min: number | null | undefined): string {
  if (min === null || min === undefined) return 'None';
  if (min === 0) return 'At start time';
  if (min % 10080 === 0) return `${min / 10080} week${min === 10080 ? '' : 's'} before`;
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'} before`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'} before`;
  return `${min} minutes before`;
}

export interface CalendarView {
  id: string;
  /** The name shown: your own name for it if you gave one (DreyMail 12.4), else its own. */
  name: string;
  /** Its name at the provider (or its own), when you gave it another (DreyMail 12.4). */
  officialName?: string;
  /** Your own name for it ('' = none) (DreyMail 12.4). */
  nickname?: string;
  /** The color shown: the mailbox's, unless one was picked (DreyMail 12.4). */
  color: string;
  /** The color follows its mailbox's (DreyMail 12.4). */
  mailboxColor?: boolean;
  /** Mailbox it is grouped under in the calendar list (null = "My calendars"). */
  accountId: string | null;
  /** 'owner' for your own, else how it was shared with you. */
  access: 'owner' | 'edit' | 'view';
  ownerName: string;
  /** Shown in the calendar (the checkbox). */
  visible: boolean;
  /** People it is shared with (owner only; DreyMail calendars only). */
  shares: { userId: string; name: string; canEdit: boolean }[];
  /** Where it lives: DreyMail itself, or a provider (read and written live). */
  source: CalendarSource;
  /** For provider calendars: the mailbox (Google, Outlook) or CalDAV connection it comes from. */
  sourceId: string | null;
  /** Online meetings this calendar can make for its events (Teams for Outlook work accounts, Meet for Google). */
  meetings?: MeetingKind[];
}

export type CalendarSource = 'local' | 'google' | 'microsoft' | 'caldav';

/** A provider connection that brings calendars: a Google or Outlook mailbox, or a CalDAV account. */
export interface CalendarSourceView {
  id: string;
  kind: 'google' | 'microsoft' | 'caldav';
  /** Mailbox name, or the CalDAV connection's name. */
  name: string;
  /** Mailbox it is grouped under (Google/Outlook: itself; CalDAV: chosen, or null). */
  accountId: string | null;
  /** CalDAV only. */
  url?: string;
  username?: string;
  /** Why its calendars can't be read right now, if so. */
  error: string | null;
  /** Reconnecting the mailbox (signing in again) fixes the error. */
  reconnect: boolean;
}

/** A reminder whose time has come, shown in the reminder window until dismissed. */
export interface ReminderAlert {
  key: string;
  eventId: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  joinUrl: string | null;
  color: string;
  /** A follow-up reminder: the message it is about (DreyMail 10.1). */
  message?: { accountId: string; folder: string; uid: number; uidValidity: string; messageId: string } | null;
}

/** An invitation found in an email (an iCalendar attachment). */
export interface InviteView {
  /** REQUEST (an invitation or update), CANCEL, REPLY (someone answered yours), PUBLISH… */
  method: string;
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  organizer: { email: string; name: string } | null;
  attendees: { email: string; name: string; status: string }[];
  /** "Repeats every week on Mon" for repeating events. */
  repeats: string | null;
}

export type InviteAnswer = 'accepted' | 'tentative' | 'declined';

/** What DreyMail knows about your answer to an invitation. */
export interface InviteState {
  answer: InviteAnswer | null;
  /** The calendar it is in, if known ("Google Calendar", or a DreyMail/CalDAV calendar name). */
  calendar: string | null;
  /** Answers go through the mailbox's own calendar (Google, Outlook) rather than by email. */
  viaProvider: boolean;
  /** A copy DreyMail added that "Remove from calendar" can delete (after a cancellation). */
  removable: boolean;
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
  interval?: number;
  byDay?: number[];
  monthlyBy?: MonthlyBy;
  count?: number | null;
  /** Occurrences of a repeating DreyMail event that were deleted or moved out (their ISO starts). */
  exdates?: string[];
  /** IANA zone the event was made in: repeats keep their local time there. */
  timeZone?: string;
  /** Reminder, in minutes before the start (null: none). */
  reminder?: number | null;
  /** Busy (the default), free, tentative, away or working elsewhere. */
  showAs?: ShowAs;
  /** People invited (the organizer not among them). */
  attendees?: Attendee[];
  /** Who sent the invitations (null: nobody was invited, or it is yours). */
  organizer?: { email: string; name: string } | null;
  /** You are the organizer (or nobody was invited): you can change the guest list. */
  isOrganizer?: boolean;
  /** Mailbox the invitations of a DreyMail or CalDAV event are sent from. */
  sendFrom?: string | null;
  /** Online meeting asked for when saving (Teams for Outlook calendars, Meet for Google ones). */
  meeting?: MeetingKind | null;
  /** Link to join the online meeting (Teams, Meet, Zoom… found in the event). */
  joinUrl?: string | null;
  /** Provider calendars: one occurrence of a repeating series. */
  instance?: boolean;
  /** For one occurrence of a series: the series' id (GET it to edit the whole series). */
  seriesId?: string;
  /** Can't be changed from DreyMail. */
  readOnly?: boolean;
}

/** One occurrence in a range (a repeating event appears once per day it happens). */
export interface EventOccurrence extends CalendarEvent {
  /** Start of this occurrence (equals start for non-repeating events). */
  occurrenceStart: string;
  occurrenceEnd: string;
}

export type EventInput = Omit<CalendarEvent, 'id' | 'instance' | 'readOnly' | 'seriesId' | 'organizer' | 'isOrganizer' | 'joinUrl'> & {
  /** The browser's time zone, so repeats keep their local time at providers. */
  timeZone?: string;
};

/** Which part of a repeating event a change or deletion applies to. */
export type SeriesScope = 'this' | 'following' | 'all';

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * The RRULE for an event's repeat, given its start as a wall time (UTC fields = local fields).
 * UNTIL is written as a date (YYYYMMDD) unless `untilValue` gives the exact value to use.
 */
export function ruleOf(e: RepeatFields, startWall: number, untilValue?: string): string | null {
  if (e.recurrence === 'none') return null;
  const s = new Date(startWall);
  const parts = [`FREQ=${e.recurrence.toUpperCase()}`];
  const interval = Math.max(1, Math.floor(e.interval ?? 1));
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (e.recurrence === 'weekly' && e.byDay?.length) {
    const days = [...new Set(e.byDay.filter((d) => d >= 0 && d <= 6))].sort();
    if (days.length && !(days.length === 1 && days[0] === s.getUTCDay())) parts.push(`BYDAY=${days.map((d) => WD[d]).join(',')}`);
  }
  if ((e.recurrence === 'monthly' || e.recurrence === 'yearly') && e.monthlyBy && e.monthlyBy !== 'day') {
    const n = e.monthlyBy === 'last' ? -1 : Math.ceil(s.getUTCDate() / 7);
    if (e.recurrence === 'yearly') parts.push(`BYMONTH=${s.getUTCMonth() + 1}`);
    parts.push(`BYDAY=${n}${WD[s.getUTCDay()]}`);
  }
  if (e.count && e.count > 0) parts.push(`COUNT=${Math.floor(e.count)}`);
  else if (e.until) parts.push(`UNTIL=${untilValue ?? e.until.replace(/-/g, '')}`);
  return parts.join(';');
}

const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Every 2 weeks on Monday, Wednesday until Dec 1, 2026" (the start as a wall time). */
export function describeRepeat(e: RepeatFields, startWall: number): string {
  if (e.recurrence === 'none') return 'Does not repeat';
  const s = new Date(startWall);
  const n = Math.max(1, e.interval ?? 1);
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[e.recurrence];
  let text = n > 1 ? `Every ${n} ${unit}s` : `Every ${unit}`;
  if (e.recurrence === 'weekly') {
    const days = e.byDay?.length ? [...new Set(e.byDay)].sort() : [s.getUTCDay()];
    text += days.join(',') === '1,2,3,4,5' ? ' on weekdays' : ` on ${days.map((d) => DAY_NAMES[d]).join(', ')}`;
  } else if (e.recurrence === 'monthly' || e.recurrence === 'yearly') {
    const month = e.recurrence === 'yearly' ? `${s.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} ` : '';
    if (e.monthlyBy === 'weekday' || e.monthlyBy === 'last') {
      const ord = e.monthlyBy === 'last' ? 'last' : ORD[Math.ceil(s.getUTCDate() / 7)];
      text += ` on the ${ord} ${DAY_NAMES[s.getUTCDay()]}${month ? ` of ${month.trim()}` : ''}`;
    } else text += ` on ${month}${e.recurrence === 'yearly' ? s.getUTCDate() : `day ${s.getUTCDate()}`}`;
  }
  if (e.count) text += `, ${e.count} times`;
  else if (e.until) {
    const [y, m, d] = e.until.split('-').map(Number);
    text += ` until ${new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  }
  return text;
}

/** The zone repeats of `e` are counted in: all-day events on UTC dates, timed ones in their own zone. */
export function zoneOf(e: Pick<CalendarEvent, 'allDay' | 'timeZone'>, fallback?: string): string {
  if (e.allDay) return 'UTC';
  if (validTimeZone(e.timeZone)) return e.timeZone;
  if (validTimeZone(fallback)) return fallback;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The event's start as an RRULE start time in its zone. */
export function startTimeOf(e: Pick<CalendarEvent, 'start' | 'allDay' | 'timeZone'>, fallbackZone?: string): IcalTime {
  const ms = Date.parse(e.start);
  const zone = zoneOf(e, fallbackZone);
  if (zone === 'UTC') return { ms, allDay: e.allDay, wall: ms, toUtc: (w) => w };
  return { ms, allDay: false, wall: utcToWall(ms, zone), toUtc: (w) => wallToUtc(w, zone) };
}

/**
 * Occurrences of an event between `from` and `to` (ms), counted in the event's time zone (so a
 * weekly 9:00 meeting stays at 9:00 across daylight-saving changes; events saved without a zone use
 * `fallbackZone`, else this computer's). Monthly events on the 29th–31st skip months without that
 * day; at most 500 occurrences per call.
 */
export function occurrences(e: CalendarEvent, from: number, to: number, fallbackZone?: string): EventOccurrence[] {
  const start = Date.parse(e.start);
  const end = Date.parse(e.end);
  const dur = Math.max(0, end - start);
  if (e.recurrence === 'none') return end > from && start < to ? [{ ...e, occurrenceStart: e.start, occurrenceEnd: e.end }] : [];
  const st = startTimeOf(e, fallbackZone);
  const rule = ruleOf(e, st.wall);
  if (!rule) return [];
  const skipped = new Set((e.exdates ?? []).map((x) => Date.parse(x)).filter((x) => !Number.isNaN(x)));
  return expandRule(rule, st, dur, from, to, skipped, 500).map((t) => ({ ...e, occurrenceStart: new Date(t).toISOString(), occurrenceEnd: new Date(t + dur).toISOString() }));
}

/** Could the event happen between `from` and `to` (ms)? The server's coarse filter. */
export function mayOccur(e: Pick<CalendarEvent, 'start' | 'end' | 'recurrence' | 'until'>, from: number, to: number): boolean {
  const start = Date.parse(e.start);
  if (e.recurrence === 'none') return Date.parse(e.end) > from && start < to;
  return start < to && (!e.until || Date.parse(`${e.until}T23:59:59.999Z`) + DAY >= from);
}

/** Links to online meetings (Teams, Meet, Zoom, Webex, GoToMeeting, Whereby, Jitsi) in event text. */
const MEETING_LINK = /https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join\/|teams\.live\.com\/meet\/|meet\.google\.com\/[a-z]|[\w-]+\.zoom\.us\/[jw]\/|zoom\.us\/[jw]\/|[\w-]+\.webex\.com\/(?:meet|join|[\w-]+\/j\.php)|meet\.goto\.com\/|global\.gotomeeting\.com\/join\/|whereby\.com\/|meet\.jit\.si\/)[^\s<>"')\]]*/i;

/** The first online meeting link in an event's location or notes, if any. */
export function findJoinUrl(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const m = t ? MEETING_LINK.exec(t) : null;
    if (m) return m[0].replace(/[.,;]+$/, '');
  }
  return null;
}
