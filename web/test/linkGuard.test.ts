// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { linkAction } from '../src/linkGuard';

const app = 'https://mail.example.com';

describe('links in the app', () => {
  it('open other sites in a new window, never in place of the app', () => {
    expect(linkAction('https://ponsys.example/chat', app, false)).toBe('new-window');
    expect(linkAction('http://example.org', app, false)).toBe('new-window');
    expect(linkAction('//elsewhere.example/x', app, false)).toBe('new-window');
  });

  it("leave the app's own links and mailto/tel alone", () => {
    expect(linkAction('/settings', app, false)).toBe('app');
    expect(linkAction('https://mail.example.com/privacy.html', app, false)).toBe('app');
    expect(linkAction('mailto:support@example.com', app, false)).toBe('app');
    expect(linkAction('tel:+15048319161', app, false)).toBe('app');
  });

  it('do nothing inside text being edited (a signature, a message)', () => {
    expect(linkAction('https://ponsys.example/chat', app, true)).toBe('nothing');
  });
});
