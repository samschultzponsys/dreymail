// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: user-visible name changed from "Ratatoskr" to "DreyMail".
// Modified by samschultzponsys, 2026-11-13: day/night DreyMail logo instead of the favicon.
// Modified by samschultzponsys, 2026-11-13: refetch everything after signing in (accounts stayed empty until a reload).
// Modified by samschultzponsys, 2026-11-15: source code link (AGPL §13) with attribution.
// Modified by samschultzponsys, 2026-11-15: passkey sign-in.
// Modified by samschultzponsys, 2026-11-15: automatic single sign-on, with /login to get to this page; source link without the credit.

import { SourceLink } from './SourceLink';
import { passkeysAvailable, signInWithPasskey } from './Passkeys';
import { Fingerprint } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';

/** Set on signing out, so automatic single sign-on doesn't sign you straight back in. */
export const SIGNED_OUT_KEY = 'dm-signed-out';
const SSO_ATTEMPT_KEY = 'dm-sso-attempt';
const session = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export function Login() {
  const qc = useQueryClient();
  // /login always shows this page (the way back in when single sign-on is automatic or broken).
  const atLogin = window.location.pathname.replace(/\/+$/, '') === '/login';
  const urlError = new URLSearchParams(window.location.search).get('error');
  const signedOut = session.get(SIGNED_OUT_KEY) === '1';
  const methods = useQuery({ queryKey: ['authMethods'], queryFn: api.authMethods, retry: false, staleTime: Infinity });
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const m = methods.data;
  const registering = mode === 'register' && !!m?.registration;
  // Automatic single sign-on: straight to the provider, unless this is /login, you just signed
  // out, it came back with an error, or it was already tried in the last minute (no loops).
  const recentTry = Date.now() - Number(session.get(SSO_ATTEMPT_KEY) ?? 0) < 60_000;
  const autoSso = !!m?.oidc?.auto && !atLogin && !signedOut && !urlError && !recentTry;
  useEffect(() => {
    if (!autoSso) return;
    session.set(SSO_ATTEMPT_KEY, String(Date.now()));
    window.location.replace('/auth/login');
  }, [autoSso]);
  const startSso = () => {
    session.set(SIGNED_OUT_KEY, null);
    session.set(SSO_ATTEMPT_KEY, String(Date.now()));
  };

  if (autoSso)
    return (
      <div className="login">
        <div className="login-card">
          <img className="brand-mark day" src="/brand-day.svg" alt="" />
          <img className="brand-mark night" src="/brand-night.svg" alt="" />
          <h1>DreyMail</h1>
          <div className="muted">Signing in with {m!.oidc!.label}…</div>
          <a className="btn ghost" href="/login">
            Other ways to sign in
          </a>
        </div>
      </div>
    );

  const submit = async () => {
    if (registering && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await (registering ? api.register(username, password) : api.passwordLogin(username, password));
      // Everything asked before signing in failed with 401: ask again now.
      session.set(SIGNED_OUT_KEY, null);
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
    setConfirm('');
  };

  return (
    <div className="login">
      <div className="login-card">
        <img className="brand-mark day" src="/brand-day.svg" alt="" />
        <img className="brand-mark night" src="/brand-night.svg" alt="" />
        <h1>DreyMail</h1>
        <div className="muted">Your mail, from any IMAP server.</div>
        {methods.isLoading && <div className="muted">Loading…</div>}
        {signedOut && !urlError && <div className="muted">You're signed out.</div>}
        {urlError && (
          <div className="error-text" role="alert">
            {urlError.slice(0, 300)}
          </div>
        )}
        {methods.error && <div className="error-text">Could not reach the server: {(methods.error as Error).message}</div>}
        {m?.password && (
          <form
            className="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              className="input"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Username"
              aria-label="Username"
              required
              maxLength={100}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className="input"
              type="password"
              name="password"
              autoComplete={registering ? 'new-password' : 'current-password'}
              placeholder="Password"
              aria-label="Password"
              required
              minLength={registering ? 10 : undefined}
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {registering && (
              <input
                className="input"
                type="password"
                name="confirm"
                autoComplete="new-password"
                placeholder="Repeat password"
                aria-label="Repeat password"
                required
                maxLength={256}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
            {registering && <div className="hint">At least 10 characters.</div>}
            {error && (
              <div className="error-text" role="alert">
                {error}
              </div>
            )}
            <button className="btn primary" type="submit" disabled={busy}>
              {registering ? 'Create account' : 'Sign in'}
            </button>
            {m.registration && (
              <button type="button" className="btn ghost" onClick={() => switchMode(registering ? 'login' : 'register')}>
                {registering ? 'I already have an account' : 'Create an account'}
              </button>
            )}
          </form>
        )}
        {m?.password && (m.oidc || m.dev) && <div className="login-divider">or</div>}
        {m?.passkeys && passkeysAvailable() && (
          <button
            className="btn"
            onClick={() =>
              void signInWithPasskey().then(
                () => void qc.invalidateQueries(),
                (e: Error) => setPasskeyError(e.name === 'NotAllowedError' ? 'Cancelled.' : e.message),
              )
            }
          >
            <Fingerprint size={16} /> Sign in with a passkey
          </button>
        )}
        {passkeyError && <div className="error-text">{passkeyError}</div>}
        {m?.oidc && (
          <a className={`btn${m.password ? '' : ' primary'}`} href="/auth/login" onClick={startSso}>
            Sign in with {m.oidc.label}
          </a>
        )}
        {m?.dev && !m.oidc && (
          <a className="btn" href="/auth/dev-login">
            Dev login
          </a>
        )}
        <SourceLink version={m?.version} />
      </div>
    </div>
  );
}
