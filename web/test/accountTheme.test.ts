// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { accountPalette, BRAND_CYAN, buttonFill, contrast, labelOn, mix, readableAccent } from '../src/accountTheme';
import { newAccountInput } from '../src/accountForm';
import { ACCOUNT_COLORS } from '../src/util';

const defaults = {
  name: '', displayName: '', email: '', password: false,
  imap: { host: '', port: 993, tls: 'tls' as const, user: '' },
  smtp: { host: '', port: 465, tls: 'tls' as const, user: '' },
};
const panels = { light: ['#ffffff', '#f6f6f4'], dark: ['#1b1c1f', '#141517'] } as const;
const samples = [...ACCOUNT_COLORS, '#ffff00', '#000080', '#808080', '#ffffff', '#000000', '#00ff00'];

describe('account colours', () => {
  it('the first account gets DreyMail cyan; later ones the other presets in turn', () => {
    expect(ACCOUNT_COLORS[0]).toBe(BRAND_CYAN);
    expect(newAccountInput(0, defaults).color).toBe(BRAND_CYAN);
    expect(newAccountInput(1, defaults).color).toBe(ACCOUNT_COLORS[1]);
    expect(new Set(ACCOUNT_COLORS).size).toBe(ACCOUNT_COLORS.length);
  });

  it('accent text and unread dots stay readable (4.5:1) on every panel, for any colour, in both themes', () => {
    for (const c of samples) {
      for (const theme of ['light', 'dark'] as const) {
        const text = readableAccent(c, theme);
        for (const bg of panels[theme]) expect(contrast(text, bg), `${c} ${theme} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(accountPalette(c, theme)['--unread-dot']).toBe(text);
      }
    }
  });

  it('button labels are navy or white and always reach 4.5:1, darkening mid-tone fills just enough', () => {
    expect(labelOn(BRAND_CYAN)).toBe('#141b34');
    expect(labelOn('#000080')).toBe('#ffffff');
    expect(buttonFill(BRAND_CYAN)).toBe(BRAND_CYAN);
    for (const c of samples) {
      for (const theme of ['light', 'dark'] as const) {
        const p = accountPalette(c, theme);
        expect(contrast(p['--accent-text']!, p['--accent-fill']!), c).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p['--accent-text']!, p['--accent-hover']!), `${c} hover`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('tints the page and sidebar only lightly, and leaves message and panel backgrounds alone', () => {
    const p = accountPalette('#ef4444', 'light');
    expect(contrast(p['--bg']!, '#f6f6f4')).toBeLessThan(1.15);
    expect(p['--bg']).not.toBe('#f6f6f4');
    for (const name of ['--message-bg', '--surface', '--text', '--link']) expect(p).not.toHaveProperty(name);
  });

  it('mixes colours', () => {
    expect(mix('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(mix('#22d3ee', '#22d3ee', 0.3)).toBe('#22d3ee');
  });
});
