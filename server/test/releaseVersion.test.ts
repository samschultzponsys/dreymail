// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: tests for two-part MAJOR.MINOR versions with rollover after .9.
// Modified by samschultzponsys, 2026-11-27: calendar versions YY.M.N.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** scripts/release-version.sh, which the Release workflow uses to pick the version to publish. */
const SCRIPT = fileURLToPath(new URL('../../scripts/release-version.sh', import.meta.url));

let dir: string | undefined;

/** A throwaway directory with a package.json carrying the given version. */
function withVersion(version: string) {
  dir = mkdtempSync(path.join(tmpdir(), 'dreymail-release-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
}

function run(args: string[], date?: string) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...(date ? { RELEASE_DATE: date } : {}) } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('release version (YY.M.N since 26.11)', () => {
  it('reads the YY.M.N version in package.json as it is', () => {
    withVersion('26.11.3');
    expect(run(['current']).out).toBe('26.11.3');
  });

  it('refuses a package.json version that is not YY.M.N', () => {
    for (const v of ['26.13.0', '26.0.1', '2026.11.0', '26.11', '26.11.01', '14.7', 'next']) {
      withVersion(v);
      const r = run(['current']);
      expect(r.status, v).not.toBe(0);
      expect(r.out).toBe('');
    }
  });

  it("counts up within a month and starts again at 0 in a new one", () => {
    withVersion('26.11.0');
    expect(run(['next'], '2026-11-27').out).toBe('26.11.1');
    expect(run(['next', '26.11.9'], '2026-11-30').out).toBe('26.11.10');
    expect(run(['next', '26.11.4'], '2026-12-01').out).toBe('26.12.0');
    expect(run(['next', 'v26.12.7'], '2027-01-02').out).toBe('27.1.0');
  });

  it('goes from the old MAJOR.MINOR versions to this month', () => {
    withVersion('14.7.0');
    expect(run(['next'], '2026-11-27').out).toBe('26.11.0');
    expect(run(['next', '14.7'], '2026-11-27').out).toBe('26.11.0');
  });

  it('uses a tag verbatim, with or without the leading v', () => {
    withVersion('26.11.0');
    expect(run(['tag', 'v26.11.2']).out).toBe('26.11.2');
    expect(run(['tag', '26.12.0']).out).toBe('26.12.0');
  });

  it('rejects a tag that is not YY.M.N', () => {
    withVersion('26.11.0');
    for (const tag of ['v14.7', 'v26.11', 'v26.11.2-rc1', 'vnext', '']) {
      const r = run(['tag', tag]);
      expect(r.status, tag).not.toBe(0);
      expect(r.out).toBe('');
    }
  });
});
