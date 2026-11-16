// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Linux notifications straight to the desktop's notification service (org.freedesktop.Notifications)
// with the `gdbus` tool. Used by the flatpak: there Electron's own notifications only showed while
// the window was in front (KDE Plasma dropped the rest), while the same call through gdbus from
// inside the sandbox shows every time. Clicks come back through `gdbus monitor`.
'use strict';

const DEST = ['--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications'];

/** A GVariant text-format string literal. */
function gvString(s) {
  const escaped = String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // Other control characters can't appear in a GVariant text string; drop them.
    .replace(/[\u0000-\u001f\u007f]/g, '');
  return `'${escaped}'`;
}

/** The `gdbus call` arguments for one Notify. */
function notifyArgs({ appName, replacesId, iconPath, title, body, desktopEntry }) {
  const hints = [`'desktop-entry': <${gvString(desktopEntry)}>`];
  if (iconPath) hints.push(`'image-path': <${gvString(iconPath)}>`);
  return [
    'call',
    ...DEST,
    '--method',
    'org.freedesktop.Notifications.Notify',
    gvString(appName),
    `uint32 ${replacesId >>> 0}`,
    gvString(iconPath || ''),
    gvString(title),
    gvString(body),
    "['default', 'Open']",
    `{${hints.join(', ')}}`,
    'int32 -1',
  ];
}

/** The notification id from `gdbus call` output such as "(uint32 42,)". */
function parseNotifyId(out) {
  const m = /\(uint32 (\d+),?\)/.exec(String(out));
  return m ? Number(m[1]) : null;
}

/** A line of `gdbus monitor` output: a click ("default" action) or a closed notification, with its id. */
function parseMonitorLine(line) {
  const click = /org\.freedesktop\.Notifications\.ActionInvoked \(uint32 (\d+), '([^']*)'\)/.exec(line);
  if (click) return { type: 'action', id: Number(click[1]), action: click[2] };
  const closed = /org\.freedesktop\.Notifications\.NotificationClosed \(uint32 (\d+),/.exec(line);
  if (closed) return { type: 'closed', id: Number(closed[1]) };
  return null;
}

/**
 * A notifier: show({ tag, title, body, iconPath, onClick }) → Promise<boolean> (false when gdbus
 * isn't there or the call failed, so the caller can fall back). A notification with the tag of one
 * still shown replaces it.
 */
function createNotifier({ execFile, spawn, appName, desktopEntry, log = () => {} }) {
  const idByTag = new Map();
  const byId = new Map(); // id → { tag, onClick }
  let monitor = null;

  const forget = (id) => {
    const entry = byId.get(id);
    if (!entry) return;
    byId.delete(id);
    if (idByTag.get(entry.tag) === id) idByTag.delete(entry.tag);
  };

  const ensureMonitor = () => {
    if (monitor) return;
    try {
      monitor = spawn('gdbus', ['monitor', ...DEST], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      log(`gdbus monitor failed: ${err.message}`);
      return;
    }
    let buf = '';
    monitor.stdout.setEncoding('utf8');
    monitor.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const ev = parseMonitorLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!ev) continue;
        if (ev.type === 'action' && ev.action === 'default') byId.get(ev.id)?.onClick?.();
        if (ev.type === 'closed') forget(ev.id);
      }
    });
    const restart = () => {
      monitor = null;
    };
    monitor.on('exit', restart);
    monitor.on('error', restart);
  };

  const show = ({ tag, title, body, iconPath, onClick }) =>
    new Promise((resolve) => {
      ensureMonitor();
      const args = notifyArgs({ appName, replacesId: idByTag.get(tag) ?? 0, iconPath, title, body, desktopEntry });
      execFile('gdbus', args, { timeout: 5000 }, (err, stdout) => {
        const id = err ? null : parseNotifyId(stdout);
        if (id === null) {
          log(`gdbus notify failed: ${err ? err.message : String(stdout).trim()}`);
          resolve(false);
          return;
        }
        const old = idByTag.get(tag);
        if (old !== undefined && old !== id) byId.delete(old);
        idByTag.set(tag, id);
        byId.set(id, { tag, onClick });
        resolve(true);
      });
    });

  const stop = () => {
    monitor?.kill();
    monitor = null;
  };

  return { show, stop };
}

module.exports = { gvString, notifyArgs, parseNotifyId, parseMonitorLine, createNotifier };
