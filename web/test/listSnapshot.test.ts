// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListResponse } from '../../shared/types';

/** Showing the list kept from last time at once (Settings → This device, DreyMail 14.5). */

const page = (subject: string) => ({ messages: [{ subject }], related: [], cursor: null, errors: [{ accountId: 'a', folder: 'INBOX', error: 'x' }], reset: false }) as unknown as ListResponse;
const KEY = ['messages', null, '', '', false, ''] as const;

describe('the mail list kept on this device', () => {
  beforeEach(() => {
    vi.resetModules();
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      get length() {
        return m.size;
      },
      key: (i: number) => [...m.keys()][i] ?? null,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps nothing unless switched on', async () => {
    const s = await import('../src/listSnapshot');
    s.setSnapshotUser('u1');
    s.saveSnapshot(KEY, page('Hello'));
    expect(localStorage.getItem(s.SNAPSHOT_KEY)).toBeNull();
    expect(s.snapshotFor(KEY)).toBeUndefined();
  });

  it('shows it only to the same person, for the same view, while recent', async () => {
    const s = await import('../src/listSnapshot');
    s.setInstantList(true);
    s.setSnapshotUser('u1');
    s.saveSnapshot(KEY, page('Hello'));
    expect(s.snapshotFor(KEY)?.messages.map((m) => m.subject)).toEqual(['Hello']);
    // Errors of that moment aren't shown again.
    expect(s.snapshotFor(KEY)?.errors).toEqual([]);
    expect(s.snapshotFor(['messages', 'acc1', 'INBOX', '', false, ''])).toBeUndefined();
    s.setSnapshotUser('u2');
    expect(s.snapshotFor(KEY)).toBeUndefined();
    s.setSnapshotUser(null);
    expect(s.snapshotFor(KEY)).toBeUndefined();
    s.setSnapshotUser('u1');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    expect(s.snapshotFor(KEY)).toBeUndefined();
  });

  it('is gone when switched off or signing out, and never in a device backup', async () => {
    const s = await import('../src/listSnapshot');
    const { collectDeviceSettings } = await import('../src/deviceBackup');
    s.setInstantList(true);
    s.setSnapshotUser('u1');
    s.saveSnapshot(KEY, page('Hello'));
    localStorage.setItem('dreymail.boot', '{"v":1}');
    const backup = JSON.stringify(collectDeviceSettings());
    expect(backup).not.toContain('Hello');
    expect(backup).not.toContain('dreymail.boot');
    expect(backup).toContain('dreymail.instantList');
    s.clearSnapshot();
    expect(s.snapshotFor(KEY)).toBeUndefined();
    s.saveSnapshot(KEY, page('Again'));
    s.setInstantList(false);
    expect(localStorage.getItem(s.SNAPSHOT_KEY)).toBeNull();
    expect(s.instantListOn()).toBe(false);
  });
});
