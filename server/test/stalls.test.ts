// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { timed, watchEventLoop } from '../src/stalls.js';

const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* holding the thread, like a big synchronous query */
  }
};

describe('finding what holds the server up (26.11)', () => {
  it('logs a slow cache step by name, not its arguments, and keeps results and this', () => {
    const logs: { msg: string; extra: Record<string, unknown> }[] = [];
    class Store {
      n = 41;
      quick(secret: string) {
        return `${secret}:${this.n}`;
      }
      slow(secret: string) {
        busy(300);
        return this.quick(secret);
      }
    }
    const s = timed(new Store(), 'cache', (msg, extra) => logs.push({ msg, extra }));
    expect(s.quick('a')).toBe('a:41');
    expect(logs).toEqual([]);
    expect(s.slow('mail text')).toBe('mail text:41');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.msg).toBe('slow cache step');
    expect(logs[0]!.extra.step).toBe('cache.slow');
    expect(JSON.stringify(logs)).not.toContain('mail text');
  });

  it('logs a blocked server, with the slow step that blocked it', async () => {
    const logs: { msg: string; extra: Record<string, unknown> }[] = [];
    const log = (msg: string, extra: Record<string, unknown>) => logs.push({ msg, extra });
    const stop = watchEventLoop(log);
    const s = timed({ measure: () => busy(1600) }, 'cache', log);
    await new Promise((r) => setTimeout(r, 300));
    s.measure();
    await new Promise((r) => setTimeout(r, 400));
    stop();
    const blocked = logs.find((l) => l.msg === 'event loop blocked');
    expect(blocked).toBeDefined();
    expect(blocked!.extra.ms as number).toBeGreaterThanOrEqual(1000);
    expect(String(blocked!.extra.during)).toContain('cache.measure');
  });
});
