// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// A banner when the versions don't match (DreyMail 13.8):
// - the server was updated while this page was open: Reload (and it reloads by itself when you
//   come back to it, unless you are writing a message);
// - the desktop or Android app is older than the server: Update (the app's own update);
// - the server is older than the app: a note to pull the new image (administrators).

import { useQuery } from '@tanstack/react-query';
import { RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { checkVersions } from '../../../shared/versions';
import { androidBridge, androidInfo } from '../android';
import { api } from '../api';
import { WEB_VERSION } from '../buildInfo';
import { desktopBridge } from '../desktop';

export function VersionBanner({ busy, isAdmin }: { busy: () => boolean; isAdmin: boolean }) {
  const version = useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 60_000, refetchInterval: 5 * 60_000, refetchOnWindowFocus: true });
  const server = version.data?.version;
  const desktop = desktopBridge();
  const android = androidBridge() ? androidInfo() : null;
  const client = desktop ? { kind: 'desktop' as const, version: desktop.version } : android ? { kind: 'android' as const, version: android.version } : { kind: 'web' as const, version: WEB_VERSION ?? server ?? '' };
  const check = server ? checkVersions(server, client, WEB_VERSION) : null;
  const key = check && !check.ok ? `${check.fix}:${server}:${client.version}` : '';
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('dreymail.versionBannerDismissed');
    } catch {
      return null;
    }
  });

  // A page older than the server reloads by itself when it is safe: while you aren't looking,
  // or when you come back to it, unless you are writing a message.
  useEffect(() => {
    if (check?.fix !== 'reload') return;
    const maybe = () => {
      if (!busy()) window.location.reload();
    };
    if (document.visibilityState === 'hidden') maybe();
    const onVisible = () => document.visibilityState === 'visible' && maybe();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', maybe);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', maybe);
    };
  }, [check?.fix, busy]);

  if (!check || check.ok || !key || dismissed === key) return null;
  if (check.fix === 'update-server' && !isAdmin) return null;
  const dismiss = () => {
    setDismissed(key);
    try {
      sessionStorage.setItem('dreymail.versionBannerDismissed', key);
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className={`version-banner ${check.fix}`} role="status">
      <RefreshCw size={15} />
      <span>{check.message}</span>
      {check.fix === 'reload' && (
        <button className="btn primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      )}
      {check.fix === 'update-app' && (
        <button className="btn primary" onClick={() => (desktop ?? androidBridge())?.checkForUpdates()}>
          Update the app
        </button>
      )}
      <button className="icon-btn" title="Not now" aria-label="Not now" onClick={dismiss}>
        <X size={15} />
      </button>
    </div>
  );
}
