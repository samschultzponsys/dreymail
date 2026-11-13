// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const update = createRequire(import.meta.url)('../../desktop/update.cjs') as {
  isNewer(a: string, b: string): boolean;
  displayVersion(v: string): string;
  detectInstall(platform: string, execPath: string, probe: { env(n: string): string | undefined; exists(p: string): boolean; owns(t: string, p: string): boolean }): string;
  assetName(kind: string, version: string, arch: string): string | null;
  downloadUrl(release: { tag_name: string; html_url: string; assets: { name: string; browser_download_url: string }[] }, kind: string, arch: string): string;
  upgradeInstructions(kind: string, version: string, arch: string): { text: string; command: string | null };
  fetchLatest(f: typeof fetch): Promise<unknown>;
};

const probe = (over: Partial<{ env: Record<string, string>; files: string[]; dpkg: boolean; rpm: boolean }> = {}) => ({
  env: (n: string) => over.env?.[n],
  exists: (p: string) => (over.files ?? []).includes(p),
  owns: (t: string) => (t === 'dpkg' ? !!over.dpkg : !!over.rpm),
});

describe('desktop app updates', () => {
  it('compares two-part versions, including the rollover after .9', () => {
    expect(update.isNewer('v1.8', '1.7.0')).toBe(true);
    expect(update.isNewer('v2.0', '1.9.0')).toBe(true);
    expect(update.isNewer('v1.7', '1.7.0')).toBe(false);
    expect(update.isNewer('v1.6', '1.7.0')).toBe(false);
    expect(update.isNewer('nonsense', '1.7.0')).toBe(false);
    expect(update.displayVersion('1.7.0')).toBe('1.7');
  });

  it('tells flatpak, deb, rpm and Windows installs apart', () => {
    expect(update.detectInstall('linux', '/app/dreymail', probe({ env: { FLATPAK_ID: 'io.github.x' } }))).toBe('flatpak');
    expect(update.detectInstall('linux', '/app/dreymail', probe({ files: ['/.flatpak-info'] }))).toBe('flatpak');
    expect(update.detectInstall('linux', '/opt/DreyMail/dreymail', probe({ dpkg: true }))).toBe('deb');
    expect(update.detectInstall('linux', '/opt/DreyMail/dreymail', probe({ rpm: true }))).toBe('rpm');
    expect(update.detectInstall('linux', '/home/me/dreymail', probe())).toBe('unknown');
    expect(update.detectInstall('win32', 'C:\\DreyMail.exe', probe())).toBe('windows');
  });

  it('names the right file with the version in it, and gives the exact upgrade command', () => {
    expect(update.assetName('rpm', 'v1.8', 'x64')).toBe('DreyMail-1.8-x86_64.rpm');
    expect(update.assetName('deb', 'v1.8', 'x64')).toBe('DreyMail-1.8-amd64.deb');
    expect(update.assetName('flatpak', 'v1.8', 'x64')).toBe('DreyMail-1.8-x86_64.flatpak');
    expect(update.assetName('windows', 'v1.8', 'x64')).toBe('DreyMail-Setup-1.8-x64.exe');
    expect(update.upgradeInstructions('flatpak', 'v1.8', 'x64').command).toBe('flatpak install --user --reinstall -y ./DreyMail-1.8-x86_64.flatpak');
    expect(update.upgradeInstructions('deb', 'v1.8', 'x64').command).toBe('sudo apt install ./DreyMail-1.8-amd64.deb');
    expect(update.upgradeInstructions('rpm', 'v1.8', 'x64').command).toBe('sudo dnf install ./DreyMail-1.8-x86_64.rpm');
    expect(update.upgradeInstructions('windows', 'v1.8', 'x64').command).toBeNull();
  });

  it('links the matching release asset, or the release page when there is none', () => {
    const release = {
      tag_name: 'v1.8',
      html_url: 'https://github.com/samschultzponsys/dreymail/releases/tag/v1.8',
      assets: [{ name: 'DreyMail-1.8-x86_64.rpm', browser_download_url: 'https://example.test/rpm' }],
    };
    expect(update.downloadUrl(release, 'rpm', 'x64')).toBe('https://example.test/rpm');
    expect(update.downloadUrl(release, 'deb', 'x64')).toBe(release.html_url);
  });

  it('treats an unreachable GitHub as "no answer", not an error', async () => {
    expect(await update.fetchLatest((() => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).toBeNull();
    const ok = (async () => ({ ok: true, json: async () => ({ tag_name: 'v1.8', assets: [] }) })) as unknown as typeof fetch;
    expect(await update.fetchLatest(ok)).toMatchObject({ tag_name: 'v1.8' });
  });
});
