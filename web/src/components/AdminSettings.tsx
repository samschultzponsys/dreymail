// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AdminUser, LoginSettingsInput, LoginSettingsView, Registration } from '../../../shared/types';
import { api } from '../api';

/** Settings → Users: everyone on this DreyMail instance (administrators only). */
export function UsersAdmin({ myId }: { myId: string }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: api.adminUsers });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);

  const run = async (fn: () => Promise<AdminUser[]>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['admin', 'users'], await fn());
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!users.data) return <div className="hint">{users.error ? (users.error as Error).message : 'Loading…'}</div>;

  return (
    <div className="stack">
      <div className="hint">Everyone who can sign in to this DreyMail. Each user only ever sees their own mail accounts.</div>
      <ul className="user-list">
        {users.data.map((u) => (
          <li key={u.id}>
            <div className="user-main">
              <div className="user-name">
                {u.name || u.username || u.email}
                {u.id === myId && <span className="chip">You</span>}
                {u.admin && (
                  <span className="chip" title={u.adminByEnv ? 'Administrator through DREYMAIL_ADMIN_USERS' : undefined}>
                    <ShieldCheck size={12} /> Admin
                  </span>
                )}
              </div>
              <div className="muted user-meta">
                {u.login === 'password' ? `Password · ${u.username}` : u.login === 'oidc' ? `OIDC · ${u.email || u.username}` : 'Dev login'} ·{' '}
                {u.accounts} mail {u.accounts === 1 ? 'account' : 'accounts'} · since {new Date(u.createdAt).toLocaleDateString()}
              </div>
            </div>
            {u.id !== myId && (
              <div className="user-actions">
                {!u.adminByEnv && (
                  <button className="btn" disabled={busy} onClick={() => void run(() => api.adminPatchUser(u.id, { admin: !u.admin }))}>
                    {u.admin ? 'Remove admin' : 'Make admin'}
                  </button>
                )}
                {u.login === 'password' && (
                  <button
                    className="icon-btn"
                    title="Set a new password"
                    disabled={busy}
                    onClick={() => {
                      const pw = window.prompt(`New password for ${u.username}`);
                      if (pw) void run(() => api.adminPatchUser(u.id, { password: pw }));
                    }}
                  >
                    <KeyRound size={16} />
                  </button>
                )}
                <button
                  className="icon-btn danger-text"
                  title="Remove user"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove ${u.name || u.username || u.email}? Their mail account settings, signatures and preferences are deleted. Their mail stays on the mail servers.`)) {
                      void run(() => api.adminDeleteUser(u.id));
                    }
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          className="sig-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.adminCreateUser({ username, password, admin: makeAdmin })).then((ok) => {
              if (ok) {
                setAdding(false);
                setUsername('');
                setPassword('');
                setMakeAdmin(false);
              }
            });
          }}
        >
          <div className="grid2">
            <div>
              <label className="label" htmlFor="new-user">
                Username
              </label>
              <input id="new-user" className="input" value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="new-password">
                Password
              </label>
              <input id="new-password" className="input" type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />
            Administrator
          </label>
          <div className="hint">They sign in with this username and password (password login must be on in Sign-in). OIDC users appear here after their first sign-in.</div>
          <div className="row-buttons">
            <span className="grow" />
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !username.trim() || !password}>
              Add user
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button className="btn" onClick={() => setAdding(true)}>
            <UserPlus size={15} /> Add user
          </button>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** A field that environment variables may lock (they override what's set here). */
function Field({ label, lockedBy, children, htmlFor }: { label: string; lockedBy?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      {(label || lockedBy) && (
        <label className="label" htmlFor={htmlFor}>
          {label}
          {lockedBy && (
            <span className="locked" title={`Set by ${lockedBy} in the compose file. Remove it there to change this here.`}>
              <Lock size={11} /> {lockedBy}
            </span>
          )}
        </label>
      )}
      {children}
    </div>
  );
}

/** Settings → Sign-in: OIDC, password login and registration (administrators only). */
export function SignInAdmin() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin', 'login'], queryFn: api.adminLogin });
  const [v, setV] = useState<LoginSettingsInput | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings.data) setV(fromView(settings.data));
  }, [settings.data]);

  if (!settings.data || !v) return <div className="hint">{settings.error ? (settings.error as Error).message : 'Loading…'}</div>;
  const s = settings.data;
  const locked = s.locked;
  const set = (patch: Partial<LoginSettingsInput>) => setV({ ...v, ...patch });

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setStatus(null);
    try {
      setStatus({ ok: true, text: await fn() });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="hint">
        Values set as environment variables in the compose file override these settings and are shown locked. Changes apply right away; no restart
        needed.
      </div>
      <fieldset className="group">
        <legend>Single sign-on (OIDC)</legend>
        <Field label="" lockedBy={locked.oidcEnabled}>
          <label className="check">
            <input type="checkbox" checked={v.oidcEnabled} disabled={!!locked.oidcEnabled} onChange={(e) => set({ oidcEnabled: e.target.checked })} />
            Sign in with an OpenID Connect provider (Authentik, Keycloak, …)
          </label>
        </Field>
        <div className="grid2">
          <Field label="Issuer URL" lockedBy={locked.issuerUrl} htmlFor="oidc-issuer">
            <input id="oidc-issuer" className="input" value={v.issuerUrl} disabled={!!locked.issuerUrl} placeholder="https://auth.example.com/application/o/dreymail/" onChange={(e) => set({ issuerUrl: e.target.value })} />
          </Field>
          <Field label="Button label" lockedBy={locked.label} htmlFor="oidc-label">
            <input id="oidc-label" className="input" value={v.label} disabled={!!locked.label} placeholder="Single sign-on" onChange={(e) => set({ label: e.target.value })} />
          </Field>
          <Field label="Client ID" lockedBy={locked.clientId} htmlFor="oidc-client">
            <input id="oidc-client" className="input" value={v.clientId} disabled={!!locked.clientId} autoComplete="off" onChange={(e) => set({ clientId: e.target.value })} />
          </Field>
          <Field label="Client secret" lockedBy={locked.clientSecret} htmlFor="oidc-secret">
            <input
              id="oidc-secret"
              className="input"
              type="password"
              value={v.clientSecret}
              disabled={!!locked.clientSecret}
              autoComplete="new-password"
              placeholder={s.hasClientSecret ? '•••••••• (saved; type to replace)' : 'Leave empty for a public client'}
              onChange={(e) => set({ clientSecret: e.target.value, clearClientSecret: false })}
            />
          </Field>
        </div>
        <Field label="Scopes" lockedBy={locked.scopes} htmlFor="oidc-scopes">
          <input id="oidc-scopes" className="input" value={v.scopes} disabled={!!locked.scopes} onChange={(e) => set({ scopes: e.target.value })} />
        </Field>
        <div className="hint">
          Redirect URI to register at your provider: <code className="copyable">{s.callbackUrl}</code>
        </div>
        <div>
          <button
            className="btn"
            disabled={busy || !v.issuerUrl.trim()}
            onClick={() => void act(async () => `Found ${(await api.adminTestLogin({ issuerUrl: v.issuerUrl, clientId: v.clientId, clientSecret: v.clientSecret })).issuer}`)}
          >
            Test connection
          </button>
        </div>
      </fieldset>
      <fieldset className="group">
        <legend>Username and password</legend>
        <Field label="" lockedBy={locked.passwordLogin}>
          <label className="check">
            <input type="checkbox" checked={v.passwordLogin} disabled={!!locked.passwordLogin} onChange={(e) => set({ passwordLogin: e.target.checked })} />
            Allow signing in with a username and password
          </label>
        </Field>
        <Field label="Who may create an account" lockedBy={locked.registration} htmlFor="registration">
          <select id="registration" className="select" value={v.registration} disabled={!!locked.registration} onChange={(e) => set({ registration: e.target.value as Registration })}>
            <option value="closed">Nobody (administrators add users)</option>
            <option value="first">Only the first user of an empty instance</option>
            <option value="open">Anyone who can reach this page</option>
          </select>
        </Field>
      </fieldset>
      {status && <div className={status.ok ? 'success-text' : 'error-text'}>{status.text}</div>}
      <div className="row-buttons">
        <span className="grow" />
        <button className="btn" disabled={busy} onClick={() => setV(fromView(s))}>
          Reset
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const saved = await api.adminSaveLogin(v);
              qc.setQueryData(['admin', 'login'], saved);
              return 'Saved.';
            })
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

function fromView(s: LoginSettingsView): LoginSettingsInput {
  return {
    oidcEnabled: s.oidcEnabled,
    issuerUrl: s.issuerUrl,
    clientId: s.clientId,
    clientSecret: '',
    clearClientSecret: false,
    scopes: s.scopes,
    label: s.label,
    passwordLogin: s.passwordLogin,
    registration: s.registration,
  };
}
