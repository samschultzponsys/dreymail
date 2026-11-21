// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Settings → Server: starting values for new mailboxes, the mail cache, limits and push. Saved in
// the database; a value set in the environment (the compose file) wins and is shown locked.
// DreyMail 11.9: the automatic backups, and one made now.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SERVER_SETTINGS, type ServerSettingDef, type ServerSettingsView } from '../../../shared/serverSettings';
import { fetchJson } from '../api';

const GROUPS = ['New mailboxes', 'Mail cache', 'Limits and safety', 'Notifications and updates', 'Backups'] as const;
const GROUP_HINTS: Record<(typeof GROUPS)[number], string> = {
  'New mailboxes': 'What the "Add a mailbox" form starts with, for everyone on this server.',
  'Mail cache': 'An encrypted, disposable copy of recent mail, so folders open at once. Changes apply after DreyMail restarts.',
  'Limits and safety': 'Changes apply after DreyMail restarts.',
  'Notifications and updates': 'Changes apply after DreyMail restarts.',
  Backups:
    'A copy of the whole database (everyone’s settings and mailboxes, secrets still encrypted with the secret key) every day. Each user can restore their own data from one in Settings → Backup; to restore the whole server, stop DreyMail and put a copy in place of dreymail.db (same secret key).',
};

export function ServerAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'server'], queryFn: () => fetchJson<ServerSettingsView>('GET', '/api/admin/server') });
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft({}), [q.data]);
  if (!q.data) return <div className="hint">Loading…</div>;
  const byEnv = new Map(q.data.settings.map((s) => [s.env, s]));
  const dirty = Object.keys(draft).length > 0;

  const valueOf = (d: ServerSettingDef) => (d.env in draft ? (draft[d.env] ?? '') : (byEnv.get(d.env)?.value ?? ''));
  const set = (env: string, v: string) => {
    setSaved(false);
    setDraft((cur) => ({ ...cur, [env]: v }));
  };
  const save = async () => {
    setBusy(true);
    try {
      const next = await fetchJson<ServerSettingsView>('PUT', '/api/admin/server', { values: draft });
      qc.setQueryData(['admin', 'server'], next);
      setError(null);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (d: ServerSettingDef) => {
    const s = byEnv.get(d.env);
    const locked = !!s?.fromEnv;
    const v = valueOf(d);
    const id = `srv-${d.env}`;
    let input: React.ReactNode;
    if (locked) input = <input id={id} className="input" value={d.type === 'secret' ? '••••••••' : s!.envValue} disabled />;
    else if (d.type === 'bool')
      input = (
        <select id={id} className="select" value={v} onChange={(e) => set(d.env, e.target.value)}>
          <option value="">Default ({d.fallback === 'true' ? 'on' : 'off'})</option>
          <option value="true">On</option>
          <option value="false">Off</option>
        </select>
      );
    else if (d.type === 'security')
      input = (
        <select id={id} className="select" value={v} onChange={(e) => set(d.env, e.target.value)}>
          <option value="">Default (TLS)</option>
          <option value="tls">TLS</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">None (unencrypted)</option>
        </select>
      );
    else if (d.type === 'secret')
      input = <input id={id} className="input" type="password" autoComplete="new-password" value={draft[d.env] ?? ''} placeholder={s?.isSet ? 'Saved (type to replace)' : 'Not set'} onChange={(e) => set(d.env, e.target.value)} />;
    else input = <input id={id} className="input" inputMode={d.type === 'number' ? 'numeric' : undefined} value={v} placeholder={d.fallback ? `Default: ${d.fallback}` : 'Not set'} onChange={(e) => set(d.env, e.target.value)} />;
    return (
      <div key={d.env} className="server-field">
        <label className="label" htmlFor={id}>
          {d.label}
          {locked && (
            <span className="locked-by-env" title={`Set by ${d.env} in the environment, which wins over this page`}>
              <Lock size={11} /> {d.env}
            </span>
          )}
        </label>
        <div className="cal-when-row">
          {input}
          {!locked && (s?.isSet || (d.env in draft && draft[d.env] !== '')) && (
            <button className="icon-btn" title="Back to the default" onClick={() => set(d.env, '')}>
              <RotateCcw size={14} />
            </button>
          )}
        </div>
        {d.hint && <div className="hint">{d.hint}</div>}
      </div>
    );
  };

  return (
    <>
      <div className="hint">
        Settings for everyone on this server. A value set in the environment (the compose file) wins and shows here locked, with its variable&apos;s name.
        The secret key, data folder and address stay in the environment.
      </div>
      {q.data.restartNeeded && <div className="warning-text">Some saved changes apply after DreyMail restarts (restart the container).</div>}
      {GROUPS.map((g) => (
        <section key={g} className="server-group">
          <h3>{g}</h3>
          <div className="hint">{GROUP_HINTS[g]}</div>
          <div className="server-fields">{SERVER_SETTINGS.filter((d) => d.group === g).map(field)}</div>
          {g === 'Backups' && <BackupsAdmin />}
        </section>
      ))}
      {error && <div className="error-text">{error}</div>}
      <div className="cal-when-row">
        <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>
          Save
        </button>
        {dirty && (
          <button className="btn" onClick={() => setDraft({})}>
            Undo changes
          </button>
        )}
        {saved && !dirty && <span className="muted">Saved.</span>}
      </div>
      <RoomsAdmin />
    </>
  );
}

type RoomRow = { email: string; name: string; capacity: number | null; building: string };

/** Meeting rooms people can book (DreyMail 10.7), for calendars without a room list of their own. */
function RoomsAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'rooms'], queryFn: () => fetchJson<RoomRow[]>('GET', '/api/admin/rooms') });
  const [rows, setRows] = useState<RoomRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const list = rows ?? q.data ?? [];
  const edit = (i: number, change: Partial<RoomRow>) => {
    setSaved(false);
    setRows(list.map((r, j) => (j === i ? { ...r, ...change } : r)));
  };
  const save = async () => {
    try {
      const next = await fetchJson<RoomRow[]>('PUT', '/api/admin/rooms', { rooms: list.filter((r) => r.email.trim()) });
      qc.setQueryData(['admin', 'rooms'], next);
      setRows(null);
      setError(null);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['rooms'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="server-group">
      <h3>Meeting rooms</h3>
      <div className="hint">
        Rooms people can book from the event editor: each room&apos;s calendar address (a Microsoft 365 room mailbox, a Google Workspace room calendar like
        …@resource.calendar.google.com, or any calendar that answers invitations). Microsoft 365 rooms also show by themselves once someone allows
        &quot;rooms&quot; for an Outlook mailbox and an administrator approves it.
      </div>
      {list.map((r, i) => (
        <div key={i} className="room-admin-row">
          <input className="input" placeholder="Name (Boardroom)" value={r.name} onChange={(e) => edit(i, { name: e.target.value })} />
          <input className="input" placeholder="Calendar address" value={r.email} onChange={(e) => edit(i, { email: e.target.value })} />
          <input className="input" placeholder="Seats" inputMode="numeric" value={r.capacity ?? ''} onChange={(e) => edit(i, { capacity: Number(e.target.value) || null })} />
          <input className="input" placeholder="Building / floor" value={r.building} onChange={(e) => edit(i, { building: e.target.value })} />
          <button
            className="icon-btn"
            title="Remove"
            onClick={() => {
              setSaved(false);
              setRows(list.filter((_, j) => j !== i));
            }}
          >
            ×
          </button>
        </div>
      ))}
      <div className="cal-when-row">
        <button className="btn" onClick={() => setRows([...list, { email: '', name: '', capacity: null, building: '' }])}>
          Add a room
        </button>
        <button className="btn primary" disabled={!rows} onClick={() => void save()}>
          Save rooms
        </button>
        {saved && !rows && <span className="muted">Saved.</span>}
      </div>
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}

type SnapshotRow = { name: string; createdAt: string; bytes: number };

/** The automatic backups on the server, and one made now (DreyMail 11.9). */
function BackupsAdmin() {
  const q = useQuery({ queryKey: ['admin', 'backups'], queryFn: () => fetchJson<{ enabled: boolean; keepDays: number; backups: SnapshotRow[] }>('GET', '/api/admin/backups') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!q.data) return null;
  if (!q.data.enabled) return <div className="hint">Automatic backups need DreyMail&apos;s data folder (not available in this setup).</div>;
  const now = async () => {
    setBusy(true);
    try {
      await fetchJson('POST', '/api/admin/backups');
      setError(null);
      await q.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {q.data.keepDays === 0 && <div className="warning-text">Automatic backups are off (kept for 0 days).</div>}
      {q.data.backups.length === 0 ? (
        <div className="hint">No backups yet; the first is made within an hour of starting.</div>
      ) : (
        <ul className="user-list">
          {q.data.backups.map((b) => (
            <li key={b.name}>
              <div className="user-main">
                <div className="user-name">{new Date(b.createdAt).toLocaleString()}</div>
                <div className="muted user-meta">
                  backups/{b.name} · {(b.bytes / 1048576).toFixed(1)} MB
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="cal-when-row">
        <button className="btn" disabled={busy} onClick={() => void now()}>
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
