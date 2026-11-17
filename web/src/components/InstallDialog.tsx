// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// "Install the app": the right download and steps for this device (Windows, Linux, Android, iPhone
// and iPad, Mac), the others one click away, and "Open in the app" for those who have it.

import { Check, Copy, Download, ExternalLink, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { androidAppLink, canInstallWebApp, desktopAppLink, detectPlatform, downloads, installWebApp, type InstallPlatform } from '../install';

const NAMES: Record<InstallPlatform, string> = {
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
  ios: 'iPhone and iPad',
  mac: 'Mac',
  other: 'This browser',
};

function Steps({ children }: { children: ReactNode }) {
  return <ol className="install-steps">{children}</ol>;
}

export function InstallDialog({ version, onClose }: { version: string; onClose: () => void }) {
  const here = detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  const [platform, setPlatform] = useState<InstallPlatform>(here);
  const [copied, setCopied] = useState(false);
  const [webApp, setWebApp] = useState(canInstallWebApp());
  const files = downloads(version);
  const server = window.location.origin;
  const path = window.location.pathname + window.location.search;

  const serverStep = (
    <li>
      When it asks for your DreyMail server, enter{' '}
      <span className="install-server">
        <code>{server}</code>
        <button
          className="icon-btn small"
          title="Copy"
          onClick={() => void navigator.clipboard?.writeText(server).then(() => (setCopied(true), window.setTimeout(() => setCopied(false), 1500)))}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </span>{' '}
      and sign in as usual.
    </li>
  );
  const webAppButton = webApp && (
    <button className="btn" onClick={() => void installWebApp().then(() => setWebApp(false))}>
      <Download size={15} /> Install as a web app
    </button>
  );

  const body: Record<InstallPlatform, ReactNode> = {
    windows: (
      <>
        <a className="btn primary" href={files.windows}>
          <Download size={15} /> Download for Windows (.exe)
        </a>
        <Steps>
          <li>Open the downloaded <code>DreyMail-Setup-{version}-x64.exe</code>.</li>
          <li>
            If Windows says it protected your PC, choose <strong>More info → Run anyway</strong> (the installer isn't signed by a paid certificate).
          </li>
          <li>Follow the installer; DreyMail starts afterwards and lives in the tray.</li>
          {serverStep}
        </Steps>
      </>
    ),
    linux: (
      <>
        <div className="install-choices">
          <a className="btn primary" href={files.flatpak}>
            <Download size={15} /> Flatpak (any distribution)
          </a>
          <a className="btn" href={files.deb}>
            <Download size={15} /> .deb (Debian, Ubuntu, Mint)
          </a>
          <a className="btn" href={files.rpm}>
            <Download size={15} /> .rpm (Fedora, openSUSE)
          </a>
        </div>
        <Steps>
          <li>
            Install the file you downloaded, in a terminal in the download folder:
            <pre>
              {`# Flatpak (adds Flathub for the runtime if needed)
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user ./DreyMail-${version}-x86_64.flatpak

# .deb
sudo apt install ./DreyMail-${version}-amd64.deb

# .rpm
sudo dnf install ./DreyMail-${version}-x86_64.rpm`}
            </pre>
            Or open the file with your software center.
          </li>
          <li>Start DreyMail from your applications menu.</li>
          {serverStep}
        </Steps>
      </>
    ),
    android: (
      <>
        <a className="btn primary" href={files.android}>
          <Download size={15} /> Download for Android (.apk)
        </a>
        <Steps>
          <li>Open the downloaded <code>DreyMail-{version}.apk</code> (from the notification or your Downloads).</li>
          <li>
            If Android asks, allow your browser to <strong>install unknown apps</strong> (Settings → Apps → your browser → Install unknown apps), then go
            back and tap <strong>Install</strong>.
          </li>
          {serverStep}
          <li>Allow notifications when asked, to hear about new mail.</li>
        </Steps>
      </>
    ),
    ios: (
      <Steps>
        <li>
          Open this page in <strong>Safari</strong>.
        </li>
        <li>
          Tap <strong>Share</strong> (the square with the arrow), then <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
        </li>
        <li>Open DreyMail from your home screen. It runs like an app and can show notifications (Settings → This device).</li>
      </Steps>
    ),
    mac: (
      <>
        {webAppButton}
        <Steps>
          <li>There is no Mac app yet; DreyMail installs as a web app with its own window and icon.</li>
          <li>
            <strong>Safari:</strong> File → <strong>Add to Dock</strong>. <strong>Chrome or Edge:</strong> the install icon at the right of the address bar
            (or ⋮ → Cast, save and share → <strong>Install page as app</strong>).
          </li>
        </Steps>
      </>
    ),
    other: (
      <>
        {webAppButton}
        <Steps>
          <li>
            In Chrome or Edge, use the install icon at the right of the address bar (or the menu → <strong>Install DreyMail</strong>) to give DreyMail its own
            window and icon.
          </li>
        </Steps>
      </>
    ),
  };

  const openLink = platform === 'android' ? androidAppLink(path, window.location.href) : platform === 'windows' || platform === 'linux' ? desktopAppLink(path) : null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Install the app" style={{ width: 'min(620px, 100%)' }}>
        <div className="dialog-head">
          <h2>Install DreyMail</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body install">
          <div className="segmented install-platforms">
            {(['windows', 'linux', 'android', 'ios', 'mac'] as InstallPlatform[]).map((p) => (
              <button key={p} className={platform === p ? 'on' : ''} onClick={() => setPlatform(p)}>
                {NAMES[p]}
                {p === here ? ' (this device)' : ''}
              </button>
            ))}
          </div>
          {body[platform]}
          {openLink && (
            <div className="install-open">
              <span className="muted">Already installed?</span>{' '}
              <a className="btn" href={openLink}>
                <ExternalLink size={15} /> Open this page in the app
              </a>
            </div>
          )}
          <div className="hint">
            Version {version}.{' '}
            <a href={files.all} target="_blank" rel="noreferrer noopener">
              All downloads
            </a>
            . The apps update themselves from there (they tell you when a new version is out).
          </div>
        </div>
      </div>
    </div>
  );
}
