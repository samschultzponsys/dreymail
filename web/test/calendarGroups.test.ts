// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { CalendarView } from '../../shared/calendar';
import type { AccountView } from '../../shared/types';
import { calendarGroups } from '../src/components/EventEditor';

describe('the calendar list in the event editor (12.4)', () => {
  it('groups calendars as the calendar page does: yours, each mailbox, shared with you', () => {
    const cal = (id: string, accountId: string | null, access: CalendarView['access'] = 'owner') => ({ id, name: id, accountId, access }) as CalendarView;
    const accounts = [{ id: 'ponsys', name: 'Ponsys' }, { id: 'gmail', name: 'Sam Gmail' }] as AccountView[];
    const groups = calendarGroups([cal('Personal', null), cal('Family', 'gmail'), cal('Calendar', 'ponsys'), cal('Team', null, 'edit')], accounts);
    expect(groups.map((g) => [g.label, g.calendars.map((c) => c.id)])).toEqual([
      ['My calendars', ['Personal']],
      ['Ponsys', ['Calendar']],
      ['Sam Gmail', ['Family']],
      ['Shared with you', ['Team']],
    ]);
  });
});
