// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Passkeys: sign in with a fingerprint, face, device PIN or security key. Added and removed in
// Settings → Profile; used from the sign-in page.

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '../api';
import { Fingerprint, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsed: string | null;
}

const call = <T,>(method: string, url: string, body?: unknown) => fetchJson<T>(method, url, body);

/** Passkeys need a secure page (https or localhost) and a browser that supports them. */
export const passkeysAvailable = () => typeof window !== 'undefined' && window.isSecureContext && browserSupportsWebAuthn();

/** Sign in with a passkey (from the sign-in page). */
export async function signInWithPasskey(): Promise<void> {
  const { attempt, options } = await call<{ attempt: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('POST', '/auth/passkey/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  await call('POST', '/auth/passkey/verify', { attempt, response });
}

export function Passkeys() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['passkeys'], queryFn: () => call<PasskeyView[]>('GET', '/api/passkeys') });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = passkeysAvailable();

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await call<Parameters<typeof startRegistration>[0]['optionsJSON']>('POST', '/api/passkeys/options', {});
      const response = await startRegistration({ optionsJSON: options });
      qc.setQueryData(['passkeys'], await call<PasskeyView[]>('POST', '/api/passkeys', { response, name }));
      setName('');
    } catch (err) {
      const e = err as Error;
      setError(e.name === 'NotAllowedError' ? 'Cancelled.' : e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="label">Passkeys</label>
      <div className="hint">Sign in with your fingerprint, face, device PIN or a security key instead of typing a password. Add one on each device you use.</div>
      {list.data && list.data.length > 0 && (
        <ul className="blocked-list">
          {list.data.map((p) => (
            <li key={p.id}>
              <Fingerprint size={15} />
              <span className="grow">
                {p.name} <span className="muted">· added {new Date(p.createdAt).toLocaleDateString()}{p.lastUsed ? ` · last used ${new Date(p.lastUsed).toLocaleDateString()}` : ''}</span>
              </span>
              <button
                className="icon-btn danger-text"
                title="Remove passkey"
                onClick={() => window.confirm(`Remove "${p.name}"? You can't sign in with it anymore.`) && void call<PasskeyView[]>('DELETE', `/api/passkeys/${encodeURIComponent(p.id)}`).then((l) => qc.setQueryData(['passkeys'], l), (e: Error) => setError(e.message))}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {available ? (
        <form
          className="row-buttons"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="input grow" value={name} maxLength={60} placeholder="Name, e.g. My phone" onChange={(e) => setName(e.target.value)} />
          <button className="btn" disabled={busy}>
            <Plus size={15} /> Add passkey
          </button>
        </form>
      ) : (
        <div className="hint">Passkeys need DreyMail to be opened over https (or on localhost) in a browser that supports them.</div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
