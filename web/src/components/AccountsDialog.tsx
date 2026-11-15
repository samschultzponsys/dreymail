// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: colour wheel (any colour) next to the preset swatches.
// Modified by samschultzponsys, 2026-11-13: US spelling (Color).
// Modified by samschultzponsys, 2026-11-15: Outlook accounts; This device settings.
// Modified by samschultzponsys, 2026-11-15: Sign in with Google for Gmail.
// Modified by samschultzponsys, 2026-11-15: mailbox editing follows the role's permissions.
// Modified by samschultzponsys, 2026-11-15: mailbox icons.
// Modified by samschultzponsys, 2026-11-15: your own picture as a mailbox icon.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { DEFAULT_PORTS } from '../../../shared/mailPorts';
import type { AccountDefaults, AccountInput, AccountView, TlsMode } from '../../../shared/types';
import { newAccountInput, usesDefaultPassword } from '../accountForm';
import { api } from '../api';
import { ACCOUNT_COLORS } from '../util';
import { labelOn } from '../accountTheme';
import { MailboxIcon, MailboxIconPicker } from './MailboxIcon';

function fromView(a: AccountView): AccountInput {
  return {
    name: a.name,
    displayName: a.displayName,
    email: a.email,
    color: a.color,
    icon: a.icon,
    imap: { ...a.imap, password: '' },
    smtp: { ...a.smtp, password: '' },
    appendSent: a.appendSent,
  };
}

function ServerFields({
  kind,
  value,
  onChange,
  editing,
  passwordHint,
}: {
  kind: 'imap' | 'smtp';
  value: AccountInput['imap'];
  onChange: (v: AccountInput['imap']) => void;
  editing: boolean;
  /** Placeholder for a blank password on a new account. */
  passwordHint: string;
}) {
  return (
    <fieldset>
      <legend>{kind === 'imap' ? 'Incoming (IMAP)' : 'Outgoing (SMTP)'}</legend>
      <div className="grid3">
        <div>
          <label className="label">Server</label>
          <input className="input" value={value.host} placeholder={`${kind}.example.com`} onChange={(e) => onChange({ ...value, host: e.target.value })} />
        </div>
        <div>
          <label className="label">Security</label>
          <select
            className="select"
            value={value.tls}
            onChange={(e) => {
              const tls = e.target.value as TlsMode;
              onChange({ ...value, tls, port: DEFAULT_PORTS[kind][tls] });
            }}
          >
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None (insecure)</option>
          </select>
        </div>
        <div>
          <label className="label">Port</label>
          <input className="input" type="number" value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value) })} />
        </div>
      </div>
      <div className="grid2">
        <div>
          <label className="label">Username</label>
          <input className="input" value={value.user} autoComplete="off" onChange={(e) => onChange({ ...value, user: e.target.value })} />
        </div>
        <div>
          <label className="label">Password</label>
          <input
            className="input"
            type="password"
            value={value.password ?? ''}
            autoComplete="new-password"
            placeholder={editing ? 'Unchanged' : passwordHint}
            onChange={(e) => onChange({ ...value, password: e.target.value })}
          />
        </div>
      </div>
      {value.tls === 'none' && <div className="error-text" style={{ fontSize: 12 }}>Without TLS, your password and mail travel unencrypted.</div>}
    </fieldset>
  );
}

function AccountForm({
  initial,
  id,
  defaults,
  onDone,
  onCancel,
  image: initialImage = null,
  onPicture,
}: {
  initial: AccountInput;
  id?: string;
  defaults: AccountDefaults;
  onDone: () => void;
  onCancel: () => void;
  /** The mailbox's uploaded picture, if any. */
  image?: string | null;
  /** The picture changed (saved right away, unlike the rest of the form). */
  onPicture?: () => void;
}) {
  const [v, setV] = useState(initial);
  const [image, setImage] = useState(initialImage);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const normalized = (): AccountInput => ({
    ...v,
    smtp: { ...v.smtp, password: v.smtp.password || (id ? '' : v.imap.password) },
  });

  const run = async (what: 'test' | 'save') => {
    setBusy(what);
    setStatus(null);
    try {
      if (what === 'test') {
        await api.testAccount(normalized(), id);
        setStatus({ ok: true, text: 'Connection successful (IMAP and SMTP).' });
      } else {
        if (id) await api.updateAccount(id, normalized());
        else await api.createAccount(normalized());
        onDone();
      }
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const defaultPw = (kind: 'imap' | 'smtp') => usesDefaultPassword(defaults, kind, v[kind].host);
  const imapHint = defaultPw('imap') ? 'Default password' : '';
  // The default password is never sent to a non-default SMTP server, not even via "Same as IMAP".
  const smtpHint = v.imap.password ? 'Same as IMAP' : defaultPw('smtp') ? 'Default password' : defaultPw('imap') ? '' : 'Same as IMAP';

  const setEmail = (email: string) => {
    // Fill obvious defaults while the user types the address.
    setV((cur) => ({
      ...cur,
      email,
      name: cur.name && cur.name !== cur.email ? cur.name : email,
      imap: { ...cur.imap, user: cur.imap.user && cur.imap.user !== cur.email ? cur.imap.user : email },
      smtp: { ...cur.smtp, user: cur.smtp.user && cur.smtp.user !== cur.email ? cur.smtp.user : email },
    }));
  };

  return (
    <>
      <div className="dialog-body">
        <div className="grid2">
          <div>
            <label className="label">Email address</label>
            <input className="input" value={v.email} placeholder="user@example.com" onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label">Your name (shown to recipients)</label>
            <input className="input" value={v.displayName} onChange={(e) => setV({ ...v, displayName: e.target.value })} />
          </div>
        </div>
        <div className="grid2">
          <div>
            <label className="label">Account label</label>
            <input className="input" value={v.name} placeholder="Work" onChange={(e) => setV({ ...v, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Color</label>
            <div className="swatches">
              {ACCOUNT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch ${v.color.toLowerCase() === c ? 'on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setV({ ...v, color: c })}
                  title={c}
                  aria-label={`Color ${c}`}
                />
              ))}
              <label
                className={`swatch custom ${ACCOUNT_COLORS.includes(v.color.toLowerCase()) ? '' : 'on'}`}
                title="Pick any color"
                style={ACCOUNT_COLORS.includes(v.color.toLowerCase()) ? undefined : { boxShadow: `inset 0 0 0 5px ${v.color}` }}
              >
                <input type="color" value={v.color} onChange={(e) => setV({ ...v, color: e.target.value })} aria-label="Pick any color" />
              </label>
            </div>
            <div className="hint">The whole app takes on this color while the account is open.</div>
          </div>
        </div>
        <MailboxIconPicker
          value={v.icon ?? ''}
          color={v.color}
          onChange={(icon) => setV((cur) => ({ ...cur, icon }))}
          accountId={id ?? null}
          image={image}
          onAccount={(a) => {
            setImage(a.iconImage);
            onPicture?.();
          }}
        />
        <ServerFields kind="imap" value={v.imap} editing={!!id} passwordHint={imapHint} onChange={(imap) => setV({ ...v, imap })} />
        <ServerFields kind="smtp" value={v.smtp} editing={!!id} passwordHint={smtpHint} onChange={(smtp) => setV({ ...v, smtp })} />
        <label className="check">
          <input type="checkbox" checked={v.appendSent} onChange={(e) => setV({ ...v, appendSent: e.target.checked })} />
          Save a copy of sent mail to the Sent folder
          <span className="muted">(turn off if your provider already does this)</span>
        </label>
      </div>
      <div className="dialog-foot">
        <span className={`grow ${status?.ok ? '' : 'error-text'}`} style={status?.ok ? { color: 'var(--success)' } : undefined}>
          {status?.text}
        </span>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" onClick={() => void run('test')} disabled={busy !== null}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button className="btn primary" onClick={() => void run('save')} disabled={busy !== null}>
          {busy === 'save' ? 'Connecting…' : 'Save'}
        </button>
      </div>
    </>
  );
}

export function AccountsDialog({
  accounts,
  defaults,
  onClose,
  startWithNew,
  canEdit = true,
}: {
  accounts: AccountView[];
  defaults: AccountDefaults;
  onClose: () => void;
  startWithNew?: boolean;
  /** The user's role allows adding, editing and removing mailboxes. */
  canEdit?: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ id?: string; input: AccountInput } | null>(null);
  // "Add account" first asks what kind: Outlook (Microsoft sign-in) or any other IMAP account.
  const [choosing, setChoosing] = useState(!!startWithNew && canEdit);
  const [editingMicrosoft, setEditingMicrosoft] = useState<AccountView | null>(null);
  const microsoft = useQuery({ queryKey: ['microsoftAvailable'], queryFn: api.microsoftAvailable, staleTime: 60_000 });
  const google = useQuery({ queryKey: ['googleAvailable'], queryFn: api.googleAvailable, staleTime: 60_000 });
  const [msError, setMsError] = useState<string | null>(null);
  const signIn = async (provider: 'microsoft' | 'google', color: string) => {
    setMsError(null);
    try {
      window.location.href = (provider === 'google' ? await api.startGoogle(color) : await api.startMicrosoft(color)).url;
    } catch (err) {
      setMsError((err as Error).message);
    }
  };
  const signInWithMicrosoft = (color: string) => signIn('microsoft', color);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['accounts'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
    void qc.invalidateQueries({ queryKey: ['messages'] });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>{editing || editingMicrosoft ? (editing?.id || editingMicrosoft ? 'Edit account' : 'Add account') : choosing ? 'Add account' : 'Mail accounts'}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        {editingMicrosoft ? (
          <MicrosoftAccountForm
            account={editingMicrosoft}
            onReconnect={() => void signIn(editingMicrosoft.auth === 'google' ? 'google' : 'microsoft', editingMicrosoft.color)}
            error={msError}
            onPicture={refresh}
            onCancel={() => setEditingMicrosoft(null)}
            onDone={() => {
              refresh();
              setEditingMicrosoft(null);
            }}
          />
        ) : choosing && !editing ? (
          <div className="dialog-body">
            <button
              className="provider-choice"
              disabled={!microsoft.data?.available}
              onClick={() => void signInWithMicrosoft(ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length]!)}
            >
              <span className="provider-mark ms" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="grow">
                <strong>Outlook / Microsoft 365</strong>
                <span className="sub">
                  {microsoft.data?.available
                    ? 'Outlook.com, Hotmail, Live and work or school accounts. You sign in on Microsoft’s page.'
                    : 'Not set up on this server yet: an administrator adds it in Settings → Outlook.'}
                </span>
              </span>
            </button>
            <button
              className="provider-choice"
              disabled={!google.data?.available}
              onClick={() => void signIn('google', ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length]!)}
            >
              <span className="provider-mark google" aria-hidden="true">G</span>
              <span className="grow">
                <strong>Gmail: Sign in with Google</strong>
                <span className="sub">
                  {google.data?.available
                    ? 'Gmail and Google Workspace. You sign in on Google’s page; no app password needed.'
                    : 'Not set up on this server yet: an administrator adds it in Settings → Google. Gmail still works with an app password below.'}
                </span>
              </span>
            </button>
            <button
              className="provider-choice"
              onClick={() => {
                setChoosing(false);
                setEditing({ input: newAccountInput(accounts.length, defaults) });
              }}
            >
              <span className="provider-mark" aria-hidden="true">@</span>
              <span className="grow">
                <strong>Gmail (app password) or other email</strong>
                <span className="sub">Gmail (with an app password), iCloud, Yahoo, Purelymail, Fastmail, your own server: any IMAP/SMTP account.</span>
              </span>
            </button>
            {msError && <div className="error-text">{msError}</div>}
            <div className="row-buttons">
              <span className="grow" />
              <button className="btn" onClick={() => (accounts.length ? setChoosing(false) : onClose())}>
                Cancel
              </button>
            </div>
          </div>
        ) : editing ? (
          <AccountForm
            initial={editing.input}
            id={editing.id}
            image={accounts.find((a) => a.id === editing.id)?.iconImage ?? null}
            onPicture={refresh}
            defaults={defaults}
            onCancel={() => (accounts.length ? setEditing(null) : onClose())}
            onDone={() => {
              refresh();
              setEditing(null);
            }}
          />
        ) : (
          <>
            <div className="dialog-body">
              {accounts.length === 0 && <div className="muted">No accounts yet.</div>}
              {!canEdit && <div className="hint">Your role doesn't allow changing mailboxes. Ask an administrator.</div>}
              {accounts.map((a) => (
                <div className="account-card" key={a.id}>
                  {a.icon === 'image' && a.iconImage ? (
                    <img className="account-mark" src={a.iconImage} alt="" />
                  ) : (
                    <span className="account-mark" style={{ background: a.color }}>
                      {a.icon && <MailboxIcon icon={a.icon} color={labelOn(a.color)} size={16} />}
                    </span>
                  )}
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{a.name}</div>
                    <div className="sub">
                      {a.email} · {a.auth === 'microsoft' ? 'Microsoft sign-in' : a.auth === 'google' ? 'Google sign-in' : a.imap.host}
                    </div>
                  </div>
                  {canEdit && (
                  <>
                  <button
                    className="icon-btn"
                    title="Edit"
                    onClick={() => (a.auth !== 'password' ? setEditingMicrosoft(a) : setEditing({ id: a.id, input: fromView(a) }))}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Remove"
                    onClick={async () => {
                      if (!window.confirm(`Remove ${a.name}? Mail on the server is not affected.`)) return;
                      await api.deleteAccount(a.id);
                      refresh();
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                  </>
                  )}
                </div>
              ))}
            </div>
            <div className="dialog-foot">
              <span className="grow muted">Passwords are stored encrypted and never sent back to the browser.</span>
              {canEdit && (
                <button className="btn primary" onClick={() => setChoosing(true)}>
                  <Plus size={15} /> Add account
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Edit an Outlook account: its servers are fixed, so only label, name and colour; plus signing in again. */
function MicrosoftAccountForm({
  account,
  onReconnect,
  error,
  onCancel,
  onDone,
  onPicture,
}: {
  account: AccountView;
  onReconnect: () => void;
  error: string | null;
  onCancel: () => void;
  onDone: () => void;
  onPicture?: () => void;
}) {
  const [name, setName] = useState(account.name);
  const [displayName, setDisplayName] = useState(account.displayName);
  const [color, setColor] = useState(account.color);
  const [icon, setIcon] = useState(account.icon);
  const [image, setImage] = useState(account.iconImage);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="dialog-body">
        <div className="ms-signed-in">
          {account.auth === 'google' ? (
            <span className="provider-mark google" aria-hidden="true">G</span>
          ) : (
            <span className="provider-mark ms" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
          <div className="grow">
            <strong>{account.email}</strong>
            <div className="sub">Signed in with {account.auth === 'google' ? 'Google' : 'Microsoft'}. DreyMail never sees the password.</div>
          </div>
          <button className="btn" onClick={onReconnect}>
            Reconnect
          </button>
        </div>
        <div className="grid2">
          <div>
            <label className="label">Account label</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Your name (shown to recipients)</label>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Color</label>
          <div className="swatches">
            {ACCOUNT_COLORS.map((c) => (
              <button key={c} type="button" className={`swatch ${color.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Color ${c}`} />
            ))}
            <label className={`swatch custom ${ACCOUNT_COLORS.includes(color.toLowerCase()) ? '' : 'on'}`} title="Pick any color">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Pick any color" />
            </label>
          </div>
        </div>
        <MailboxIconPicker value={icon} color={color} onChange={setIcon} accountId={account.id} image={image} onAccount={(a) => { setImage(a.iconImage); onPicture?.(); }} />
        <div className="hint">{account.auth === 'google' ? 'Gmail keeps the copy of sent mail itself.' : 'Sent mail goes through Microsoft, which keeps the copy in Sent Items.'}</div>
        {(error || status) && <div className="error-text">{error ?? status}</div>}
      </div>
      <div className="dialog-foot">
        <span className="grow" />
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await api.updateAccount(account.id, { ...fromView(account), name: name.trim(), displayName, color, icon });
              onDone();
            } catch (err) {
              setStatus((err as Error).message);
              setBusy(false);
            }
          }}
        >
          Save
        </button>
      </div>
    </>
  );
}

