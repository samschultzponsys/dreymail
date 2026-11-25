// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// "Show your mail list at once when DreyMail starts" (Settings → This device, DreyMail 14.5; off
// unless chosen): the first page of the list last shown is kept on this device (subjects, senders,
// previews), shown the moment the app starts and replaced as soon as the server answers. Only for
// the same person and the same view; never in a device backup; gone when signing out or switching
// it off.

import type { ListResponse } from '../../shared/types';

const ON_KEY = 'dreymail.instantList';
export const SNAPSHOT_KEY = 'dreymail.listSnapshot';
/** Kept this long at most. */
const MAX_AGE_MS = 7 * 86_400_000;
/** Bigger pages aren't kept (local storage is small). */
const MAX_CHARS = 400_000;

let userId: string | null = null;

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function instantListOn(): boolean {
  return storage()?.getItem(ON_KEY) === '1';
}

export function setInstantList(on: boolean) {
  const s = storage();
  if (!s) return;
  if (on) s.setItem(ON_KEY, '1');
  else {
    s.removeItem(ON_KEY);
    s.removeItem(SNAPSHOT_KEY);
  }
}

/** Whose lists these are (set once signed in). */
export function setSnapshotUser(id: string | null) {
  userId = id;
}

export function clearSnapshot() {
  storage()?.removeItem(SNAPSHOT_KEY);
}

/** Keep the first page of a list just shown (when switched on). */
export function saveSnapshot(key: readonly unknown[], page: ListResponse) {
  if (!userId || !instantListOn()) return;
  try {
    const value = JSON.stringify({ user: userId, key: JSON.stringify(key), at: Date.now(), page: { ...page, errors: [] } });
    if (value.length <= MAX_CHARS) storage()?.setItem(SNAPSHOT_KEY, value);
  } catch {
    /* storage full or off: shown as before */
  }
}

/** The page kept for this view and person, if any (and not too old). */
export function snapshotFor(key: readonly unknown[]): ListResponse | undefined {
  if (!userId || !instantListOn()) return undefined;
  try {
    const saved = JSON.parse(storage()?.getItem(SNAPSHOT_KEY) ?? 'null') as { user: string; key: string; at: number; page: ListResponse } | null;
    if (!saved || saved.user !== userId || saved.key !== JSON.stringify(key) || Date.now() - saved.at > MAX_AGE_MS) return undefined;
    return saved.page;
  } catch {
    return undefined;
  }
}
