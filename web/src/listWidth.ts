// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The message list's width on tablets and PCs, dragged by its right edge and kept per device.

import { useCallback, useState } from 'react';

const KEY = 'dm-list-width';

const read = (): number | null => {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= 200 ? n : null;
  } catch {
    return null;
  }
};

/** [width in CSS px or null for the default, set (null resets)]. */
export function useListWidth(): [number | null, (w: number | null, save?: boolean) => void] {
  const [width, setWidth] = useState<number | null>(read);
  const set = useCallback((w: number | null, save = true) => {
    setWidth(w);
    if (!save) return;
    try {
      if (w === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(Math.round(w)));
    } catch {
      /* private mode: kept for this visit only */
    }
  }, []);
  return [width, set];
}
