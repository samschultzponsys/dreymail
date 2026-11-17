// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Event reminders, as Outlook has them: a notification on every device (desktop app, Android app,
// browsers) when an event's reminder time comes, and a reminder window in the app with Join,
// Snooze and Dismiss. The server looks ahead in each user's visible calendars (DreyMail's own,
// Google, Outlook and CalDAV) every few minutes and keeps the reminders due in calendar_alerts, so
// they come on time also while no device has DreyMail open.

import crypto from 'node:crypto';
import type { ReminderAlert } from '../../../shared/calendar.js';
import type { ServerEvent } from '../../../shared/types.js';
import type { Store } from '../db.js';
import type { NotificationPayload } from '../push/notify.js';
import type { CalendarService } from './service.js';

const MIN = 60_000;
/** How far ahead reminders are looked for (the longest reminder is a week). */
const AHEAD = 8 * 24 * 60 * MIN;
/** How often each user's calendars are read again. */
const SCAN_EVERY = 5 * MIN;
/** Reminders stay in the window until dismissed, at most this long after the event ended. */
const KEEP_AFTER_END = 12 * 60 * MIN;

interface AlertRow {
  user_id: string;
  key: string;
  event_id: string;
  calendar_id: string;
  title: string;
  start_at: number;
  end_at: number;
  all_day: number;
  location: string;
  join_url: string | null;
  color: string;
  base_fire: number;
  fire_at: number;
  notified: number;
  dismissed: number;
}

/** "In 15 minutes", "Now", "Started 5 minutes ago", "Tomorrow" … for a notification's text. */
export function whenText(start: number, now: number, allDay: boolean): string {
  const min = Math.round((start - now) / MIN);
  if (allDay) return min > 0 && min <= 24 * 60 ? 'Tomorrow (all day)' : min > 0 ? `In ${Math.round(min / 1440)} days (all day)` : 'Today (all day)';
  if (Math.abs(min) < 1) return 'Now';
  const span = (m: number) => (m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : m < 1440 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'}` : `${Math.round(m / 1440)} day${Math.round(m / 1440) === 1 ? '' : 's'}`);
  return min > 0 ? `In ${span(min)}` : `Started ${span(-min)} ago`;
}

export class Reminders {
  private timer: NodeJS.Timeout | null = null;
  private readonly scanned = new Map<string, number>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      store: Store;
      calendars: CalendarService;
      /** Web Push and the Android app. */
      push: (userId: string, payload: NotificationPayload) => Promise<number>;
      /** Open sessions (the desktop app shows a native notification; every app opens its reminder window). */
      emit: (userId: string, event: ServerEvent) => void;
      log?: (msg: string, extra?: Record<string, unknown>) => void;
      now?: () => number;
    },
  ) {}

  private get db() {
    return this.deps.store.db;
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    setTimeout(() => void this.tick(), 5_000).unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads calendars that are due for it, then sends the reminders that are due. One run at a time. */
  tick(): Promise<void> {
    if (!this.running)
      this.running = this.run()
        .catch((err: Error) => this.deps.log?.('calendar reminders failed', { error: err.message }))
        .finally(() => (this.running = null));
    return this.running;
  }

  private async run() {
    const now = this.now();
    const users = this.db.prepare('SELECT DISTINCT owner_id AS id FROM calendars UNION SELECT DISTINCT user_id AS id FROM calendar_shares').all() as { id: string }[];
    for (const { id } of users) {
      if (now - (this.scanned.get(id) ?? 0) < SCAN_EVERY) continue;
      this.scanned.set(id, now);
      await this.scan(id).catch((err: Error) => this.deps.log?.('reading calendars for reminders failed', { error: err.message }));
    }
    await this.fireDue();
    this.db.prepare('DELETE FROM calendar_alerts WHERE end_at < ?').run(now - 2 * KEEP_AFTER_END);
  }

  /** After an event is saved: look again soon for this user. */
  changed(userId: string) {
    this.scanned.delete(userId);
    setTimeout(() => void this.tick(), 2_000).unref();
  }

  /** Keeps a user's coming reminders in calendar_alerts (moved events move theirs; deleted ones go). */
  async scan(userId: string) {
    const now = this.now();
    const { items, failed } = await this.deps.calendars.upcoming(userId, now - KEEP_AFTER_END, now + AHEAD);
    const seen = new Set<string>();
    const get = this.db.prepare('SELECT * FROM calendar_alerts WHERE user_id = ? AND key = ?');
    for (const o of items) {
      if (o.reminder === null || o.reminder === undefined) continue;
      const start = Date.parse(o.occurrenceStart);
      const end = Date.parse(o.occurrenceEnd);
      const fire = start - o.reminder * MIN;
      if (end < now || fire > now + AHEAD) continue;
      const key = `${o.id}|${o.occurrenceStart}`;
      seen.add(key);
      const cur = get.get(userId, key) as AlertRow | undefined;
      const fields = [o.title.slice(0, 300), end, o.allDay ? 1 : 0, o.location.slice(0, 500), o.joinUrl ?? null, o.color] as const;
      if (!cur) {
        this.db
          .prepare('INSERT INTO calendar_alerts (user_id, key, event_id, calendar_id, title, start_at, end_at, all_day, location, join_url, color, base_fire, fire_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          // A reminder whose time passed long before it was found (an event added at the last minute) still comes once.
          .run(userId, key, o.id, o.calendarId, fields[0], start, ...fields.slice(1), fire, fire);
      } else if (cur.base_fire !== fire) {
        // The reminder was changed: it comes at its new time (a snooze is forgotten).
        this.db.prepare('UPDATE calendar_alerts SET title = ?, end_at = ?, all_day = ?, location = ?, join_url = ?, color = ?, base_fire = ?, fire_at = ?, notified = 0, dismissed = 0 WHERE user_id = ? AND key = ?').run(...fields, fire, fire, userId, key);
      } else {
        this.db.prepare('UPDATE calendar_alerts SET title = ?, end_at = ?, all_day = ?, location = ?, join_url = ?, color = ? WHERE user_id = ? AND key = ?').run(...fields, userId, key);
      }
    }
    // Events that are gone (or moved: their key has the old start) take their reminders with them,
    // unless their calendar couldn't be read just now.
    const known = this.db.prepare('SELECT key, calendar_id FROM calendar_alerts WHERE user_id = ? AND start_at > ? AND dismissed = 0').all(userId, now) as { key: string; calendar_id: string }[];
    for (const a of known) if (!seen.has(a.key) && !failed.has(a.calendar_id)) this.db.prepare('DELETE FROM calendar_alerts WHERE user_id = ? AND key = ?').run(userId, a.key);
  }

  /** Notifies every device about reminders whose time has come. */
  async fireDue() {
    const now = this.now();
    const due = this.db.prepare('SELECT * FROM calendar_alerts WHERE notified = 0 AND dismissed = 0 AND fire_at <= ?').all(now) as unknown as AlertRow[];
    for (const a of due) {
      this.db.prepare('UPDATE calendar_alerts SET notified = 1 WHERE user_id = ? AND key = ?').run(a.user_id, a.key);
      // Over before anyone heard of it (the server was down): just leave it in the window.
      if (a.end_at < now) continue;
      const body = [whenText(a.start_at, now, a.all_day === 1), a.location].filter(Boolean).join(' · ');
      const tag = `reminder:${crypto.createHash('sha256').update(a.key).digest('base64url').slice(0, 16)}`;
      this.deps.emit(a.user_id, { type: 'reminder', title: a.title, body, tag, url: '/calendar', joinUrl: a.join_url });
      await this.deps.push(a.user_id, { title: a.title, body, tag, url: '/calendar', color: a.color || '#22d3ee' }).catch(() => 0);
    }
  }

  /** The reminders showing in the reminder window. */
  active(userId: string): ReminderAlert[] {
    const now = this.now();
    const rows = this.db.prepare('SELECT * FROM calendar_alerts WHERE user_id = ? AND dismissed = 0 AND fire_at <= ? AND end_at > ? ORDER BY start_at').all(userId, now, now - KEEP_AFTER_END) as unknown as AlertRow[];
    return rows.map((a) => ({
      key: a.key,
      eventId: a.event_id,
      calendarId: a.calendar_id,
      title: a.title,
      start: new Date(a.start_at).toISOString(),
      end: new Date(a.end_at).toISOString(),
      allDay: a.all_day === 1,
      location: a.location,
      joinUrl: a.join_url,
      color: a.color,
    }));
  }

  dismiss(userId: string, keys: string[]) {
    for (const k of keys) this.db.prepare('UPDATE calendar_alerts SET dismissed = 1 WHERE user_id = ? AND key = ?').run(userId, k);
    this.deps.emit(userId, { type: 'reminders' });
  }

  /** Comes back `minutes` from now, or at the start (minutes = 'start'). */
  snooze(userId: string, keys: string[], minutes: number | 'start') {
    const now = this.now();
    for (const k of keys) {
      const a = this.db.prepare('SELECT start_at FROM calendar_alerts WHERE user_id = ? AND key = ?').get(userId, k) as { start_at: number } | undefined;
      if (!a) continue;
      const at = minutes === 'start' ? Math.max(a.start_at, now + MIN) : now + minutes * MIN;
      this.db.prepare('UPDATE calendar_alerts SET fire_at = ?, notified = 0 WHERE user_id = ? AND key = ?').run(at, userId, k);
    }
    this.deps.emit(userId, { type: 'reminders' });
  }
}
