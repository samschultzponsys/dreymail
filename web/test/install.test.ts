// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { androidAppLink, desktopAppLink, detectPlatform, downloads, safePath } from '../src/install';

describe('install', () => {
  it('tells devices apart', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130', 0)).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) Firefox/133', 0)).toBe('linux');
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130 Mobile', 5)).toBe('android');
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 5)).toBe('ios'); // iPad
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 0)).toBe('mac');
  });

  it('links the running version’s release files', () => {
    const d = downloads('7.9');
    expect(d.windows).toBe('https://github.com/samschultzponsys/dreymail/releases/download/v7.9/DreyMail-Setup-7.9-x64.exe');
    expect(d.android).toMatch(/\/v7\.9\/DreyMail-7\.9\.apk$/);
    expect(d.flatpak).toMatch(/DreyMail-7\.9-x86_64\.flatpak$/);
  });

  it('app links only carry a path on this server', () => {
    expect(safePath('/?account=a')).toBe('/?account=a');
    expect(safePath('//evil.example')).toBe('/');
    expect(safePath('https://evil.example')).toBe('/');
    expect(desktopAppLink('/x?y=1')).toBe('dreymail://open?path=%2Fx%3Fy%3D1');
    expect(androidAppLink('/', 'https://mail.example.com/')).toBe(
      'intent://open?path=%2F#Intent;scheme=dreymail;package=io.github.samschultzponsys.dreymail;S.browser_fallback_url=https%3A%2F%2Fmail.example.com%2F;end',
    );
  });
});
