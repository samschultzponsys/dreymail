// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { nextFreeSlot } from '../src/components/SchedulingAssistant';

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

describe('next free time (10.2)', () => {
  it('skips busy times, evenings and weekends', () => {
    const busy = [
      { start: at(18, 9), end: at(18, 10) },
      { start: at(18, 10), end: at(18, 11, 30) },
    ];
    // Wednesday Nov 18, from 9:00, an hour long: free at 11:30.
    expect(nextFreeSlot(busy, at(18, 9), 3_600_000)).toBe(at(18, 11, 30));
    // Friday evening: next is Monday morning.
    expect(nextFreeSlot([], at(20, 19, 30), 3_600_000)).toBe(at(23, 7));
  });
});
