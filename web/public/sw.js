// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-15: notification icon drawn in the mailbox's colour with its icon.
// Modified by samschultzponsys, 2026-11-15: your own picture as a mailbox icon.

// DreyMail service worker: phone/desktop notifications only. It deliberately has no fetch handler
// and caches nothing, so the app stays a thin client that always talks to the server.
// The payload formats are NotificationPayload and ClearPayload in server/src/push/notify.ts.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function sameOriginPath(url) {
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* show a generic notification below */
  }
  const setBadge = async () => {
    if (typeof data.badge === 'number' && 'setAppBadge' in self.navigator) {
      await (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {});
    }
  };
  // The mail was read (or moved away) elsewhere: close its notifications (ClearPayload).
  if (data.type === 'clear') {
    const tags = new Set(Array.isArray(data.tags) ? data.tags : []);
    event.waitUntil(
      (async () => {
        for (const n of await self.registration.getNotifications()) if (tags.has(n.tag)) n.close();
        await setBadge();
      })(),
    );
    return;
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'New mail';
  event.waitUntil(
    (async () => {
      // Browsers require a visible notification for every push, so always show one.
      await self.registration.showNotification(title, {
        body: typeof data.body === 'string' ? data.body : '',
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        icon: (await mailboxPicture(data.iconImage)) || (await mailboxIcon(data.color, data.iconPath)) || '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: sameOriginPath(data.url || '/') },
      });
      await setBadge();
    })(),
  );
});

/** The mailbox's uploaded picture (a same-origin URL) as a data: URL, or null (DreyMail). */
async function mailboxPicture(url) {
  try {
    if (typeof url !== 'string' || !/^\/api\/accounts\/[\w-]+\/icon\?v=\d+$/.test(url)) return null;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok || !/^image\/(png|jpeg|webp)$/.test(res.headers.get('content-type') || '')) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${res.headers.get('content-type')};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

/**
 * The mailbox's icon on its colour, as a PNG data: URL (DreyMail), drawn like the app draws it
 * (web/src/desktop.ts). Null where the browser can't draw in a service worker, or for a mailbox
 * without an icon: the app icon is shown then.
 */
async function mailboxIcon(color, path) {
  try {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
    if (typeof path !== 'string' || path.length > 4000 || !/^[MmLlHhVvCcSsQqTtAaZz0-9 .,\-]+$/.test(path)) return null;
    if (typeof OffscreenCanvas === 'undefined' || typeof Path2D === 'undefined') return null;
    const size = 192;
    const canvas = new OffscreenCanvas(size, size);
    const g = canvas.getContext('2d');
    g.fillStyle = color;
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, size, size, size * 0.22);
    else g.rect(0, 0, size, size);
    g.fill();
    // Navy or white, whichever reads better on the colour.
    const [r, gr, b] = [1, 3, 5].map((i) => {
      const c = parseInt(color.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    const scale = (size * 0.58) / 24;
    g.translate((size - 24 * scale) / 2, (size - 24 * scale) / 2);
    g.scale(scale, scale);
    g.strokeStyle = (lum + 0.05) / (0.0118 + 0.05) >= 1.05 / (lum + 0.05) ? '#141b34' : '#ffffff';
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.stroke(new Path2D(path));
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/png;base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        // The app listens for this and navigates without a reload (see web/src/push.ts).
        existing.postMessage({ type: 'open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The push service rotated the subscription: register the new one with the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('/api/push', { credentials: 'same-origin' });
      if (!res.ok) return;
      const { publicKey } = await res.json();
      const sub =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey }));
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dreymail': '1' },
        body: JSON.stringify(sub.toJSON()),
      });
    })(),
  );
});
