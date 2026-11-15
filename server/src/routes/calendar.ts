// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Calendars: DreyMail's own (create, color, group under a mailbox, share with other DreyMail users
// to view or edit) next to provider calendars (Google, Outlook, CalDAV) read and written live.
// Every calendar has a show/hide checkbox per user. Every request checks the signed-in user's
// access: owner, edit or view. Also answering invitations found in mail.

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { mayOccur, type CalendarEvent, type CalendarView } from '../../../shared/calendar.js';
import { RemoteCalendarError } from '../calendar/remote.js';
import type { CalendarRow, CalendarService } from '../calendar/service.js';
import type { Store } from '../db.js';

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const calendarSchema = z.object({ name: z.string().trim().min(1).max(80), color: colorSchema, accountId: z.string().max(64).nullable().default(null) });
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
    timeZone: z.string().max(64).optional(),
    /** Provider events: this is one occurrence of a repeating series. */
    instance: z.boolean().optional(),
  })
  .refine((e) => Date.parse(e.end) >= Date.parse(e.start), { message: 'The end must be after the start' });
const refSchema = z.object({ accountId: z.string().max(64), folder: z.string().max(1000), uid: z.number().int().positive(), uidValidity: z.string().max(40) });

type Access = 'owner' | 'edit' | 'view';

/** Provider events carry the calendar in their id: "<calendar id>~<provider event id, base64url>". */
const remoteEventId = (calendarId: string, remoteId: string) => `${calendarId}~${Buffer.from(remoteId).toString('base64url')}`;
function parseRemoteId(id: string): { calendarId: string; remoteId: string } | null {
  const i = id.indexOf('~');
  if (i < 0) return null;
  return { calendarId: id.slice(0, i), remoteId: Buffer.from(id.slice(i + 1), 'base64url').toString() };
}

export function registerCalendarRoutes(app: FastifyInstance, deps: { store: Store; calendars: CalendarService }) {
  const { store, calendars } = deps;
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
    return rows.map((r) => {
      const owner = r.owner_id === userId;
      return {
        id: r.id,
        name: r.name,
        color: r.color,
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
    // Provider calendars: only the color is DreyMail's (name and mailbox come from the provider).
    if (r.source !== 'local') db.prepare('UPDATE calendars SET color = ? WHERE id = ?').run(body.data.color, r.id);
    else {
      if (!ownsAccount(req.user!.id, body.data.accountId)) return bad(reply, 'Mailbox not found', 404);
      db.prepare('UPDATE calendars SET name = ?, color = ?, account_id = ? WHERE id = ?').run(body.data.name, body.data.color, body.data.accountId, r.id);
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

  const toEvent = (r: Record<string, unknown>): CalendarEvent => ({
    id: String(r.id),
    calendarId: String(r.calendar_id),
    title: String(r.title),
    start: new Date(Number(r.start_at)).toISOString(),
    end: new Date(Number(r.end_at)).toISOString(),
    allDay: r.all_day === 1,
    location: String(r.location),
    notes: String(r.notes),
    recurrence: r.recurrence as CalendarEvent['recurrence'],
    until: (r.until_day as string | null) ?? null,
  });

  /** Events of the user's visible calendars that may happen between from and to (DreyMail repeats are expanded by the app). */
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/events', async (req, reply) => {
    const from = Date.parse(req.query.from ?? '');
    const to = Date.parse(req.query.to ?? '');
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 400 * 86_400_000) return bad(reply, 'Invalid range');
    const visible = list(req.user!.id).filter((c) => c.visible);
    const local = visible.filter((c) => c.source === 'local').map((c) => c.id);
    const out: CalendarEvent[] = [];
    if (local.length) {
      const rows = db
        .prepare(`SELECT * FROM calendar_events WHERE calendar_id IN (${local.map(() => '?').join(',')}) AND start_at < ? AND (end_at > ? OR recurrence != 'none')`)
        .all(...local, to, from) as Record<string, unknown>[];
      out.push(...rows.map(toEvent).filter((e) => mayOccur(e, from, to)));
    }
    const remote = await Promise.all(
      visible
        .filter((c) => c.source !== 'local')
        .map(async (c) => {
          const r = row(c.id)!;
          return (await calendars.events(req.user!.id, r, from, to)).map(
            (e): CalendarEvent => ({
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
              instance: e.instance || undefined,
              readOnly: e.readOnly || !r.writable || undefined,
            }),
          );
        }),
    );
    return out.concat(...remote);
  });

  app.post('/api/events', async (req, reply) => {
    const body = eventSchema.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues[0]?.message ?? 'Check the event');
    if (!canEdit(req.user!.id, body.data.calendarId)) return bad(reply, "You can't add events to this calendar", 403);
    const e = body.data;
    const cal = row(e.calendarId)!;
    if (cal.source !== 'local') {
      try {
        await calendars.create(req.user!.id, cal, e);
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    }
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO calendar_events (id, calendar_id, title, start_at, end_at, all_day, location, notes, recurrence, until_day, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, e.calendarId, e.title, Date.parse(e.start), Date.parse(e.end), e.allDay ? 1 : 0, e.location, e.notes, e.recurrence, e.until, req.user!.id, Date.now());
    return toEvent(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as Record<string, unknown>);
  });

  app.put<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    const body = eventSchema.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues[0]?.message ?? 'Check the event');
    const remote = parseRemoteId(req.params.id);
    if (remote) {
      const cal = row(remote.calendarId);
      if (!cal || cal.owner_id !== req.user!.id || cal.source === 'local') return bad(reply, 'Event not found', 404);
      if (body.data.calendarId !== cal.id) return bad(reply, 'Events from your provider stay in their calendar');
      try {
        await calendars.update(req.user!.id, cal, remote.remoteId, body.data, !!body.data.instance);
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    }
    const cur = db.prepare('SELECT calendar_id FROM calendar_events WHERE id = ?').get(req.params.id) as { calendar_id: string } | undefined;
    if (!cur || !canEdit(req.user!.id, cur.calendar_id)) return bad(reply, 'Event not found, or you may not change it', 404);
    if (!canEdit(req.user!.id, body.data.calendarId) || row(body.data.calendarId)?.source !== 'local') return bad(reply, "You can't move events to that calendar", 403);
    const e = body.data;
    db.prepare('UPDATE calendar_events SET calendar_id = ?, title = ?, start_at = ?, end_at = ?, all_day = ?, location = ?, notes = ?, recurrence = ?, until_day = ?, updated_at = ? WHERE id = ?').run(
      e.calendarId,
      e.title,
      Date.parse(e.start),
      Date.parse(e.end),
      e.allDay ? 1 : 0,
      e.location,
      e.notes,
      e.recurrence,
      e.until,
      Date.now(),
      req.params.id,
    );
    return toEvent(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id) as Record<string, unknown>);
  });

  app.delete<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    const remote = parseRemoteId(req.params.id);
    if (remote) {
      const cal = row(remote.calendarId);
      if (!cal || cal.owner_id !== req.user!.id || cal.source === 'local') return bad(reply, 'Event not found', 404);
      try {
        await calendars.remove(req.user!.id, cal, remote.remoteId);
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    }
    const cur = db.prepare('SELECT calendar_id FROM calendar_events WHERE id = ?').get(req.params.id) as { calendar_id: string } | undefined;
    if (!cur || !canEdit(req.user!.id, cur.calendar_id)) return bad(reply, 'Event not found, or you may not delete it', 404);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id);
    return { ok: true };
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
