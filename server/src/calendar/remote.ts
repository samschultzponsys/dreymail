// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Calendars that live with a provider: Google Calendar (for Gmail signed in with Google), Outlook /
// Microsoft 365 (Microsoft Graph), and any CalDAV server (Nextcloud, iCloud, Fastmail, Radicale…).
// The provider stays the source of truth: events are read for the range on screen and changes are
// written straight back, as with mail.

import { parseDocument } from 'htmlparser2';
import type { Recurrence } from '../../../shared/calendar.js';
import { eventsOf, newEventIcs, occurrencesOf, parseIcal, ruleFor, updateEventIcs, utcToWall, validTimeZone, type EventFields } from './ical.js';

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
  /** One occurrence of a repeating series: edits change this occurrence only. */
  instance: boolean;
  /** Can't be changed from DreyMail (repeating CalDAV events). */
  readOnly: boolean;
}

export type InviteAnswer = 'accepted' | 'tentative' | 'declined';

export interface CalendarProvider {
  listCalendars(): Promise<RemoteCalendar[]>;
  events(calendar: string, from: number, to: number): Promise<RemoteEvent[]>;
  create(calendar: string, f: EventFields): Promise<string>;
  update(calendar: string, eventId: string, f: EventFields, instance: boolean): Promise<void>;
  remove(calendar: string, eventId: string): Promise<void>;
  /** The invitation with this iCalendar UID in the user's calendar, if the provider added it. */
  findInvite?(uid: string): Promise<{ eventId: string; answer: InviteAnswer | null } | null>;
  answerInvite?(eventId: string, answer: InviteAnswer): Promise<void>;
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

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  recurringEventId?: string;
  attendees?: { self?: boolean; responseStatus?: string; email?: string }[];
}

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
      const r = await this.req<{ items?: { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; accessRole?: string; selected?: boolean; hidden?: boolean; deleted?: boolean }[]; nextPageToken?: string }>(
        'GET',
        `/users/me/calendarList?maxResults=250${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`,
      );
      for (const c of r.items ?? [])
        if (!c.deleted)
          out.push({
            remoteId: c.id,
            name: c.summaryOverride || c.summary || c.id,
            color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor ?? '') ? c.backgroundColor! : '#4285f4',
            writable: c.accessRole === 'owner' || c.accessRole === 'writer',
            visibleByDefault: c.selected === true && !c.hidden,
          });
      if (!r.nextPageToken) break;
      page = r.nextPageToken;
    }
    return out;
  }

  async events(calendar: string, from: number, to: number): Promise<RemoteEvent[]> {
    const out: RemoteEvent[] = [];
    let page = '';
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({ singleEvents: 'true', timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), maxResults: '2500', ...(page ? { pageToken: page } : {}) });
      const r = await this.req<{ items?: GEvent[]; nextPageToken?: string }>('GET', `/calendars/${encodeURIComponent(calendar)}/events?${q}`);
      for (const e of r.items ?? []) {
        if (e.status === 'cancelled' || !e.start) continue;
        const allDay = !!e.start.date;
        out.push({
          remoteId: e.id,
          title: e.summary ?? '(no title)',
          start: allDay ? `${e.start.date}T00:00:00.000Z` : new Date(e.start.dateTime!).toISOString(),
          end: allDay ? `${e.end?.date ?? e.start.date}T00:00:00.000Z` : new Date(e.end?.dateTime ?? e.start.dateTime!).toISOString(),
          allDay,
          location: e.location ?? '',
          notes: e.description ?? '',
          recurrence: 'none',
          until: null,
          instance: !!e.recurringEventId,
          readOnly: false,
        });
      }
      if (!r.nextPageToken) break;
      page = r.nextPageToken;
    }
    return out;
  }

  private body(f: EventFields, withRecurrence: boolean) {
    const tz = validTimeZone(f.timeZone) ? f.timeZone : 'UTC';
    const rule = ruleFor(f);
    return {
      summary: f.title,
      location: f.location,
      description: f.notes,
      start: f.allDay ? { date: dateOf(f.start), dateTime: null } : { dateTime: f.start, timeZone: tz, date: null },
      end: f.allDay ? { date: dateOf(f.end), dateTime: null } : { dateTime: f.end, timeZone: tz, date: null },
      ...(withRecurrence ? { recurrence: rule ? [`RRULE:${rule}`] : [] } : {}),
    };
  }

  async create(calendar: string, f: EventFields): Promise<string> {
    return (await this.req<{ id: string }>('POST', `/calendars/${encodeURIComponent(calendar)}/events`, this.body(f, true))).id;
  }
  async update(calendar: string, eventId: string, f: EventFields, instance: boolean) {
    await this.req('PATCH', `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`, this.body(f, !instance));
  }
  async remove(calendar: string, eventId: string) {
    try {
      await this.req('DELETE', `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`);
    } catch (err) {
      if (!(err instanceof RemoteCalendarError && (err.status === 404 || err.status === 410))) throw err;
    }
  }

  async findInvite(uid: string) {
    const r = await this.req<{ items?: GEvent[] }>('GET', `/calendars/primary/events?iCalUID=${encodeURIComponent(uid)}`);
    const e = r.items?.find((x) => x.status !== 'cancelled');
    if (!e) return null;
    const s = e.attendees?.find((a) => a.self)?.responseStatus;
    return { eventId: e.id, answer: s === 'accepted' || s === 'tentative' || s === 'declined' ? (s as InviteAnswer) : null };
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

interface GraphEvent {
  id: string;
  subject?: string;
  location?: { displayName?: string };
  body?: { content?: string };
  start?: { dateTime: string };
  end?: { dateTime: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  type?: string;
  responseStatus?: { response?: string };
}

export class OutlookCalendar implements CalendarProvider {
  private readonly base = 'https://graph.microsoft.com/v1.0';
  constructor(
    private readonly token: () => Promise<string>,
    private readonly http: Http,
  ) {}

  private async req<T>(method: string, pathOrUrl: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return call<T>(this.http, pathOrUrl.startsWith('https://') ? pathOrUrl : `${this.base}${pathOrUrl}`, method, await this.token(), body, headers);
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
    const list = await this.all<{ id: string; name: string; hexColor?: string; color?: string; canEdit?: boolean; isDefaultCalendar?: boolean }>('/me/calendars?$top=100&$select=id,name,hexColor,color,canEdit,isDefaultCalendar');
    return list.map((c) => ({
      remoteId: c.id,
      name: c.name,
      color: /^#[0-9a-f]{6}$/i.test(c.hexColor ?? '') ? c.hexColor! : GRAPH_COLORS[c.color ?? ''] ?? '#0078d4',
      writable: c.canEdit !== false,
      visibleByDefault: !!c.isDefaultCalendar || c.canEdit !== false,
    }));
  }

  async events(calendar: string, from: number, to: number): Promise<RemoteEvent[]> {
    const q = new URLSearchParams({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $top: '250', $select: 'id,subject,location,body,start,end,isAllDay,isCancelled,type' });
    const list = await this.all<GraphEvent>(`/me/calendars/${encodeURIComponent(calendar)}/calendarView?${q}`, { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' });
    return list
      .filter((e) => !e.isCancelled && e.start && e.end)
      .map((e) => ({
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
      }));
  }

  private body(f: EventFields, withRecurrence: boolean) {
    const tz = validTimeZone(f.timeZone) ? f.timeZone : 'UTC';
    const wall = (iso: string) => new Date(utcToWall(Date.parse(iso), tz)).toISOString().slice(0, 19);
    const start = f.allDay ? { dateTime: `${dateOf(f.start)}T00:00:00`, timeZone: 'UTC' } : { dateTime: wall(f.start), timeZone: tz };
    const end = f.allDay ? { dateTime: `${dateOf(f.end)}T00:00:00`, timeZone: 'UTC' } : { dateTime: wall(f.end), timeZone: tz };
    let recurrence: unknown = null;
    if (f.recurrence !== 'none') {
      const localStart = new Date(f.allDay ? Date.parse(f.start) : utcToWall(Date.parse(f.start), tz));
      const pattern =
        f.recurrence === 'daily'
          ? { type: 'daily', interval: 1 }
          : f.recurrence === 'weekly'
            ? { type: 'weekly', interval: 1, daysOfWeek: [WEEKDAY_NAMES[localStart.getUTCDay()]] }
            : f.recurrence === 'monthly'
              ? { type: 'absoluteMonthly', interval: 1, dayOfMonth: localStart.getUTCDate() }
              : { type: 'absoluteYearly', interval: 1, dayOfMonth: localStart.getUTCDate(), month: localStart.getUTCMonth() + 1 };
      const startDate = localStart.toISOString().slice(0, 10);
      recurrence = { pattern, range: f.until ? { type: 'endDate', startDate, endDate: f.until } : { type: 'noEnd', startDate } };
    }
    return {
      subject: f.title,
      body: { contentType: 'text', content: f.notes },
      location: { displayName: f.location },
      isAllDay: f.allDay,
      start,
      end,
      ...(withRecurrence ? { recurrence } : {}),
    };
  }

  async create(calendar: string, f: EventFields): Promise<string> {
    return (await this.req<{ id: string }>('POST', `/me/calendars/${encodeURIComponent(calendar)}/events`, this.body(f, true))).id;
  }
  async update(_calendar: string, eventId: string, f: EventFields, instance: boolean) {
    await this.req('PATCH', `/me/events/${encodeURIComponent(eventId)}`, this.body(f, !instance));
  }
  async remove(_calendar: string, eventId: string) {
    try {
      await this.req('DELETE', `/me/events/${encodeURIComponent(eventId)}`);
    } catch (err) {
      if (!(err instanceof RemoteCalendarError && err.status === 404)) throw err;
    }
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
        const simple = !o.repeating && o.event.rrule === null;
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
          readOnly: !simple,
        });
      }
    }
    return out;
  }

  async create(calendar: string, f: EventFields): Promise<string> {
    const { uid, ics } = newEventIcs(f);
    return this.putIcs(calendar, uid, ics);
  }

  /** Stores a calendar object under a name made from its UID (replacing it if it's there). */
  async putIcs(calendar: string, uid: string, ics: string, mustBeNew = true): Promise<string> {
    const href = new URL(`${encodeURIComponent(uid.replace(/[^A-Za-z0-9@._-]/g, '_')).slice(0, 200)}.ics`, calendar).toString();
    const { res } = await this.dav(href, 'PUT', ics, mustBeNew ? { 'if-none-match': '*' } : {});
    if (!res.ok) throw new RemoteCalendarError(`The calendar server did not save the event (${res.status})`, res.status);
    return href;
  }

  async update(_calendar: string, eventId: string, f: EventFields) {
    if (eventId.includes('#')) throw new RemoteCalendarError('Change repeating events of this calendar in its own app', 400);
    const { res } = await this.dav(eventId, 'GET');
    if (!res.ok) throw new RemoteCalendarError(`This event is no longer on the calendar server (${res.status})`, res.status);
    const etag = res.headers.get('etag');
    const ics = updateEventIcs(await res.text(), f);
    const put = await this.dav(eventId, 'PUT', ics, etag ? { 'if-match': etag } : {});
    if (put.res.status === 412) throw new RemoteCalendarError('This event was changed elsewhere in the meantime. Reload and try again.', 412);
    if (!put.res.ok) throw new RemoteCalendarError(`The calendar server did not save the change (${put.res.status})`, put.res.status);
  }

  async remove(_calendar: string, eventId: string) {
    if (eventId.includes('#')) throw new RemoteCalendarError('Delete repeating events of this calendar in its own app', 400);
    const { res } = await this.dav(eventId, 'DELETE');
    if (!res.ok && res.status !== 404) throw new RemoteCalendarError(`The calendar server did not delete the event (${res.status})`, res.status);
  }
}
