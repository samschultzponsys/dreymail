// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, KeyRound, Lock, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { PERMISSIONS, SUPERADMIN, USER_DEFAULTS, type Permission, type Role } from '../../../shared/permissions';
import type { AdminUser, LoginSettingsInput, LoginSettingsView, Me, Registration } from '../../../shared/types';
import { api, type RolesView } from '../api';
import { PictureEditor, UserAvatar } from './UserPicture';

/** Settings → Users: everyone on this DreyMail instance. What can be done depends on the role. */
export function UsersAdmin({ me }: { me: Me }) {
  const qc = useQueryClient();
  const myId = me.id;
  const can = (p: Permission) => me.permissions.includes(p);
  const superadmin = me.role.id === SUPERADMIN;
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: api.adminUsers });
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: api.adminRoles, enabled: can('roles.manage') || can('users.manage') });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picturing, setPicturing] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newRole, setNewRole] = useState('');

  const run = async (fn: () => Promise<AdminUser[]>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['admin', 'users'], await fn());
      void qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!users.data) return <div className="hint">{users.error ? (users.error as Error).message : 'Loading…'}</div>;
  const roleList = roles.data?.roles ?? [];
  const roleName = (id: string) => roleList.find((r) => r.id === id)?.name ?? (id === SUPERADMIN ? 'Superadmin' : id === 'user' ? 'User' : 'Role');
  // Roles this administrator may hand out: none with rights they don't have themselves.
  const grantable = roleList.filter((r) => (r.id === SUPERADMIN ? superadmin : r.permissions.every((p) => can(p))));

  return (
    <div className="stack">
      <div className="hint">Everyone who can sign in to this DreyMail. Each user only ever sees their own mail accounts.</div>
      <ul className="user-list">
        {users.data.map((u) => {
          const display = u.name || u.username || u.email;
          const protectedUser = u.roleId === SUPERADMIN && !superadmin;
          return (
            <li key={u.id}>
              <UserAvatar src={u.avatar} name={display} size={36} />
              <div className="user-main">
                <div className="user-name">
                  {display}
                  {u.id === myId && <span className="chip">You</span>}
                  {(!can('roles.manage') || u.id === myId || u.adminByEnv || protectedUser) && (
                    <span className="chip" title={u.adminByEnv ? 'Superadmin through DREYMAIL_ADMIN_USERS' : undefined}>
                      {u.roleId === SUPERADMIN && <ShieldCheck size={12} />} {roleName(u.roleId)}
                    </span>
                  )}
                </div>
                <div className="muted user-meta">
                  {u.login === 'password' ? `Password · ${u.username}` : u.login === 'oidc' ? `OIDC · ${u.email || u.username}` : 'Dev login'} ·{' '}
                  {u.accounts} mail {u.accounts === 1 ? 'account' : 'accounts'} · since {new Date(u.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div className="user-actions">
                {can('roles.manage') && u.id !== myId && !u.adminByEnv && !protectedUser && (
                  <select
                    className="input role-select"
                    aria-label={`Role of ${display}`}
                    value={u.roleId}
                    disabled={busy}
                    onChange={(e) => void run(() => api.adminPatchUser(u.id, { roleId: e.target.value }))}
                  >
                    {(grantable.some((r) => r.id === u.roleId) ? grantable : [...grantable, { id: u.roleId, name: roleName(u.roleId) }]).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                )}
                {can('users.manage') && (
                  <select
                    className="input role-select"
                    aria-label={`AI assistant for ${display}`}
                    title="AI assistant"
                    value={u.aiAccess}
                    disabled={busy}
                    onChange={(e) => void run(() => api.adminPatchUser(u.id, { aiAccess: e.target.value as '' | 'on' | 'off' }))}
                  >
                    <option value="">AI: as role</option>
                    <option value="on">AI: on</option>
                    <option value="off">AI: off</option>
                  </select>
                )}
                {can('users.pictures') && (
                  <button className="icon-btn" title="Change profile picture" disabled={busy} onClick={() => setPicturing(picturing === u.id ? null : u.id)}>
                    <Camera size={16} />
                  </button>
                )}
                {can('users.manage') && u.login === 'password' && !protectedUser && (
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
                {can('users.manage') && u.id !== myId && !protectedUser && (
                  <button
                    className="icon-btn danger-text"
                    title="Remove user"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove ${display}? Their mail account settings, signatures and preferences are deleted. Their mail stays on the mail servers.`)) {
                        void run(() => api.adminDeleteUser(u.id));
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              {picturing === u.id && (
                <div className="user-picture-edit">
                  <PictureEditor
                    busy={busy}
                    onCancel={() => setPicturing(null)}
                    onSave={(d) => void run(() => api.adminSetPicture(u.id, d)).then((ok) => ok && setPicturing(null))}
                  />
                  {u.hasPicture && (
                    <button className="btn" disabled={busy} onClick={() => void run(() => api.adminDeletePicture(u.id)).then((ok) => ok && setPicturing(null))}>
                      <Trash2 size={15} /> Remove their picture
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {can('users.manage') &&
        (adding ? (
          <form
            className="sig-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.adminCreateUser({ username, password, ...(newRole ? { roleId: newRole } : {}) })).then((ok) => {
                if (ok) {
                  setAdding(false);
                  setUsername('');
                  setPassword('');
                  setNewRole('');
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
            {can('roles.manage') && grantable.length > 0 && (
              <div>
                <label className="label" htmlFor="new-role">
                  Role
                </label>
                <select id="new-role" className="input" value={newRole || roles.data?.defaultRole || 'user'} onChange={(e) => setNewRole(e.target.value)}>
                  {grantable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
        ))}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** Settings → Roles: roles and their permission flags, and the role new users get. */
export function RolesAdmin({ me }: { me: Me }) {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: api.adminRoles });
  const [editing, setEditing] = useState<{ id: string | null; name: string; permissions: Permission[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = new Set(me.permissions);

  const run = async (fn: () => Promise<RolesView>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['admin', 'roles'], await fn());
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!roles.data) return <div className="hint">{roles.error ? (roles.error as Error).message : 'Loading…'}</div>;
  const groups = [...new Set(PERMISSIONS.map((p) => p.group))];
  const allowedRole = (r: Role) => r.permissions.every((p) => mine.has(p));

  return (
    <div className="stack">
      <div className="hint">
        Every user has one role. <strong>Superadmin</strong> always has every right, including ones added in later versions. <strong>User</strong> is
        for using DreyMail without administration. Add your own roles for anything in between.
      </div>
      <ul className="role-list">
        {roles.data.roles.map((r) => (
          <li key={r.id}>
            <div className="user-main">
              <div className="user-name">
                {r.id === SUPERADMIN && <ShieldCheck size={14} />} {r.name}
                {roles.data.defaultRole === r.id && <span className="chip">New users</span>}
              </div>
              <div className="muted user-meta">
                {r.id === SUPERADMIN ? 'Everything' : r.permissions.length === 0 ? 'Reading and sending mail only' : PERMISSIONS.filter((p) => r.permissions.includes(p.key)).map((p) => p.label).join(' · ')}
                {' · '}
                {r.users} {r.users === 1 ? 'user' : 'users'}
              </div>
            </div>
            {r.id !== SUPERADMIN && allowedRole(r) && (
              <div className="user-actions">
                <button className="btn" disabled={busy} onClick={() => setEditing({ id: r.id, name: r.name, permissions: r.permissions })}>
                  Edit
                </button>
                {!r.builtin && (
                  <button
                    className="icon-btn danger-text"
                    title="Remove role"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove the role ${r.name}? Its ${r.users} ${r.users === 1 ? 'user gets' : 'users get'} the role new users get.`)) void run(() => api.adminDeleteRole(r.id));
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing ? (
        <form
          className="sig-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.adminSaveRole(editing.id, { name: editing.name, permissions: editing.permissions })).then((ok) => ok && setEditing(null));
          }}
        >
          <div>
            <label className="label" htmlFor="role-name">
              Name
            </label>
            <input id="role-name" className="input" value={editing.name} disabled={editing.id === 'user'} maxLength={60} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </div>
          {groups.map((g) => (
            <fieldset key={g} className="perm-group">
              <legend>{g}</legend>
              {PERMISSIONS.filter((p) => p.group === g).map((p) => (
                <label key={p.key} className="check" title={mine.has(p.key) ? undefined : "You don't have this right yourself"}>
                  <input
                    type="checkbox"
                    checked={editing.permissions.includes(p.key)}
                    disabled={!mine.has(p.key)}
                    onChange={(e) =>
                      setEditing({ ...editing, permissions: e.target.checked ? [...editing.permissions, p.key] : editing.permissions.filter((x) => x !== p.key) })
                    }
                  />
                  {p.label}
                </label>
              ))}
            </fieldset>
          ))}
          <div className="hint">Reading, sending and organizing mail, signatures, saved searches and personal settings are always allowed.</div>
          <div className="row-buttons">
            <span className="grow" />
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !editing.name.trim()}>
              {editing.id ? 'Save role' : 'Add role'}
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button className="btn" onClick={() => setEditing({ id: null, name: '', permissions: [...USER_DEFAULTS] })}>
            <Plus size={15} /> Add role
          </button>
        </div>
      )}
      <div>
        <label className="label" htmlFor="default-role">
          Role for new users
        </label>
        <select id="default-role" className="input" value={roles.data.defaultRole} disabled={busy} onChange={(e) => void run(() => api.adminDefaultRole(e.target.value))}>
          {roles.data.roles
            .filter((r) => r.id !== SUPERADMIN && allowedRole(r))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
        <div className="hint">What people get when they register or first sign in with OIDC. The very first user of a new DreyMail is always Superadmin.</div>
      </div>
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

/** Settings → Android (administrators): Firebase, which wakes the Android app when mail arrives. */
export function AndroidAdmin() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin', 'firebase'], queryFn: api.adminFirebase });
  const [serviceAccount, setServiceAccount] = useState('');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [appId, setAppId] = useState<string | null>(null);
  const [senderId, setSenderId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!settings.data) return <div className="hint">{settings.error ? (settings.error as Error).message : 'Loading…'}</div>;
  const s = settings.data;
  const locked = s.locked;
  const v = { apiKey: apiKey ?? s.apiKey, appId: appId ?? s.appId, senderId: senderId ?? s.senderId };

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      qc.setQueryData(['admin', 'firebase'], await api.adminSaveFirebase({ serviceAccount, ...v }));
      setServiceAccount('');
      setStatus({ ok: true, text: 'Saved. Phones register the next time the Android app opens.' });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="hint">
        The DreyMail Android app gets new mail instantly: this server watches your inboxes and wakes the phone through Firebase Cloud Messaging, the
        same channel Spark and Gmail use. Message contents never go through Google; only “there is a notification” and its text, over TLS.
      </div>
      <div className={s.configured ? 'success-text' : 'muted'}>
        {s.configured ? `Set up for Firebase project “${s.projectId}”.` : 'Not set up yet: the Android app shows no notifications until it is.'}
      </div>
      <fieldset className="group">
        <legend>One-time setup in the Firebase console</legend>
        <ol className="steps">
          <li>
            Open <code className="copyable">console.firebase.google.com</code>, <em>Create a project</em> (free; Analytics not needed).
          </li>
          <li>
            <em>Add app → Android</em>, package name <code className="copyable">io.github.samschultzponsys.dreymail</code>. Skip the download steps.
          </li>
          <li>
            <em>Project settings → General</em>: copy the Android app's <strong>App ID</strong>, the <strong>Web API key</strong> and, under <em>Cloud
            Messaging</em>, the <strong>Sender ID</strong> into the fields below.
          </li>
          <li>
            <em>Project settings → Service accounts → Generate new private key</em>: paste the whole downloaded JSON file below.
          </li>
        </ol>
      </fieldset>
      <div className="grid2">
        <Field label="App ID" lockedBy={locked.appId} htmlFor="fb-app">
          <input id="fb-app" className="input" value={v.appId} disabled={!!locked.appId} placeholder="1:1234567890:android:abc123" onChange={(e) => setAppId(e.target.value)} />
        </Field>
        <Field label="Sender ID" lockedBy={locked.senderId} htmlFor="fb-sender">
          <input id="fb-sender" className="input" value={v.senderId} disabled={!!locked.senderId} placeholder="1234567890" onChange={(e) => setSenderId(e.target.value)} />
        </Field>
      </div>
      <Field label="Web API key" lockedBy={locked.apiKey} htmlFor="fb-key">
        <input id="fb-key" className="input" value={v.apiKey} disabled={!!locked.apiKey} placeholder="AIza…" autoComplete="off" onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <Field label="Service account JSON" lockedBy={locked.serviceAccount} htmlFor="fb-sa">
        <textarea
          id="fb-sa"
          className="input textarea"
          rows={5}
          value={serviceAccount}
          disabled={!!locked.serviceAccount}
          placeholder={s.hasServiceAccount ? `Saved (${s.serviceAccountEmail}). Paste a new one to replace it.` : '{ "type": "service_account", "project_id": … }'}
          onChange={(e) => setServiceAccount(e.target.value)}
        />
      </Field>
      <div className="hint">The service account is stored encrypted and never sent to browsers or phones.</div>
      {status && <div className={status.ok ? 'success-text' : 'error-text'}>{status.text}</div>}
      <div className="row-buttons">
        <span className="grow" />
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

/** Settings → Outlook (administrators): the Microsoft app registration behind "Add Outlook account". */
export function OutlookAdmin() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin', 'microsoft'], queryFn: api.adminMicrosoft });
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState('');
  const [tenant, setTenant] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!settings.data) return <div className="hint">{settings.error ? (settings.error as Error).message : 'Loading…'}</div>;
  const s = settings.data;
  const v = { clientId: clientId ?? s.clientId, tenant: tenant ?? s.tenant };

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      qc.setQueryData(['admin', 'microsoft'], await api.adminSaveMicrosoft({ clientId: v.clientId, clientSecret, tenant: v.tenant }));
      await qc.invalidateQueries({ queryKey: ['microsoftAvailable'] });
      setClientSecret('');
      setStatus({ ok: true, text: 'Saved. "Add account → Outlook / Microsoft 365" now works for everyone on this DreyMail.' });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="hint">
        Microsoft no longer lets mail apps sign in to Outlook.com, Hotmail, Live or Microsoft 365 with a password. With this set up, users add those
        accounts by signing in on Microsoft’s own page; DreyMail never sees their password.
      </div>
      <div className={s.configured ? 'success-text' : 'muted'}>{s.configured ? 'Set up: Outlook accounts can be added.' : 'Not set up yet.'}</div>
      <fieldset className="group">
        <legend>One-time setup in the Microsoft Entra admin center (free)</legend>
        <ol className="steps">
          <li>
            Open <code className="copyable">entra.microsoft.com</code> and sign in with any Microsoft account (a personal Outlook.com one works). Go to{' '}
            <em>Applications → App registrations → New registration</em>.
          </li>
          <li>
            Name: <code className="copyable">DreyMail</code>. Supported account types:{' '}
            <em>Accounts in any organizational directory and personal Microsoft accounts</em>.
          </li>
          <li>
            Redirect URI: platform <em>Web</em>, address <code className="copyable">{s.redirectUri}</code>. Click <em>Register</em>.
          </li>
          <li>
            Copy the <strong>Application (client) ID</strong> from the overview page into the field below.
          </li>
          <li>
            <em>Certificates &amp; secrets → New client secret</em> (pick the longest expiry), then copy its <strong>Value</strong> (not the ID) below.
          </li>
          <li>
            Nothing else: people grant the mail permissions themselves when they sign in. (In some work tenants an admin must approve the app once.)
          </li>
        </ol>
      </fieldset>
      <div className="grid2">
        <Field label="Application (client) ID" lockedBy={s.locked.clientId} htmlFor="ms-client">
          <input id="ms-client" className="input" value={v.clientId} disabled={!!s.locked.clientId} placeholder="00000000-0000-0000-0000-000000000000" onChange={(e) => setClientId(e.target.value)} />
        </Field>
        <Field label="Client secret value" lockedBy={s.locked.clientSecret} htmlFor="ms-secret">
          <input
            id="ms-secret"
            className="input"
            type="password"
            value={clientSecret}
            disabled={!!s.locked.clientSecret}
            autoComplete="new-password"
            placeholder={s.hasClientSecret ? '•••••••• (saved; type to replace)' : ''}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Who may sign in" lockedBy={s.locked.tenant} htmlFor="ms-tenant">
        <select id="ms-tenant" className="select" value={['common', 'consumers', 'organizations'].includes(v.tenant) ? v.tenant : 'custom'} disabled={!!s.locked.tenant} onChange={(e) => setTenant(e.target.value === 'custom' ? '' : e.target.value)}>
          <option value="common">Personal and work/school accounts (recommended)</option>
          <option value="consumers">Personal accounts only (Outlook.com, Hotmail, Live)</option>
          <option value="organizations">Work/school accounts only</option>
          <option value="custom">One organization (tenant ID)…</option>
        </select>
      </Field>
      {!['common', 'consumers', 'organizations'].includes(v.tenant) && (
        <Field label="Tenant ID" htmlFor="ms-tenant-id">
          <input id="ms-tenant-id" className="input" value={v.tenant} onChange={(e) => setTenant(e.target.value)} placeholder="contoso.onmicrosoft.com or tenant GUID" />
        </Field>
      )}
      <div className="hint">The client secret is stored encrypted. Microsoft secrets expire (up to 2 years): put a reminder in your calendar to renew it.</div>
      {status && <div className={status.ok ? 'success-text' : 'error-text'}>{status.text}</div>}
      <div className="row-buttons">
        <span className="grow" />
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

/** Settings → Google (administrators): the OAuth client behind "Gmail: Sign in with Google". */
export function GoogleAdmin() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin', 'google'], queryFn: api.adminGoogle });
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!settings.data) return <div className="hint">{settings.error ? (settings.error as Error).message : 'Loading…'}</div>;
  const s = settings.data;
  const id = clientId ?? s.clientId;

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      qc.setQueryData(['admin', 'google'], await api.adminSaveGoogle({ clientId: id, clientSecret }));
      await qc.invalidateQueries({ queryKey: ['googleAvailable'] });
      setClientSecret('');
      setStatus({ ok: true, text: 'Saved. "Add account → Gmail: Sign in with Google" now works. App passwords keep working too.' });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="hint">
        Optional: lets people add Gmail by signing in with Google instead of creating an app password. Both ways keep working; the sign-in survives
        password changes and doesn’t need 2-Step Verification app passwords.
      </div>
      <div className={s.configured ? 'success-text' : 'muted'}>{s.configured ? 'Set up: Gmail can be added with Sign in with Google.' : 'Not set up (Gmail works with app passwords).'}</div>
      <fieldset className="group">
        <legend>One-time setup in Google Cloud (free)</legend>
        <ol className="steps">
          <li>
            Open <code className="copyable">console.cloud.google.com</code>, create a project named <code className="copyable">DreyMail</code>.
          </li>
          <li>
            <em>APIs &amp; Services → OAuth consent screen</em> (or <em>Google Auth Platform</em>): User type <em>External</em>, app name DreyMail, your
            email as support and developer contact. Save.
          </li>
          <li>
            <strong>Publish the app</strong> (<em>Audience → Publish app</em>). In “Testing”, Google ends the sign-in every 7 days. Published but
            unverified is fine for your own use: when signing in, Google shows “Google hasn’t verified this app”; choose <em>Advanced → Go to
            DreyMail</em>.
          </li>
          <li>
            <em>Credentials (Clients) → Create OAuth client ID</em>, type <em>Web application</em>, Authorized redirect URI{' '}
            <code className="copyable">{s.redirectUri}</code>. Create.
          </li>
          <li>Copy the <strong>Client ID</strong> and <strong>Client secret</strong> into the fields below.</li>
        </ol>
      </fieldset>
      <div className="grid2">
        <Field label="Client ID" lockedBy={s.locked.clientId} htmlFor="g-client">
          <input id="g-client" className="input" value={id} disabled={!!s.locked.clientId} placeholder="…apps.googleusercontent.com" onChange={(e) => setClientId(e.target.value)} />
        </Field>
        <Field label="Client secret" lockedBy={s.locked.clientSecret} htmlFor="g-secret">
          <input
            id="g-secret"
            className="input"
            type="password"
            value={clientSecret}
            disabled={!!s.locked.clientSecret}
            autoComplete="new-password"
            placeholder={s.hasClientSecret ? '•••••••• (saved; type to replace)' : 'GOCSPX-…'}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </Field>
      </div>
      <div className="hint">The client secret is stored encrypted.</div>
      {status && <div className={status.ok ? 'success-text' : 'error-text'}>{status.text}</div>}
      <div className="row-buttons">
        <span className="grow" />
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}
