// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Settings → Server: starting values for new mailboxes, the mail cache, limits and push. Saved in
// the database; a value set in the environment (the compose file) wins and is shown locked.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SERVER_SETTINGS, type ServerSettingDef, type ServerSettingsView } from '../../../shared/serverSettings';
import { fetchJson } from '../api';

const GROUPS = ['New mailboxes', 'Mail cache', 'Limits and safety', 'Notifications and updates'] as const;
const GROUP_HINTS: Record<(typeof GROUPS)[number], string> = {
  'New mailboxes': 'What the "Add a mailbox" form starts with, for everyone on this server.',
  'Mail cache': 'An encrypted, disposable copy of recent mail, so folders open at once. Changes apply after DreyMail restarts.',
  'Limits and safety': 'Changes apply after DreyMail restarts.',
  'Notifications and updates': 'Changes apply after DreyMail restarts.',
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
    </>
  );
}
