// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// DreyMail's own events in the database: reading and writing a row (repeats, reminders, guests),
// and changing one occurrence, this-and-following or the whole series of a repeating event.

import crypto from 'node:crypto';
import { occurrences, startTimeOf, type Attendee, type CalendarEvent, type EventInput, type MonthlyBy } from '../../../shared/calendar.js';
import { DAY } from '../../../shared/rrule.js';
import type { Store } from '../db.js';

type Row = Record<string, unknown>;

const json = <T>(v: unknown, fallback: T): T => {
  try {
    const x = JSON.parse(String(v ?? '')) as T;
    return x ?? fallback;
  } catch {
    return fallback;
  }
};

/** A calendar_events row as the app sees it. */
export function eventFromRow(r: Row): CalendarEvent {
  const byDay = String(r.by_day ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
    .filter((n) => n >= 0 && n <= 6);
  const attendees = json<Attendee[]>(r.attendees, []);
  const organizer = json<{ email: string; name: string } | null>(r.organizer, null);
  return {
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
    ...(Number(r.repeat_interval ?? 1) > 1 ? { interval: Number(r.repeat_interval) } : {}),
    ...(byDay.length ? { byDay } : {}),
    ...(r.monthly_by && r.monthly_by !== 'day' ? { monthlyBy: r.monthly_by as MonthlyBy } : {}),
    ...(r.repeat_count ? { count: Number(r.repeat_count) } : {}),
    ...(json<string[]>(r.exdates, []).length ? { exdates: json<string[]>(r.exdates, []) } : {}),
    ...(r.time_zone ? { timeZone: String(r.time_zone) } : {}),
    reminder: r.reminder === null || r.reminder === undefined ? null : Number(r.reminder),
    ...(attendees.length ? { attendees, organizer } : {}),
    sendFrom: (r.send_from as string | null) ?? null,
  };
}

/** Column values for an event (the repeat, reminder and guests included). */
function columns(e: EventInput & { exdates?: string[] }, organizer: { email: string; name: string } | null) {
  const repeating = e.recurrence !== 'none';
  return {
    calendar_id: e.calendarId,
    title: e.title,
    start_at: Date.parse(e.start),
    end_at: Date.parse(e.end),
    all_day: e.allDay ? 1 : 0,
    location: e.location,
    notes: e.notes,
    recurrence: e.recurrence,
    until_day: repeating && !e.count ? e.until : null,
    repeat_interval: repeating ? Math.max(1, Math.min(999, Math.floor(e.interval ?? 1))) : 1,
    by_day: repeating && e.recurrence === 'weekly' ? [...new Set(e.byDay ?? [])].sort().join(',') : '',
    monthly_by: repeating && (e.recurrence === 'monthly' || e.recurrence === 'yearly') ? (e.monthlyBy ?? 'day') : 'day',
    repeat_count: repeating && e.count ? Math.floor(e.count) : null,
    exdates: JSON.stringify(repeating ? (e.exdates ?? []) : []),
    time_zone: e.timeZone ?? null,
    reminder: e.reminder ?? null,
    attendees: JSON.stringify(e.attendees ?? []),
    organizer: e.attendees?.length && organizer ? JSON.stringify(organizer) : null,
    send_from: e.attendees?.length ? (e.sendFrom ?? null) : null,
  };
}

export class LocalEvents {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  get(id: string): CalendarEvent | null {
    const r = this.db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as Row | undefined;
    return r ? eventFromRow(r) : null;
  }
  row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as Row | undefined;
  }

  insert(e: EventInput & { exdates?: string[] }, userId: string, organizer: { email: string; name: string } | null, icalUid: string | null = null): CalendarEvent {
    const id = crypto.randomUUID();
    const c = { id, ...columns(e, organizer), created_by: userId, updated_at: Date.now(), ical_uid: icalUid ?? (e.attendees?.length ? `${id}@dreymail` : null), sequence: 0 };
    const keys = Object.keys(c);
    this.db.prepare(`INSERT INTO calendar_events (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(Object.values(c) as (string | number | null)[]));
    return this.get(id)!;
  }

  update(id: string, e: EventInput & { exdates?: string[] }, organizer: { email: string; name: string } | null): CalendarEvent {
    const cur = this.row(id)!;
    const c = { ...columns(e, organizer), updated_at: Date.now(), sequence: Number(cur.sequence ?? 0) + 1 };
    // Guests need a UID to match updates with what they have.
    const uid = (cur.ical_uid as string | null) ?? (e.attendees?.length ? `${id}@dreymail` : null);
    this.db.prepare(`UPDATE calendar_events SET ${Object.keys(c).map((k) => `${k} = ?`).join(', ')}, ical_uid = ? WHERE id = ?`).run(...(Object.values(c) as (string | number | null)[]), uid, id);
    return this.get(id)!;
  }

  remove(id: string) {
    this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id);
  }

  /** Leaves one occurrence out of a repeating event. */
  skip(id: string, occurrenceStart: string): CalendarEvent {
    const e = this.get(id)!;
    const ex = [...new Set([...(e.exdates ?? []), new Date(occurrenceStart).toISOString()])].slice(-1000);
    this.db.prepare('UPDATE calendar_events SET exdates = ?, updated_at = ?, sequence = sequence + 1 WHERE id = ?').run(JSON.stringify(ex), Date.now(), id);
    return this.get(id)!;
  }

  /**
   * Ends a repeating event before `occurrenceStart` (for "this and following"). Returns the event
   * as it is now, or null when nothing was left (it was the first occurrence: the row is deleted)
   * and how many occurrences came before, for a COUNT-limited series.
   */
  endBefore(id: string, occurrenceStart: string): { kept: CalendarEvent | null; before: number } {
    const e = this.get(id)!;
    const at = Date.parse(occurrenceStart);
    const before = occurrences({ ...e, exdates: [] }, Date.parse(e.start), at, e.timeZone).filter((o) => Date.parse(o.occurrenceStart) < at).length;
    if (before === 0) {
      this.remove(id);
      return { kept: null, before };
    }
    if (e.count) this.db.prepare('UPDATE calendar_events SET repeat_count = ?, until_day = NULL, updated_at = ?, sequence = sequence + 1 WHERE id = ?').run(before, Date.now(), id);
    else {
      // The day before the occurrence, in the event's zone.
      const st = startTimeOf(e);
      const wall = at + (st.wall - st.ms);
      const day = new Date(wall - DAY).toISOString().slice(0, 10);
      this.db.prepare('UPDATE calendar_events SET until_day = ?, repeat_count = NULL, updated_at = ?, sequence = sequence + 1 WHERE id = ?').run(day, Date.now(), id);
    }
    return { kept: this.get(id), before };
  }

  /** The ical UID and sequence (for invitations). */
  uidOf(id: string): { uid: string; sequence: number } | null {
    const r = this.db.prepare('SELECT ical_uid, sequence FROM calendar_events WHERE id = ?').get(id) as { ical_uid: string | null; sequence: number } | undefined;
    return r?.ical_uid ? { uid: r.ical_uid, sequence: r.sequence } : null;
  }

  /** A guest answered an invitation DreyMail sent for this UID. */
  setAttendeeStatus(uid: string, email: string, status: Attendee['status']): boolean {
    let changed = false;
    for (const r of this.db.prepare('SELECT id, attendees FROM calendar_events WHERE ical_uid = ?').all(uid) as { id: string; attendees: string }[]) {
      const list = json<Attendee[]>(r.attendees, []);
      const a = list.find((x) => x.email.toLowerCase() === email.toLowerCase());
      if (!a || a.status === status) continue;
      a.status = status;
      this.db.prepare('UPDATE calendar_events SET attendees = ? WHERE id = ?').run(JSON.stringify(list), r.id);
      changed = true;
    }
    return changed;
  }
}
