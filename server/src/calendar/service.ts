// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Brings provider calendars next to DreyMail's own: the calendar list of each Google / Outlook
// mailbox and CalDAV connection is mirrored into the calendars table (so each keeps its checkbox
// and color), while events are read live for the range on screen (cached for a minute) and changes
// go straight to the provider. Also answers invitations found in mail.

import crypto from 'node:crypto';
import type { CalendarSourceView, InviteAnswer, InviteState } from '../../../shared/calendar.js';
import type { MessageRef } from '../../../shared/types.js';
import type { Store } from '../db.js';
import type { MailService } from '../imap/mail.js';
import type { ComposeService } from '../mail/send.js';
import { assertPublicHost } from '../net/ssrf.js';
import type { GoogleAuth } from '../oauth/google.js';
import type { MicrosoftAuth } from '../oauth/microsoft.js';
import { describeRule, replyIcs, simpleRecurrence, storableIcs, type EventFields, type PartStat } from './ical.js';
import { findInvite, type FoundInvite } from './invites.js';
import { CalDavCalendar, GoogleCalendar, OutlookCalendar, RemoteCalendarError, type CalendarProvider, type Http, type RemoteEvent } from './remote.js';

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
}

const SYNC_EVERY = 5 * 60_000;
const EVENTS_FOR = 60_000;

export class CalendarService {
  private readonly lastSync = new Map<string, number>();
  private readonly syncing = new Map<string, Promise<void>>();
  /** Per source (mailbox id or CalDAV connection id): why it can't be read right now. */
  private readonly errors = new Map<string, { message: string; reconnect: boolean }>();
  private readonly cache = new Map<string, { at: number; events: RemoteEvent[] }>();

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
  ) {}

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
      if (a.auth === 'google' || a.auth === 'microsoft') {
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
            if (row) this.db.prepare('UPDATE calendars SET name = ?, writable = ?, account_id = ? WHERE id = ?').run(c.name, c.writable ? 1 : 0, s.accountId, row.id);
            else {
              const id = crypto.randomUUID();
              this.db
                .prepare('INSERT INTO calendars (id, owner_id, name, color, account_id, created_at, source, source_id, remote_id, writable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(id, userId, c.name, c.color, s.accountId, Date.now(), s.kind, s.id, c.remoteId, c.writable ? 1 : 0);
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
      return [];
    }
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

  async create(userId: string, cal: CalendarRow, f: EventFields) {
    await this.need(userId, cal).create(cal.remote_id!, f);
    this.forget(cal.id);
  }
  async update(userId: string, cal: CalendarRow, eventId: string, f: EventFields, instance: boolean) {
    await this.need(userId, cal).update(cal.remote_id!, eventId, f, instance);
    this.forget(cal.id);
  }
  async remove(userId: string, cal: CalendarRow, eventId: string) {
    await this.need(userId, cal).remove(cal.remote_id!, eventId);
    this.forget(cal.id);
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
      const simple = e.rrule ? simpleRecurrence(e.rrule, e.start) : null;
      const notes = [e.rrule && !simple ? describeRule(e.rrule) : '', e.organizer ? `Organizer: ${e.organizer.name || e.organizer.email}` : '', e.description].filter(Boolean).join('\n\n');
      this.db
        .prepare('INSERT INTO calendar_events (id, calendar_id, title, start_at, end_at, all_day, location, notes, recurrence, until_day, created_by, updated_at, ical_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), cal.id, e.title || 'Invitation', e.start.ms, e.end, e.allDay ? 1 : 0, e.location.slice(0, 500), notes.slice(0, 10_000), simple?.recurrence ?? 'none', simple?.until ?? null, userId, Date.now(), e.uid);
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
    const simple = e.rrule ? simpleRecurrence(e.rrule, e.start) : null;
    const id = await p.create(cal.remote_id!, {
      title: e.title || 'Invitation',
      location: e.location,
      notes: e.description,
      start: new Date(e.start.ms).toISOString(),
      end: new Date(e.end).toISOString(),
      allDay: e.allDay,
      recurrence: simple?.recurrence ?? 'none',
      until: simple?.until ?? null,
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
