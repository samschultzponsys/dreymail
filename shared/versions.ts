// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-27: three-part calendar versions YY.M.N.

// The server's version next to the version of what the user runs (the web page as loaded, or the
// desktop / Android app), and what to do when they differ.

// Versions (DreyMail 26.11): YY.M.N, the year, the month and a count from 0 each month (26.11.0,
// 26.11.1, … 26.12.0). Before that, MAJOR.MINOR (… 14.7); those compare as older, since 26 beats
// every earlier major.

/** The year from which versions are YY.M.N (shown with all three numbers). */
export const CALENDAR_FROM = 26;

/** [a, b, c] of "26.11.2", "v14.7" (c = 0) or "9.0.0"; null if it isn't a version. */
function parts(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** -1, 0 or 1; 0 also when either isn't a version (nothing to warn about then). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i]! - y[i]!);
  return 0;
}

/** As shown: "26.11.0" (calendar versions whole), "9.0.0" → "9.0" (the versions before them). */
export function shortVersion(v: string): string {
  const p = parts(v);
  if (!p) return v;
  return p[0] >= CALENDAR_FROM ? `${p[0]}.${p[1]}.${p[2]}` : `${p[0]}.${p[1]}`;
}

export type ClientKind = 'web' | 'desktop' | 'android';

export interface VersionCheck {
  /** Everything matches. */
  ok: boolean;
  /**
   * What to do: 'reload' (this page is older than the server: load the new one), 'update-app'
   * (the desktop or Android app is older than the server), 'update-server' (the app is newer than
   * the server: pull the new image), or null.
   */
  fix: 'reload' | 'update-app' | 'update-server' | null;
  /** A sentence for the tooltip. */
  message: string;
}

/**
 * Compare the server with the client. In the desktop and Android apps the client is the app; the
 * page inside it comes from the server, so only a page left open across a server update can be
 * behind (checked too).
 */
export function checkVersions(server: string, client: { kind: ClientKind; version: string }, page: string | null): VersionCheck {
  if (page && compareVersions(page, server) < 0) {
    return { ok: false, fix: 'reload', message: `The server was updated to ${server} while this page was open (${page}). Reload to use the new version.` };
  }
  if (client.kind === 'web') return { ok: true, fix: null, message: `Server and web app ${server}` };
  const app = client.kind === 'desktop' ? 'desktop app' : 'Android app';
  const c = compareVersions(client.version, server);
  if (c < 0) return { ok: false, fix: 'update-app', message: `This ${app} is ${client.version}; the server is ${server}. Update the app.` };
  if (c > 0) {
    return { ok: false, fix: 'update-server', message: `The server is still on ${server}, older than this ${app} (${client.version}). Update the server's image (pull it again and recreate the container).` };
  }
  return { ok: true, fix: null, message: `Server and ${app} ${server}` };
}
