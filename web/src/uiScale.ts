// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Interface size, per device (a phone and a desktop want different sizes, so it lives in this
// browser's storage, not in the account's preferences). The whole UI is scaled with CSS zoom;
// styles.css divides its viewport-sized lengths by --ui-zoom so nothing overflows.

import { androidInfo } from './android';

export type UiScale = 'auto' | number;
export const UI_SCALES: { value: UiScale; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 0.9, label: 'Small (90%)' },
  { value: 1, label: 'Normal (100%)' },
  { value: 1.15, label: 'Large (115%)' },
  { value: 1.3, label: 'Larger (130%)' },
  { value: 1.5, label: 'Largest (150%)' },
];
const KEY = 'dreymail.uiScale';

export function savedUiScale(): UiScale {
  try {
    const v = localStorage.getItem(KEY);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0.75 && n <= 2 ? n : 'auto';
  } catch {
    return 'auto';
  }
}

/** Automatic: larger in the Android app (also following the phone's font size), and a bit larger on touch phones. */
export function autoUiScale(env: { android: { fontScale?: number } | null; touchPhone: boolean }): number {
  if (env.android) return Math.round(Math.min(2, Math.max(1, env.android.fontScale ?? 1) * 1.15) * 100) / 100;
  return env.touchPhone ? 1.1 : 1;
}

export function effectiveUiScale(scale: UiScale = savedUiScale()): number {
  if (scale !== 'auto') return scale;
  const touchPhone = typeof matchMedia === 'function' && matchMedia('(max-width: 860px) and (pointer: coarse)').matches;
  return autoUiScale({ android: androidInfo() as { fontScale?: number } | null, touchPhone });
}

export function applyUiScale(scale: UiScale = savedUiScale()) {
  const z = effectiveUiScale(scale);
  const root = document.documentElement;
  root.style.setProperty('--ui-zoom', String(z));
  root.style.zoom = z === 1 ? '' : String(z);
}

export function saveUiScale(scale: UiScale) {
  try {
    if (scale === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(scale));
  } catch {
    /* private mode: applies for this visit only */
  }
  applyUiScale(scale);
}
