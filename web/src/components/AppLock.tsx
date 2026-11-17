// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The app lock: after the chosen idle time the server refuses this device's requests (423) until
// the user unlocks with one of their passkeys. While locked, the app is covered by the lock screen.
// Also this device's session settings (stay signed in, lock after) in Settings → This device.

import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Lock, LogOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, request } from '../api';
import { passkeysAvailable } from './Passkeys';

export interface DeviceSession {
  trusted: boolean;
  lockAfter: number;
  locked: boolean;
  hasPasskey: boolean;
  expires?: string;
}

/** Fired by the API client when the server says this device is locked. */
export const LOCKED_EVENT = 'dreymail:locked';

const LOCK_CHOICES: [number, string][] = [
  [0, 'Never'],
  [1, 'After 1 minute'],
  [5, 'After 5 minutes'],
  [10, 'After 10 minutes'],
  [15, 'After 15 minutes'],
  [30, 'After 30 minutes'],
  [60, 'After 1 hour'],
  [240, 'After 4 hours'],
];

export const sessionApi = {
  get: () => request<DeviceSession>('GET', '/api/session'),
  save: (s: { trusted?: boolean; lockAfter?: number }) => request<DeviceSession>('PUT', '/api/session', s),
  active: () => request<{ ok: true }>('POST', '/api/session/active'),
  lock: () => request<{ locked: true }>('POST', '/api/session/lock'),
  async unlock() {
    const { options } = await request<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('POST', '/api/session/unlock/options', {});
    const response = await startAuthentication({ optionsJSON: options });
    await request('POST', '/api/session/unlock', { response });
  },
};

/**
 * Covers the app while this device is locked, and tells the server about activity (at most once a
 * minute) while an idle lock is set.
 */
export function AppLock({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ['device-session'], queryFn: sessionApi.get, enabled, retry: false, staleTime: 60_000 });
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastPing = useRef(0);

  useEffect(() => {
    const on = () => setLocked(true);
    window.addEventListener(LOCKED_EVENT, on);
    return () => window.removeEventListener(LOCKED_EVENT, on);
  }, []);
  useEffect(() => {
    if (session.data?.locked) setLocked(true);
  }, [session.data?.locked]);

  // Activity: keys, clicks, touches and scrolling keep the session awake.
  const lockAfter = session.data?.lockAfter ?? 0;
  useEffect(() => {
    if (!enabled || !lockAfter || locked) return;
    const ping = () => {
      if (Date.now() - lastPing.current < 60_000) return;
      lastPing.current = Date.now();
      void sessionApi.active().catch(() => undefined);
    };
    const events = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, ping, { passive: true });
    // Locks this window on time too (the server decides; this only asks it).
    const t = window.setInterval(() => {
      if (Date.now() - lastPing.current > lockAfter * 60_000 + 5_000) void sessionApi.get().then((s) => s.locked && setLocked(true), () => undefined);
    }, 30_000);
    return () => {
      for (const e of events) window.removeEventListener(e, ping);
      window.clearInterval(t);
    };
  }, [enabled, lockAfter, locked]);

  if (!enabled || !locked) return null;

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await sessionApi.unlock();
      setLocked(false);
      lastPing.current = Date.now();
      void qc.invalidateQueries();
    } catch (e) {
      setError((e as Error).name === 'NotAllowedError' ? 'Unlocking was canceled.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    const { redirect } = await api.logout().catch(() => ({ redirect: '/login' }));
    window.location.href = redirect || '/login';
  };

  return (
    <div className="app-lock" role="dialog" aria-modal="true" aria-label="DreyMail is locked">
      <div className="app-lock-card">
        <Lock size={34} />
        <h2>DreyMail is locked</h2>
        <p className="muted">Unlock it with one of your passkeys to carry on.</p>
        {passkeysAvailable() ? (
          <button className="btn primary" disabled={busy} onClick={() => void unlock()} autoFocus>
            <Fingerprint size={16} /> Unlock with a passkey
          </button>
        ) : (
          <div className="hint">This browser can't use passkeys here. Sign out and sign in again instead.</div>
        )}
        {error && <div className="error-text">{error}</div>}
        <button className="btn" onClick={() => void signOut()}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </div>
  );
}

/** Settings → This device: stay signed in, and the idle lock. */
export function DeviceSessionSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['device-session'], queryFn: sessionApi.get });
  const [error, setError] = useState<string | null>(null);
  if (!q.data) return null;
  const s = q.data;
  const save = (change: { trusted?: boolean; lockAfter?: number }) =>
    sessionApi.save(change).then(
      (next) => {
        qc.setQueryData(['device-session'], next);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  return (
    <div>
      <label className="label">Signing in on this device</label>
      <label className="check">
        <input type="checkbox" checked={s.trusted} onChange={(e) => void save({ trusted: e.target.checked })} /> Stay signed in on this device
      </label>
      <div className="hint">
        {s.trusted
          ? 'Signed in for as long as you use DreyMail here at least once a month (sign in again after a year).'
          : 'Otherwise a sign-in lasts 14 days. Only use this on a device that is yours.'}
      </div>
      <div className="cal-when-row" style={{ marginTop: 8 }}>
        <label className="label" htmlFor="lock-after" style={{ margin: 0, whiteSpace: 'nowrap' }}>
          Lock DreyMail
        </label>
        <select id="lock-after" className="select" value={s.lockAfter} disabled={!s.hasPasskey && !s.lockAfter} onChange={(e) => void save({ lockAfter: Number(e.target.value) })}>
          {LOCK_CHOICES.map(([v, l]) => (
            <option key={v} value={v}>
              {l} {v ? 'without use' : ''}
            </option>
          ))}
        </select>
        {s.hasPasskey && (
          <button className="btn" onClick={() => void sessionApi.lock().then(() => window.dispatchEvent(new Event(LOCKED_EVENT)), (e: Error) => setError(e.message))}>
            <Lock size={14} /> Lock now
          </button>
        )}
      </div>
      <div className="hint">{s.hasPasskey ? 'Unlocking needs one of your passkeys. The lock is kept by the server, so reloading or reopening the app doesn’t get past it.' : 'The lock is unlocked with a passkey: add one under Settings → Profile first.'}</div>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
