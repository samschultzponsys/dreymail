// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The server's version next to the version of what the user runs (the web page as loaded, or the
// desktop / Android app), and what to do when they differ.

/** [major, minor] of "9.0", "v9.0" or "9.0.0"; null if it isn't a version. */
function parts(v: string | null | undefined): [number, number] | null {
  const m = /^v?(\d+)\.(\d+)/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** -1, 0 or 1; 0 also when either isn't a version (nothing to warn about then). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return 0;
  return x[0] !== y[0] ? Math.sign(x[0] - y[0]) : Math.sign(x[1] - y[1]);
}

/** "9.0.0" → "9.0". */
export function shortVersion(v: string): string {
  const p = parts(v);
  return p ? `${p[0]}.${p[1]}` : v;
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
