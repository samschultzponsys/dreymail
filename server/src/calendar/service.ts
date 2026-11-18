// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Brings provider calendars next to DreyMail's own: the calendar list of each Google / Outlook
// mailbox and CalDAV connection is mirrored into the calendars table (so each keeps its checkbox
// and color), while events are read live for the range on screen (cached for a minute) and changes
// go straight to the provider. Also answers invitations found in mail.
// Shared mailboxes (10.5) bring no calendars of their own.

import crypto from 'node:crypto';
import { DAY } from '../../../shared/rrule.js';
import { findJoinUrl, occurrences, startTimeOf, type CalendarEvent, type CalendarSourceView, type EventOccurrence, type InviteAnswer, type InviteState } from '../../../shared/calendar.js';
import type { MessageRef } from '../../../shared/types.js';
import type { Store } from '../db.js';
import type { MailService } from '../imap/mail.js';
import type { ComposeService } from '../mail/send.js';
import { assertPublicHost } from '../net/ssrf.js';
import type { GoogleAuth } from '../oauth/google.js';
import type { MicrosoftAuth } from '../oauth/microsoft.js';
import { windowsZone } from './ical.js';
import { counterIcs, declineCounterIcs, describeRule, fieldsOfIcs, guestsOfStored, itipFromStored, repeatFromRule, replyIcs, requestIcs, statusOfPartstat, storableIcs, validTimeZone, type EventFields, type PartStat } from './ical.js';
import { eventFromRow, LocalEvents } from './localEvents.js';
import { findInvite, type FoundInvite } from './invites.js';
import { CalDavCalendar, GoogleCalendar, OutlookCalendar, RemoteCalendarError, type CalendarProvider, type Http, type RemoteEvent, type RemoteSeries } from './remote.js';

export interface CalendarRow {
  id: string;
  owner_id: string;
  name: string;
  color: string;
  account_id: string | null;
  source: 'local' | 'google' | 'microsoft' | 'caldav';
  source_id: string | null;
  remote_id: string | null;
  writable: number;
  meetings?: string;
}

/** A sender for invitations: a mailbox of the user. */
interface Sender {
  id: string;
  email: string;
  displayName: string;
}

const SYNC_EVERY = 5 * 60_000;

/** Invitations added to a calendar get Outlook's default reminder (none for all-day events). */
const DEFAULT_INVITE_REMINDER = (allDay: boolean) => (allDay ? null : 15);

/** The IANA zone an invitation's start is written in, if it names one DreyMail knows. */
function zoneOfStart(inv: FoundInvite): string | undefined {
  const tz = inv.event.component.props.find((p) => p.name === 'DTSTART')?.params.TZID?.replace(/^\/+/, '').trim();
  if (!tz) return undefined;
  return validTimeZone(tz) ? tz : windowsZone(tz);
}
const EVENTS_FOR = 60_000;

export class CalendarService {
  private readonly lastSync = new Map<string, number>();
  private readonly syncing = new Map<string, Promise<void>>();
  /** Per source (mailbox id or CalDAV connection id): why it can't be read right now. */
  private readonly errors = new Map<string, { message: string; reconnect: boolean }>();
  private readonly cache = new Map<string, { at: number; events: RemoteEvent[] }>();
  readonly local: LocalEvents;

  constructor(
    private readonly deps: {
      store: Store;
      google: GoogleAuth;
      microsoft: MicrosoftAuth;
      mail: MailService;
      compose: ComposeService;
      http: Http;
      blockPrivateHosts: boolean;
      maxMessageBytes: number;
    },
  ) {
    this.local = new LocalEvents(deps.store);
  }

  private get db() {
    return this.deps.store.db;
  }

  // ---- providers ------------------------------------------------------------------------------

  private caldav(userId: string, sourceId: string): CalDavCalendar | null {
    const s = this.db.prepare('SELECT * FROM calendar_sources WHERE id = ? AND owner_id = ?').get(sourceId, userId) as { url: string; username: string; secret: string } | undefined;
    if (!s) return null;
    return this.caldavFor(s.url, s.username, this.deps.store.openSecret(`caldav:${sourceId}`, s.secret));
  }

  private caldavFor(url: string, username: string, password: string) {
    return new CalDavCalendar(url, username, password, this.deps.http, async (u) => {
      if (this.deps.blockPrivateHosts) await assertPublicHost(u.hostname.replace(/^\[|\]$/g, ''));
    });
  }

  private provider(userId: string, source: CalendarRow['source'], sourceId: string | null): CalendarProvider | null {
    if (!sourceId) return null;
    if (source === 'google') return new GoogleCalendar(() => this.deps.google.accessToken(userId, sourceId), this.deps.http);
    if (source === 'microsoft') return new OutlookCalendar(() => this.deps.microsoft.accessToken(userId, sourceId, 'calendar'), this.deps.http);
    if (source === 'caldav') return this.caldav(userId, sourceId);
    return null;
  }

  private remember(sourceId: string, err: unknown) {
    const msg = (err as Error).message ?? String(err);
    const reconnect = (err instanceof RemoteCalendarError && err.reconnect) || /consent|AADSTS65001|invalid_grant|Reconnect|expired/i.test(msg);
    this.errors.set(sourceId, {
      message: reconnect && !(err instanceof RemoteCalendarError) ? 'Calendar access was not allowed for this mailbox. Reconnect it to allow calendar access.' : msg,
      reconnect,
    });
  }

  // ---- sources and the calendar list --------------------------------------------------------------

  sources(userId: string): CalendarSourceView[] {
    const out: CalendarSourceView[] = [];
    for (const a of this.deps.store.listAccounts(userId))
      // Shared mailboxes use their parent's sign-in: its calendars are already there.
      if ((a.auth === 'google' || a.auth === 'microsoft') && !a.sharedOf) {
        const e = this.errors.get(a.id);
        out.push({ id: a.id, kind: a.auth, name: a.name, accountId: a.id, error: e?.message ?? null, reconnect: e?.reconnect ?? false });
      }
    for (const s of this.db.prepare('SELECT id, name, url, username, account_id FROM calendar_sources WHERE owner_id = ? ORDER BY created_at').all(userId) as { id: string; name: string; url: string; username: string; account_id: string | null }[]) {
      const e = this.errors.get(s.id);
      out.push({ id: s.id, kind: 'caldav', name: s.name, accountId: s.account_id, url: s.url, username: s.username, error: e?.message ?? null, reconnect: false });
    }
    return out;
  }

  /** Mirrors the provider calendar lists (at most every 5 minutes unless forced). */
  async sync(userId: string, force = false): Promise<void> {
    if (!force && Date.now() - (this.lastSync.get(userId) ?? 0) < SYNC_EVERY) return;
    let job = this.syncing.get(userId);
    if (!job) {
      job = this.doSync(userId).finally(() => this.syncing.delete(userId));
      this.syncing.set(userId, job);
    }
    return job;
  }

  private async doSync(userId: string) {
    const sources = this.sources(userId);
    // Calendars whose mailbox or connection is gone.
    const live = new Set(sources.map((s) => `${s.kind}:${s.id}`));
    for (const r of this.db.prepare("SELECT id, source, source_id FROM calendars WHERE owner_id = ? AND source != 'local'").all(userId) as { id: string; source: string; source_id: string }[])
      if (!live.has(`${r.source}:${r.source_id}`)) this.db.prepare('DELETE FROM calendars WHERE id = ?').run(r.id);
    await Promise.all(
      sources.map(async (s) => {
        const p = this.provider(userId, s.kind, s.id);
        if (!p) return;
        try {
          const list = await p.listCalendars();
          this.errors.delete(s.id);
          const existing = this.db.prepare('SELECT id, remote_id FROM calendars WHERE owner_id = ? AND source = ? AND source_id = ?').all(userId, s.kind, s.id) as { id: string; remote_id: string }[];
          const seen = new Set<string>();
          for (const c of list) {
            seen.add(c.remoteId);
            const row = existing.find((e) => e.remote_id === c.remoteId);
            const meetings = (c.meetings ?? []).join(',');
            if (row) this.db.prepare('UPDATE calendars SET name = ?, writable = ?, account_id = ?, meetings = ? WHERE id = ?').run(c.name, c.writable ? 1 : 0, s.accountId, meetings, row.id);
            else {
              const id = crypto.randomUUID();
              this.db
                .prepare('INSERT INTO calendars (id, owner_id, name, color, account_id, created_at, source, source_id, remote_id, writable, meetings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(id, userId, c.name, c.color, s.accountId, Date.now(), s.kind, s.id, c.remoteId, c.writable ? 1 : 0, meetings);
              if (!c.visibleByDefault) this.db.prepare('INSERT OR IGNORE INTO calendar_hidden (calendar_id, user_id) VALUES (?, ?)').run(id, userId);
            }
          }
          for (const e of existing) if (!seen.has(e.remote_id)) this.db.prepare('DELETE FROM calendars WHERE id = ?').run(e.id);
        } catch (err) {
          this.remember(s.id, err);
        }
      }),
    );
    this.lastSync.set(userId, Date.now());
  }

  /** Adds a CalDAV account after finding its calendars; returns its id. */
  async addCalDav(userId: string, input: { url: string; username: string; password: string; name: string; accountId: string | null }): Promise<string> {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`);
    } catch {
      throw new RemoteCalendarError('That is not a web address', 400);
    }
    const found = await this.caldavFor(url.toString(), input.username, input.password).listCalendars();
    if (!found.length) throw new RemoteCalendarError('No calendars found at this address', 404);
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO calendar_sources (id, owner_id, name, url, username, secret, account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, input.name || url.hostname, url.toString(), input.username, this.deps.store.sealSecret(`caldav:${id}`, input.password), input.accountId, Date.now());
    await this.sync(userId, true);
    return id;
  }

  removeCalDav(userId: string, id: string): boolean {
    const n = this.db.prepare('DELETE FROM calendar_sources WHERE id = ? AND owner_id = ?').run(id, userId).changes;
    if (n) {
      this.db.prepare("DELETE FROM calendars WHERE owner_id = ? AND source = 'caldav' AND source_id = ?").run(userId, id);
      this.errors.delete(id);
    }
    return n > 0;
  }

  // ---- events --------------------------------------------------------------------------------------

  /** Events of a provider calendar in [from, to); errors are remembered for the calendar list. */
  async events(userId: string, cal: CalendarRow, from: number, to: number): Promise<RemoteEvent[]> {
    return (await this.eventsOrNull(userId, cal, from, to)) ?? [];
  }

  /** Like events(), but null when the provider couldn't be read. */
  async eventsOrNull(userId: string, cal: CalendarRow, from: number, to: number): Promise<RemoteEvent[] | null> {
    const key = `${cal.id}|${from}|${to}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < EVENTS_FOR) return hit.events;
    const p = this.provider(userId, cal.source, cal.source_id);
    if (!p || !cal.remote_id) return [];
    try {
      const events = await p.events(cal.remote_id, from, to);
      this.errors.delete(cal.source_id!);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(key, { at: Date.now(), events });
      return events;
    } catch (err) {
      this.remember(cal.source_id!, err);
      return null;
    }
  }

  /** The user's mailbox addresses (lowercase): who "you" are as an organizer. */
  myAddresses(userId: string): Set<string> {
    return new Set(this.deps.store.listAccounts(userId).map((a) => a.email.toLowerCase()));
  }

  /** The mailbox invitations go out from: the one asked for, the calendar's mailbox, or the first. */
  sender(userId: string, cal: Pick<CalendarRow, 'account_id'> | null, wanted?: string | null): Sender | null {
    const list = this.deps.store.listAccounts(userId);
    const a = list.find((x) => x.id === wanted) ?? list.find((x) => x.id === cal?.account_id) ?? list[0];
    return a ? { id: a.id, email: a.email.toLowerCase(), displayName: a.displayName } : null;
  }

  /** Emails an invitation, update or cancellation to `to`, from one of the user's mailboxes. */
  async mailInvitation(userId: string, from: Sender, method: 'REQUEST' | 'CANCEL', to: string[], f: Pick<EventFields, 'title' | 'start' | 'end' | 'allDay' | 'location' | 'notes' | 'timeZone'>, ics: string, update: boolean) {
    const list = [...new Set(to.map((x) => x.toLowerCase()))].filter((x) => x && x !== from.email);
    if (!list.length) return;
    const zone = validTimeZone(f.timeZone) ? f.timeZone : 'UTC';
    const when = f.allDay
      ? new Date(f.start).toLocaleDateString('en-US', { dateStyle: 'full', timeZone: 'UTC' })
      : `${new Date(f.start).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: zone })} – ${new Date(f.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' })}`;
    const verb = method === 'CANCEL' ? 'Canceled' : update ? 'Updated invitation' : 'Invitation';
    const join = findJoinUrl(f.location, f.notes);
    const text = [
      method === 'CANCEL' ? `${from.displayName || from.email} canceled this event.` : `${from.displayName || from.email} invited you.`,
      '',
      f.title,
      when,
      f.location ? `Where: ${f.location}` : '',
      join && join !== f.location ? `Join: ${join}` : '',
      f.notes ? `\n${f.notes}` : '',
    ]
      .filter((x, i) => x || i === 1)
      .join('\n');
    await this.deps.compose.sendInvitation(userId, from.id, { to: list, subject: `${verb}: ${f.title} @ ${when}`, text, ics, method });
  }

  /** Invitations for a DreyMail event with guests (from its sender mailbox). */
  async inviteLocal(userId: string, e: CalendarEvent, method: 'REQUEST' | 'CANCEL', opts: { to?: string[]; update?: boolean } = {}) {
    if (!e.attendees?.length) return;
    const uid = this.local.uidOf(e.id);
    const cal = this.db.prepare('SELECT account_id FROM calendars WHERE id = ?').get(e.calendarId) as { account_id: string | null } | undefined;
    const from = this.sender(userId, cal ?? null, e.sendFrom);
    if (!uid || !from) return;
    const f: EventFields = { ...e, organizer: e.organizer ?? { email: from.email, name: from.displayName } };
    const ics = requestIcs(uid.uid, f, method, uid.sequence);
    await this.mailInvitation(userId, from, method, opts.to ?? e.attendees.map((a) => a.email), f, ics, !!opts.update);
  }

  /**
   * "This and following" for a provider series (DreyMail 10.9): the series ends before the
   * occurrence (until the day before, or after as many times as came before), and with `f` a new
   * series starts at it with the changes. Without `f` (deleting), the series just ends there.
   */
  async splitSeries(userId: string, cal: CalendarRow, seriesId: string, occurrenceStart: string, f: (EventFields & { sendFrom?: string | null }) | null) {
    const p = this.need(userId, cal);
    const series = await p.get(cal.remote_id!, seriesId);
    if (series.recurrence === 'none') throw new RemoteCalendarError('This event does not repeat', 400);
    if (!series.editable) throw new RemoteCalendarError("This series repeats in a way DreyMail can't change; change it in its own app", 400);
    const at = Date.parse(occurrenceStart);
    const asEvent = { ...series, id: '', calendarId: cal.id, exdates: [] } as unknown as CalendarEvent;
    const before = occurrences(asEvent, Date.parse(series.start), at, series.timeZone).filter((o) => Date.parse(o.occurrenceStart) < at).length;
    if (before === 0) {
      // From the first occurrence on: that is the whole series.
      if (f) await this.update(userId, cal, seriesId, f, false);
      else await this.remove(userId, cal, seriesId);
      return;
    }
    const st = startTimeOf(asEvent, series.timeZone);
    const dayBefore = new Date(at + (st.wall - st.ms) - DAY).toISOString().slice(0, 10);
    const ended: EventFields = {
      title: series.title,
      location: series.location,
      notes: series.notes,
      start: series.start,
      end: series.end,
      allDay: series.allDay,
      recurrence: series.recurrence,
      interval: series.interval,
      byDay: series.byDay,
      monthlyBy: series.monthlyBy,
      ...(series.count ? { count: before, until: null } : { count: null, until: dayBefore }),
      timeZone: series.timeZone,
      onlyRepeat: true,
    };
    await p.update(cal.remote_id!, seriesId, ended, false);
    this.forget(cal.id);
    if (f) await this.create(userId, cal, { ...f, count: f.count ? Math.max(1, f.count - before) : f.count });
  }

  /** The whole event or series of a provider calendar (for editing every occurrence). */
  async get(userId: string, cal: CalendarRow, eventId: string): Promise<RemoteSeries> {
    const p = this.provider(userId, cal.source, cal.source_id);
    if (!p || !cal.remote_id) throw new RemoteCalendarError('This calendar is not connected any more', 404);
    return p.get(cal.remote_id, eventId);
  }

  /**
   * Occurrences with a reminder in the user's visible calendars between from and to (DreyMail's own
   * repeats expanded in each event's zone), and the calendars that couldn't be read.
   */
  async upcoming(userId: string, from: number, to: number, opts: { all?: boolean } = {}): Promise<{ items: (EventOccurrence & { color: string })[]; failed: Set<string> }> {
    const cals = this.db
      .prepare(
        `SELECT c.* FROM calendars c LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ?
          WHERE (c.owner_id = ? OR (s.user_id IS NOT NULL AND c.source = 'local'))
            AND NOT EXISTS (SELECT 1 FROM calendar_hidden h WHERE h.calendar_id = c.id AND h.user_id = ?)`,
      )
      .all(userId, userId, userId) as unknown as CalendarRow[];
    const items: (EventOccurrence & { color: string })[] = [];
    const failed = new Set<string>();
    const local = cals.filter((c) => c.source === 'local');
    if (local.length) {
      const rows = this.db
        .prepare(`SELECT * FROM calendar_events WHERE calendar_id IN (${local.map(() => '?').join(',')}) AND ${opts.all ? '1' : 'reminder IS NOT NULL'} AND start_at < ? AND (end_at > ? OR recurrence != 'none')`)
        .all(...local.map((c) => c.id), to, from) as Record<string, unknown>[];
      for (const r of rows) {
        const e = eventFromRow(r);
        const color = local.find((c) => c.id === e.calendarId)?.color ?? '#22d3ee';
        for (const o of occurrences(e, from, to)) items.push({ ...o, color, joinUrl: findJoinUrl(e.location, e.notes) });
      }
    }
    await Promise.all(
      cals
        .filter((c) => c.source !== 'local')
        .map(async (c) => {
          const list = await this.eventsOrNull(userId, c, from, to);
          if (!list) return failed.add(c.id);
          for (const e of list)
            if (opts.all || (e.reminder !== null && e.reminder !== undefined))
              items.push({
                id: `${c.id}~${Buffer.from(e.remoteId).toString('base64url')}`,
                calendarId: c.id,
                title: e.title,
                start: e.start,
                end: e.end,
                allDay: e.allDay,
                location: e.location,
                notes: '',
                recurrence: 'none',
                until: null,
                reminder: e.reminder,
                ...(e.showAs ? { showAs: e.showAs } : {}),
                joinUrl: e.joinUrl ?? null,
                occurrenceStart: e.start,
                occurrenceEnd: e.end,
                color: c.color,
              });
        }),
    );
    return { items, failed };
  }

  /**
   * Free/busy for the scheduling assistant (DreyMail 10.2): the user's own busy times from their
   * visible calendars, and other people's from Outlook (getSchedule) or Google (freeBusy): through
   * the calendar's own mailbox, else the user's first Outlook or Google mailbox.
   */
  async freeBusy(userId: string, calendarId: string | null, emails: string[], from: number, to: number) {
    const mine = await this.upcoming(userId, from, to, { all: true });
    const self = {
      busy: mine.items
        .filter((o) => !o.allDay && o.showAs !== 'free')
        .map((o) => ({ start: o.occurrenceStart, end: o.occurrenceEnd, status: (o.showAs ?? 'busy') as 'busy' | 'tentative' | 'away' | 'elsewhere', title: o.title }))
        .sort((a, b) => a.start.localeCompare(b.start)),
    };
    const cal = calendarId ? (this.db.prepare('SELECT * FROM calendars WHERE id = ? AND owner_id = ?').get(calendarId, userId) as CalendarRow | undefined) : undefined;
    const accounts = this.deps.store.listAccounts(userId);
    const via =
      cal && (cal.source === 'microsoft' || cal.source === 'google')
        ? { kind: cal.source, id: cal.source_id! }
        : (() => {
            const a = accounts.find((x) => x.auth === 'microsoft') ?? accounts.find((x) => x.auth === 'google');
            return a ? { kind: a.auth as 'microsoft' | 'google', id: a.id } : null;
          })();
    const mineSet = this.myAddresses(userId);
    const others = [...new Set(emails.map((e) => e.toLowerCase()))].filter((e) => !mineSet.has(e)).slice(0, 50);
    let people: Record<string, { busy: { start: string; end: string; status: string }[]; error?: string }> = {};
    if (others.length && via) {
      const p = this.provider(userId, via.kind, via.id);
      try {
        people = (await p?.freeBusy?.(others, from, to)) ?? {};
      } catch (err) {
        const msg = err instanceof RemoteCalendarError ? err.message : (err as Error).message;
        for (const e of others) people[e] = { busy: [], error: msg };
      }
    }
    for (const e of others) people[e] ??= { busy: [], error: via ? 'Not available' : 'Free/busy needs an Outlook or Google mailbox signed in with Microsoft or Google' };
    return { self, people, via: via?.kind ?? null };
  }

  /** A guest answered an invitation the user sent from DreyMail: their answer goes on the event. */
  async applyReply(userId: string, ref: MessageRef): Promise<boolean> {
    const inv = await this.loadInvite(userId, ref);
    if (inv.method !== 'REPLY') return false;
    const mine = this.myAddresses(userId);
    let changed = false;
    for (const a of inv.event.attendees) {
      if (mine.has(a.email)) continue;
      const rows = this.db
        .prepare('SELECT e.id, e.organizer FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE e.ical_uid = ? AND c.owner_id = ?')
        .all(inv.event.uid, userId) as { id: string; organizer: string | null }[];
      if (!rows.length) continue;
      changed = this.local.setAttendeeStatus(inv.event.uid, a.email, statusOfPartstat(a.status)) || changed;
    }
    return changed;
  }

  private forget(calId: string) {
    for (const k of this.cache.keys()) if (k.startsWith(`${calId}|`)) this.cache.delete(k);
  }

  private need(userId: string, cal: CalendarRow): CalendarProvider {
    const p = this.provider(userId, cal.source, cal.source_id);
    if (!p || !cal.remote_id) throw new RemoteCalendarError('This calendar is not connected any more', 404);
    if (!cal.writable) throw new RemoteCalendarError('This calendar is read-only', 403);
    return p;
  }

  async create(userId: string, cal: CalendarRow, f: EventFields & { sendFrom?: string | null }) {
    const p = this.need(userId, cal);
    const guests = cal.source === 'caldav' && !!f.attendees?.length;
    const from = guests ? this.sender(userId, cal, f.sendFrom) : null;
    const id = await p.create(cal.remote_id!, from ? { ...f, organizer: { email: from.email, name: from.displayName } } : f);
    this.forget(cal.id);
    // CalDAV: DreyMail emails the guests (Google and Outlook do it themselves).
    if (from && p instanceof CalDavCalendar) {
      const raw = await p.raw(id).catch(() => null);
      if (raw) await this.mailInvitation(userId, from, 'REQUEST', f.attendees!.map((a) => a.email), f, itipFromStored(raw, 'REQUEST'), false);
    }
  }
  async update(userId: string, cal: CalendarRow, eventId: string, f: EventFields & { sendFrom?: string | null }, instance: boolean) {
    const p = this.need(userId, cal);
    if (!(p instanceof CalDavCalendar)) {
      await p.update(cal.remote_id!, eventId, f, instance);
      this.forget(cal.id);
      return;
    }
    const before = await p.raw(eventId).catch(() => null);
    const old = before ? guestsOfStored(before) : { organizer: null, attendees: [] };
    const mine = this.myAddresses(userId);
    const organizes = !old.organizer || mine.has(old.organizer);
    // Only the organizer changes the guest list.
    const fields: EventFields = organizes ? f : { ...f, attendees: undefined };
    const from = organizes && (f.attendees?.length || old.attendees.length) ? this.sender(userId, cal, f.sendFrom) : null;
    if (from && f.attendees?.length) fields.organizer = old.organizer ? { email: old.organizer, name: from.email === old.organizer ? from.displayName : '' } : { email: from.email, name: from.displayName };
    await p.update(cal.remote_id!, eventId, fields, instance);
    this.forget(cal.id);
    if (!from) return;
    const after = await p.raw(eventId).catch(() => null);
    const now = f.attendees?.map((a) => a.email) ?? old.attendees;
    const removed = old.attendees.filter((a) => !now.includes(a));
    if (after && now.length) await this.mailInvitation(userId, from, 'REQUEST', now, f, itipFromStored(after, 'REQUEST'), true);
    if (before && removed.length) await this.mailInvitation(userId, from, 'CANCEL', removed, f, itipFromStored(before, 'CANCEL'), true);
  }
  async remove(userId: string, cal: CalendarRow, eventId: string) {
    const p = this.need(userId, cal);
    const before = p instanceof CalDavCalendar ? await p.raw(eventId).catch(() => null) : null;
    await p.remove(cal.remote_id!, eventId);
    this.forget(cal.id);
    if (!before || !(p instanceof CalDavCalendar)) return;
    const g = guestsOfStored(before);
    if (!g.attendees.length || (g.organizer && !this.myAddresses(userId).has(g.organizer))) return;
    const from = this.sender(userId, cal);
    const f = fieldsOfIcs(before);
    if (!from || !f) return;
    // One occurrence left out: the guests get the series without it; otherwise a cancellation.
    if (eventId.includes('#')) {
      const after = await p.raw(eventId).catch(() => null);
      if (after) await this.mailInvitation(userId, from, 'REQUEST', g.attendees, f, itipFromStored(after, 'REQUEST'), true);
    } else await this.mailInvitation(userId, from, 'CANCEL', g.attendees, f, itipFromStored(before, 'CANCEL'), true);
  }

  // ---- invitations ----------------------------------------------------------------------------------

  private async loadInvite(userId: string, ref: MessageRef) {
    const parsed = await this.deps.mail.getParsed(userId, ref, this.deps.maxMessageBytes);
    const inv = findInvite(parsed);
    if (!inv) throw new RemoteCalendarError('This message has no invitation', 400);
    return inv;
  }

  /** Your answer so far, and where the event is. */
  async inviteState(userId: string, accountId: string, uid: string): Promise<InviteState> {
    const account = this.deps.store.listAccounts(userId).find((a) => a.id === accountId);
    if (!account) throw new RemoteCalendarError('Mailbox not found', 404);
    const row = this.db.prepare('SELECT response, calendar_id FROM invite_responses WHERE user_id = ? AND ical_uid = ?').get(userId, uid) as { response: string; calendar_id: string | null } | undefined;
    if (account.auth === 'google' || account.auth === 'microsoft') {
      const p = this.provider(userId, account.auth, account.id)!;
      try {
        const found = await p.findInvite!(uid);
        if (found) return { answer: found.answer, calendar: account.auth === 'google' ? 'Google Calendar' : 'Outlook calendar', viaProvider: true, removable: false };
      } catch {
        /* fall back to what DreyMail knows */
      }
    }
    const cal = row?.calendar_id ? (this.db.prepare('SELECT name FROM calendars WHERE id = ?').get(row.calendar_id) as { name: string } | undefined) : undefined;
    const answer = row && ['accepted', 'tentative', 'declined'].includes(row.response) ? (row.response as InviteAnswer) : null;
    return { answer, calendar: cal?.name ?? null, viaProvider: false, removable: !!cal && row?.response !== 'declined' };
  }

  /**
   * Answers an invitation. Google / Outlook mailboxes answer through their calendar (which tells the
   * organizer); other mailboxes email an iTIP REPLY to the organizer, and accepted invitations are
   * added to the calendar you chose.
   */
  async answer(userId: string, ref: MessageRef, answer: InviteAnswer, calendarId: string | null, canUse: (calendarId: string) => CalendarRow | null): Promise<InviteState> {
    const account = this.deps.store.getAccountSecret(userId, ref.accountId);
    if (!account) throw new RemoteCalendarError('Mailbox not found', 404);
    const inv = await this.loadInvite(userId, ref);
    if (inv.method !== 'REQUEST') throw new RemoteCalendarError('This message is not an invitation you can answer', 400);
    const uid = inv.event.uid;

    if (account.auth === 'google' || account.auth === 'microsoft') {
      const p = this.provider(userId, account.auth, account.id)!;
      const found = await p.findInvite!(uid).catch(() => null);
      if (found) {
        await p.answerInvite!(found.eventId, answer);
        this.record(userId, uid, answer, null, null);
        return this.inviteState(userId, account.id, uid);
      }
    }

    const organizer = inv.event.organizer?.email;
    if (!organizer || !organizer.includes('@')) throw new RemoteCalendarError('This invitation does not say who to answer', 400);
    const partstat: PartStat = answer === 'accepted' ? 'ACCEPTED' : answer === 'tentative' ? 'TENTATIVE' : 'DECLINED';
    const verb = answer === 'accepted' ? 'Accepted' : answer === 'tentative' ? 'Tentative' : 'Declined';
    const me = { email: account.email, name: account.displayName };
    await this.deps.compose.sendInvitationReply(userId, account.id, {
      to: organizer,
      subject: `${verb}: ${inv.event.title || 'Invitation'}`,
      text: `${me.name || me.email} ${answer === 'accepted' ? 'accepted' : answer === 'tentative' ? 'might attend' : 'declined'} this invitation.`,
      ics: replyIcs(inv.event, me, partstat),
    });

    const prev = this.db.prepare('SELECT calendar_id, remote_ref FROM invite_responses WHERE user_id = ? AND ical_uid = ?').get(userId, uid) as { calendar_id: string | null; remote_ref: string | null } | undefined;
    let savedCal: string | null = prev?.calendar_id ?? null;
    let savedRef: string | null = prev?.remote_ref ?? null;
    if (answer === 'declined') {
      if (prev?.calendar_id) await this.removeCopy(userId, prev.calendar_id, prev.remote_ref, uid);
      savedCal = null;
      savedRef = null;
    } else if (calendarId) {
      const cal = canUse(calendarId);
      if (!cal) throw new RemoteCalendarError("You can't add events to that calendar", 403);
      if (prev?.calendar_id && prev.calendar_id !== cal.id) await this.removeCopy(userId, prev.calendar_id, prev.remote_ref, uid);
      savedRef = await this.addCopy(userId, cal, inv);
      savedCal = cal.id;
    }
    this.record(userId, uid, answer, savedCal, savedRef);
    return this.inviteState(userId, account.id, uid);
  }

  /**
   * Answers an invitation with a new time proposed (DreyMail 10.8): through Outlook for Outlook
   * mailboxes, otherwise as an iTIP COUNTER email to the organizer.
   */
  async propose(userId: string, ref: MessageRef, p: { answer: 'tentative' | 'declined'; start: number; end: number; comment: string }): Promise<InviteState> {
    const account = this.deps.store.getAccountSecret(userId, ref.accountId);
    if (!account) throw new RemoteCalendarError('Mailbox not found', 404);
    const inv = await this.loadInvite(userId, ref);
    if (inv.method !== 'REQUEST') throw new RemoteCalendarError('This message is not an invitation you can answer', 400);
    if (!(p.end > p.start)) throw new RemoteCalendarError('The new end must be after the new start', 400);
    const uid = inv.event.uid;
    if (account.auth === 'microsoft' && !account.sharedOf) {
      const prov = this.provider(userId, 'microsoft', account.id)!;
      const found = await prov.findInvite!(uid).catch(() => null);
      if (found && prov.proposeTime) {
        await prov.proposeTime(found.eventId, p.answer, p.start, p.end, p.comment);
        this.record(userId, uid, p.answer, null, null);
        return this.inviteState(userId, account.id, uid);
      }
    }
    const organizer = inv.event.organizer?.email;
    if (!organizer) throw new RemoteCalendarError('This invitation does not say who to answer', 400);
    const me = { email: account.email, name: account.displayName };
    const when = `${new Date(p.start).toUTCString().replace(' GMT', ' UTC')}`;
    await this.deps.compose.sendInvitation(userId, account.id, {
      to: [organizer],
      subject: `New time proposed: ${inv.event.title || 'Invitation'}`,
      text: `${me.name || me.email} proposes a new time: ${when}.${p.comment ? `\n\n${p.comment}` : ''}`,
      ics: counterIcs(inv.event, me, p.start, p.end, p.answer === 'tentative' ? 'TENTATIVE' : 'DECLINED', p.comment),
      method: 'COUNTER',
    });
    this.record(userId, uid, p.answer, null, null);
    return this.inviteState(userId, account.id, uid);
  }

  /**
   * A guest proposed a new time for an event the user organizes (a COUNTER message): accepting it
   * moves the event (DreyMail's own, or in Outlook / Google, which tell the guests); declining it
   * tells that guest (DreyMail 10.8).
   */
  async answerCounter(userId: string, ref: MessageRef, accept: boolean): Promise<{ moved: boolean }> {
    const inv = await this.loadInvite(userId, ref);
    if (inv.method !== 'COUNTER') throw new RemoteCalendarError('This message does not propose a new time', 400);
    const e = inv.event;
    const uid = e.uid;
    const guest = e.attendees[0]?.email;
    const local = this.db
      .prepare('SELECT ev.* FROM calendar_events ev JOIN calendars c ON c.id = ev.calendar_id WHERE ev.ical_uid = ? AND c.owner_id = ?')
      .get(uid, userId) as Record<string, unknown> | undefined;
    if (!accept) {
      const account = this.deps.store.getAccountSecret(userId, ref.accountId);
      if (account && guest) {
        const me = { email: account.email, name: account.displayName };
        await this.deps.compose.sendInvitation(userId, account.id, { to: [guest], subject: `Proposal declined: ${e.title || 'Event'}`, text: `${me.name || me.email} kept the original time.`, ics: declineCounterIcs(e, me), method: 'DECLINECOUNTER' });
      }
      return { moved: false };
    }
    if (local) {
      const cur = eventFromRow(local);
      const saved = this.local.update(cur.id, { ...cur, start: new Date(e.start.ms).toISOString(), end: new Date(e.end).toISOString() }, cur.organizer ?? null);
      await this.inviteLocal(userId, saved, 'REQUEST', { update: true });
      return { moved: true };
    }
    for (const a of this.deps.store.listAccounts(userId).filter((x) => (x.auth === 'microsoft' || x.auth === 'google') && !x.sharedOf)) {
      const prov = this.provider(userId, a.auth as 'microsoft' | 'google', a.id);
      const found = await prov?.findInvite?.(uid).catch(() => null);
      if (found && prov?.moveEvent) {
        await prov.moveEvent(found.eventId, e.start.ms, e.end);
        for (const k of this.cache.keys()) this.cache.delete(k);
        return { moved: true };
      }
    }
    throw new RemoteCalendarError("DreyMail can't find this event in your calendars to move it", 404);
  }

  /** After a cancellation: removes the copy DreyMail added. */
  async removeInvite(userId: string, uid: string): Promise<void> {
    const prev = this.db.prepare('SELECT calendar_id, remote_ref FROM invite_responses WHERE user_id = ? AND ical_uid = ?').get(userId, uid) as { calendar_id: string | null; remote_ref: string | null } | undefined;
    if (prev?.calendar_id) await this.removeCopy(userId, prev.calendar_id, prev.remote_ref, uid);
    this.db.prepare('UPDATE invite_responses SET calendar_id = NULL, remote_ref = NULL, response = ?, updated_at = ? WHERE user_id = ? AND ical_uid = ?').run('canceled', Date.now(), userId, uid);
  }

  private record(userId: string, uid: string, answer: string, calendarId: string | null, remoteRef: string | null) {
    this.db
      .prepare('INSERT INTO invite_responses (user_id, ical_uid, response, calendar_id, remote_ref, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, ical_uid) DO UPDATE SET response = excluded.response, calendar_id = excluded.calendar_id, remote_ref = excluded.remote_ref, updated_at = excluded.updated_at')
      .run(userId, uid, answer, calendarId, remoteRef, Date.now());
  }

  private async addCopy(userId: string, cal: CalendarRow, inv: FoundInvite): Promise<string | null> {
    const e = inv.event;
    if (cal.source === 'local') {
      this.db.prepare('DELETE FROM calendar_events WHERE calendar_id = ? AND ical_uid = ?').run(cal.id, e.uid);
      const rep = e.rrule ? repeatFromRule(e.rrule, e.start) : null;
      const notes = [e.rrule && !rep ? describeRule(e.rrule) : '', e.organizer ? `Organizer: ${e.organizer.name || e.organizer.email}` : '', e.description].filter(Boolean).join('\n\n');
      this.local.insert(
        {
          calendarId: cal.id,
          title: e.title || 'Invitation',
          start: new Date(e.start.ms).toISOString(),
          end: new Date(e.end).toISOString(),
          allDay: e.allDay,
          location: e.location.slice(0, 500),
          notes: notes.slice(0, 10_000),
          ...(rep ?? { recurrence: 'none', until: null }),
          exdates: [...e.exdates].map((x) => new Date(x).toISOString()),
          timeZone: zoneOfStart(inv),
          reminder: DEFAULT_INVITE_REMINDER(e.allDay),
        },
        userId,
        null,
        e.uid,
      );
      return null;
    }
    if (cal.source === 'caldav') {
      const dav = this.caldav(userId, cal.source_id!);
      if (!dav) throw new RemoteCalendarError('This calendar is not connected any more', 404);
      // The whole invitation (repeats, attendees) goes in, as the organizer sent it.
      const href = await dav.putIcs(cal.remote_id!, e.uid, storableIcs(inv.calendar), false);
      this.forget(cal.id);
      return href;
    }
    // A Google or Outlook calendar picked for a mailbox without its own calendar.
    const p = this.need(userId, cal);
    const rep = e.rrule ? repeatFromRule(e.rrule, e.start) : null;
    const id = await p.create(cal.remote_id!, {
      title: e.title || 'Invitation',
      location: e.location,
      notes: e.description,
      start: new Date(e.start.ms).toISOString(),
      end: new Date(e.end).toISOString(),
      allDay: e.allDay,
      ...(rep ?? { recurrence: 'none', until: null }),
      timeZone: zoneOfStart(inv),
      reminder: DEFAULT_INVITE_REMINDER(e.allDay),
    });
    this.forget(cal.id);
    return id;
  }

  private async removeCopy(userId: string, calendarId: string, remoteRef: string | null, uid: string) {
    const cal = this.db.prepare('SELECT * FROM calendars WHERE id = ?').get(calendarId) as CalendarRow | undefined;
    if (!cal) return;
    if (cal.source === 'local') this.db.prepare('DELETE FROM calendar_events WHERE calendar_id = ? AND ical_uid = ?').run(cal.id, uid);
    else if (remoteRef) {
      await this.provider(userId, cal.source, cal.source_id)
        ?.remove(cal.remote_id!, remoteRef)
        .catch(() => undefined);
      this.forget(cal.id);
    }
  }
}
