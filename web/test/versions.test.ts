// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { checkVersions, compareVersions, shortVersion } from '../../shared/versions';

describe('server and client versions', () => {
  it('compares two-part versions', () => {
    expect(compareVersions('9.0', '8.9')).toBe(1);
    expect(compareVersions('8.10', '8.9')).toBe(1);
    expect(compareVersions('v9.0.0', '9.0')).toBe(0);
    expect(compareVersions('dev', '9.0')).toBe(0);
    expect(shortVersion('9.0.0')).toBe('9.0');
  });

  it('matches in a browser unless the page was loaded before a server update', () => {
    expect(checkVersions('9.0', { kind: 'web', version: '9.0' }, '9.0')).toMatchObject({ ok: true, fix: null });
    expect(checkVersions('9.0', { kind: 'web', version: '8.9' }, '8.9')).toMatchObject({ ok: false, fix: 'reload' });
  });

  it('tells which side to update in the desktop and Android apps', () => {
    expect(checkVersions('8.5', { kind: 'desktop', version: '9.0' }, '8.5')).toMatchObject({ ok: false, fix: 'update-server' });
    expect(checkVersions('9.0', { kind: 'android', version: '8.7' }, '9.0')).toMatchObject({ ok: false, fix: 'update-app' });
    expect(checkVersions('9.0', { kind: 'desktop', version: '9.0' }, '9.0').ok).toBe(true);
    expect(checkVersions('9.0', { kind: 'desktop', version: '9.0' }, '8.9').fix).toBe('reload');
  });
});
