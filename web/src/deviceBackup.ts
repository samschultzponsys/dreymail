// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// This device's own settings (DreyMail 12.0): what this browser, the desktop app or the Android app
// keeps for itself (interface size, layout, the Android app's notification icons, …), saved to the
// server on a schedule or by hand, and as a file, to restore on this device or another one.

import { androidBridge } from './android';
import { desktopBridge } from './desktop';
import { fetchJson } from './api';

export type DeviceKind = 'browser' | 'desktop' | 'android';

export interface DeviceSettings {
  format: 'dreymail-device';
  version: 1;
  createdAt: string;
  kind: DeviceKind;
  /** This device's own storage, minus what only means something here and now. */
  local: Record<string, string>;
  android?: { left: string; right: string };
  desktop?: { minimizeToTray: boolean };
}

export interface DeviceSchedule {
  every: 'off' | 'daily' | 'weekly';
  /** When this device last saved its settings to the server (ms). */
  last: number;
}

const ID_KEY = 'dreymail.deviceId';
const NAME_KEY = 'dreymail.deviceName';
const SCHEDULE_KEY = 'dreymail.deviceBackup';
/** Kept out of a backup: who this device is, its schedule, and one-off state (sign-in steps, a pending link). */
const SKIP = new Set([ID_KEY, NAME_KEY, SCHEDULE_KEY, 'dm-signed-out', 'dm-sso-attempt', 'dreymail.pendingMailto', 'dreymail.outlook', 'dreymail.sso']);

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function deviceKind(): DeviceKind {
  if (androidBridge()) return 'android';
  if (desktopBridge()) return 'desktop';
  return 'browser';
}

/** This device's id (made once, random). */
export function deviceId(): string {
  const s = storage();
  let id = s?.getItem(ID_KEY) ?? '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = crypto.randomUUID().replace(/-/g, '');
    s?.setItem(ID_KEY, id);
  }
  return id;
}

/** A name to tell devices apart in the list ("Android", "Chrome on Windows", or what the user typed). */
export function deviceName(): string {
  const saved = storage()?.getItem(NAME_KEY);
  if (saved) return saved;
  const ua = globalThis.navigator?.userAgent ?? '';
  const kind = deviceKind();
  if (kind === 'android') return 'Android app';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  if (kind === 'desktop') return `Desktop app${os ? ` on ${os}` : ''}`;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return os ? `${browser} on ${os}` : browser;
}

export function setDeviceName(name: string) {
  const s = storage();
  if (name.trim()) s?.setItem(NAME_KEY, name.trim().slice(0, 100));
  else s?.removeItem(NAME_KEY);
}

export function collectDeviceSettings(): DeviceSettings {
  const local: Record<string, string> = {};
  const s = storage();
  if (s)
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || SKIP.has(k)) continue;
      const v = s.getItem(k);
      if (v !== null && v.length < 200_000) local[k] = v;
    }
  const out: DeviceSettings = { format: 'dreymail-device', version: 1, createdAt: new Date().toISOString(), kind: deviceKind(), local };
  const a = androidBridge();
  if (a?.notificationIcons) {
    try {
      out.android = JSON.parse(a.notificationIcons()) as { left: string; right: string };
    } catch {
      /* older app */
    }
  }
  const d = desktopBridge() as { minimizeToTray?: boolean } | undefined;
  if (d && typeof d.minimizeToTray === 'boolean') out.desktop = { minimizeToTray: d.minimizeToTray };
  return out;
}

/** Puts saved settings in place on this device (the caller reloads the app afterwards). */
export function applyDeviceSettings(data: unknown) {
  const d = data as DeviceSettings;
  if (d?.format !== 'dreymail-device' || d.version !== 1 || typeof d.local !== 'object' || !d.local) throw new Error('This is not a DreyMail device settings file');
  const s = storage();
  if (s)
    for (const [k, v] of Object.entries(d.local)) {
      if (SKIP.has(k) || typeof v !== 'string') continue;
      try {
        s.setItem(k, v);
      } catch {
        /* storage full */
      }
    }
  const a = androidBridge();
  if (d.android && a?.setNotificationIcons) a.setNotificationIcons(String(d.android.left), String(d.android.right));
  const desk = desktopBridge() as { setMinimizeToTray?: (on: boolean) => void } | undefined;
  if (d.desktop && desk?.setMinimizeToTray) desk.setMinimizeToTray(!!d.desktop.minimizeToTray);
}

export function deviceSchedule(): DeviceSchedule {
  try {
    const v = JSON.parse(storage()?.getItem(SCHEDULE_KEY) ?? '') as DeviceSchedule;
    if (v && ['off', 'daily', 'weekly'].includes(v.every)) return { every: v.every, last: Number(v.last) || 0 };
  } catch {
    /* not set */
  }
  return { every: 'off', last: 0 };
}

export function setDeviceSchedule(v: DeviceSchedule) {
  storage()?.setItem(SCHEDULE_KEY, JSON.stringify(v));
}

/** Saves this device's settings to the server now. */
export async function saveDeviceSettings(): Promise<string> {
  const r = await fetchJson<{ savedAt: string }>('PUT', `/api/device-backups/${deviceId()}`, { name: deviceName(), kind: deviceKind(), data: collectDeviceSettings() });
  setDeviceSchedule({ ...deviceSchedule(), last: Date.now() });
  return r.savedAt;
}

/** Whether a scheduled save is due. */
export function deviceBackupDue(v: DeviceSchedule, now = Date.now()): boolean {
  if (v.every === 'off') return false;
  const every = v.every === 'daily' ? 86_400_000 : 7 * 86_400_000;
  return now - v.last >= every;
}

/** The schedule, checked while the app is open (at start and every hour). */
export function startDeviceBackups(): () => void {
  const check = () => {
    if (deviceBackupDue(deviceSchedule())) void saveDeviceSettings().catch(() => {});
  };
  const first = setTimeout(check, 30_000);
  const timer = setInterval(check, 3600_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
