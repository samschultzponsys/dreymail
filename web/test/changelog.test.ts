// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';
import { renderChangelog } from '../src/components/ChangelogDialog';
import { userLabel } from '../src/App';

describe('changelog and name', () => {
  it('renders release entries as headings and bullets, never raw HTML', () => {
    const md = '# Changes\n\nintro\n\n## 2026-11-14 (v2.1): thing\n\n- **Bold** and `code` and [link](https://example.com)\n  continued\n- <script>alert(1)</script>\n';
    const html = renderToStaticMarkup(createElement(Fragment, null, ...renderChangelog(md)));
    expect(html).not.toContain('intro');
    expect(html).toContain('<h3>2026-11-14 (v2.1): thing</h3>');
    expect(html).toContain('<strong>Bold</strong> and <code>code</code> and <a href="https://example.com"');
    expect(html).toContain('continued');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows the first name unless the full name is asked for', () => {
    const me = { name: 'sam', displayName: 'Sam Schultz', email: 'sam@example.com' };
    expect(userLabel(me)).toBe('Sam');
    expect(userLabel(me, true)).toBe('Sam Schultz');
    expect(userLabel({ name: 'sam', displayName: '', email: '' })).toBe('Sam');
  });
});
