// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-19: the conversation-notifications setting.

// The DreyMail Android app (android/) loads this web app in a WebView and adds a bridge as
// `window.DreyMailAndroid`. In a browser it is absent and none of this does anything.

import { MAILBOX_ICONS } from '../../shared/mailboxIcons';
import { loadMailboxPicture } from './desktop';
import type { AccountView } from '../../shared/types';
import { api } from './api';

interface AndroidBridge {
  /** JSON: { version, installKind: "android" }. */
  info(): string;
  /**
   * Firebase client values (JSON). The app answers with a 'dreymail-android-token' event whose
   * detail is { token, p256dh, auth }: its Firebase token and the keys notifications are encrypted to.
   */
  registerPush(firebaseJson: string): void;
  /** JSON [{ id, name, color }]: one Android notification channel per account. */
  setAccounts(accountsJson: string): void;
  /** Opens Android's settings for this account's channel (sound, vibration, importance). */
  openChannelSettings(accountId: string): void;
  checkForUpdates(): void;
  /** Notifications as conversations, with the mailbox's icon on the left (app 11.4 and later). */
  conversations?(): boolean;
  setConversations?(on: boolean): void;
  /** Asks for a different DreyMail server address. */
  changeServer(): void;
}

export function androidBridge(): AndroidBridge | undefined {
  return (globalThis as { DreyMailAndroid?: AndroidBridge }).DreyMailAndroid;
}

export function androidInfo(): { version: string; installKind: string } | null {
  const b = androidBridge();
  if (!b) return null;
  try {
    return JSON.parse(b.info()) as { version: string; installKind: string };
  } catch {
    return null;
  }
}

/** Keeps the app's notification channels in step with the accounts. */
export async function syncAndroidAccounts(accounts: AccountView[]) {
  const bridge = androidBridge();
  if (!bridge) return;
  // icon: the mailbox icon's 24x24 SVG path (shared/mailboxIcons.ts); image: its uploaded picture as
  // a data: URL. The app's notifications draw them.
  const list = await Promise.all(
    accounts.map(async (a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      icon: MAILBOX_ICONS[a.icon]?.path ?? '',
      image: a.icon === 'image' && a.iconImage ? ((await loadMailboxPicture(a.iconImage)) ?? '') : '',
    })),
  );
  bridge.setAccounts(JSON.stringify(list));
}

let registering = false;

/** Registers this phone for notifications once Firebase is set up on the server. */
export async function registerAndroidPush(): Promise<void> {
  const bridge = androidBridge();
  if (!bridge || registering) return;
  registering = true;
  const { firebase } = await api.androidPush();
  if (!firebase) return;
  window.addEventListener('dreymail-android-token', (e) => {
    const d = (e as CustomEvent<{ token?: unknown; p256dh?: unknown; auth?: unknown }>).detail;
    if (d && typeof d.token === 'string' && typeof d.p256dh === 'string' && typeof d.auth === 'string') {
      void api.registerAndroidToken(d.token, { p256dh: d.p256dh, auth: d.auth });
    }
  });
  bridge.registerPush(JSON.stringify(firebase));
}
