// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Reminders DreyMail puts in its administrators' own calendars, e.g. "renew the Outlook client
// secret before it expires". One all-day event per Superadmin, in their first DreyMail calendar
// (made if they have none); saving again moves it instead of adding another.

import crypto from 'node:crypto';
import type { Store } from '../db.js';

export interface AdminReminder {
  /** Identifies this reminder, so it is replaced rather than repeated. */
  key: string;
  title: string;
  notes: string;
  /** The day it shows on (YYYY-MM-DD). */
  day: string;
}

/** The user's first own DreyMail calendar, made ("Personal") if there is none. */
function ownCalendar(store: Store, userId: string): string {
  const row = store.db.prepare("SELECT id FROM calendars WHERE owner_id = ? AND source = 'local' ORDER BY created_at LIMIT 1").get(userId) as { id: string } | undefined;
  if (row) return row.id;
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO calendars (id, owner_id, name, color, account_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(id, userId, 'Personal', '#22d3ee', Date.now());
  return id;
}

/** Puts (or moves) the reminder in each of these users' calendars. Returns how many got it. */
export function setAdminReminder(store: Store, userIds: string[], r: AdminReminder): number {
  const uid = `dreymail-reminder-${r.key}`;
  const start = Date.parse(`${r.day}T00:00:00.000Z`);
  if (Number.isNaN(start)) return 0;
  for (const userId of userIds) {
    const calendarId = ownCalendar(store, userId);
    store.db.prepare('DELETE FROM calendar_events WHERE ical_uid = ? AND calendar_id IN (SELECT id FROM calendars WHERE owner_id = ?)').run(uid, userId);
    store.db
      .prepare('INSERT INTO calendar_events (id, calendar_id, title, start_at, end_at, all_day, location, notes, recurrence, until_day, created_by, updated_at, ical_uid) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?)')
      .run(crypto.randomUUID(), calendarId, r.title, start, start + 86_400_000, '', r.notes, 'none', Date.now(), uid);
  }
  return userIds.length;
}

export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
