// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: tests for two-part MAJOR.MINOR versions with rollover after .9.

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

function run(...args: string[]) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('release version', () => {
  it('reads MAJOR.MINOR from the MAJOR.MINOR.0 version in package.json', () => {
    withVersion('1.4.0');
    expect(run('current').out).toBe('1.4');
  });

  it('refuses a package.json version with a patch part or a minor above 9', () => {
    for (const v of ['1.4.1', '1.10.0', '1.4', 'next']) {
      withVersion(v);
      const r = run('current');
      expect(r.status).not.toBe(0);
      expect(r.out).toBe('');
    }
  });

  it('counts the minor part up and rolls over to the next major after .9', () => {
    withVersion('1.0.0');
    expect(run('next').out).toBe('1.1');
    expect(run('next', '1.8').out).toBe('1.9');
    expect(run('next', '1.9').out).toBe('2.0');
    expect(run('next', 'v2.9').out).toBe('3.0');
  });

  it('uses a tag verbatim, with or without the leading v', () => {
    withVersion('1.0.0');
    expect(run('tag', 'v3.2').out).toBe('3.2');
    expect(run('tag', '3.2').out).toBe('3.2');
  });

  it('rejects a tag that is not MAJOR.MINOR with MINOR 0-9', () => {
    withVersion('1.0.0');
    for (const tag of ['v1.2.3', 'v1.10', 'v1.2-rc1', 'vnext', '']) {
      const r = run('tag', tag);
      expect(r.status).not.toBe(0);
      expect(r.out).toBe('');
    }
  });
});
