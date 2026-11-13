// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The only things the loaded web app can ask of the desktop app (window.dreymailDesktop).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('dreymail:info');

contextBridge.exposeInMainWorld('dreymailDesktop', {
  version: info.version,
  installKind: info.installKind,
  notify: (n) => {
    if (!n || typeof n !== 'object') return;
    const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    ipcRenderer.send('dreymail:notify', {
      title: s(n.title, 200),
      body: s(n.body, 1000),
      tag: s(n.tag, 200),
      url: s(n.url, 2000),
      icon: s(n.icon, 200000),
    });
  },
  onOpen: (cb) => {
    ipcRenderer.removeAllListeners('dreymail:open');
    ipcRenderer.on('dreymail:open', (_e, url) => cb(String(url)));
  },
  checkForUpdates: () => ipcRenderer.send('dreymail:check-updates'),
});
