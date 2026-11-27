// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Update checks for the desktop app: which release is newest, how this copy was installed
// (flatpak, deb, rpm, Windows installer) and the exact steps to upgrade it. No Electron here, so
// it can be tested on its own.
'use strict';

const REPO = 'samschultzponsys/dreymail';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

/**
 * "26.11.2", "1.7.0" or "v1.7" → [26, 11, 2] / [1, 7, 0]; null if it isn't a version. Since 26.11
 * versions are YY.M.N (year, month, count from 0 each month); before, MAJOR.MINOR.
 */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** As shown and in release file names: "26.11.0" (calendar versions whole), "1.7.0" → "1.7" (before them). */
function displayVersion(v) {
  const p = parseVersion(v);
  if (!p) return String(v);
  return p[0] >= 26 ? `${p[0]}.${p[1]}.${p[2]}` : `${p[0]}.${p[1]}`;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * How this copy was installed. `probe` answers questions about the system so this stays testable:
 *   env(name), exists(path), owns(tool, path) → does `dpkg -S`/`rpm -qf` know the path.
 */
function detectInstall(platform, execPath, probe) {
  if (platform === 'win32') return 'windows';
  if (platform !== 'linux') return 'unknown';
  if (probe.env('FLATPAK_ID') || probe.exists('/.flatpak-info')) return 'flatpak';
  if (probe.owns('dpkg', execPath)) return 'deb';
  if (probe.owns('rpm', execPath)) return 'rpm';
  return 'unknown';
}

/** File name of the release asset for this install type (CI names them this way). */
function assetName(kind, version, arch) {
  const v = displayVersion(version);
  const linuxArch = arch === 'arm64' ? 'aarch64' : 'x86_64';
  switch (kind) {
    case 'flatpak':
      return `DreyMail-${v}-${linuxArch}.flatpak`;
    case 'deb':
      return `DreyMail-${v}-${arch === 'arm64' ? 'arm64' : 'amd64'}.deb`;
    case 'rpm':
      return `DreyMail-${v}-${linuxArch}.rpm`;
    case 'windows':
      return `DreyMail-Setup-${v}-${arch === 'arm64' ? 'arm64' : 'x64'}.exe`;
    default:
      return null;
  }
}

/** Download URL of that asset on the release, or the releases page. */
function downloadUrl(release, kind, arch) {
  const name = assetName(kind, release.tag_name, arch);
  const asset = name && (release.assets || []).find((a) => a.name === name);
  return asset ? asset.browser_download_url : release.html_url || RELEASES_PAGE;
}

/** The flatpak's id (desktop/electron-builder.yml appId). */
const FLATPAK_ID = 'io.github.samschultzponsys.dreymail';
/**
 * After a flatpak install the running app is still the old version: close it and start the new
 * one (in its own session, so closing the terminal doesn't close DreyMail).
 */
const FLATPAK_RESTART = ` && { flatpak kill ${FLATPAK_ID} 2>/dev/null; sleep 1; setsid -f flatpak run ${FLATPAK_ID} >/dev/null 2>&1; }`;

/** Where CI puts a release's file (the same address whether or not the release lists it yet). */
function assetUrl(version, file) {
  return `${RELEASES_PAGE}/download/v${displayVersion(version)}/${file}`;
}

/**
 * What to tell the user: a sentence and, on Linux, the command that upgrades this install.
 * `fallback` is the slower way when the command can't be used: download the file, then a command.
 */
function upgradeInstructions(kind, version, arch) {
  const file = assetName(kind, version, arch);
  switch (kind) {
    case 'flatpak':
      // One command that downloads and installs; downloading by hand is the fallback.
      return {
        text: 'Run this command in a terminal. It downloads the new version, installs it over this one (keeping your settings) and restarts DreyMail.',
        command: `curl -fL -o /tmp/${file} ${assetUrl(version, file)} && flatpak install --user --reinstall -y /tmp/${file}${FLATPAK_RESTART}`,
        fallback: {
          // Saved by the browser into the Downloads folder (wherever the desktop has it), so the
          // command works from any folder.
          text: `Or download ${file} into your Downloads folder and run:`,
          command: `flatpak install --user --reinstall -y "$(xdg-user-dir DOWNLOAD 2>/dev/null || echo ~/Downloads)/${file}"${FLATPAK_RESTART}`,
        },
      };
    case 'deb':
      return {
        text: `Download ${file}, then run this command in the folder you saved it to (Debian, Ubuntu and similar).`,
        command: `sudo apt install ./${file}`,
      };
    case 'rpm':
      return {
        text: `Download ${file}, then run this command in the folder you saved it to (Fedora; on openSUSE use zypper install).`,
        command: `sudo dnf install ./${file}`,
      };
    case 'windows':
      return {
        text: `DreyMail can download ${file} and start it for you. The installer replaces the installed version and keeps your settings.`,
        command: null,
      };
    default:
      return {
        text: 'Download the package for your system from the release page and install it over this one.',
        command: null,
      };
  }
}

/** Fetches the newest release. Resolves null when offline or GitHub doesn't answer. */
async function fetchLatest(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'DreyMail-desktop' } });
    if (!res.ok) return null;
    const json = await res.json();
    return parseVersion(json.tag_name) ? json : null;
  } catch {
    return null;
  }
}

module.exports = { RELEASES_PAGE, parseVersion, displayVersion, isNewer, detectInstall, assetName, assetUrl, downloadUrl, upgradeInstructions, fetchLatest };
