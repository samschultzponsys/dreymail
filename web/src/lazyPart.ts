// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Parts of the app not needed to show your mail (Settings, Calendar, the composer…) are separate
// files (DreyMail 14.4), so starting downloads and runs less. They are fetched in the background
// once the app is idle, so opening one is still instant.

import { lazy, type ComponentType } from 'react';

const loaders: (() => Promise<unknown>)[] = [];
const RELOADED_KEY = 'dreymail.partReload';

/** A lazily loaded component, exported as `name` by the module `load` imports. */
export function lazyPart<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  loaders.push(load);
  return lazy(async () => {
    try {
      const m = await load();
      sessionStorage.removeItem(RELOADED_KEY);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each part keeps its own props (the cast below)
      return { default: m[name] as ComponentType<any> };
    } catch (err) {
      // The server has a newer version whose files are named differently: start again (once).
      if (!sessionStorage.getItem(RELOADED_KEY)) {
        sessionStorage.setItem(RELOADED_KEY, '1');
        window.location.reload();
        return new Promise<never>(() => {});
      }
      throw err;
    }
  }) as unknown as M[K];
}

/** Fetch every part in the background, one after another, when the browser has nothing else to do. */
export function preloadParts() {
  const idle = (fn: () => void) => (typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(fn, { timeout: 3000 }) : window.setTimeout(fn, 1000));
  idle(() => {
    void loaders.reduce<Promise<unknown>>((prev, load) => prev.then(() => load().catch(() => undefined)), Promise.resolve());
  });
}
