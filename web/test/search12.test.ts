// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// 12.1: where a search looks, the search at the top (contacts, tasks, calendar, settings), and
// reordering the folders pinned above the list.

import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../shared/calendar';
import type { Contact, Task } from '../../shared/people';
import { scopeOf, withScope, withoutScope } from '../../shared/search';
import { moveKey } from '../src/components/TopFolderBar';
import { matchContacts, matches, matchEvents, matchSettings, matchTasks } from '../src/globalSearch';

describe('search scope', () => {
  it('searches the whole mailbox by default, or the folder, or every mailbox', () => {
    const f = { from: 'ada' };
    expect(withScope(f, 'mailbox', 'work')).toEqual({ from: 'ada', where: 'all', accounts: ['work'] });
    expect(scopeOf(withScope(f, 'mailbox', 'work'), 'work')).toBe('mailbox');
    expect(withScope(f, 'folder', 'work')).toEqual({ from: 'ada' });
    expect(scopeOf({}, 'work')).toBe('folder');
    expect(withScope({ where: 'all', accounts: ['work'] }, 'all', 'work')).toEqual({ where: 'all' });
    expect(scopeOf({ where: 'all' }, 'work')).toBe('all');
    expect(scopeOf({ where: 'all', accounts: ['home'] }, 'work')).toBe('all');
    expect(withoutScope({ where: 'all', accounts: ['work'], from: 'x' })).toEqual({ from: 'x' });
  });
});

describe('the search at the top', () => {
  it('matches every word, ignoring case and accents', () => {
    expect(matches('jose garcia', ['José García', 'jose@example.com'])).toBe(true);
    expect(matches('jose smith', ['José García'])).toBe(false);
    expect(matches('', ['anything'])).toBe(false);
  });

  it('finds contacts, open tasks first, next events first, and settings the user has', () => {
    const contacts = [{ id: '1', name: 'Ada Lovelace', emails: ['ada@example.com'], phones: [], company: 'Analytical' } as unknown as Contact];
    expect(matchContacts('analytical', contacts)).toHaveLength(1);
    const tasks = [{ id: 'a', listId: 'l', title: 'Call printer vendor', notes: '', due: null, done: true }, { id: 'b', listId: 'l', title: 'Printer toner', notes: '', due: null, done: false }] as Task[];
    expect(matchTasks('printer', tasks).map((t) => t.id)).toEqual(['b', 'a']);
    const now = Date.parse('2026-11-22T12:00:00Z');
    const ev = (id: string, start: string) => ({ id, calendarId: 'c', title: 'Standup', start, end: start, allDay: false, location: '', notes: '', recurrence: 'none', until: null }) as CalendarEvent;
    expect(matchEvents('standup', [ev('past', '2026-11-01T09:00:00Z'), ev('later', '2026-12-01T09:00:00Z'), ev('soon', '2026-11-23T09:00:00Z')], now).map((e) => e.id)).toEqual(['soon', 'later', 'past']);
    expect(matchSettings('dark', null).map((s) => s.tab)).toContain('general');
    expect(matchSettings('backup', ['device', 'general'])).toEqual([]);
    expect(matchSettings('out of office', null)[0]?.tab).toBe('autoreplies');
  });
});

describe('folders pinned above the list', () => {
  it('drag one to a new place', () => {
    expect(moveKey(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveKey(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(moveKey(['a', 'b', 'c'], 'b', 9)).toEqual(['a', 'c', 'b']);
  });
});
