// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// AI connections for the mailbox assistant: which AI service, key and model, a daily limit, and
// checkboxes for the mailboxes that use it. Cloud services or your own local server.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus, Server, Share2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AI_PRESETS, presetFor, README_AI_URL, type AiConnectionView } from '../../../shared/aiProviders';
import type { AccountView } from '../../../shared/types';
import { api, type AiConnectionInput } from '../api';

export function useAiConnections(enabled = true) {
  return useQuery({ queryKey: ['ai', 'connections'], queryFn: api.aiConnections, enabled });
}

/** Link to the README's guide (the version running, so it matches this screen). */
export function AiGuideLink({ children = 'Guide: services, keys and which models to pick' }: { children?: string }) {
  const version = useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 3600_000 });
  return (
    <a className="guide-link" href={README_AI_URL(version.data?.version ?? '3.1')} target="_blank" rel="noreferrer">
      {children} <ExternalLink size={12} />
    </a>
  );
}

export function ConnectionForm({
  initial,
  canShare,
  onSaved,
  onCancel,
}: {
  initial: AiConnectionView | null;
  canShare: boolean;
  onSaved: (list: AiConnectionView[]) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<AiConnectionInput>(() =>
    initial
      ? { name: initial.name, preset: initial.preset, baseUrl: initial.baseUrl, model: initial.model, apiKey: '', dailyLimit: initial.dailyLimit, shared: initial.shared }
      : { name: 'Claude', preset: 'anthropic', baseUrl: presetFor('anthropic')!.baseUrl, model: 'claude-haiku-5-5', apiKey: '', dailyLimit: 500, shared: false },
  );
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const preset = presetFor(v.preset) ?? presetFor('custom')!;
  const target = { ...(initial ? { id: initial.id } : {}), preset: v.preset, baseUrl: v.baseUrl, apiKey: v.apiKey };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="sig-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => onSaved(await api.saveAiConnection(initial?.id ?? null, v)));
      }}
    >
      <div className="grid2">
        <div>
          <label className="label" htmlFor="ai-preset">
            AI service
          </label>
          <select
            id="ai-preset"
            className="input"
            value={v.preset}
            onChange={(e) => {
              const p = presetFor(e.target.value)!;
              setModels([]);
              setV({ ...v, preset: p.id, baseUrl: p.baseUrl, name: p.label.replace(/ \(.*\)$/, ''), model: p.suggestions[0]?.model ?? '' });
            }}
          >
            <optgroup label="Cloud services">
              {AI_PRESETS.filter((p) => !p.local && p.id !== 'custom').map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="On your own computer or server">
              {AI_PRESETS.filter((p) => p.local || p.id === 'custom').map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ai-name">
            Name
          </label>
          <input id="ai-name" className="input" value={v.name} maxLength={80} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </div>
      </div>
      {preset.local && (
        <div className="hint">
          <Server size={12} /> Runs on your own hardware, so your mail never leaves your network. Use the address DreyMail's server can reach (for Docker, often the host's IP rather than
          localhost). Local servers can only be added by an administrator, as a shared connection.
        </div>
      )}
      <div>
        <label className="label" htmlFor="ai-url">
          Server address
        </label>
        <input id="ai-url" className="input" value={v.baseUrl} placeholder="https://… or http://192.168.1.10:1234/v1" onChange={(e) => setV({ ...v, baseUrl: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="ai-key">
          API key {!preset.keyRequired && <span className="muted">(usually not needed)</span>}
        </label>
        <input
          id="ai-key"
          className="input"
          type="password"
          autoComplete="off"
          value={v.apiKey}
          placeholder={initial?.hasKey ? 'Unchanged' : preset.keyRequired ? 'Paste your key' : 'Leave empty'}
          onChange={(e) => setV({ ...v, apiKey: e.target.value })}
        />
        {preset.keyUrl && (
          <div className="hint">
            <a href={preset.keyUrl} target="_blank" rel="noreferrer">
              Get a key <ExternalLink size={11} />
            </a>{' '}
            · stored encrypted, never shown again
          </div>
        )}
      </div>
      <div>
        <label className="label" htmlFor="ai-model">
          Model
        </label>
        <div className="row-buttons">
          <input id="ai-model" className="input grow" list="ai-models" value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })} placeholder="Model name" />
          <datalist id="ai-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => setModels((await api.aiModels(target)).models))}>
            Load models
          </button>
        </div>
        {models.length > 0 && <div className="hint">{models.length} models found; start typing to pick one.</div>}
        {preset.suggestions.length > 0 && (
          <ul className="model-tips">
            {preset.suggestions.map((s) => (
              <li key={s.model || s.note}>
                {s.model ? (
                  <button type="button" className={`chip ${v.model === s.model ? 'on' : ''}`} onClick={() => setV({ ...v, model: s.model })}>
                    {s.model}
                  </button>
                ) : null}{' '}
                <span className="muted">{s.note}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="hint">Sorting mail is a simple job: a small, inexpensive model is usually all it takes. Bigger models cost more without sorting much better.</div>
      </div>
      <div className="grid2">
        <div>
          <label className="label" htmlFor="ai-limit">
            Daily limit (AI requests)
          </label>
          <input id="ai-limit" className="input" type="number" min={0} value={v.dailyLimit} onChange={(e) => setV({ ...v, dailyLimit: Math.max(0, Number(e.target.value) || 0) })} />
          <div className="hint">One request per message the AI looks at. 0 = no limit.</div>
        </div>
        {canShare && (
          <label className="check" style={{ alignSelf: 'center' }}>
            <input type="checkbox" checked={v.shared} disabled={!!initial} onChange={(e) => setV({ ...v, shared: e.target.checked })} />
            Share with everyone allowed to use the assistant (they never see the key)
          </label>
        )}
      </div>
      {status && <div className={status.ok ? 'hint ok-text' : 'error-text'}>{status.text}</div>}
      <div className="row-buttons">
        <AiGuideLink />
        <span className="grow" />
        <button
          type="button"
          className="btn"
          disabled={busy || !v.model}
          onClick={() => void run(async () => setStatus((await api.aiTest({ ...target, model: v.model })).ok ? { ok: true, text: 'It works: the AI answered.' } : { ok: false, text: 'The AI answered, but not as expected.' }))}
        >
          Test
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !v.name.trim() || !v.model.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

/** Settings → AI connections: the list, the form, and per connection the mailboxes that use it. */
export function AiConnections({ accounts, canShare }: { accounts: AccountView[]; canShare: boolean }) {
  const qc = useQueryClient();
  const list = useAiConnections();
  const [editing, setEditing] = useState<AiConnectionView | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (l: AiConnectionView[]) => qc.setQueryData(['ai', 'connections'], l);

  if (!list.data) return <div className="hint">{list.error ? (list.error as Error).message : 'Loading…'}</div>;

  return (
    <div className="stack">
      <div className="hint">
        An AI connection is the AI service the assistant asks about your mail: a cloud service with your own API key, or a model running on your own hardware. Use one for all your
        mailboxes, or a different one per mailbox. <AiGuideLink />
      </div>
      {list.data.length === 0 && !editing && <div className="muted">No AI connections yet.</div>}
      <ul className="role-list">
        {list.data.map((c) => (
          <li key={c.id} className="ai-conn">
            <div className="user-main">
              <div className="user-name">
                {c.name}
                {c.shared && (
                  <span className="chip">
                    <Share2 size={11} /> Shared
                  </span>
                )}
              </div>
              <div className="muted user-meta">
                {presetFor(c.preset)?.label ?? c.preset} · {c.model || 'no model'} · {c.usedToday}
                {c.dailyLimit ? ` / ${c.dailyLimit}` : ''} requests today
              </div>
              <div className="ai-conn-boxes">
                {accounts.map((a) => (
                  <label key={a.id} className="check">
                    <input
                      type="checkbox"
                      checked={c.accountIds.includes(a.id)}
                      onChange={(e) =>
                        void api
                          .aiConnectionMailboxes(c.id, e.target.checked ? [...c.accountIds, a.id] : c.accountIds.filter((x) => x !== a.id))
                          .then(set, (err: Error) => setError(err.message))
                      }
                    />
                    <span className="dot" style={{ background: a.color }} /> {a.name}
                  </label>
                ))}
              </div>
            </div>
            {(!c.shared || canShare) && (
              <div className="user-actions">
                <button className="icon-btn" title="Edit" onClick={() => setEditing(c)}>
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-btn danger-text"
                  title="Remove"
                  onClick={() => {
                    if (window.confirm(`Remove the AI connection "${c.name}"? Mailboxes that use it stop being sorted until you pick another.`)) {
                      void api.deleteAiConnection(c.id).then(set, (err: Error) => setError(err.message));
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
      {editing ? (
        <ConnectionForm
          initial={editing === 'new' ? null : editing}
          canShare={canShare}
          onCancel={() => setEditing(null)}
          onSaved={(l) => {
            set(l);
            setEditing(null);
          }}
        />
      ) : (
        <div>
          <button className="btn" onClick={() => setEditing('new')}>
            <Plus size={15} /> Add AI connection
          </button>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
