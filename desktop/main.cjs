// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// DreyMail desktop app: your DreyMail server in its own window, with native notifications in each
// account's colour, a tray icon that keeps it running in the background, and update checks that
// know how this copy was installed (flatpak, deb, rpm or the Windows installer).
'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, session, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const update = require('./update.cjs');

const APP_ID = 'io.github.samschultzponsys.dreymail';
const SOURCE_URL = 'https://github.com/samschultzponsys/dreymail';
const ICON = path.join(__dirname, 'build', 'icon.png');

if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId(APP_ID);

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

function showSetup() {
  const icon = nativeImage.createFromPath(ICON).resize({ width: 128 }).toDataURL();
  void win.loadFile(path.join(__dirname, 'setup.html'), { query: { icon, current: serverUrl() || '' } });
}

function showServer() {
  const url = serverUrl();
  if (url) void win.loadURL(url);
  else showSetup();
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

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- notifications ------------------------------------------------------------------------------

const shownNotifications = new Map();

ipcMain.on('dreymail:info', (e) => {
  e.returnValue = { version: update.displayVersion(app.getVersion()), installKind };
});

ipcMain.on('dreymail:notify', (e, n) => {
  if (!isServerPage(e.senderFrame.url)) return;
  // Troubleshooting: DREYMAIL_NOTIFY_LOG=/path/file records each notification (title, body, colour icon or not).
  if (process.env.DREYMAIL_NOTIFY_LOG) {
    fs.appendFileSync(process.env.DREYMAIL_NOTIFY_LOG, JSON.stringify({ title: n.title, body: n.body, tag: n.tag, url: n.url, colourIcon: n.icon.startsWith('data:image/png') }) + '\n');
  }
  if (!Notification.isSupported()) return;
  shownNotifications.get(n.tag)?.close();
  const icon = n.icon.startsWith('data:image/png;base64,') ? nativeImage.createFromDataURL(n.icon) : nativeImage.createFromPath(ICON);
  const note = new Notification({ title: n.title || 'DreyMail', body: n.body, icon });
  note.on('click', () => {
    focusWindow();
    win?.webContents.send('dreymail:open', n.url);
  });
  note.on('close', () => shownNotifications.delete(n.tag));
  shownNotifications.set(n.tag, note);
  note.show();
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
  const detail = [`You have ${current} (${installKind}).`, '', how.text, ...(how.command ? ['', how.command] : [])].join('\n');

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
        { type: 'separator' },
        { role: 'reload' },
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
              detail: `Installed as: ${installKind}.\n\nCopyright (C) 2026 samschultzponsys. A modified version of Ratatoskr by Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only.\n\nSource code: ${SOURCE_URL}`,
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open DreyMail', click: focusWindow },
      { label: 'Check for updates…', click: () => void checkForUpdates(true) },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', focusWindow);
}

// ---- start ----------------------------------------------------------------------------------------

app.on('second-instance', focusWindow);
app.on('before-quit', () => {
  quitting = true;
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
  // Check for a newer release on every start (quietly: only says something when there is one).
  setTimeout(() => void checkForUpdates(false), 8000);
});
