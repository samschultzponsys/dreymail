// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Per-account UI colour. While one account is open (not "All inboxes"), the whole app takes on that
// account's colour: buttons, highlights, unread dots, focus rings, and a light tint on the page and
// sidebar background. Message content is never tinted (--message-bg and --surface stay neutral).

import type { ResolvedTheme } from './hooks';

/** Brand cyan: the first account's default colour, and the app colour in "All inboxes". */
export const BRAND_CYAN = '#22d3ee';
const NAVY = '#141b34';
const WHITE = '#ffffff';

/** Page, sidebar and panel backgrounds the tints and contrast checks start from (styles.css). */
const BASE: Record<ResolvedTheme, { bg: string; sidebar: string; surface: string }> = {
  light: { bg: '#f6f6f4', sidebar: '#efefec', surface: '#ffffff' },
  dark: { bg: '#141517', sidebar: '#111214', surface: '#1b1c1f' },
};

type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');
}

/** `amount` of `a` mixed into `b` (0: all b, 1: all a). */
export function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex([0, 1, 2].map((i) => x[i]! * amount + y[i]! * (1 - amount)) as Rgb);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Label colour on a filled button of this colour: navy or white, whichever reads better. */
export function labelOn(fill: string): string {
  return contrast(fill, NAVY) >= contrast(fill, WHITE) ? NAVY : WHITE;
}

/**
 * Fill for buttons: the colour itself when a navy or white label reads well on it (4.5:1), else
 * darkened just enough for a white label (mid-tone colours like violet need this).
 */
export function buttonFill(color: string): string {
  let c = color;
  for (let step = 1; step <= 20 && contrast(c, labelOn(c)) < 4.5; step++) c = mix('#000000', color, step * 0.04);
  return c;
}

/**
 * The colour, darkened (light theme) or lightened (dark theme) just enough for text and outline
 * icons to reach 4.5:1 against the panels they sit on.
 */
export function readableAccent(color: string, theme: ResolvedTheme): string {
  const target = theme === 'light' ? '#000000' : WHITE;
  const against = [BASE[theme].surface, BASE[theme].bg];
  let c = color;
  for (let step = 1; step <= 20 && against.some((bg) => contrast(c, bg) < 4.5); step++) c = mix(target, color, step * 0.05);
  return c;
}

const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** CSS variables that recolour the app for one account. */
export function accountPalette(color: string, theme: ResolvedTheme): Record<string, string> {
  const base = BASE[theme];
  const text = readableAccent(color, theme);
  const light = theme === 'light';
  const fill = buttonFill(color);
  const label = labelOn(fill);
  return {
    '--accent': text,
    '--accent-fill': fill,
    // Hover moves away from the label colour, so the label keeps its contrast.
    '--accent-hover': label === NAVY ? mix(WHITE, fill, 0.15) : mix('#000000', fill, 0.12),
    '--accent-text': label,
    '--accent-soft': light ? mix(color, WHITE, 0.14) : rgba(color, 0.16),
    '--active': rgba(color, light ? 0.14 : 0.18),
    '--unread-dot': text,
    '--bg': mix(color, base.bg, light ? 0.05 : 0.07),
    '--bg-sidebar': mix(color, base.sidebar, light ? 0.09 : 0.1),
  };
}

export const ACCOUNT_PALETTE_VARS = Object.keys(accountPalette(BRAND_CYAN, 'light'));
