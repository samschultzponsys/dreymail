// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EventOccurrence } from '../../shared/calendar.js';
import { Reminders, whenText } from '../src/calendar/reminders.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const T0 = Date.parse('2026-11-20T08:00:00Z');

function setup() {
  const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
  const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
  store.db.prepare('INSERT INTO calendars (id, owner_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').run('cal', user.id, 'Work', '#22d3ee', 1);
  let now = T0;
  let items: (EventOccurrence & { color: string })[] = [];
  let failed = new Set<string>();
  const pushed: { title: string; body: string }[] = [];
  const emitted: string[] = [];
  const r = new Reminders({
    store,
    calendars: { upcoming: async () => ({ items, failed }) } as never,
    push: async (_u, p) => (pushed.push(p), 1),
    emit: (_u, e) => void emitted.push(e.type),
    now: () => now,
  });
  const occ = (id: string, start: string, reminder: number | null, over: Partial<EventOccurrence> = {}) => ({
    id,
    calendarId: 'cal',
    title: id,
    start,
    end: new Date(Date.parse(start) + 3_600_000).toISOString(),
    occurrenceStart: start,
    occurrenceEnd: new Date(Date.parse(start) + 3_600_000).toISOString(),
    allDay: false,
    location: '',
    notes: '',
    recurrence: 'none' as const,
    until: null,
    reminder,
    color: '#22d3ee',
    ...over,
  });
  return {
    r,
    user,
    pushed,
    emitted,
    occ,
    set: (list: typeof items, f: string[] = []) => ((items = list), (failed = new Set(f))),
    at: (iso: string) => (now = Date.parse(iso)),
  };
}

describe('event reminders', () => {
  it('notifies every device when the time comes, and shows the reminder until dismissed', async () => {
    const t = setup();
    t.set([t.occ('Standup', '2026-11-20T09:00:00.000Z', 15, { location: 'Room 4', joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' }), t.occ('Quiet', '2026-11-20T09:00:00.000Z', null)]);
    await t.r.tick();
    expect(t.pushed).toEqual([]);
    expect(t.r.active(t.user.id)).toEqual([]);

    t.at('2026-11-20T08:45:00Z');
    await t.r.fireDue();
    expect(t.pushed).toEqual([expect.objectContaining({ title: 'Standup', body: 'In 15 minutes · Room 4', url: '/calendar' })]);
    expect(t.emitted).toContain('reminder');
    const [a] = t.r.active(t.user.id);
    expect(a).toMatchObject({ title: 'Standup', joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' });
    // Once only.
    await t.r.fireDue();
    expect(t.pushed).toHaveLength(1);

    // Snoozed for 5 minutes: gone from the window, back (and notified again) after.
    t.r.snooze(t.user.id, [a!.key], 5);
    expect(t.r.active(t.user.id)).toEqual([]);
    t.at('2026-11-20T08:50:00Z');
    await t.r.fireDue();
    expect(t.pushed).toHaveLength(2);
    expect(t.pushed[1]!.body).toBe('In 10 minutes · Room 4');
    t.r.dismiss(t.user.id, [a!.key]);
    expect(t.r.active(t.user.id)).toEqual([]);
  });

  it('follows a moved event, drops a deleted one, and keeps those of calendars it could not read', async () => {
    const t = setup();
    t.set([t.occ('A', '2026-11-20T12:00:00.000Z', 30), t.occ('B', '2026-11-20T13:00:00.000Z', 30)]);
    await t.r.scan(t.user.id);
    // A moves to 14:00 (a new occurrence key), B's calendar fails to load.
    t.set([t.occ('A', '2026-11-20T14:00:00.000Z', 30)], ['cal']);
    await t.r.scan(t.user.id);
    t.at('2026-11-20T13:45:00Z');
    await t.r.fireDue();
    // The calendar failed: both of A's are kept for now, and B is still there.
    expect(t.pushed.map((p) => p.title).sort()).toEqual(['A', 'B']);
    t.set([t.occ('A', '2026-11-20T14:00:00.000Z', 30)]);
    t.at('2026-11-20T11:00:00Z');
    await t.r.scan(t.user.id);
    expect(t.r.active(t.user.id).map((x) => x.title)).toEqual([]);
  });

  it('says when, in words', () => {
    expect(whenText(T0 + 15 * 60_000, T0, false)).toBe('In 15 minutes');
    expect(whenText(T0 + 60 * 60_000, T0, false)).toBe('In 1 hour');
    expect(whenText(T0, T0, false)).toBe('Now');
    expect(whenText(T0 - 5 * 60_000, T0, false)).toBe('Started 5 minutes ago');
    expect(whenText(T0 + 16 * 3_600_000, T0, true)).toBe('Tomorrow (all day)');
  });
});
