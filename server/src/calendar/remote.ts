// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Calendars that live with a provider: Google Calendar (for Gmail signed in with Google), Outlook /
// Microsoft 365 (Microsoft Graph), and any CalDAV server (Nextcloud, iCloud, Fastmail, Radicale…).
// The provider stays the source of truth: events are read for the range on screen and changes are
// written straight back, as with mail.

import crypto from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import { findJoinUrl, type Attendee, type AttendeeStatus, type MeetingKind, type Recurrence, type RepeatFields, type ShowAs } from '../../../shared/calendar.js';
import { utcToWall as wallOf, wallToUtc } from '../../../shared/rrule.js';
import {
  eventsOf,
  excludeOccurrenceIcs,
  fieldsOfIcs,
  newEventIcs,
  occurrencesOf,
  overrideOccurrenceIcs,
  parseIcal,
  reminderOf,
  showAsOf,
  repeatFromRule,
  ruleFor,
  startWallOf,
  statusOfPartstat,
  updateEventIcs,
  utcToWall,
  validTimeZone,
  windowsZone,
  type EventFields,
} from './ical.js';

export type Http = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'manual' | 'follow' },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null } }>;

export interface RemoteCalendar {
  remoteId: string;
  name: string;
  color: string;
  writable: boolean;
  /** Shown at first (the user's checkbox decides afterwards). */
  visibleByDefault: boolean;
  /** Online meetings the provider makes for events in this calendar. */
  meetings?: MeetingKind[];
}

export interface RemoteEvent {
  remoteId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  notes: string;
  /** For events that aren't expanded by the provider (none of these three are); kept for the editor. */
  recurrence: Recurrence;
  until: string | null;
  /** One occurrence of a repeating series. */
  instance: boolean;
  /** Can't be changed from DreyMail. */
  readOnly: boolean;
  /** For an occurrence: the provider id of its series. */
  seriesId?: string;
  reminder?: number | null;
  attendees?: Attendee[];
  organizer?: { email: string; name: string } | null;
  /** The provider says you organize it (CalDAV leaves this to the caller). */
  isOrganizer?: boolean;
  showAs?: ShowAs;
  joinUrl?: string | null;
}

/** A whole event or series, as the editor shows it. */
export type RemoteSeries = RemoteEvent & RepeatFields & { timeZone?: string; exdates?: string[]; editable: boolean };

export type InviteAnswer = 'accepted' | 'tentative' | 'declined';

export interface CalendarProvider {
  listCalendars(): Promise<RemoteCalendar[]>;
  events(calendar: string, from: number, to: number): Promise<RemoteEvent[]>;
  create(calendar: string, f: EventFields): Promise<string>;
  update(calendar: string, eventId: string, f: EventFields, instance: boolean): Promise<void>;
  remove(calendar: string, eventId: string): Promise<void>;
  /** The whole event or series (for editing every occurrence). */
  get(calendar: string, eventId: string): Promise<RemoteSeries>;
  /** The invitation with this iCalendar UID in the user's calendar, if the provider added it. */
  findInvite?(uid: string): Promise<{ eventId: string; answer: InviteAnswer | null } | null>;
  answerInvite?(eventId: string, answer: InviteAnswer): Promise<void>;
  /** Answers with a new time proposed (DreyMail 10.8; Outlook only). */
  proposeTime?(eventId: string, answer: 'tentative' | 'declined', start: number, end: number, comment: string): Promise<void>;
  /** Moves an event the user organizes (accepting a guest's proposed time) (DreyMail 10.8). */
  moveEvent?(eventId: string, start: number, end: number): Promise<void>;
  /** Busy times of these people (colleagues, shared calendars) between from and to (DreyMail 10.2). */
  freeBusy?(emails: string[], from: number, to: number): Promise<Record<string, BusyResult>>;
}

/** Someone's busy times, or why they can't be seen. */
export interface BusyResult {
  busy: { start: string; end: string; status: 'busy' | 'tentative' | 'away' | 'elsewhere' }[];
  error?: string;
}

export class RemoteCalendarError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The sign-in lacks calendar access: reconnecting the mailbox fixes it. */
    readonly reconnect = false,
  ) {
    super(message);
  }
}

const TIMEOUT = 20_000;
const dateOf = (iso: string) => iso.slice(0, 10);

async function call<T>(http: Http, url: string, method: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await http(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let msg = '';
    let reason = '';
    try {
      const j = JSON.parse(text) as { error?: { message?: string; code?: string; errors?: { reason?: string }[]; status?: string } | string };
      if (typeof j.error === 'object') {
        msg = j.error.message ?? '';
        reason = `${j.error.errors?.[0]?.reason ?? ''} ${j.error.code ?? ''} ${j.error.status ?? ''}`;
      } else msg = j.error ?? '';
    } catch {
      /* not JSON */
    }
    throw explain(res.status, msg, reason);
  }
  return (text ? JSON.parse(text) : null) as T;
}

function explain(status: number, msg: string, reason: string): RemoteCalendarError {
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(`${reason} ${msg}`))
    return new RemoteCalendarError('The Google Calendar API is turned off for this server. An administrator turns it on in Google Cloud Console (APIs & Services → Library → Google Calendar API).', status);
  if (status === 401 || (status === 403 && /insufficient|scope|AccessDenied|Authorization_RequestDenied|PERMISSION_DENIED/i.test(`${reason} ${msg}`)))
    return new RemoteCalendarError('Calendar access was not allowed for this mailbox. Reconnect it to allow calendar access.', status, true);
  return new RemoteCalendarError(msg ? `The calendar server said: ${msg}` : `The calendar server answered ${status}`, status);
}

// ---- Google Calendar ------------------------------------------------------------------------------

interface GPerson {
  email?: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  responseStatus?: string;
  resource?: boolean;
}
interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurringEventId?: string;
  recurrence?: string[];
  attendees?: GPerson[];
  organizer?: GPerson;
  reminders?: { useDefault?: boolean; overrides?: { method?: string; minutes?: number }[] };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  transparency?: string;
}

const G_STATUS: Record<string, AttendeeStatus> = { accepted: 'accepted', tentative: 'tentative', declined: 'declined' };
const G_RESPONSE: Record<AttendeeStatus, string> = { accepted: 'accepted', tentative: 'tentative', declined: 'declined', 'needs-action': 'needsAction' };

export class GoogleCalendar implements CalendarProvider {
  private readonly base = 'https://www.googleapis.com/calendar/v3';
  constructor(
    private readonly token: () => Promise<string>,
    private readonly http: Http,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    return call<T>(this.http, `${this.base}${path}`, method, await this.token(), body);
  }

  async listCalendars(): Promise<RemoteCalendar[]> {
    const out: RemoteCalendar[] = [];
    let page = '';
    for (let i = 0; i < 10; i++) {
      const r = await this.req<{
        items?: { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; accessRole?: string; selected?: boolean; hidden?: boolean; deleted?: boolean; conferenceProperties?: { allowedConferenceSolutionTypes?: string[] } }[];
        nextPageToken?: string;
      }>('GET', `/users/me/calendarList?maxResults=250${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      for (const c of r.items ?? [])
        if (!c.deleted)
          out.push({
            remoteId: c.id,
            name: c.summaryOverride || c.summary || c.id,
            color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor ?? '') ? c.backgroundColor! : '#4285f4',
            writable: c.accessRole === 'owner' || c.accessRole === 'writer',
            visibleByDefault: c.selected === true && !c.hidden,
            ...(c.conferenceProperties?.allowedConferenceSolutionTypes?.includes('hangoutsMeet') ? { meetings: ['meet' as const] } : {}),
          });
      if (!r.nextPageToken) break;
      page = r.nextPageToken;
    }
    return out;
  }

  private toEvent(e: GEvent, defaults: { minutes?: number }[] = []): RemoteEvent {
    const allDay = !!e.start!.date;
    const people = (e.attendees ?? []).filter((a) => a.email && !a.organizer && !(a.self && e.organizer?.self));
    const rem = e.reminders?.useDefault ? defaults : (e.reminders?.overrides ?? []);
    const minutes = rem.map((x) => x.minutes).filter((x): x is number => typeof x === 'number');
    return {
      remoteId: e.id,
      title: e.summary ?? '(no title)',
      start: allDay ? `${e.start!.date}T00:00:00.000Z` : new Date(e.start!.dateTime!).toISOString(),
      end: allDay ? `${e.end?.date ?? e.start!.date}T00:00:00.000Z` : new Date(e.end?.dateTime ?? e.start!.dateTime!).toISOString(),
      allDay,
      location: e.location ?? '',
      notes: e.description ?? '',
      recurrence: 'none',
      until: null,
      instance: !!e.recurringEventId,
      readOnly: false,
      seriesId: e.recurringEventId,
      reminder: minutes.length ? Math.min(...minutes) : null,
      attendees: people.map((a) => ({ email: a.email!.toLowerCase(), name: a.displayName ?? '', status: G_STATUS[a.responseStatus ?? ''] ?? 'needs-action', ...(a.optional ? { optional: true } : {}), ...(a.resource ? { resource: true } : {}) })),
      organizer: e.organizer?.email ? { email: e.organizer.email.toLowerCase(), name: e.organizer.displayName ?? '' } : null,
      isOrganizer: !e.organizer || !!e.organizer.self,
      ...(e.transparency === 'transparent' ? { showAs: 'free' as const } : {}),
      joinUrl: e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? findJoinUrl(e.location, e.description),
    };
  }

  async events(calendar: string, from: number, to: number): Promise<RemoteEvent[]> {
    const out: RemoteEvent[] = [];
    let page = '';
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({ singleEvents: 'true', timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), maxResults: '2500', ...(page ? { pageToken: page } : {}) });
      const r = await this.req<{ items?: GEvent[]; nextPageToken?: string; defaultReminders?: { minutes?: number }[] }>('GET', `/calendars/${encodeURIComponent(calendar)}/events?${q}`);
      for (const e of r.items ?? []) if (e.status !== 'cancelled' && e.start) out.push(this.toEvent(e, r.defaultReminders));
      if (!r.nextPageToken) break;
      page = r.nextPageToken;
    }
    return out;
  }

  async get(calendar: string, eventId: string): Promise<RemoteSeries> {
    const e = await this.req<GEvent>('GET', `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`);
    if (!e.start) throw new RemoteCalendarError('This event is no longer in the calendar', 404);
    const base = this.toEvent(e);
    const zone = e.start.timeZone && validTimeZone(e.start.timeZone) ? e.start.timeZone : undefined;
    const line = e.recurrence?.find((x) => /^RRULE:/i.test(x));
    if (!line) return { ...base, recurrence: 'none', until: null, timeZone: zone, editable: true };
    const ms = Date.parse(base.start);
    const start = base.allDay || !zone ? { ms, allDay: base.allDay, wall: ms, toUtc: (w: number) => w } : { ms, allDay: false, wall: wallOf(ms, zone), toUtc: (w: number) => wallToUtc(w, zone) };
    const rep = repeatFromRule(line.slice(6), start);
    return { ...base, ...(rep ?? { recurrence: 'none', until: null }), timeZone: zone, editable: !!rep };
  }

  private body(f: EventFields, withRecurrence: boolean) {
    const tz = validTimeZone(f.timeZone) ? f.timeZone : 'UTC';
    const rule = ruleFor(f);
    if (f.onlyRepeat) return { recurrence: rule ? [`RRULE:${rule}`] : [] };
    return {
      summary: f.title,
      location: f.location,
      description: f.notes,
      start: f.allDay ? { date: dateOf(f.start), dateTime: null } : { dateTime: f.start, timeZone: tz, date: null },
      end: f.allDay ? { date: dateOf(f.end), dateTime: null } : { dateTime: f.end, timeZone: tz, date: null },
      ...(withRecurrence ? { recurrence: rule ? [`RRULE:${rule}`] : [] } : {}),
      ...(f.reminder !== undefined ? { reminders: { useDefault: false, overrides: f.reminder === null ? [] : [{ method: 'popup', minutes: f.reminder }] } } : {}),
      ...(f.attendees ? { attendees: f.attendees.map((a) => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}), ...(a.optional ? { optional: true } : {}), ...(a.resource ? { resource: true } : {}), responseStatus: G_RESPONSE[a.status] ?? 'needsAction' })) } : {}),
      ...(f.showAs ? { transparency: f.showAs === 'free' ? 'transparent' : 'opaque' } : {}),
      ...(f.meeting === 'meet' ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
    };
  }

  /** Guests hear about it from Google; a new Meet link needs conferenceDataVersion. */
  private query(f: EventFields) {
    return `?sendUpdates=all${f.meeting === 'meet' ? '&conferenceDataVersion=1' : ''}`;
  }

  async create(calendar: string, f: EventFields): Promise<string> {
    return (await this.req<{ id: string }>('POST', `/calendars/${encodeURIComponent(calendar)}/events${this.query(f)}`, this.body(f, true))).id;
  }
  async update(calendar: string, eventId: string, f: EventFields, instance: boolean) {
    await this.req('PATCH', `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}${this.query(f)}`, this.body(f, !instance));
  }
  async remove(calendar: string, eventId: string) {
    try {
      await this.req('DELETE', `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`);
    } catch (err) {
      if (!(err instanceof RemoteCalendarError && (err.status === 404 || err.status === 410))) throw err;
    }
  }

  async freeBusy(emails: string[], from: number, to: number): Promise<Record<string, BusyResult>> {
    const r = await this.req<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }> }>('POST', '/freeBusy', {
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      items: emails.map((id) => ({ id })),
    });
    const out: Record<string, BusyResult> = {};
    for (const e of emails) {
      const c = r.calendars?.[e];
      out[e] = c?.errors?.length
        ? { busy: [], error: c.errors[0]?.reason === 'notFound' ? 'Not found in Google' : 'Their calendar isn\'t shared with you' }
        : { busy: (c?.busy ?? []).map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), status: 'busy' as const })) };
    }
    return out;
  }

  async findInvite(uid: string) {
    const r = await this.req<{ items?: GEvent[] }>('GET', `/calendars/primary/events?iCalUID=${encodeURIComponent(uid)}`);
    const e = r.items?.find((x) => x.status !== 'cancelled');
    if (!e) return null;
    const s = e.attendees?.find((a) => a.self)?.responseStatus;
    return { eventId: e.id, answer: s === 'accepted' || s === 'tentative' || s === 'declined' ? (s as InviteAnswer) : null };
  }

  async moveEvent(eventId: string, start: number, end: number) {
    await this.req('PATCH', `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } });
  }

  async answerInvite(eventId: string, answer: InviteAnswer) {
    const e = await this.req<GEvent>('GET', `/calendars/primary/events/${encodeURIComponent(eventId)}`);
    const attendees = (e.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: answer } : a));
    if (!attendees.some((a) => a.self)) throw new RemoteCalendarError('You are not on the guest list of this event in Google Calendar', 400);
    // sendUpdates tells the organizer.
    await this.req('PATCH', `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { attendees });
  }
}

// ---- Outlook / Microsoft 365 (Microsoft Graph) -----------------------------------------------------

const GRAPH_COLORS: Record<string, string> = {
  lightBlue: '#4f9bd9',
  lightGreen: '#5fb84f',
  lightOrange: '#e8833a',
  lightGray: '#9a9a9a',
  lightYellow: '#e3c33c',
  lightTeal: '#3fb8b0',
  lightPink: '#e06aa6',
  lightBrown: '#a3a3a3', // DreyMail avoids brown
  lightRed: '#e05a5a',
  maxColor: '#0078d4',
  auto: '#0078d4',
};
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

interface GraphPerson {
  emailAddress?: { address?: string; name?: string };
  type?: string;
  status?: { response?: string };
}
interface GraphEvent {
  id: string;
  subject?: string;
  location?: { displayName?: string };
  body?: { content?: string };
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  type?: string;
  seriesMasterId?: string;
  responseStatus?: { response?: string };
  attendees?: GraphPerson[];
  organizer?: GraphPerson;
  isOrganizer?: boolean;
  isReminderOn?: boolean;
  reminderMinutesBeforeStart?: number;
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  recurrence?: GraphRecurrence | null;
  originalStartTimeZone?: string;
  showAs?: string;
}
interface GraphRecurrence {
  pattern: { type: string; interval?: number; daysOfWeek?: string[]; dayOfMonth?: number; month?: number; index?: string; firstDayOfWeek?: string };
  range: { type: string; startDate?: string; endDate?: string; numberOfOccurrences?: number };
}

const GRAPH_STATUS: Record<string, AttendeeStatus> = { accepted: 'accepted', tentativelyAccepted: 'tentative', declined: 'declined' };
const GRAPH_RESPONSE: Record<AttendeeStatus, string> = { accepted: 'accepted', tentative: 'tentativelyAccepted', declined: 'declined', 'needs-action': 'none' };
const INDEX = ['', 'first', 'second', 'third', 'fourth'];
const SELECT = 'id,subject,location,body,start,end,isAllDay,isCancelled,type,seriesMasterId,attendees,organizer,isOrganizer,isReminderOn,reminderMinutesBeforeStart,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,showAs';
const FROM_GRAPH_SHOW: Record<string, ShowAs> = { free: 'free', tentative: 'tentative', oof: 'away', workingElsewhere: 'elsewhere' };
const TO_GRAPH_SHOW: Record<ShowAs, string> = { busy: 'busy', free: 'free', tentative: 'tentative', away: 'oof', elsewhere: 'workingElsewhere' };

/** A Graph repeat pattern for DreyMail's repeat fields (`localStart`: the start's wall time). */
export function graphRecurrence(f: RepeatFields, localStart: Date): GraphRecurrence | null {
  if (f.recurrence === 'none') return null;
  const interval = Math.max(1, f.interval ?? 1);
  const wd = localStart.getUTCDay();
  const nth = f.monthlyBy === 'last' || Math.ceil(localStart.getUTCDate() / 7) > 4 ? 'last' : INDEX[Math.ceil(localStart.getUTCDate() / 7)]!;
  const byWeekday = f.monthlyBy === 'weekday' || f.monthlyBy === 'last';
  const pattern =
    f.recurrence === 'daily'
      ? { type: 'daily', interval }
      : f.recurrence === 'weekly'
        ? { type: 'weekly', interval, daysOfWeek: (f.byDay?.length ? [...new Set(f.byDay)].sort() : [wd]).map((d) => WEEKDAY_NAMES[d]!), firstDayOfWeek: 'sunday' }
        : f.recurrence === 'monthly'
          ? byWeekday
            ? { type: 'relativeMonthly', interval, daysOfWeek: [WEEKDAY_NAMES[wd]!], index: nth }
            : { type: 'absoluteMonthly', interval, dayOfMonth: localStart.getUTCDate() }
          : byWeekday
            ? { type: 'relativeYearly', interval, daysOfWeek: [WEEKDAY_NAMES[wd]!], index: nth, month: localStart.getUTCMonth() + 1 }
            : { type: 'absoluteYearly', interval, dayOfMonth: localStart.getUTCDate(), month: localStart.getUTCMonth() + 1 };
  const startDate = localStart.toISOString().slice(0, 10);
  const range = f.count ? { type: 'numbered', startDate, numberOfOccurrences: f.count } : f.until ? { type: 'endDate', startDate, endDate: f.until } : { type: 'noEnd', startDate };
  return { pattern, range };
}

/** DreyMail's repeat fields for a Graph pattern, or null when the editor can't show it. */
export function repeatFromGraph(r: GraphRecurrence, localStart: Date): RepeatFields | null {
  const p = r.pattern;
  const interval = Math.max(1, p.interval ?? 1);
  const range: Pick<RepeatFields, 'until' | 'count'> = r.range.type === 'numbered' ? { until: null, count: r.range.numberOfOccurrences ?? null } : r.range.type === 'endDate' ? { until: r.range.endDate ?? null, count: null } : { until: null, count: null };
  const days = (p.daysOfWeek ?? []).map((d) => WEEKDAY_NAMES.indexOf(d.toLowerCase())).filter((d) => d >= 0);
  const relative = (): Pick<RepeatFields, 'monthlyBy'> | null => {
    if (days.length !== 1 || days[0] !== localStart.getUTCDay()) return null;
    if (p.index === 'last') return { monthlyBy: 'last' };
    return INDEX.indexOf(p.index ?? 'first') === Math.ceil(localStart.getUTCDate() / 7) ? { monthlyBy: 'weekday' } : null;
  };
  switch (p.type) {
    case 'daily':
      return { recurrence: 'daily', interval, ...range };
    case 'weekly':
      return { recurrence: 'weekly', interval, byDay: days.length ? days.sort() : undefined, ...range };
    case 'absoluteMonthly':
      return p.dayOfMonth === localStart.getUTCDate() ? { recurrence: 'monthly', interval, monthlyBy: 'day', ...range } : null;
    case 'relativeMonthly': {
      const r = relative();
      return r ? { recurrence: 'monthly', interval, ...r, ...range } : null;
    }
    case 'absoluteYearly':
      return p.dayOfMonth === localStart.getUTCDate() && p.month === localStart.getUTCMonth() + 1 ? { recurrence: 'yearly', interval, monthlyBy: 'day', ...range } : null;
    case 'relativeYearly': {
      const r = relative();
      return r && p.month === localStart.getUTCMonth() + 1 ? { recurrence: 'yearly', interval, ...r, ...range } : null;
    }
    default:
      return null;
  }
}

export class OutlookCalendar implements CalendarProvider {
  private readonly base = 'https://graph.microsoft.com/v1.0';
  constructor(
    private readonly token: () => Promise<string>,
    private readonly http: Http,
  ) {}

  private async req<T>(method: string, pathOrUrl: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    try {
      return await call<T>(this.http, pathOrUrl.startsWith('https://') ? pathOrUrl : `${this.base}${pathOrUrl}`, method, await this.token(), body, headers);
    } catch (err) {
      if (err instanceof RemoteCalendarError && /onlineMeeting|teamsForBusiness|OnlineMeetingProvider/i.test(err.message))
        throw new RemoteCalendarError('Outlook could not make a Teams meeting for this calendar. Teams meetings need a work or school Microsoft 365 account with Teams.', err.status);
      throw err;
    }
  }

  private async all<T>(first: string, headers?: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = first;
    for (let i = 0; url && i < 20; i++) {
      const r: { value?: T[]; '@odata.nextLink'?: string } = await this.req('GET', url, undefined, headers);
      out.push(...(r.value ?? []));
      url = r['@odata.nextLink'];
      if (url && !url.startsWith(this.base)) break; // only follow links back to Graph
    }
    return out;
  }

  async listCalendars(): Promise<RemoteCalendar[]> {
    const list = await this.all<{ id: string; name: string; hexColor?: string; color?: string; canEdit?: boolean; isDefaultCalendar?: boolean; allowedOnlineMeetingProviders?: string[] }>(
      '/me/calendars?$top=100&$select=id,name,hexColor,color,canEdit,isDefaultCalendar,allowedOnlineMeetingProviders',
    );
    return list.map((c) => ({
      remoteId: c.id,
      name: c.name,
      color: /^#[0-9a-f]{6}$/i.test(c.hexColor ?? '') ? c.hexColor! : GRAPH_COLORS[c.color ?? ''] ?? '#0078d4',
      writable: c.canEdit !== false,
      visibleByDefault: !!c.isDefaultCalendar || c.canEdit !== false,
      ...(c.allowedOnlineMeetingProviders?.includes('teamsForBusiness') ? { meetings: ['teams' as const] } : {}),
    }));
  }

  private toEvent(e: GraphEvent): RemoteEvent {
    const people = (e.attendees ?? []).filter((a) => a.emailAddress?.address && a.status?.response !== 'organizer');
    const organizer = e.organizer?.emailAddress?.address ? { email: e.organizer.emailAddress.address.toLowerCase(), name: e.organizer.emailAddress.name ?? '' } : null;
    return {
      remoteId: e.id,
      title: e.subject || '(no title)',
      start: e.isAllDay ? `${e.start!.dateTime.slice(0, 10)}T00:00:00.000Z` : new Date(`${e.start!.dateTime.replace(/\.\d+$/, '')}Z`).toISOString(),
      end: e.isAllDay ? `${e.end!.dateTime.slice(0, 10)}T00:00:00.000Z` : new Date(`${e.end!.dateTime.replace(/\.\d+$/, '')}Z`).toISOString(),
      allDay: !!e.isAllDay,
      location: e.location?.displayName ?? '',
      notes: (e.body?.content ?? '').trim().slice(0, 10_000),
      recurrence: 'none' as Recurrence,
      until: null,
      instance: e.type === 'occurrence' || e.type === 'exception',
      readOnly: false,
      seriesId: e.seriesMasterId,
      reminder: e.isReminderOn === false ? null : (e.reminderMinutesBeforeStart ?? null),
      attendees: people.map((a) => ({
        email: a.emailAddress!.address!.toLowerCase(),
        name: a.emailAddress!.name ?? '',
        status: GRAPH_STATUS[a.status?.response ?? ''] ?? 'needs-action',
        ...(a.type === 'optional' ? { optional: true } : {}),
        ...(a.type === 'resource' ? { resource: true } : {}),
      })),
      organizer: people.length ? organizer : null,
      isOrganizer: e.isOrganizer !== false,
      ...(FROM_GRAPH_SHOW[e.showAs ?? ''] ? { showAs: FROM_GRAPH_SHOW[e.showAs!] } : {}),
      joinUrl: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? findJoinUrl(e.location?.displayName, e.body?.content),
    };
  }

  async events(calendar: string, from: number, to: number): Promise<RemoteEvent[]> {
    const q = new URLSearchParams({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $top: '250', $select: SELECT });
    const list = await this.all<GraphEvent>(`/me/calendars/${encodeURIComponent(calendar)}/calendarView?${q}`, { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' });
    return list.filter((e) => !e.isCancelled && e.start && e.end).map((e) => this.toEvent(e));
  }

  async get(_calendar: string, eventId: string): Promise<RemoteSeries> {
    const e = await this.req<GraphEvent>('GET', `/me/events/${encodeURIComponent(eventId)}?$select=${SELECT},recurrence,originalStartTimeZone`, undefined, { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' });
    if (!e.start || !e.end) throw new RemoteCalendarError('This event is no longer in the calendar', 404);
    const base = this.toEvent(e);
    const zoneName = e.originalStartTimeZone && validTimeZone(e.originalStartTimeZone) ? e.originalStartTimeZone : (e.originalStartTimeZone ? windowsZone(e.originalStartTimeZone) : undefined);
    if (!e.recurrence) return { ...base, recurrence: 'none', until: null, timeZone: zoneName, editable: true };
    const ms = Date.parse(base.start);
    const local = new Date(base.allDay || !zoneName ? ms : utcToWall(ms, zoneName));
    const rep = repeatFromGraph(e.recurrence, local);
    return { ...base, ...(rep ?? { recurrence: 'none', until: null }), timeZone: zoneName, editable: !!rep };
  }

  private body(f: EventFields, withRecurrence: boolean) {
    const tz = validTimeZone(f.timeZone) ? f.timeZone : 'UTC';
    const wall = (iso: string) => new Date(utcToWall(Date.parse(iso), tz)).toISOString().slice(0, 19);
    const start = f.allDay ? { dateTime: `${dateOf(f.start)}T00:00:00`, timeZone: 'UTC' } : { dateTime: wall(f.start), timeZone: tz };
    const end = f.allDay ? { dateTime: `${dateOf(f.end)}T00:00:00`, timeZone: 'UTC' } : { dateTime: wall(f.end), timeZone: tz };
    const localStart = new Date(startWallOf({ ...f, timeZone: tz }));
    if (f.onlyRepeat) return { recurrence: graphRecurrence(f, localStart) };
    return {
      subject: f.title,
      body: { contentType: 'text', content: f.notes },
      location: { displayName: f.location },
      isAllDay: f.allDay,
      start,
      end,
      ...(withRecurrence ? { recurrence: graphRecurrence(f, localStart) } : {}),
      ...(f.reminder !== undefined ? { isReminderOn: f.reminder !== null, ...(f.reminder !== null ? { reminderMinutesBeforeStart: f.reminder } : {}) } : {}),
      ...(f.attendees
        ? { attendees: f.attendees.map((a) => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) }, type: a.resource ? 'resource' : a.optional ? 'optional' : 'required', status: { response: GRAPH_RESPONSE[a.status] ?? 'none' } })) }
        : {}),
      ...(f.meeting === 'teams' ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
      ...(f.showAs ? { showAs: TO_GRAPH_SHOW[f.showAs] } : {}),
    };
  }

  // Outlook sends the invitations, updates and cancellations to the guests itself.
  async create(calendar: string, f: EventFields): Promise<string> {
    return (await this.req<{ id: string }>('POST', `/me/calendars/${encodeURIComponent(calendar)}/events`, this.body(f, true))).id;
  }
  async update(_calendar: string, eventId: string, f: EventFields, instance: boolean) {
    await this.req('PATCH', `/me/events/${encodeURIComponent(eventId)}`, this.body(f, !instance));
  }
  async remove(_calendar: string, eventId: string) {
    try {
      // The organizer's cancel tells the guests; anyone else's is a plain delete.
      await this.req('POST', `/me/events/${encodeURIComponent(eventId)}/cancel`, { comment: '' }).catch(async (err: unknown) => {
        if (err instanceof RemoteCalendarError && (err.status === 400 || err.status === 403)) await this.req('DELETE', `/me/events/${encodeURIComponent(eventId)}`);
        else throw err;
      });
    } catch (err) {
      if (!(err instanceof RemoteCalendarError && err.status === 404)) throw err;
    }
  }

  async freeBusy(emails: string[], from: number, to: number): Promise<Record<string, BusyResult>> {
    const r = await this.req<{ value?: { scheduleId: string; scheduleItems?: { status?: string; start?: { dateTime: string }; end?: { dateTime: string } }[]; error?: { message?: string } }[] }>(
      'POST',
      '/me/calendar/getSchedule',
      { schedules: emails, startTime: { dateTime: new Date(from).toISOString().slice(0, 19), timeZone: 'UTC' }, endTime: { dateTime: new Date(to).toISOString().slice(0, 19), timeZone: 'UTC' }, availabilityViewInterval: 15 },
      { prefer: 'outlook.timezone="UTC"' },
    );
    const status = (x?: string) => (x === 'tentative' ? 'tentative' : x === 'oof' ? 'away' : x === 'workingElsewhere' ? 'elsewhere' : 'busy') as BusyResult['busy'][number]['status'];
    const out: Record<string, BusyResult> = {};
    for (const e of emails) out[e] = { busy: [], error: 'Not found in Outlook' };
    for (const v of r.value ?? []) {
      const key = emails.find((e) => e.toLowerCase() === v.scheduleId.toLowerCase()) ?? v.scheduleId;
      out[key] = v.error
        ? { busy: [], error: v.error.message?.includes('not found') ? 'Not found in Outlook' : "Their calendar can't be seen" }
        : {
            busy: (v.scheduleItems ?? [])
              .filter((i) => i.status !== 'free' && i.start && i.end)
              .map((i) => ({ start: new Date(`${i.start!.dateTime.replace(/\.\d+$/, '')}Z`).toISOString(), end: new Date(`${i.end!.dateTime.replace(/\.\d+$/, '')}Z`).toISOString(), status: status(i.status) })),
          };
    }
    return out;
  }

  async findInvite(uid: string) {
    const list = await this.all<GraphEvent>(`/me/events?$filter=${encodeURIComponent(`iCalUId eq '${uid.replace(/'/g, "''")}'`)}&$select=id,responseStatus,isCancelled`);
    const e = list.find((x) => !x.isCancelled);
    if (!e) return null;
    const r = e.responseStatus?.response;
    return { eventId: e.id, answer: r === 'accepted' ? 'accepted' : r === 'tentativelyAccepted' ? 'tentative' : r === 'declined' ? 'declined' : null } as const;
  }

  async answerInvite(eventId: string, answer: InviteAnswer) {
    const action = answer === 'accepted' ? 'accept' : answer === 'tentative' ? 'tentativelyAccept' : 'decline';
    await this.req('POST', `/me/events/${encodeURIComponent(eventId)}/${action}`, { sendResponse: true });
  }

  async proposeTime(eventId: string, answer: 'tentative' | 'declined', start: number, end: number, comment: string) {
    const t = (ms: number) => ({ dateTime: new Date(ms).toISOString().slice(0, 19), timeZone: 'UTC' });
    await this.req('POST', `/me/events/${encodeURIComponent(eventId)}/${answer === 'tentative' ? 'tentativelyAccept' : 'decline'}`, { sendResponse: true, comment, proposedNewTime: { start: t(start), end: t(end) } });
  }

  async moveEvent(eventId: string, start: number, end: number) {
    const t = (ms: number) => ({ dateTime: new Date(ms).toISOString().slice(0, 19), timeZone: 'UTC' });
    await this.req('PATCH', `/me/events/${encodeURIComponent(eventId)}`, { start: t(start), end: t(end) });
  }
}

// ---- CalDAV ----------------------------------------------------------------------------------------

interface XNode {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  data?: string;
  children?: XNode[];
}
const local = (n: XNode) => (n.name ?? '').split(':').pop()!.toLowerCase();
function findAll(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children ?? []) {
    if (c.type === 'tag' && local(c) === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
const find = (n: XNode, name: string) => findAll(n, name)[0];
function textOf(n: XNode | undefined): string {
  if (!n) return '';
  if (n.type === 'text') return n.data ?? '';
  return (n.children ?? []).map(textOf).join('');
}

interface DavResponse {
  href: string;
  /** Properties from the 200 propstat only. */
  props: XNode;
}

function multistatus(xml: string): DavResponse[] {
  const doc = parseDocument(xml, { xmlMode: true }) as unknown as XNode;
  return findAll(doc, 'response').map((r) => {
    const ok = findAll(r, 'propstat').filter((ps) => /\s200\s/.test(` ${textOf(find(ps, 'status'))} `));
    const props: XNode = { type: 'tag', name: 'prop', children: ok.flatMap((ps) => find(ps, 'prop')?.children ?? []) };
    return { href: textOf(find(r, 'href')).trim(), props };
  });
}

const PROPFIND_DISCOVER = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;
const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop></d:propfind>`;

const fmtUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

export class CalDavCalendar implements CalendarProvider {
  constructor(
    private readonly url: string,
    private readonly username: string,
    private readonly password: string,
    private readonly http: Http,
    /** Checks each URL before connecting (refuses internal addresses when the server is set to). */
    private readonly guard: (url: URL) => Promise<void>,
  ) {}

  private async dav(url: string, method: string, body?: string, headers: Record<string, string> = {}) {
    let target = new URL(url);
    const origin = new URL(this.url).origin;
    for (let hop = 0; hop < 5; hop++) {
      if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new RemoteCalendarError('Only http and https calendar addresses work', 400);
      await this.guard(target);
      const res = await this.http(target.toString(), {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: {
          // Credentials only go to the server you entered (redirects elsewhere get none).
          ...(target.origin === origin || hop === 0 ? { authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}` } : {}),
          ...(body ? { 'content-type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}),
          ...headers,
        },
        body,
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        target = new URL(loc, target);
        continue;
      }
      if (res.status === 401) throw new RemoteCalendarError('The calendar server did not accept the username or password', 401);
      return { res, url: target };
    }
    throw new RemoteCalendarError('The calendar server redirected too many times', 508);
  }

  private async propfind(url: string, depth: '0' | '1', body: string) {
    const { res, url: final } = await this.dav(url, 'PROPFIND', body, { depth });
    const text = await res.text();
    if (res.status !== 207) throw new RemoteCalendarError(`The calendar server answered ${res.status} at ${new URL(url).pathname}`, res.status);
    return { list: multistatus(text), url: final };
  }

  /** Finds the calendar home (RFC 6764 / RFC 4791) and lists its event calendars. */
  async listCalendars(): Promise<RemoteCalendar[]> {
    const base = new URL(this.url);
    const starts = base.pathname === '/' || base.pathname === '' ? [new URL('/.well-known/caldav', base).toString(), base.toString()] : [base.toString()];
    let home: string | null = null;
    let lastErr: unknown = null;
    for (const start of starts) {
      try {
        const { list, url } = await this.propfind(start, '0', PROPFIND_DISCOVER);
        const self = list[0];
        if (!self) continue;
        if (find(self.props, 'resourcetype') && find(find(self.props, 'resourcetype')!, 'calendar')) {
          // The address is a calendar itself: list just that one.
          return this.collections(url.toString(), '0');
        }
        const homeHref = textOf(find(find(self.props, 'calendar-home-set') ?? { type: 'x' }, 'href')).trim();
        if (homeHref) home = new URL(homeHref, url).toString();
        else {
          const principal = textOf(find(find(self.props, 'current-user-principal') ?? { type: 'x' }, 'href')).trim();
          if (principal) {
            const p = await this.propfind(new URL(principal, url).toString(), '0', PROPFIND_DISCOVER);
            const h = textOf(find(find(p.list[0]?.props ?? { type: 'x' }, 'calendar-home-set') ?? { type: 'x' }, 'href')).trim();
            if (h) home = new URL(h, p.url).toString();
          }
        }
        if (!home) home = url.toString();
        break;
      } catch (err) {
        if (err instanceof RemoteCalendarError && err.status === 401) throw err;
        lastErr = err;
      }
    }
    if (!home) throw lastErr instanceof Error ? lastErr : new RemoteCalendarError('No calendars found at this address', 404);
    return this.collections(home, '1');
  }

  private async collections(url: string, depth: '0' | '1'): Promise<RemoteCalendar[]> {
    const { list, url: final } = await this.propfind(url, depth, PROPFIND_CALENDARS);
    const out: RemoteCalendar[] = [];
    for (const r of list) {
      const rt = find(r.props, 'resourcetype');
      if (!rt || !find(rt, 'calendar')) continue;
      const comps = findAll(r.props, 'comp');
      if (comps.length && !comps.some((c) => (c.attribs?.name ?? '').toUpperCase() === 'VEVENT')) continue;
      const privs = find(r.props, 'current-user-privilege-set');
      const writable = !privs || ['write', 'write-content', 'all', 'bind'].some((p) => find(privs, p));
      const href = new URL(r.href, final).toString();
      const color = textOf(find(r.props, 'calendar-color')).trim().slice(0, 7);
      out.push({
        remoteId: href.endsWith('/') ? href : `${href}/`,
        name: textOf(find(r.props, 'displayname')).trim() || decodeURIComponent(new URL(href).pathname.split('/').filter(Boolean).pop() ?? 'Calendar'),
        color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#22d3ee',
        writable,
        visibleByDefault: true,
      });
    }
    if (!out.length) throw new RemoteCalendarError('No event calendars found at this address', 404);
    return out;
  }

  async events(calendar: string, from: number, to: number): Promise<RemoteEvent[]> {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="${fmtUtc(from)}" end="${fmtUtc(to)}"/></c:calendar-data></d:prop>
<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${fmtUtc(from)}" end="${fmtUtc(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const { res, url } = await this.dav(calendar, 'REPORT', body, { depth: '1' });
    const text = await res.text();
    if (res.status !== 207) throw new RemoteCalendarError(`The calendar server answered ${res.status}`, res.status);
    const out: RemoteEvent[] = [];
    for (const r of multistatus(text)) {
      const data = textOf(find(r.props, 'calendar-data'));
      const cal = parseIcal(data).find((c) => c.name === 'VCALENDAR');
      if (!cal) continue;
      const href = new URL(r.href, url).toString();
      const events = eventsOf(cal);
      // Servers that don't expand send the series itself; expand it here.
      for (const o of occurrencesOf(events, from, to)) {
        const people = o.event.attendees.filter((a) => a.email !== o.event.organizer?.email);
        out.push({
          remoteId: o.repeating ? `${href}#${o.start}` : href,
          title: o.event.title || '(no title)',
          start: new Date(o.start).toISOString(),
          end: new Date(o.end).toISOString(),
          allDay: o.event.allDay,
          location: o.event.location,
          notes: o.event.description,
          recurrence: 'none',
          until: null,
          instance: o.repeating,
          readOnly: false,
          seriesId: o.repeating ? href : undefined,
          reminder: reminderOf(o.event.component),
          ...(showAsOf(o.event.component) ? { showAs: showAsOf(o.event.component) } : {}),
          attendees: people.map((a) => ({ email: a.email, name: a.name, status: statusOfPartstat(a.status), ...(a.role === 'OPT-PARTICIPANT' ? { optional: true } : {}), ...(a.cutype === 'ROOM' || a.cutype === 'RESOURCE' ? { resource: true } : {}) })),
          organizer: people.length && o.event.organizer ? { email: o.event.organizer.email, name: o.event.organizer.name } : null,
          joinUrl: findJoinUrl(o.event.location, o.event.description),
        });
      }
    }
    return out;
  }

  async create(calendar: string, f: EventFields): Promise<string> {
    // DreyMail emails the guests itself; SCHEDULE-AGENT=CLIENT keeps the server from doing it too.
    const { uid, ics } = newEventIcs(f, undefined, { clientSchedules: true });
    return this.putIcs(calendar, uid, ics);
  }

  /** Stores a calendar object under a name made from its UID (replacing it if it's there). */
  async putIcs(calendar: string, uid: string, ics: string, mustBeNew = true): Promise<string> {
    const href = new URL(`${encodeURIComponent(uid.replace(/[^A-Za-z0-9@._-]/g, '_')).slice(0, 200)}.ics`, calendar).toString();
    const { res } = await this.dav(href, 'PUT', ics, mustBeNew ? { 'if-none-match': '*' } : {});
    if (!res.ok) throw new RemoteCalendarError(`The calendar server did not save the event (${res.status})`, res.status);
    return href;
  }

  /** Reads a calendar object, changes it and writes it back (only if nobody changed it meanwhile). */
  private async change(href: string, edit: (ics: string) => string) {
    const { res } = await this.dav(href, 'GET');
    if (!res.ok) throw new RemoteCalendarError(`This event is no longer on the calendar server (${res.status})`, res.status);
    const etag = res.headers.get('etag');
    const put = await this.dav(href, 'PUT', edit(await res.text()), etag ? { 'if-match': etag } : {});
    if (put.res.status === 412) throw new RemoteCalendarError('This event was changed elsewhere in the meantime. Reload and try again.', 412);
    if (!put.res.ok) throw new RemoteCalendarError(`The calendar server did not save the change (${put.res.status})`, put.res.status);
  }

  /** "href#start" is one occurrence of a repeating event: it gets an override of its own. */
  private static split(eventId: string): { href: string; occurrence: number | null } {
    const i = eventId.lastIndexOf('#');
    const t = i >= 0 ? Number(eventId.slice(i + 1)) : NaN;
    return i >= 0 && Number.isFinite(t) ? { href: eventId.slice(0, i), occurrence: t } : { href: eventId, occurrence: null };
  }

  async update(_calendar: string, eventId: string, f: EventFields, _instance?: boolean) {
    const { href, occurrence } = CalDavCalendar.split(eventId);
    await this.change(href, (ics) => (occurrence !== null ? overrideOccurrenceIcs(ics, occurrence, f, { clientSchedules: true }) : updateEventIcs(ics, f, { clientSchedules: true })));
  }

  async remove(_calendar: string, eventId: string) {
    const { href, occurrence } = CalDavCalendar.split(eventId);
    if (occurrence !== null) return this.change(href, (ics) => excludeOccurrenceIcs(ics, occurrence));
    const { res } = await this.dav(href, 'DELETE');
    if (!res.ok && res.status !== 404) throw new RemoteCalendarError(`The calendar server did not delete the event (${res.status})`, res.status);
  }

  async get(_calendar: string, eventId: string): Promise<RemoteSeries> {
    const { href } = CalDavCalendar.split(eventId);
    const { res } = await this.dav(href, 'GET');
    if (!res.ok) throw new RemoteCalendarError(`This event is no longer on the calendar server (${res.status})`, res.status);
    const f = fieldsOfIcs(await res.text());
    if (!f) throw new RemoteCalendarError('This event could not be read', 422);
    return { ...f, remoteId: href, instance: false, readOnly: false, joinUrl: findJoinUrl(f.location, f.notes), organizer: f.attendees?.length ? f.organizer : null };
  }

  /** The raw calendar object (for invitations sent from DreyMail). */
  async raw(eventId: string): Promise<string | null> {
    const { res } = await this.dav(CalDavCalendar.split(eventId).href, 'GET');
    return res.ok ? res.text() : null;
  }
}
