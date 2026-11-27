// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Finding what holds the server up (DreyMail 26.11). Node runs JavaScript on one thread: while
// something synchronous runs (a big SQLite query on the mail cache, say), every request, timer
// and mail-server reply waits. These log when that happens, and which cache step it was.

type Log = (msg: string, extra: Record<string, unknown>) => void;

/** Cache steps slower than this are logged, by name. */
const SLOW_STEP_MS = 250;
/** How often the watchdog looks, and how late it must be to log a blocked server. */
const TICK_MS = 250;
const BLOCKED_MS = 1000;

/** Recent slow steps, so a blocked server can say what it was doing. */
const recent: { step: string; ms: number; at: number }[] = [];

function remember(step: string, ms: number) {
  recent.push({ step, ms, at: Date.now() });
  if (recent.length > 20) recent.shift();
}

/**
 * `target` with each method timed: a call slower than SLOW_STEP_MS is logged with its name (never
 * its arguments, which can be mail). Only synchronous time counts; promises are passed through.
 */
export function timed<T extends object>(target: T, name: string, log: Log): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return function (this: unknown, ...args: unknown[]) {
        const started = performance.now();
        try {
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        } finally {
          const ms = Math.round(performance.now() - started);
          if (ms > SLOW_STEP_MS) {
            const step = `${name}.${prop}`;
            remember(step, ms);
            log('slow cache step', { step, ms });
          }
        }
      };
    },
  });
}

/** Logs when the server was blocked for more than BLOCKED_MS, with the slow steps just before. Returns a stop function. */
export function watchEventLoop(log: Log): () => void {
  let expected = Date.now() + TICK_MS;
  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - expected;
    expected = now + TICK_MS;
    if (late < BLOCKED_MS) return;
    const during = recent.filter((r) => r.at >= now - late - TICK_MS).map((r) => `${r.step} ${r.ms} ms`);
    log('event loop blocked', { ms: late, ...(during.length ? { during: during.join(', ') } : {}) });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
