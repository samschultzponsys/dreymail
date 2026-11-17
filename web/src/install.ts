// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// "Install the app": which app suits this device, where its file is for the running version, and
// links that open the installed app (dreymail://open?path=…) instead of the browser.

import { androidBridge } from './android';
import { desktopBridge } from './desktop';
import { isIosDevice } from './push';
import { REPO_URL } from './components/SourceLink';

export type InstallPlatform = 'windows' | 'linux' | 'android' | 'ios' | 'mac' | 'other';

export function detectPlatform(userAgent: string, maxTouchPoints: number): InstallPlatform {
  if (isIosDevice(userAgent, maxTouchPoints)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'mac';
  if (/Linux|X11|CrOS/i.test(userAgent)) return 'linux';
  return 'other';
}

/** Already in the desktop app, the Android app or an installed web app: nothing to install. */
export function runningAsApp(): boolean {
  if (desktopBridge() || androidBridge()) return true;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || nav.standalone === true;
}

/** Release files of a version, as the Release workflow names them. */
export function downloads(version: string) {
  const base = `${REPO_URL}/releases/download/v${version}`;
  return {
    windows: `${base}/DreyMail-Setup-${version}-x64.exe`,
    flatpak: `${base}/DreyMail-${version}-x86_64.flatpak`,
    deb: `${base}/DreyMail-${version}-amd64.deb`,
    rpm: `${base}/DreyMail-${version}-x86_64.rpm`,
    android: `${base}/DreyMail-${version}.apk`,
    all: `${REPO_URL}/releases/tag/v${version}`,
  };
}

/** Only paths on this server (never another site) go into an app link. */
export function safePath(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

/** Opens the desktop app at this page (Windows and Linux; the browser asks first). */
export const desktopAppLink = (path: string) => `dreymail://open?path=${encodeURIComponent(safePath(path))}`;

/**
 * Opens the Android app at this page if it's installed; otherwise Chrome stays on (or returns to)
 * `fallback`.
 */
export const androidAppLink = (path: string, fallback: string) =>
  `intent://open?path=${encodeURIComponent(safePath(path))}#Intent;scheme=dreymail;package=io.github.samschultzponsys.dreymail;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;

/** Chrome and Edge offer installing the web app themselves; kept so a button can ask for it. */
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
let installPrompt: InstallPrompt | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e as InstallPrompt;
  });
  window.addEventListener('appinstalled', () => (installPrompt = null));
}
export const canInstallWebApp = () => installPrompt !== null;
export async function installWebApp(): Promise<boolean> {
  const p = installPrompt;
  if (!p) return false;
  await p.prompt();
  installPrompt = null;
  return (await p.userChoice).outcome === 'accepted';
}
