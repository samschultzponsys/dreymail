// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The version this server runs (from package.json, which the image carries), whether a newer
// image has been released (GitHub's latest release, checked at most every 6 hours), and the
// changelog (CHANGES.md, also in the image).

import fs from 'node:fs';
import path from 'node:path';

const LATEST_API = 'https://api.github.com/repos/samschultzponsys/dreymail/releases/latest';
export const RELEASES_URL = 'https://github.com/samschultzponsys/dreymail/releases';
const CHECK_EVERY_MS = 6 * 3600 * 1000;

/** "2.0.0" → "2.0". */
export function displayVersion(v: string): string {
  const m = /^v?(\d+)\.(\d+)/.exec(v.trim());
  return m ? `${m[1]}.${m[2]}` : v;
}

export function isNewer(latest: string, current: string): boolean {
  const p = (v: string) => /^v?(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const a = p(latest);
  const b = p(current);
  if (!a || !b) return false;
  return a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! > b[1]!;
}

export function serverVersion(root = process.cwd()): string {
  try {
    return displayVersion((JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version);
  } catch {
    return 'dev';
  }
}

export function readChangelog(root = process.cwd()): string {
  try {
    return fs.readFileSync(path.join(root, 'CHANGES.md'), 'utf8');
  } catch {
    return '';
  }
}

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Newest released version on GitHub, cached; null when unknown or the check is off. */
export class UpdateChecker {
  private latest: { version: string; url: string } | null = null;
  private checkedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly enabled: boolean,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
  ) {}

  async get(): Promise<{ version: string; url: string } | null> {
    if (!this.enabled) return null;
    if (Date.now() - this.checkedAt > CHECK_EVERY_MS) {
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = null;
      });
      await this.inflight;
    }
    return this.latest;
  }

  private async refresh() {
    this.checkedAt = Date.now();
    try {
      const res = await this.fetchImpl(LATEST_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'DreyMail-server' } });
      if (!res.ok) return;
      const json = (await res.json()) as { tag_name?: string; html_url?: string };
      if (json.tag_name && /^v?\d+\.\d+/.test(json.tag_name)) {
        this.latest = { version: displayVersion(json.tag_name), url: json.html_url || RELEASES_URL };
      }
    } catch {
      /* offline: try again next time */
    }
  }
}
