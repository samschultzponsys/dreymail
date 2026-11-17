// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Settings → Profile → Single sign-on: connect the server's OIDC provider to this account, so
// signing in with it opens this account (with its mailboxes) instead of making a new one. Connecting
// removes the account's password; disconnecting asks for a new one unless a passkey is left.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type MouseEvent, useState } from 'react';
import type { SsoStatus } from '../../../shared/types';
import { fetchJson } from '../api';

export function SingleSignOn() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['sso'], queryFn: () => fetchJson<SsoStatus>('GET', '/api/sso') });
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const s = status.data;
  if (!s?.available) return null;

  const disconnect = async () => {
    setError(null);
    if (password !== repeat) return setError('The passwords do not match');
    setBusy(true);
    try {
      await fetchJson('DELETE', '/api/sso', password ? { password } : {});
      setDisconnecting(false);
      setPassword('');
      setRepeat('');
      void qc.invalidateQueries({ queryKey: ['sso'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connect = (e: MouseEvent) => {
    if (!window.confirm(`Connect ${s.label}? Your password is removed: from then on you sign in with ${s.label} (or a passkey).`)) e.preventDefault();
  };

  return (
    <div>
      <label className="label">Single sign-on</label>
      {s.connected ? (
        <>
          <div className="sso-row">
            <KeyRound size={15} />
            <span className="grow">
              Connected: you sign in with <strong>{s.label}</strong>
              {s.connectedAt ? <span className="muted"> · since {new Date(s.connectedAt).toLocaleDateString()}</span> : null}
            </span>
            {s.canDisconnect && !disconnecting && (
              <button className="btn" onClick={() => setDisconnecting(true)}>
                Disconnect
              </button>
            )}
          </div>
          {disconnecting && (
            <form
              className="password-form"
              style={{ marginTop: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                void disconnect();
              }}
            >
              <div className="hint">
                {s.needsPassword
                  ? `Choose a password to sign in with instead of ${s.label}.`
                  : `Signing in with ${s.label} will no longer open this account. Choose a password to sign in with, or leave it empty to sign in with your passkey only.`}
              </div>
              <input className="input" type="password" autoComplete="new-password" placeholder="New password (at least 10 characters)" aria-label="New password" required={s.needsPassword} minLength={10} maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
              <input className="input" type="password" autoComplete="new-password" placeholder="Repeat new password" aria-label="Repeat new password" required={s.needsPassword || !!password} maxLength={256} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" disabled={busy}>
                  Disconnect {s.label}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDisconnecting(false);
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      ) : (
        <>
          <div className="hint">
            Connect {s.label} to this account, so signing in with it opens this account with your mailboxes and settings (instead of a new, empty
            one). This replaces your password: afterwards you sign in with {s.label} (or a passkey).
          </div>
          <a className="btn" href="/auth/login?link=1" onClick={connect} style={{ alignSelf: 'flex-start', marginTop: 6 }}>
            <KeyRound size={15} /> Connect {s.label}
          </a>
        </>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
