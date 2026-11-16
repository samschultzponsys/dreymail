// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Widths of the folder bar and the message list on tablets and PCs, dragged by their right edges
// and kept per device (browser storage).

import { useCallback, useState } from 'react';

function usePaneWidth(key: string): [number | null, (w: number | null, save?: boolean) => void] {
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const n = Number(localStorage.getItem(key));
      return Number.isFinite(n) && n >= 120 ? n : null;
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (w: number | null, save = true) => {
      setWidth(w);
      if (!save) return;
      try {
        if (w === null) localStorage.removeItem(key);
        else localStorage.setItem(key, String(Math.round(w)));
      } catch {
        /* private mode: kept for this visit only */
      }
    },
    [key],
  );
  return [width, set];
}

/** The message list's width (null: the default). */
export const useListWidth = () => usePaneWidth('dm-list-width');
/** The folder bar's width (null: the default). */
export const useSideWidth = () => usePaneWidth('dm-side-width');
