// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The DreyMail desktop app (desktop/) loads this web app and exposes a small bridge as
// `window.dreymailDesktop`. In a normal browser it is absent and none of this does anything.

import { MAILBOX_ICONS } from '../../shared/mailboxIcons';
import { labelOn } from './accountTheme';

export interface DesktopNotification {
  title: string;
  body: string;
  tag: string;
  /** App path to open when the notification is clicked. */
  url: string;
  /** PNG data URL: the envelope in the account's colour. */
  icon: string;
}

export interface DesktopBridge {
  /** Desktop app version, e.g. "1.7". */
  version: string;
  /** How it was installed: flatpak, deb, rpm, windows, or unknown. */
  installKind: string;
  notify(n: DesktopNotification): void;
  /** Called with the app path of a clicked notification. */
  onOpen(cb: (url: string) => void): void;
  /** Checks GitHub for a newer release and shows the result (with upgrade instructions). */
  checkForUpdates(): void;
  /** Asks for a different DreyMail server address. */
  changeServer(): void;
  /** Minimizing hides the window to the tray (desktop app 6.2 and later). */
  minimizeToTray?: boolean;
  setMinimizeToTray?(on: boolean): void;
}

export function desktopBridge(): DesktopBridge | undefined {
  return (globalThis as { dreymailDesktop?: DesktopBridge }).dreymailDesktop;
}

const iconCache = new Map<string, string>();
/** Uploaded mailbox pictures as data: URLs, by picture URL (fetched ahead, so notifying stays instant). */
const pictures = new Map<string, string>();

/** Fetches a mailbox picture once and keeps it as a data: URL; null if it can't be loaded. */
export async function loadMailboxPicture(url: string): Promise<string | null> {
  const known = pictures.get(url);
  if (known) return known;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    pictures.set(url, data);
    return data;
  } catch {
    return null;
  }
}

/** The notification icon for a mailbox: its uploaded picture when that's its icon (and loaded). */
export function mailboxNotificationIcon(a: { color: string; icon: string; iconImage: string | null } | undefined, fallback: string): string {
  if (a?.icon === 'image' && a.iconImage) {
    const data = pictures.get(a.iconImage);
    if (data) return data;
    void loadMailboxPicture(a.iconImage);
  }
  return accountIcon(a?.color ?? fallback, a?.icon === 'image' ? '' : a?.icon);
}

/**
 * A 128px notification icon: the mailbox's own icon on its colour, or without one DreyMail's
 * envelope in the account colour on night navy.
 */
export function accountIcon(color: string, icon = ''): string {
  const key = `${color}|${icon}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const path = MAILBOX_ICONS[icon]?.path;
  if (path) {
    drawMailboxIcon(g, 128, color, path);
    const url = c.toDataURL('image/png');
    iconCache.set(key, url);
    return url;
  }
  g.fillStyle = '#141b34';
  g.beginPath();
  g.roundRect(0, 0, 128, 128, 28);
  g.fill();
  // Envelope
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(22, 34, 84, 60, 8);
  g.fill();
  g.strokeStyle = '#141b34';
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(28, 40);
  g.lineTo(64, 66);
  g.lineTo(100, 40);
  g.stroke();
  const url = c.toDataURL('image/png');
  iconCache.set(key, url);
  return url;
}

/** A rounded tile in the mailbox colour with its icon drawn in a readable colour on top. */
export function drawMailboxIcon(g: CanvasRenderingContext2D, size: number, color: string, path: string) {
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(0, 0, size, size, size * 0.22);
  g.fill();
  const scale = (size * 0.58) / 24;
  g.save();
  g.translate((size - 24 * scale) / 2, (size - 24 * scale) / 2);
  g.scale(scale, scale);
  g.strokeStyle = labelOn(color);
  g.lineWidth = 2;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.stroke(new Path2D(path));
  g.restore();
}
