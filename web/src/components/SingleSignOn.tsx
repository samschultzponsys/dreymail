// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Settings → Profile → Single sign-on: connect the server's OIDC provider to this account, so
// signing in with it opens this account (with its mailboxes) instead of making a new one.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import type { SsoStatus } from '../../../shared/types';
import { fetchJson } from '../api';

export function SingleSignOn() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['sso'], queryFn: () => fetchJson<SsoStatus>('GET', '/api/sso') });
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  if (!s?.available) return null;

  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${s.label}? Signing in with it will no longer open this account. Your password and passkeys keep working.`)) return;
    try {
      await fetchJson('DELETE', '/api/sso');
      void qc.invalidateQueries({ queryKey: ['sso'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <label className="label">Single sign-on</label>
      {s.connected ? (
        <div className="sso-row">
          <KeyRound size={15} />
          <span className="grow">
            Connected: <strong>Sign in with {s.label}</strong> opens this account
            {s.connectedAt ? <span className="muted"> · since {new Date(s.connectedAt).toLocaleDateString()}</span> : null}
          </span>
          {s.canDisconnect && (
            <button className="btn" onClick={() => void disconnect()}>
              Disconnect
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="hint">
            Connect {s.label} to this account, so signing in with it opens this account with your mailboxes and settings (instead of a new, empty
            one). Your password keeps working.
          </div>
          <a className="btn" href="/auth/login?link=1" style={{ alignSelf: 'flex-start', marginTop: 6 }}>
            <KeyRound size={15} /> Connect {s.label}
          </a>
        </>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
