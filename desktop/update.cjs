// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Update checks for the desktop app: which release is newest, how this copy was installed
// (flatpak, deb, rpm, Windows installer) and the exact steps to upgrade it. No Electron here, so
// it can be tested on its own.
'use strict';

const REPO = 'samschultzponsys/dreymail';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

/** "1.7.0" or "v1.7" → [1, 7]; null if it isn't a version. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Two-part display version: "1.7.0" → "1.7". */
function displayVersion(v) {
  const p = parseVersion(v);
  return p ? `${p[0]}.${p[1]}` : String(v);
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
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

/** What to tell the user: a sentence and, on Linux, the command that upgrades this install. */
function upgradeInstructions(kind, version, arch) {
  const file = assetName(kind, version, arch);
  switch (kind) {
    case 'flatpak':
      return {
        text: `Download ${file}, then run this command in the folder you saved it to. It replaces the installed version and keeps your settings.`,
        command: `flatpak install --user --reinstall -y ./${file}`,
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

module.exports = { RELEASES_PAGE, parseVersion, displayVersion, isNewer, detectInstall, assetName, downloadUrl, upgradeInstructions, fetchLatest };
