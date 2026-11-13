// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: browser bar colour can follow the open account's tint.

import type { ResolvedTheme } from './hooks';

// The browser chrome colour per theme: the page background (--bg in styles.css), so Android's status and navigation
// bars blend into the app.
export const THEME_COLORS: Record<ResolvedTheme, string> = { light: '#f6f6f4', dark: '#141517' };

interface ThemeColorDoc {
  querySelectorAll(selector: string): Iterable<{ setAttribute(name: string, value: string): void }>;
}

// index.html picks a theme-color by prefers-color-scheme; this pins every variant to the app's resolved theme, so an
// explicit light/dark preference that differs from the phone's setting also recolours the bars.
export function applyThemeColor(doc: ThemeColorDoc, theme: ResolvedTheme, override?: string): void {
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', override ?? THEME_COLORS[theme]);
}
