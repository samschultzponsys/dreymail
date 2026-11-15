// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// DreyMail's own calendars: create, color, group under a mailbox, show/hide (the checkboxes),
// share with other DreyMail users (view or edit), and their events. Every request checks the
// signed-in user's access to the calendar: owner, edit or view.

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { mayOccur, type CalendarEvent, type CalendarView } from '../../../shared/calendar.js';
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
  })
  .refine((e) => Date.parse(e.end) >= Date.parse(e.start), { message: 'The end must be after the start' });

type Access = 'owner' | 'edit' | 'view';

export function registerCalendarRoutes(app: FastifyInstance, deps: { store: Store }) {
  const { store } = deps;
  const db = store.db;
  const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });

  const access = (userId: string, calendarId: string): Access | null => {
    const own = db.prepare('SELECT 1 FROM calendars WHERE id = ? AND owner_id = ?').get(calendarId, userId);
    if (own) return 'owner';
    const share = db.prepare('SELECT can_edit FROM calendar_shares WHERE calendar_id = ? AND user_id = ?').get(calendarId, userId) as { can_edit: number } | undefined;
    return share ? (share.can_edit ? 'edit' : 'view') : null;
  };
  const nameOf = (userId: string) => {
    const u = store.getUser(userId);
    return u ? u.displayName || u.name || u.username : 'Someone';
  };

  const list = (userId: string): CalendarView[] => {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.color, c.account_id, c.owner_id, s.can_edit,
                EXISTS (SELECT 1 FROM calendar_hidden h WHERE h.calendar_id = c.id AND h.user_id = ?) AS hidden
           FROM calendars c LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ?
          WHERE c.owner_id = ? OR s.user_id IS NOT NULL
          ORDER BY c.owner_id != ?, c.created_at`,
      )
      .all(userId, userId, userId, userId) as { id: string; name: string; color: string; account_id: string | null; owner_id: string; can_edit: number | null; hidden: number }[];
    return rows.map((r) => {
      const owner = r.owner_id === userId;
      return {
        id: r.id,
        name: r.name,
        color: r.color,
        accountId: owner ? r.account_id : null,
        access: owner ? 'owner' : r.can_edit ? 'edit' : 'view',
        ownerName: nameOf(r.owner_id),
        visible: !r.hidden,
        shares: owner
          ? (db.prepare('SELECT user_id, can_edit FROM calendar_shares WHERE calendar_id = ?').all(r.id) as { user_id: string; can_edit: number }[]).map((s) => ({ userId: s.user_id, name: nameOf(s.user_id), canEdit: s.can_edit === 1 }))
          : [],
      };
    });
  };

  /** Everyone's first calendar is made for them the first time they open the calendar. */
  const ensureFirst = (userId: string) => {
    if (db.prepare('SELECT 1 FROM calendars WHERE owner_id = ? LIMIT 1').get(userId)) return;
    db.prepare('INSERT INTO calendars (id, owner_id, name, color, account_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(crypto.randomUUID(), userId, 'Personal', '#22d3ee', Date.now());
  };

  const ownsAccount = (userId: string, accountId: string | null) => !accountId || store.listAccounts(userId).some((a) => a.id === accountId);

  // ---- calendars ------------------------------------------------------------------------

  app.get('/api/calendars', async (req) => {
    ensureFirst(req.user!.id);
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
    if (access(req.user!.id, req.params.id) !== 'owner') return bad(reply, 'Only the owner can change this calendar', 403);
    const body = calendarSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Give the calendar a name');
    if (!ownsAccount(req.user!.id, body.data.accountId)) return bad(reply, 'Mailbox not found', 404);
    db.prepare('UPDATE calendars SET name = ?, color = ?, account_id = ? WHERE id = ?').run(body.data.name, body.data.color, body.data.accountId, req.params.id);
    return list(req.user!.id);
  });

  app.delete<{ Params: { id: string } }>('/api/calendars/:id', async (req, reply) => {
    const a = access(req.user!.id, req.params.id);
    if (a === 'owner') db.prepare('DELETE FROM calendars WHERE id = ?').run(req.params.id);
    // Shared with you: "remove" means leaving it.
    else if (a) db.prepare('DELETE FROM calendar_shares WHERE calendar_id = ? AND user_id = ?').run(req.params.id, req.user!.id);
    else return bad(reply, 'Calendar not found', 404);
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

  /** Share with DreyMail users (replaces the list). */
  app.put<{ Params: { id: string } }>('/api/calendars/:id/shares', async (req, reply) => {
    if (access(req.user!.id, req.params.id) !== 'owner') return bad(reply, 'Only the owner can share this calendar', 403);
    const body = z.object({ shares: z.array(z.object({ userId: z.string().max(64), canEdit: z.boolean() })).max(200) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    db.prepare('DELETE FROM calendar_shares WHERE calendar_id = ?').run(req.params.id);
    for (const s of body.data.shares) {
      if (s.userId === req.user!.id || !store.getUser(s.userId)) continue;
      db.prepare('INSERT OR REPLACE INTO calendar_shares (calendar_id, user_id, can_edit) VALUES (?, ?, ?)').run(req.params.id, s.userId, s.canEdit ? 1 : 0);
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

  /** Events of the user's visible calendars that may happen between from and to (repeats are expanded by the app). */
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/events', async (req, reply) => {
    const from = Date.parse(req.query.from ?? '');
    const to = Date.parse(req.query.to ?? '');
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 400 * 86_400_000) return bad(reply, 'Invalid range');
    const ids = list(req.user!.id).filter((c) => c.visible).map((c) => c.id);
    if (!ids.length) return [];
    const rows = db
      .prepare(`SELECT * FROM calendar_events WHERE calendar_id IN (${ids.map(() => '?').join(',')}) AND start_at < ? AND (end_at > ? OR recurrence != 'none')`)
      .all(...ids, to, from) as Record<string, unknown>[];
    return rows.map(toEvent).filter((e) => mayOccur(e, from, to));
  });

  const canEdit = (userId: string, calendarId: string) => {
    const a = access(userId, calendarId);
    return a === 'owner' || a === 'edit';
  };

  app.post('/api/events', async (req, reply) => {
    const body = eventSchema.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues[0]?.message ?? 'Check the event');
    if (!canEdit(req.user!.id, body.data.calendarId)) return bad(reply, "You can't add events to this calendar", 403);
    const e = body.data;
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO calendar_events (id, calendar_id, title, start_at, end_at, all_day, location, notes, recurrence, until_day, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, e.calendarId, e.title, Date.parse(e.start), Date.parse(e.end), e.allDay ? 1 : 0, e.location, e.notes, e.recurrence, e.until, req.user!.id, Date.now());
    return toEvent(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as Record<string, unknown>);
  });

  app.put<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    const cur = db.prepare('SELECT calendar_id FROM calendar_events WHERE id = ?').get(req.params.id) as { calendar_id: string } | undefined;
    if (!cur || !canEdit(req.user!.id, cur.calendar_id)) return bad(reply, 'Event not found, or you may not change it', 404);
    const body = eventSchema.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues[0]?.message ?? 'Check the event');
    if (!canEdit(req.user!.id, body.data.calendarId)) return bad(reply, "You can't move events to that calendar", 403);
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
    const cur = db.prepare('SELECT calendar_id FROM calendar_events WHERE id = ?').get(req.params.id) as { calendar_id: string } | undefined;
    if (!cur || !canEdit(req.user!.id, cur.calendar_id)) return bad(reply, 'Event not found, or you may not delete it', 404);
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id);
    return { ok: true };
  });
}
