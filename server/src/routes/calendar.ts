// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Calendars: DreyMail's own (create, color, group under a mailbox, share with other DreyMail users
// to view or edit) next to provider calendars (Google, Outlook, CalDAV) read and written live.
// Every calendar has a show/hide checkbox per user. Every request checks the signed-in user's
// access: owner, edit or view. Also answering invitations found in mail.

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { findJoinUrl, mayOccur, type CalendarEvent, type CalendarView, type EventInput, type MeetingKind } from '../../../shared/calendar.js';
import { eventFromRow } from '../calendar/localEvents.js';
import { RemoteCalendarError, type RemoteEvent } from '../calendar/remote.js';
import type { Reminders } from '../calendar/reminders.js';
import type { Rooms } from '../calendar/rooms.js';
import type { CalendarRow, CalendarService } from '../calendar/service.js';
import type { Store } from '../db.js';

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const calendarSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: colorSchema,
  accountId: z.string().max(64).nullable().default(null),
  // DreyMail 12.4: your own name for a provider's calendar, and whether the color follows the mailbox.
  nickname: z.string().trim().max(80).optional(),
  mailboxColor: z.boolean().optional(),
});
const attendeeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(200).default(''),
  status: z.enum(['needs-action', 'accepted', 'tentative', 'declined']).default('needs-action'),
  optional: z.boolean().optional(),
  resource: z.boolean().optional(),
});
const eventSchema = z
  .object({
    calendarId: z.string().max(64),
    title: z.string().trim().min(1).max(300),
    start: z.string().datetime(),
    end: z.string().datetime(),
    allDay: z.boolean().default(false),
    location: z.string().max(500).default(''),
    notes: z.string().max(10_000).default(''),
    recurrence: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).default('none'),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    interval: z.number().int().min(1).max(999).optional(),
    byDay: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    monthlyBy: z.enum(['day', 'weekday', 'last']).optional(),
    count: z.number().int().min(1).max(999).nullable().optional(),
    timeZone: z.string().max(64).optional(),
    /** Minutes before the start; null: none. */
    reminder: z.number().int().min(0).max(40_320).nullable().optional(),
    showAs: z.enum(['busy', 'free', 'tentative', 'away', 'elsewhere']).optional(),
    attendees: z.array(attendeeSchema).max(200).optional(),
    /** Mailbox the invitations of DreyMail and CalDAV events go out from. */
    sendFrom: z.string().max(64).nullable().optional(),
    meeting: z.enum(['teams', 'meet']).nullable().optional(),
    /** Provider events: this is one occurrence of a repeating series. */
    instance: z.boolean().optional(),
    /** Repeating DreyMail events: change this occurrence, this and the following ones, or all. */
    scope: z.enum(['this', 'following', 'all']).optional(),
    occurrenceStart: z.string().datetime().optional(),
  })
  .refine((e) => Date.parse(e.end) >= Date.parse(e.start), { message: 'The end must be after the start' })
  .refine((e) => !e.scope || e.scope === 'all' || !!e.occurrenceStart, { message: 'Which occurrence?' });
const refSchema = z.object({ accountId: z.string().max(64), folder: z.string().max(1000), uid: z.number().int().positive(), uidValidity: z.string().max(40) });

type Access = 'owner' | 'edit' | 'view';

/** Provider events carry the calendar in their id: "<calendar id>~<provider event id, base64url>". */
const remoteEventId = (calendarId: string, remoteId: string) => `${calendarId}~${Buffer.from(remoteId).toString('base64url')}`;
function parseRemoteId(id: string): { calendarId: string; remoteId: string } | null {
  const i = id.indexOf('~');
  if (i < 0) return null;
  return { calendarId: id.slice(0, i), remoteId: Buffer.from(id.slice(i + 1), 'base64url').toString() };
}

export function registerCalendarRoutes(app: FastifyInstance, deps: { store: Store; calendars: CalendarService; reminders?: Reminders; rooms?: Rooms }) {
  const { store, calendars, reminders, rooms } = deps;
  const db = store.db;
  const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RemoteCalendarError) return bad(reply, err.message, err.status >= 400 && err.status < 500 ? err.status : 502);
    throw err;
  };

  const row = (id: string) => db.prepare('SELECT * FROM calendars WHERE id = ?').get(id) as CalendarRow | undefined;
  const access = (userId: string, calendarId: string): Access | null => {
    const r = row(calendarId);
    if (!r) return null;
    if (r.owner_id === userId) return r.source === 'local' || r.writable ? 'owner' : 'view';
    if (r.source !== 'local') return null; // provider calendars are never shared
    const share = db.prepare('SELECT can_edit FROM calendar_shares WHERE calendar_id = ? AND user_id = ?').get(calendarId, userId) as { can_edit: number } | undefined;
    return share ? (share.can_edit ? 'edit' : 'view') : null;
  };
  const canEdit = (userId: string, calendarId: string) => {
    const a = access(userId, calendarId);
    return a === 'owner' || a === 'edit';
  };
  const nameOf = (userId: string) => {
    const u = store.getUser(userId);
    return u ? u.displayName || u.name || u.username : 'Someone';
  };

  const list = (userId: string): CalendarView[] => {
    const rows = db
      .prepare(
        `SELECT c.*, s.can_edit,
                EXISTS (SELECT 1 FROM calendar_hidden h WHERE h.calendar_id = c.id AND h.user_id = ?) AS hidden
           FROM calendars c LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ?
          WHERE c.owner_id = ? OR (s.user_id IS NOT NULL AND c.source = 'local')
          ORDER BY c.owner_id != ?, c.source != 'local', c.created_at`,
      )
      .all(userId, userId, userId, userId) as unknown as (CalendarRow & { can_edit: number | null; hidden: number })[];
    const mailboxColors = new Map(store.listAccounts(userId).map((a) => [a.id, a.color]));
    return rows.map((r) => {
      const owner = r.owner_id === userId;
      const x = r as CalendarRow & { nickname?: string; color_set?: number };
      const nickname = owner ? (x.nickname ?? '') : '';
      // A mailbox's calendar shows in the mailbox's color unless one was picked for it (DreyMail 12.4).
      const followsMailbox = owner && !!r.account_id && !x.color_set && mailboxColors.has(r.account_id);
      return {
        id: r.id,
        name: nickname || r.name,
        ...(nickname ? { nickname, officialName: r.name } : {}),
        color: followsMailbox ? mailboxColors.get(r.account_id!)! : r.color,
        mailboxColor: followsMailbox,
        accountId: owner ? r.account_id : null,
        access: owner ? (r.source === 'local' || r.writable ? 'owner' : 'view') : r.can_edit ? 'edit' : 'view',
        ownerName: nameOf(r.owner_id),
        visible: !r.hidden,
        shares:
          owner && r.source === 'local'
            ? (db.prepare('SELECT user_id, can_edit FROM calendar_shares WHERE calendar_id = ?').all(r.id) as { user_id: string; can_edit: number }[]).map((s) => ({ userId: s.user_id, name: nameOf(s.user_id), canEdit: s.can_edit === 1 }))
            : [],
        source: r.source,
        sourceId: r.source_id,
        ...(r.meetings ? { meetings: r.meetings.split(',').filter(Boolean) as MeetingKind[] } : {}),
      };
    });
  };

  /** Everyone's first calendar is made for them the first time they open the calendar. */
  const ensureFirst = (userId: string) => {
    if (db.prepare("SELECT 1 FROM calendars WHERE owner_id = ? AND source = 'local' LIMIT 1").get(userId)) return;
    db.prepare('INSERT INTO calendars (id, owner_id, name, color, account_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(crypto.randomUUID(), userId, 'Personal', '#22d3ee', Date.now());
  };

  const ownsAccount = (userId: string, accountId: string | null) => !accountId || store.listAccounts(userId).some((a) => a.id === accountId);

  // ---- calendars ------------------------------------------------------------------------

  app.get<{ Querystring: { refresh?: string } }>('/api/calendars', async (req) => {
    ensureFirst(req.user!.id);
    await calendars.sync(req.user!.id, req.query.refresh === '1');
    return list(req.user!.id);
  });

  app.post('/api/calendars', async (req, reply) => {
    const body = calendarSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Give the calendar a name');
    if (!ownsAccount(req.user!.id, body.data.accountId)) return bad(reply, 'Mailbox not found', 404);
    db.prepare('INSERT INTO calendars (id, owner_id, name, color, account_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), req.user!.id, body.data.name, body.data.color, body.data.accountId, Date.now());
    return list(req.user!.id);
  });

  app.put<{ Params: { id: string } }>('/api/calendars/:id', async (req, reply) => {
    const r = row(req.params.id);
    if (!r || r.owner_id !== req.user!.id) return bad(reply, 'Only the owner can change this calendar', 403);
    const body = calendarSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Give the calendar a name');
    // Following the mailbox's color, or the one picked (DreyMail 12.4).
    const colorSet = body.data.mailboxColor === true ? 0 : 1;
    // Provider calendars: the name there stays theirs; DreyMail keeps a name of your own and the color.
    if (r.source !== 'local') db.prepare('UPDATE calendars SET color = ?, color_set = ?, nickname = ? WHERE id = ?').run(body.data.color, colorSet, body.data.nickname ?? '', r.id);
    else {
      if (!ownsAccount(req.user!.id, body.data.accountId)) return bad(reply, 'Mailbox not found', 404);
      db.prepare('UPDATE calendars SET name = ?, color = ?, account_id = ?, color_set = ? WHERE id = ?').run(body.data.name, body.data.color, body.data.accountId, colorSet, r.id);
    }
    return list(req.user!.id);
  });

  app.delete<{ Params: { id: string } }>('/api/calendars/:id', async (req, reply) => {
    const r = row(req.params.id);
    const a = access(req.user!.id, req.params.id);
    if (!r || !a) return bad(reply, 'Calendar not found', 404);
    if (r.source !== 'local') return bad(reply, 'This calendar comes from your provider. Hide it with its checkbox instead.');
    if (r.owner_id === req.user!.id) db.prepare('DELETE FROM calendars WHERE id = ?').run(r.id);
    // Shared with you: "remove" means leaving it.
    else db.prepare('DELETE FROM calendar_shares WHERE calendar_id = ? AND user_id = ?').run(r.id, req.user!.id);
    return list(req.user!.id);
  });

  /** The checkbox: show or hide a calendar (per user, also for calendars shared with you). */
  app.put<{ Params: { id: string } }>('/api/calendars/:id/visible', async (req, reply) => {
    if (!access(req.user!.id, req.params.id)) return bad(reply, 'Calendar not found', 404);
    const body = z.object({ visible: z.boolean() }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    if (body.data.visible) db.prepare('DELETE FROM calendar_hidden WHERE calendar_id = ? AND user_id = ?').run(req.params.id, req.user!.id);
    else db.prepare('INSERT OR IGNORE INTO calendar_hidden (calendar_id, user_id) VALUES (?, ?)').run(req.params.id, req.user!.id);
    return list(req.user!.id);
  });

  /** Share with DreyMail users (replaces the list). DreyMail calendars only. */
  app.put<{ Params: { id: string } }>('/api/calendars/:id/shares', async (req, reply) => {
    const r = row(req.params.id);
    if (!r || r.owner_id !== req.user!.id) return bad(reply, 'Only the owner can share this calendar', 403);
    if (r.source !== 'local') return bad(reply, 'Calendars from your provider are shared there, not in DreyMail');
    const body = z.object({ shares: z.array(z.object({ userId: z.string().max(64), canEdit: z.boolean() })).max(200) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    db.prepare('DELETE FROM calendar_shares WHERE calendar_id = ?').run(r.id);
    for (const s of body.data.shares) {
      if (s.userId === req.user!.id || !store.getUser(s.userId)) continue;
      db.prepare('INSERT OR REPLACE INTO calendar_shares (calendar_id, user_id, can_edit) VALUES (?, ?, ?)').run(r.id, s.userId, s.canEdit ? 1 : 0);
    }
    return list(req.user!.id);
  });

  /** DreyMail users to share with (names only). */
  app.get('/api/calendars/people', async (req) =>
    store
      .listUsers()
      .filter((u) => u.id !== req.user!.id)
      .map((u) => ({ id: u.id, name: u.displayName || u.name || u.username })),
  );

  // ---- provider connections ---------------------------------------------------------------

  app.get('/api/calendar-sources', async (req) => calendars.sources(req.user!.id));

  /** Connect a CalDAV account (Nextcloud, iCloud, Fastmail, Radicale…). */
  app.post('/api/calendar-sources', async (req, reply) => {
    const body = z
      .object({
        url: z.string().trim().min(3).max(500),
        username: z.string().trim().min(1).max(200),
        password: z.string().min(1).max(500),
        name: z.string().trim().max(80).default(''),
        accountId: z.string().max(64).nullable().default(null),
      })
      .safeParse(req.body);
    if (!body.success) return bad(reply, 'Enter the address, username and password');
    if (!ownsAccount(req.user!.id, body.data.accountId)) return bad(reply, 'Mailbox not found', 404);
    try {
      await calendars.addCalDav(req.user!.id, body.data);
    } catch (err) {
      if (err instanceof RemoteCalendarError) return bad(reply, err.message, 400);
      return bad(reply, `Could not connect: ${(err as Error).message}`, 400);
    }
    return { sources: calendars.sources(req.user!.id), calendars: list(req.user!.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/calendar-sources/:id', async (req, reply) => {
    if (!calendars.removeCalDav(req.user!.id, req.params.id)) return bad(reply, 'Not found', 404);
    return { sources: calendars.sources(req.user!.id), calendars: list(req.user!.id) };
  });

  // ---- events --------------------------------------------------------------------------

  /** A DreyMail event as the user sees it (whether they organize it, its meeting link). */
  const toEvent = (userId: string, r: Record<string, unknown>): CalendarEvent => {
    const e = eventFromRow(r);
    const org = e.organizer?.email;
    return { ...e, isOrganizer: !org || calendars.myAddresses(userId).has(org.toLowerCase()), joinUrl: findJoinUrl(e.location, e.notes) };
  };
  const localRow = (id: string) => db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  /** A provider event in the app's terms. */
  const fromRemote = (userId: string, c: CalendarRow, e: RemoteEvent & Partial<Pick<CalendarEvent, 'interval' | 'byDay' | 'monthlyBy' | 'count' | 'timeZone' | 'exdates'>>, writable: boolean): CalendarEvent => {
    const org = e.organizer?.email;
    return {
      id: remoteEventId(c.id, e.remoteId),
      calendarId: c.id,
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      location: e.location,
      notes: e.notes,
      recurrence: e.recurrence,
      until: e.until,
      ...(e.interval && e.interval > 1 ? { interval: e.interval } : {}),
      ...(e.byDay?.length ? { byDay: e.byDay } : {}),
      ...(e.monthlyBy ? { monthlyBy: e.monthlyBy } : {}),
      ...(e.count ? { count: e.count } : {}),
      ...(e.timeZone ? { timeZone: e.timeZone } : {}),
      reminder: e.reminder ?? null,
      ...(e.showAs && e.showAs !== 'busy' ? { showAs: e.showAs } : {}),
      ...(e.attendees?.length ? { attendees: e.attendees, organizer: e.organizer ?? null } : {}),
      isOrganizer: c.source === 'caldav' ? !org || calendars.myAddresses(userId).has(org) : e.isOrganizer !== false,
      joinUrl: e.joinUrl ?? null,
      instance: e.instance || undefined,
      ...(e.seriesId ? { seriesId: remoteEventId(c.id, e.seriesId) } : {}),
      readOnly: e.readOnly || !writable || undefined,
    };
  };

  /** Events of the user's visible calendars that may happen between from and to (DreyMail repeats are expanded by the app). */
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/events', async (req, reply) => {
    const userId = req.user!.id;
    const from = Date.parse(req.query.from ?? '');
    const to = Date.parse(req.query.to ?? '');
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 400 * 86_400_000) return bad(reply, 'Invalid range');
    const visible = list(userId).filter((c) => c.visible);
    const local = visible.filter((c) => c.source === 'local').map((c) => c.id);
    const out: CalendarEvent[] = [];
    if (local.length) {
      const rows = db
        .prepare(`SELECT * FROM calendar_events WHERE calendar_id IN (${local.map(() => '?').join(',')}) AND start_at < ? AND (end_at > ? OR recurrence != 'none')`)
        .all(...local, to, from) as Record<string, unknown>[];
      out.push(...rows.map((r) => toEvent(userId, r)).filter((e) => mayOccur(e, from, to)));
    }
    const remote = await Promise.all(
      visible
        .filter((c) => c.source !== 'local')
        .map(async (c) => {
          const r = row(c.id)!;
          return (await calendars.events(userId, r, from, to)).map((e) => fromRemote(userId, r, e, !!r.writable));
        }),
    );
    return out.concat(...remote);
  });

  /** One event, or the whole series an occurrence belongs to (provider events: read from the provider). */
  app.get<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    const userId = req.user!.id;
    const remote = parseRemoteId(req.params.id);
    if (remote) {
      const cal = row(remote.calendarId);
      if (!cal || cal.owner_id !== userId || cal.source === 'local') return bad(reply, 'Event not found', 404);
      try {
        const s = await calendars.get(userId, cal, remote.remoteId);
        return fromRemote(userId, cal, { ...s, readOnly: !s.editable }, !!cal.writable);
      } catch (err) {
        return fail(reply, err);
      }
    }
    const r = localRow(req.params.id);
    if (!r || !access(userId, String(r.calendar_id))) return bad(reply, 'Event not found', 404);
    return toEvent(userId, r);
  });

  /** Sends invitations in the background: a guest's address that bounces doesn't undo the save. */
  const inviting = (p: Promise<unknown>, reply: FastifyReply) =>
    p.catch((err: Error) => {
      reply.log.warn({ error: err.message }, 'sending calendar invitations failed');
      return err.message;
    });

  /** The organizer of a DreyMail event with guests: the mailbox they are invited from. */
  const organizerFor = (userId: string, calendarId: string, e: { attendees?: unknown[]; sendFrom?: string | null }) => {
    if (!e.attendees?.length) return null;
    const s = calendars.sender(userId, row(calendarId) ?? null, e.sendFrom);
    return s ? { email: s.email, name: s.displayName } : null;
  };

  app.post('/api/events', async (req, reply) => {
    const userId = req.user!.id;
    const body = eventSchema.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues[0]?.message ?? 'Check the event');
    if (!canEdit(userId, body.data.calendarId)) return bad(reply, "You can't add events to this calendar", 403);
    const { scope: _s, occurrenceStart: _o, instance: _i, ...e } = body.data;
    const cal = row(e.calendarId)!;
    if (cal.source !== 'local') {
      try {
        await calendars.create(userId, cal, e);
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    }
    const org = organizerFor(userId, e.calendarId, e);
    const sendFrom = org ? (calendars.sender(userId, cal, e.sendFrom)?.id ?? null) : null;
    const saved = calendars.local.insert({ ...e, sendFrom }, userId, org);
    const warning = await inviting(calendars.inviteLocal(userId, saved, 'REQUEST'), reply);
    return { ...toEvent(userId, localRow(saved.id)!), ...(typeof warning === 'string' ? { warning: `Saved, but the invitations were not sent: ${warning}` } : {}) };
  });

  app.put<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    const userId = req.user!.id;
    const body = eventSchema.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues[0]?.message ?? 'Check the event');
    const remote = parseRemoteId(req.params.id);
    const { scope, occurrenceStart, instance, ...e } = body.data;
    if (remote) {
      const cal = row(remote.calendarId);
      if (!cal || cal.owner_id !== userId || cal.source === 'local') return bad(reply, 'Event not found', 404);
      if (e.calendarId !== cal.id) return bad(reply, 'Events from your provider stay in their calendar');
      try {
        // This and the following ones of a provider series (DreyMail 10.9).
        if (scope === 'following' && occurrenceStart) {
          await calendars.splitSeries(userId, cal, remote.remoteId, occurrenceStart, e);
          return { ok: true };
        }
        await calendars.update(userId, cal, remote.remoteId, e, !!instance);
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    }
    const curRow = localRow(req.params.id);
    if (!curRow || !canEdit(userId, String(curRow.calendar_id))) return bad(reply, 'Event not found, or you may not change it', 404);
    if (!canEdit(userId, e.calendarId) || row(e.calendarId)?.source !== 'local') return bad(reply, "You can't move events to that calendar", 403);
    const cur = toEvent(userId, curRow);
    // Only the organizer changes the guest list; others keep it as it is.
    const input: EventInput = cur.isOrganizer ? e : { ...e, attendees: cur.attendees, sendFrom: cur.sendFrom };
    const org = cur.isOrganizer ? organizerFor(userId, input.calendarId, input) : (cur.organizer ?? null);
    const sendFrom = cur.isOrganizer && org ? (calendars.sender(userId, row(input.calendarId) ?? null, input.sendFrom)?.id ?? null) : (cur.sendFrom ?? null);
    const which = cur.recurrence === 'none' ? 'all' : (scope ?? 'all');
    const mails: Promise<unknown>[] = [];
    let saved: CalendarEvent;
    if (which === 'all') {
      saved = calendars.local.update(cur.id, { ...input, sendFrom, exdates: input.recurrence === 'none' ? [] : cur.exdates }, org);
      if (cur.isOrganizer) {
        const now = new Set((saved.attendees ?? []).map((a) => a.email));
        const removed = (cur.attendees ?? []).filter((a) => !now.has(a.email)).map((a) => a.email);
        mails.push(calendars.inviteLocal(userId, saved, 'REQUEST', { update: true }));
        if (removed.length) mails.push(calendars.inviteLocal(userId, { ...saved, attendees: cur.attendees }, 'CANCEL', { to: removed }));
      }
    } else if (which === 'this') {
      // The occurrence leaves the series and becomes an event of its own.
      const series = calendars.local.skip(cur.id, occurrenceStart!);
      saved = calendars.local.insert({ ...input, recurrence: 'none', until: null, count: null, sendFrom }, userId, org);
      if (cur.isOrganizer) mails.push(calendars.inviteLocal(userId, series, 'REQUEST', { update: true }), calendars.inviteLocal(userId, saved, 'REQUEST'));
    } else {
      // This and the following: the series ends before it, a new one starts with the changes.
      const { kept, before } = calendars.local.endBefore(cur.id, occurrenceStart!);
      saved = calendars.local.insert({ ...input, count: input.count ? Math.max(1, input.count - before) : input.count, sendFrom }, userId, org);
      if (cur.isOrganizer) {
        if (kept) mails.push(calendars.inviteLocal(userId, kept, 'REQUEST', { update: true }));
        else mails.push(calendars.inviteLocal(userId, cur, 'CANCEL'));
        mails.push(calendars.inviteLocal(userId, saved, 'REQUEST'));
      }
    }
    const warning = await inviting(Promise.all(mails), reply);
    return { ...toEvent(userId, localRow(saved.id)!), ...(typeof warning === 'string' ? { warning: `Saved, but the invitations were not sent: ${warning}` } : {}) };
  });

  app.delete<{ Params: { id: string }; Querystring: { scope?: string; occurrence?: string } }>('/api/events/:id', async (req, reply) => {
    const userId = req.user!.id;
    const remote = parseRemoteId(req.params.id);
    if (remote) {
      const cal = row(remote.calendarId);
      if (!cal || cal.owner_id !== userId || cal.source === 'local') return bad(reply, 'Event not found', 404);
      try {
        if (req.query.scope === 'following' && req.query.occurrence && !Number.isNaN(Date.parse(req.query.occurrence))) await calendars.splitSeries(userId, cal, remote.remoteId, req.query.occurrence, null);
        else await calendars.remove(userId, cal, remote.remoteId);
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    }
    const curRow = localRow(req.params.id);
    if (!curRow || !canEdit(userId, String(curRow.calendar_id))) return bad(reply, 'Event not found, or you may not delete it', 404);
    const cur = toEvent(userId, curRow);
    const occurrence = req.query.occurrence && !Number.isNaN(Date.parse(req.query.occurrence)) ? req.query.occurrence : null;
    const which = cur.recurrence === 'none' || !occurrence ? 'all' : req.query.scope === 'this' || req.query.scope === 'following' ? req.query.scope : 'all';
    let mail: Promise<unknown> = Promise.resolve();
    if (which === 'this') {
      const series = calendars.local.skip(cur.id, occurrence!);
      if (cur.isOrganizer) mail = calendars.inviteLocal(userId, series, 'REQUEST', { update: true });
    } else if (which === 'following') {
      const { kept } = calendars.local.endBefore(cur.id, occurrence!);
      if (cur.isOrganizer) mail = kept ? calendars.inviteLocal(userId, kept, 'REQUEST', { update: true }) : calendars.inviteLocal(userId, cur, 'CANCEL');
    } else {
      // Guests hear about it before the event (and its UID) are gone.
      if (cur.isOrganizer) await inviting(calendars.inviteLocal(userId, cur, 'CANCEL'), reply);
      calendars.local.remove(cur.id);
    }
    await inviting(mail, reply);
    return { ok: true };
  });

  // ---- free/busy (scheduling assistant, DreyMail 10.2) ---------------------------------------

  app.post('/api/freebusy', async (req, reply) => {
    const body = z
      .object({ calendarId: z.string().max(64).nullable().default(null), emails: z.array(z.string().trim().toLowerCase().email().max(320)).max(50), from: z.string().datetime(), to: z.string().datetime() })
      .refine((b) => Date.parse(b.to) > Date.parse(b.from) && Date.parse(b.to) - Date.parse(b.from) <= 14 * 86_400_000, { message: 'Invalid range' })
      .safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues[0]?.message ?? 'Invalid request');
    return calendars.freeBusy(req.user!.id, body.data.calendarId, body.data.emails, Date.parse(body.data.from), Date.parse(body.data.to));
  });

  // ---- meeting rooms (DreyMail 10.7) ------------------------------------------------------------

  app.get('/api/rooms', async (req) => ({ rooms: (await rooms?.list(req.user!.id)) ?? [], microsoft: (await rooms?.microsoftAllowed(req.user!.id)) ?? [] }));

  // ---- reminders ------------------------------------------------------------------------

  // A changed event may change a reminder: look again soon.
  app.addHook('onResponse', async (req, reply) => {
    if (req.user && req.method !== 'GET' && reply.statusCode < 400 && /^\/api\/(events|calendars)/.test(req.url)) reminders?.changed(req.user.id);
  });

  /** Reminders whose time has come (the reminder window). */
  app.get('/api/reminders', async (req) => reminders?.active(req.user!.id) ?? []);

  app.post('/api/reminders/dismiss', async (req, reply) => {
    const body = z.object({ keys: z.array(z.string().max(2000)).min(1).max(200) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    reminders?.dismiss(req.user!.id, body.data.keys);
    return reminders?.active(req.user!.id) ?? [];
  });

  app.post('/api/reminders/snooze', async (req, reply) => {
    const body = z.object({ keys: z.array(z.string().max(2000)).min(1).max(200), minutes: z.union([z.number().int().min(1).max(10_080), z.literal('start')]) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    reminders?.snooze(req.user!.id, body.data.keys, body.data.minutes);
    return reminders?.active(req.user!.id) ?? [];
  });

  // ---- invitations ----------------------------------------------------------------------

  app.get<{ Querystring: { accountId?: string; uid?: string } }>('/api/invite', async (req, reply) => {
    if (!req.query.accountId || !req.query.uid) return bad(reply, 'Invalid request');
    try {
      return await calendars.inviteState(req.user!.id, req.query.accountId, req.query.uid.slice(0, 1000));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/invite/answer', async (req, reply) => {
    const body = z.object({ ref: refSchema, answer: z.enum(['accepted', 'tentative', 'declined']), calendarId: z.string().max(64).nullable().default(null) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    const userId = req.user!.id;
    try {
      return await calendars.answer(userId, body.data.ref, body.data.answer, body.data.calendarId, (id) => (canEdit(userId, id) ? row(id)! : null));
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Answer with a new time proposed (DreyMail 10.8). */
  app.post('/api/invite/propose', async (req, reply) => {
    const body = z.object({ ref: refSchema, answer: z.enum(['tentative', 'declined']), start: z.string().datetime(), end: z.string().datetime(), comment: z.string().max(1000).default('') }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Check the new time');
    try {
      return await calendars.propose(req.user!.id, body.data.ref, { answer: body.data.answer, start: Date.parse(body.data.start), end: Date.parse(body.data.end), comment: body.data.comment });
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Accept or decline a guest's proposed new time for your event (DreyMail 10.8). */
  app.post('/api/invite/counter', async (req, reply) => {
    const body = z.object({ ref: refSchema, accept: z.boolean() }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    try {
      const r = await calendars.answerCounter(req.user!.id, body.data.ref, body.data.accept);
      reminders?.changed(req.user!.id);
      return r;
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** A guest's answer to an invitation you sent from DreyMail: shown on your event. */
  app.post('/api/invite/reply', async (req, reply) => {
    const body = z.object({ ref: refSchema }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    try {
      return { updated: await calendars.applyReply(req.user!.id, body.data.ref) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/invite/remove', async (req, reply) => {
    const body = z.object({ uid: z.string().min(1).max(1000) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    try {
      await calendars.removeInvite(req.user!.id, body.data.uid);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
