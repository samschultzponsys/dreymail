// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyDeviceSettings, collectDeviceSettings, deviceBackupDue, deviceId, setDeviceSchedule } from '../src/deviceBackup';

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

describe("this device's settings (12.0)", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    delete (globalThis as { DreyMailAndroid?: unknown }).DreyMailAndroid;
  });

  it('collects what the device keeps, without who it is or one-off state', () => {
    localStorage.setItem('dreymail.uiScale', '1.15');
    localStorage.setItem('navRail', '1');
    localStorage.setItem('dm-signed-out', '1');
    const id = deviceId();
    setDeviceSchedule({ every: 'daily', last: 5 });
    const s = collectDeviceSettings();
    expect(s).toMatchObject({ format: 'dreymail-device', kind: 'browser', local: { 'dreymail.uiScale': '1.15', navRail: '1' } });
    expect(Object.keys(s.local)).not.toContain('dm-signed-out');
    expect(JSON.stringify(s)).not.toContain(id);
  });

  it('restores on another device, Android notification icons included, keeping that device its own id', () => {
    const calls: string[][] = [];
    (globalThis as { DreyMailAndroid?: unknown }).DreyMailAndroid = {
      notificationIcons: () => JSON.stringify({ left: 'group', right: 'color' }),
      setNotificationIcons: (l: string, r: string) => calls.push([l, r]),
    };
    localStorage.setItem('dreymail.uiScale', '1.3');
    const saved = collectDeviceSettings();
    expect(saved.android).toEqual({ left: 'group', right: 'color' });
    expect(saved.kind).toBe('android');

    localStorage.clear();
    const newId = deviceId();
    applyDeviceSettings(JSON.parse(JSON.stringify(saved)));
    expect(localStorage.getItem('dreymail.uiScale')).toBe('1.3');
    expect(calls).toEqual([['group', 'color']]);
    expect(deviceId()).toBe(newId);
    expect(() => applyDeviceSettings({ hello: 1 })).toThrow(/not a DreyMail device settings file/);
  });

  it('saves on its schedule', () => {
    const day = 86_400_000;
    expect(deviceBackupDue({ every: 'off', last: 0 })).toBe(false);
    expect(deviceBackupDue({ every: 'daily', last: 0 })).toBe(true);
    expect(deviceBackupDue({ every: 'daily', last: 10 * day }, 10.5 * day)).toBe(false);
    expect(deviceBackupDue({ every: 'weekly', last: 10 * day }, 16 * day)).toBe(false);
    expect(deviceBackupDue({ every: 'weekly', last: 10 * day }, 17 * day)).toBe(true);
  });
});
