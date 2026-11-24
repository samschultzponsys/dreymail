// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// DreyMail desktop app: your DreyMail server in its own window, with native notifications in each
// account's colour, a tray icon that keeps it running in the background, and update checks that
// know how this copy was installed (flatpak, deb, rpm or the Windows installer).
'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, session, shell } = require('electron');
const { execFile, spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const update = require('./update.cjs');
const notify = require('./notify.cjs');
const dbus = require('./dbus.cjs');

const APP_ID = 'io.github.samschultzponsys.dreymail';
const SOURCE_URL = 'https://github.com/samschultzponsys/dreymail';
const ICON = path.join(__dirname, 'build', 'icon.png');

if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId(APP_ID);

// dreymail://open?path=/… links ("Open this page in the app" on the web) open that page of the
// configured server here. Only paths: a link can never point the app at another site.
const LINK_SCHEME = 'dreymail';
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(LINK_SCHEME);
}
/** The server path a dreymail:// link in these arguments asks for, or null. */
function linkPath(argv) {
  const link = argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${LINK_SCHEME}://`));
  if (!link) return null;
  try {
    const p = new URL(link).searchParams.get('path') || '/';
    return p.startsWith('/') && !p.startsWith('//') ? p : '/';
  } catch {
    return '/';
  }
}
function openLink(p) {
  focusWindow();
  const origin = serverOrigin();
  if (win && origin) void win.loadURL(origin + p);
}

// ---- settings (server address) ----------------------------------------------------------------

const configFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}
const serverUrl = () => readConfig().serverUrl || null;
const serverOrigin = () => {
  const u = serverUrl();
  return u ? new URL(u).origin : null;
};
const isServerPage = (url) => {
  try {
    return new URL(url).origin === serverOrigin();
  } catch {
    return false;
  }
};

// ---- how this copy was installed --------------------------------------------------------------

const installKind = update.detectInstall(process.platform, process.execPath, {
  env: (name) => process.env[name],
  exists: (p) => fs.existsSync(p),
  owns: (tool, p) => {
    const args = tool === 'dpkg' ? ['-S', p] : ['-qf', p];
    try {
      return spawnSync(tool, args, { timeout: 3000, stdio: 'ignore' }).status === 0;
    } catch {
      return false;
    }
  },
});

// ---- window -------------------------------------------------------------------------------------

let win = null;
let tray = null;
let quitting = false;
/** When the window last lost focus: clicking the tray icon takes focus away first (Windows). */
let lastBlur = 0;

/** Minimize to the tray: minimizing hides the window (and its taskbar button) until the tray brings it back. */
const minimizeToTray = () => readConfig().minimizeToTray !== false;
function setMinimizeToTray(on) {
  writeConfig({ ...readConfig(), minimizeToTray: !!on });
  refreshTrayMenu();
  Menu.setApplicationMenu(buildMenu());
}

function showSetup() {
  const icon = nativeImage.createFromPath(ICON).resize({ width: 128 }).toDataURL();
  void win.loadFile(path.join(__dirname, 'setup.html'), { query: { icon, current: serverUrl() || '' } });
}

function showServer() {
  const url = serverUrl();
  if (!url) return showSetup();
  // A loading screen at once (13.8); it stays up until the server's page arrives and replaces it.
  const icon = nativeImage.createFromPath(ICON).resize({ width: 192 }).toDataURL();
  void win
    .loadFile(path.join(__dirname, 'loading.html'))
    .then(() => win.webContents.executeJavaScript(`document.getElementById('icon').src = ${JSON.stringify(icon)}`).catch(() => {}))
    .catch(() => {})
    .finally(() => void win.loadURL(url));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    title: 'DreyMail',
    icon: ICON,
    backgroundColor: '#141517',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // A mail app in the tray must keep hearing about new mail: no slowing down while hidden.
      backgroundThrottling: false,
    },
  });

  // Only the server's own pages and the setup page load here; everything else opens in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('dreymail-setup://')) {
      e.preventDefault();
      const chosen = new URL(url).searchParams.get('url');
      if (chosen) {
        writeConfig({ ...readConfig(), serverUrl: chosen });
        showServer();
      }
      return;
    }
    // The window itself only navigates for the app and its sign-in (an OIDC provider and back);
    // links in mail open as new windows, which go to the browser (setWindowOpenHandler). The
    // bridge answers the server's own pages only, never the provider's.
    if (/^https?:/i.test(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isServerPage(url)) void win.loadURL(url);
    else openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted (e.g. a redirect)
    void dialog
      .showMessageBox(win, {
        type: 'error',
        message: `Couldn't reach ${url}`,
        detail: `${desc}. Check the address and that the server is running.`,
        buttons: ['Try again', 'Change server…'],
      })
      .then(({ response }) => (response === 0 ? showServer() : showSetup()));
  });

  // The mouse's back button (Windows) goes back too.
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') goBack();
  });
  win.on('blur', () => {
    lastBlur = Date.now();
  });
  win.on('minimize', () => {
    if (tray && minimizeToTray()) win.hide();
  });
  win.on('close', (e) => {
    // With a tray icon, closing keeps DreyMail running so notifications keep coming.
    if (tray && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  showServer();
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

function goBack() {
  const history = win?.webContents.navigationHistory;
  if (history?.canGoBack()) history.goBack();
  else if (win) showServer();
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** The tray icon flips the window: in front → to the tray; hidden, minimized or behind others → in front. */
function toggleWindow() {
  if (!win) return;
  const inFront = win.isVisible() && !win.isMinimized() && (win.isFocused() || Date.now() - lastBlur < 400);
  if (inFront) win.hide();
  else focusWindow();
}

// ---- notifications ------------------------------------------------------------------------------

const shownNotifications = new Map();

ipcMain.on('dreymail:info', (e) => {
  e.returnValue = { version: update.displayVersion(app.getVersion()), installKind, minimizeToTray: minimizeToTray() };
});

ipcMain.on('dreymail:minimize-to-tray', (e, on) => {
  if (isServerPage(e.senderFrame.url)) setMinimizeToTray(on);
});

// Flatpak: straight to the desktop's notification service. Electron's own notifications only
// showed there while the window was in front (KDE Plasma dropped the rest). First over our own
// long-lived D-Bus connection, which also hears clicks (KDE Plasma sends a click only to the
// connection that showed the notification); if that can't be had, through `gdbus` as before.
const busNotifier =
  installKind === 'flatpak' ? dbus.createBusNotifier({ appName: 'DreyMail', desktopEntry: APP_ID, log: (m) => notifyLog({ error: m }) }) : null;
const directNotifier =
  installKind === 'flatpak'
    ? notify.createNotifier({ execFile, spawn, appName: 'DreyMail', desktopEntry: APP_ID, log: (m) => notifyLog({ error: m }) })
    : null;

function notifyLog(entry) {
  // Troubleshooting: DREYMAIL_NOTIFY_LOG=/path/file records each notification (title, body, colour icon or not, how it was shown).
  if (process.env.DREYMAIL_NOTIFY_LOG) {
    try {
      fs.appendFileSync(process.env.DREYMAIL_NOTIFY_LOG, JSON.stringify(entry) + '\n');
    } catch {
      /* troubleshooting only */
    }
  }
}

/** The icon as a PNG file the desktop can read (the flatpak's own files and /tmp are invisible to it). */
function iconFile(image) {
  try {
    const png = image.toPNG();
    const dir = path.join(app.getPath('userData'), 'notification-icons');
    const file = path.join(dir, `${crypto.createHash('sha256').update(png).digest('hex').slice(0, 32)}.png`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, png);
    }
    return file;
  } catch {
    return '';
  }
}

ipcMain.on('dreymail:notify', (e, n) => {
  if (!isServerPage(e.senderFrame.url)) return;
  const colourIcon = /^data:image\/(png|jpeg);base64,/.test(n.icon);
  const icon = colourIcon ? nativeImage.createFromDataURL(n.icon) : nativeImage.createFromPath(ICON);
  const open = () => {
    focusWindow();
    win?.webContents.send('dreymail:open', n.url);
  };
  const viaElectron = () => {
    if (!Notification.isSupported()) return;
    shownNotifications.get(n.tag)?.close();
    const note = new Notification({ title: n.title || 'DreyMail', body: n.body, icon });
    note.on('click', open);
    note.on('close', () => shownNotifications.delete(n.tag));
    shownNotifications.set(n.tag, note);
    note.show();
  };
  const entry = { title: n.title, body: n.body, tag: n.tag, url: n.url, colourIcon, focused: !!win?.isFocused(), visible: !!win?.isVisible() };
  if (!directNotifier) {
    notifyLog({ ...entry, via: 'electron' });
    viaElectron();
    return;
  }
  const shown = { tag: n.tag, title: n.title || 'DreyMail', body: n.body, iconPath: iconFile(icon.isEmpty() ? nativeImage.createFromPath(ICON) : icon), onClick: open };
  void (async () => {
    if (busNotifier && (await busNotifier.show(shown))) return notifyLog({ ...entry, via: 'dbus' });
    if (await directNotifier.show(shown)) return notifyLog({ ...entry, via: 'gdbus (dbus failed)' });
    notifyLog({ ...entry, via: 'electron (dbus and gdbus failed)' });
    viaElectron();
  })();
});

ipcMain.on('dreymail:change-server', (e) => {
  if (isServerPage(e.senderFrame.url)) showSetup();
});

ipcMain.on('dreymail:check-updates', (e) => {
  if (isServerPage(e.senderFrame.url)) void checkForUpdates(true);
});

// ---- updates ------------------------------------------------------------------------------------

async function checkForUpdates(manual) {
  const latest = await update.fetchLatest();
  const current = update.displayVersion(app.getVersion());
  if (!latest) {
    if (manual) void dialog.showMessageBox(win, { type: 'warning', message: "Couldn't check for updates", detail: 'GitHub could not be reached. Try again later.' });
    return;
  }
  const version = update.displayVersion(latest.tag_name);
  if (!update.isNewer(latest.tag_name, app.getVersion())) {
    if (manual) void dialog.showMessageBox(win, { type: 'info', message: `DreyMail ${current} is up to date.`, detail: `Installed as: ${installKind}.` });
    return;
  }
  const how = update.upgradeInstructions(installKind, latest.tag_name, process.arch);
  const url = update.downloadUrl(latest, installKind, process.arch);
  const detail = [
    `You have ${current} (${installKind}).`,
    '',
    how.text,
    ...(how.command ? ['', how.command] : []),
    ...(how.fallback ? ['', how.fallback.text, '', how.fallback.command] : []),
  ].join('\n');

  if (installKind === 'windows') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: `DreyMail ${version} is available`,
      detail,
      buttons: ['Download and install', 'Release notes', 'Later'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) await installWindowsUpdate(url, update.assetName('windows', latest.tag_name, process.arch));
    if (response === 1) openExternal(latest.html_url || update.RELEASES_PAGE);
    return;
  }

  // Flatpak: one command does it all (copied), or download by hand and copy the shorter command.
  if (how.fallback) {
    const buttons = ['Copy command', 'Download instead', 'Release notes', 'Later'];
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: `DreyMail ${version} is available`,
      detail: `${detail}\n\n"Copy command" puts the first command on your clipboard; paste it into a terminal. "Download instead" opens the download and copies the second one.`,
      buttons,
      defaultId: 0,
      cancelId: 3,
    });
    if (response === 0) clipboard.writeText(how.command);
    if (response === 1) {
      clipboard.writeText(how.fallback.command);
      openExternal(url);
    }
    if (response === 2) openExternal(latest.html_url || update.RELEASES_PAGE);
    return;
  }

  const buttons = how.command ? ['Download and copy command', 'Release notes', 'Later'] : ['Open release page', 'Later'];
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    message: `DreyMail ${version} is available`,
    detail: how.command ? `${detail}\n\n"Download and copy command" opens the download and puts the command on your clipboard.` : detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (response === 0) {
    if (how.command) clipboard.writeText(how.command);
    openExternal(how.command ? url : latest.html_url || update.RELEASES_PAGE);
  } else if (response === 1 && how.command) {
    openExternal(latest.html_url || update.RELEASES_PAGE);
  }
}

async function installWindowsUpdate(url, fileName) {
  try {
    const res = await fetch(url);
    if (!res.ok || !fileName) throw new Error(`download failed (${res.status})`);
    const file = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
    quitting = true;
    app.quit();
  } catch (err) {
    void dialog.showMessageBox(win, { type: 'error', message: "Couldn't download the update", detail: `${err.message}\n\nDownload it from ${update.RELEASES_PAGE}` });
  }
}

// ---- menus and tray -----------------------------------------------------------------------------

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'DreyMail',
      submenu: [
        { label: 'Change server…', click: () => { focusWindow(); showSetup(); } },
        { label: 'Check for updates…', click: () => void checkForUpdates(true) },
        { label: 'Minimize to the tray', type: 'checkbox', checked: minimizeToTray(), click: (item) => setMinimizeToTray(item.checked) },
        { type: 'separator' },
        { role: 'reload' },
        // A way back if the window ever shows another site (e.g. a link that opened in place).
        { label: 'Back', accelerator: 'Alt+Left', click: goBack },
        { label: 'Back to DreyMail', accelerator: 'CmdOrCtrl+Shift+H', click: () => { focusWindow(); showServer(); } },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Source code', click: () => openExternal(SOURCE_URL) },
        { label: 'Release notes', click: () => openExternal(update.RELEASES_PAGE) },
        {
          label: 'About DreyMail',
          click: () =>
            void dialog.showMessageBox(win, {
              type: 'info',
              message: `DreyMail ${update.displayVersion(app.getVersion())}`,
              detail: `Installed as: ${installKind}.\n\nCopyright (C) 2026 samschultzponsys. Licensed under the GNU AGPL v3.0 only.\n\nSource code: ${SOURCE_URL}`,
            }),
        },
      ],
    },
  ]);
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }));
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip('DreyMail');
  refreshTrayMenu();
  // A click on the icon shows or hides the window. Some Linux desktops only open the menu on a
  // click, so the menu has "Show / hide DreyMail" too.
  tray.on('click', toggleWindow);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show / hide DreyMail', click: toggleWindow },
      { label: 'Back to DreyMail', click: () => { focusWindow(); showServer(); } },
      { label: 'Minimize to the tray', type: 'checkbox', checked: minimizeToTray(), click: (item) => setMinimizeToTray(item.checked) },
      { label: 'Check for updates…', click: () => void checkForUpdates(true) },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

// ---- start ----------------------------------------------------------------------------------------

app.on('second-instance', (_event, argv) => {
  focusWindow();
  const p = linkPath(argv);
  if (p) openLink(p);
});
app.on('open-url', (event, url) => {
  event.preventDefault();
  const p = linkPath([url]);
  if (p && app.isReady()) openLink(p);
});
app.on('before-quit', () => {
  quitting = true;
  directNotifier?.stop();
  busNotifier?.stop();
});
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

app.whenReady().then(() => {
  // The web app asks for nothing beyond copying to the clipboard; notifications go through the bridge.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(isServerPage(wc.getURL()) && permission === 'clipboard-sanitized-write');
  });
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  createTray();
  // Started by a dreymail:// link.
  const startPath = linkPath(process.argv);
  if (startPath && startPath !== '/' && serverOrigin()) void win.loadURL(serverOrigin() + startPath);
  // Check for a newer release on every start (quietly: only says something when there is one).
  setTimeout(() => void checkForUpdates(false), 8000);
});
