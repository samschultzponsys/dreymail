// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The AI mailbox assistant for one mailbox: the notice (first time), setup (on/off, AI connection,
// how much the AI sees), rules built point-and-click, a test against recent mail, and the history
// of what it did, with undo.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, Check, History, ListChecks, Pencil, Plus, Settings2, Sparkles, Trash2, Undo2, X, FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { ACCURACY_LEVELS } from '../../../shared/aiProviders';
import { RULE_ACTION_LABELS, type AssistantDecision, type AssistantRule, type RuleAction, type RuleInput } from '../../../shared/assistant';
import type { AccountFolders, AccountView } from '../../../shared/types';
import { api } from '../api';
import { AiGuideLink, ConnectionForm, useAiConnections } from './AiConnections';
import { MailboxIcon } from './MailboxIcon';

type Tab = 'setup' | 'rules' | 'test' | 'history';

function Notice({ onAccept }: { onAccept: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="dialog-body assistant-notice">
      <AlertTriangle size={28} />
      <h3>Before you start</h3>
      <p>
        The AI assistant reads your mail and acts on it in your mailbox (moving, labeling, archiving, deleting) according to the rules you set. <strong>AI can make
        mistakes.</strong> It can misread a message or pick the wrong rule.
      </p>
      <ul>
        <li>You use the assistant at your own risk.</li>
        <li>Test rules on recent mail before switching them on, and check the history now and then. Most actions can be undone there.</li>
        <li>What the AI sees of your mail goes to the AI service you choose, under that service's terms. A model on your own hardware keeps it on your network.</li>
        <li>AI services charge for use. Set a daily limit on each connection.</li>
      </ul>
      <label className="check">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />I understand and want to use the AI assistant at my own risk.
      </label>
      <div className="row-buttons">
        <span className="grow" />
        <button className="btn primary" disabled={!ok} onClick={onAccept}>
          Continue
        </button>
      </div>
    </div>
  );
}

/** Accuracy: how much of each message the AI sees. Holding the slider shows exactly what. */
function AccuracySlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [held, setHeld] = useState(false);
  const level = ACCURACY_LEVELS.find((l) => l.level === value) ?? ACCURACY_LEVELS[3];
  return (
    <div className="accuracy">
      <label className="label" htmlFor="accuracy">
        Accuracy: how much of each message the AI sees
      </label>
      <div className="accuracy-track">
        {held && (
          <div className="accuracy-bubble" style={{ left: `${((value - 1) / 3) * 100}%` }} role="tooltip">
            <strong>{level.label}</strong>
            <span>{level.sees}</span>
          </div>
        )}
        <input
          id="accuracy"
          type="range"
          min={1}
          max={4}
          step={1}
          value={value}
          aria-valuetext={`${level.label}: ${level.sees}`}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerDown={() => setHeld(true)}
          onPointerUp={() => setHeld(false)}
          onPointerCancel={() => setHeld(false)}
          onBlur={() => setHeld(false)}
        />
        <div className="accuracy-labels">
          {ACCURACY_LEVELS.map((l) => (
            <span key={l.level} className={l.level === value ? 'on' : ''}>
              {l.label}
            </span>
          ))}
        </div>
      </div>
      <div className="hint">
        <strong>{level.label}:</strong> {level.sees}. More lets the AI decide more accurately; less keeps more of your mail private and costs less.
      </div>
    </div>
  );
}

const EMPTY_RULE: RuleInput = { name: '', instructions: '', conditions: {}, actions: [{ type: 'archive' }], enabled: true };

function actionText(a: RuleAction): string {
  if (a.type === 'move') return `Move to ${a.folder}`;
  if (a.type === 'label') return `Label "${a.name}"`;
  return RULE_ACTION_LABELS[a.type];
}

/** The rule builder: plain-language description, optional exact conditions, and actions to pick. */
function RuleEditor({
  initial,
  folders,
  onSave,
  onCancel,
  onTest,
  busy,
}: {
  initial: RuleInput;
  folders: string[];
  onSave: (r: RuleInput) => void;
  onCancel: () => void;
  onTest: (r: RuleInput) => void;
  busy: boolean;
}) {
  const [r, setR] = useState<RuleInput>(initial);
  const c = r.conditions;
  const setCond = (k: keyof typeof c, v: string | boolean | undefined) => {
    const next = { ...c } as Record<string, unknown>;
    if (v === undefined || v === '') delete next[k];
    else next[k] = v;
    setR({ ...r, conditions: next });
  };
  const setAction = (i: number, a: RuleAction) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? a : x)) });
  const valid = r.name.trim() && r.actions.length > 0 && r.actions.every((a) => (a.type === 'move' ? a.folder.trim() : a.type === 'label' ? a.name.trim() : true)) && (r.instructions.trim() || Object.keys(c).length > 0);

  return (
    <form
      className="sig-editor rule-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(r);
      }}
    >
      <div>
        <label className="label" htmlFor="rule-name">
          Rule name
        </label>
        <input id="rule-name" className="input" value={r.name} maxLength={100} placeholder="Newsletters" onChange={(e) => setR({ ...r, name: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="rule-instr">
          Which mail is this for? <span className="muted">(in your own words; the AI decides)</span>
        </label>
        <textarea
          id="rule-instr"
          className="input"
          rows={3}
          maxLength={2000}
          value={r.instructions}
          placeholder="Newsletters and marketing emails I didn't ask for, except from my bank and my kids' school."
          onChange={(e) => setR({ ...r, instructions: e.target.value })}
        />
        <div className="hint">Leave empty to use only the exact conditions below (instant, no AI needed).</div>
      </div>
      <fieldset className="perm-group">
        <legend>Only when (optional, exact)</legend>
        <div className="grid2">
          <label className="sp-field">
            <span>From contains</span>
            <input className="input" value={c.from ?? ''} onChange={(e) => setCond('from', e.target.value)} placeholder="shop.example" />
          </label>
          <label className="sp-field">
            <span>To contains</span>
            <input className="input" value={c.to ?? ''} onChange={(e) => setCond('to', e.target.value)} />
          </label>
          <label className="sp-field">
            <span>Subject contains</span>
            <input className="input" value={c.subject ?? ''} onChange={(e) => setCond('subject', e.target.value)} placeholder="Invoice" />
          </label>
          <label className="sp-field">
            <span>Attachments</span>
            <select className="input" value={c.hasAttachment === undefined ? '' : c.hasAttachment ? 'yes' : 'no'} onChange={(e) => setCond('hasAttachment', e.target.value === '' ? undefined : e.target.value === 'yes')}>
              <option value="">Doesn't matter</option>
              <option value="yes">Has attachments</option>
              <option value="no">No attachments</option>
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset className="perm-group">
        <legend>Then</legend>
        {r.actions.map((a, i) => (
          <div key={i} className="rule-action">
            <select
              className="input"
              value={a.type}
              onChange={(e) => {
                const t = e.target.value as RuleAction['type'];
                setAction(i, t === 'move' ? { type: 'move', folder: '' } : t === 'label' ? { type: 'label', name: '' } : ({ type: t } as RuleAction));
              }}
            >
              {(Object.keys(RULE_ACTION_LABELS) as RuleAction['type'][]).map((t) => (
                <option key={t} value={t}>
                  {RULE_ACTION_LABELS[t]}
                </option>
              ))}
            </select>
            {a.type === 'move' && (
              <>
                <input className="input grow" list="rule-folders" value={a.folder} placeholder="Folder (new ones are created)" onChange={(e) => setAction(i, { type: 'move', folder: e.target.value })} />
                <datalist id="rule-folders">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </>
            )}
            {a.type === 'label' && <input className="input grow" value={a.name} placeholder="Label name" onChange={(e) => setAction(i, { type: 'label', name: e.target.value })} />}
            {r.actions.length > 1 && (
              <button type="button" className="icon-btn" title="Remove this action" onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}>
                <X size={15} />
              </button>
            )}
          </div>
        ))}
        {r.actions.length < 8 && (
          <button type="button" className="btn" onClick={() => setR({ ...r, actions: [...r.actions, { type: 'read' }] })}>
            <Plus size={14} /> Another action
          </button>
        )}
        <div className="hint">Labels are real labels in Gmail; elsewhere they are tags where the server supports them, or a copy in a folder of that name.</div>
      </fieldset>
      <div className="row-buttons">
        <button type="button" className="btn" disabled={!valid || busy} onClick={() => onTest(r)}>
          <FlaskConical size={15} /> Test this rule
        </button>
        <span className="grow" />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid || busy}>
          Save rule
        </button>
      </div>
    </form>
  );
}

function Decisions({ items, rules, onApply, busy }: { items: AssistantDecision[]; rules: AssistantRule[]; onApply?: (d: AssistantDecision) => void; busy: boolean }) {
  if (items.length === 0) return <div className="muted">No messages in the inbox.</div>;
  return (
    <ul className="decisions">
      {items.map((d) => (
        <li key={`${d.uidValidity}:${d.uid}`} className={d.error ? 'error' : d.ruleId ? 'hit' : ''}>
          <div className="user-main">
            <div className="decision-subject">{d.subject || '(no subject)'}</div>
            <div className="muted user-meta">{d.from}</div>
            {d.error ? (
              <div className="error-text">{d.error}</div>
            ) : d.ruleId ? (
              <div className="decision-rule">
                <Check size={13} /> <strong>{d.ruleName || rules.find((r) => r.id === d.ruleId)?.name}</strong>: {d.actions.map(actionText).join(', ')}
                <span className="muted"> · {d.reason}</span>
              </div>
            ) : (
              <div className="muted">No rule applies · {d.reason}</div>
            )}
          </div>
          {onApply && d.ruleId && d.ruleId !== 'draft' && !d.error && (
            <button className="btn" disabled={busy} onClick={() => onApply(d)}>
              Do it
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AssistantDialog({ account, folders, onClose }: { account: AccountView; folders: AccountFolders | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: api.assistantStatus });
  const conns = useAiConnections(!!status.data?.allowed);
  const data = useQuery({ queryKey: ['ai', 'mailbox', account.id], queryFn: () => api.assistantMailbox(account.id), enabled: !!status.data?.allowed });
  const history = useQuery({ queryKey: ['ai', 'history', account.id], queryFn: () => api.assistantHistory(account.id), enabled: false });
  const [tab, setTab] = useState<Tab>('setup');
  const [editing, setEditing] = useState<{ id: string | null; rule: RuleInput } | null>(null);
  const [preview, setPreview] = useState<{ title: string; items: AssistantDecision[] } | null>(null);
  const [limit, setLimit] = useState(25);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingConn, setAddingConn] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setRules = (rules: AssistantRule[]) => {
    qc.setQueryData(['ai', 'mailbox', account.id], (old: typeof data.data) => (old ? { ...old, rules } : old));
  };
  const folderPaths = (folders?.folders ?? []).filter((f) => f.selectable && f.specialUse !== 'inbox').map((f) => f.path);

  const body = () => {
    if (!status.data || (status.data.allowed && (!data.data || !conns.data))) return <div className="dialog-body hint">Loading…</div>;
    if (!status.data.allowed) return <div className="dialog-body hint">Your role doesn't include the AI assistant. An administrator can turn it on for you.</div>;
    if (!status.data.acceptedTerms) return <Notice onAccept={() => void run(async () => (await api.acceptAssistantTerms(), void (await status.refetch())))} />;
    const { settings, rules } = data.data!;
    const connections = conns.data!;
    const save = (s: Partial<typeof settings>) =>
      void run(async () => {
        const next = await api.saveAssistantSettings(account.id, { enabled: settings.enabled, connectionId: settings.connectionId, accuracy: settings.accuracy, ...s });
        qc.setQueryData(['ai', 'mailbox', account.id], { settings: next, rules });
        void qc.invalidateQueries({ queryKey: ['ai', 'connections'] });
      });

    return (
      <>
        <div className="tabs" role="tablist">
          {(
            [
              ['setup', 'Setup', Settings2],
              ['rules', `Rules (${rules.length})`, ListChecks],
              ['test', 'Test', FlaskConical],
              ['history', 'History', History],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={`tab ${tab === key ? 'on' : ''}`}
              onClick={() => {
                setTab(key);
                if (key === 'history') void history.refetch();
              }}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <div className="dialog-body">
          {tab === 'setup' && (
            <div className="stack">
              <div>
                <label className="label" htmlFor="ai-conn">
                  AI connection
                </label>
                {connections.length > 0 && (
                  <select id="ai-conn" className="input" value={settings.connectionId ?? ''} onChange={(e) => save({ connectionId: e.target.value || null, ...(e.target.value ? {} : { enabled: false }) })}>
                    <option value="">Choose…</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.model}
                        {c.shared ? ' (shared)' : ''}
                      </option>
                    ))}
                  </select>
                )}
                {addingConn ? (
                  <ConnectionForm
                    initial={null}
                    canShare={status.data.canShare}
                    onCancel={() => setAddingConn(false)}
                    onSaved={(l) => {
                      qc.setQueryData(['ai', 'connections'], l);
                      setAddingConn(false);
                      const added = l.find((c) => !connections.some((o) => o.id === c.id));
                      if (added && !settings.connectionId) save({ connectionId: added.id });
                    }}
                  />
                ) : (
                  <button className="btn" style={{ marginTop: 8 }} onClick={() => setAddingConn(true)}>
                    <Plus size={14} /> Add AI connection
                  </button>
                )}
              </div>
              <AccuracySlider value={settings.accuracy} onChange={(accuracy) => save({ accuracy })} />
              <label className="check assistant-switch">
                <input type="checkbox" checked={settings.enabled} disabled={!settings.connectionId || busy} onChange={(e) => save({ enabled: e.target.checked })} />
                <span>
                  <strong>Sort new mail automatically</strong>
                  <span className="hint">New mail in this mailbox's inbox goes through your rules as it arrives, even while DreyMail isn't open.</span>
                </span>
              </label>
              {!rules.length && <div className="hint">Next: add rules in the Rules tab, then try them in Test.</div>}
              <div className="hint warn-text">
                <AlertTriangle size={12} /> AI can make mistakes; you use the assistant at your own risk. Check the History tab now and then.
              </div>
              <AiGuideLink />
            </div>
          )}

          {tab === 'rules' && (
            <div className="stack">
              {!editing && (
                <div className="hint">Rules are checked from the top; the first that applies wins. Rules with only exact conditions don't use the AI at all.</div>
              )}
              {!editing && (
                <ul className="role-list">
                  {rules.map((r, i) => (
                    <li key={r.id} className={r.enabled ? '' : 'rule-off'}>
                      <label className="check" title={r.enabled ? 'On' : 'Off'}>
                        <input type="checkbox" checked={r.enabled} onChange={(e) => void run(async () => setRules(await api.saveAssistantRule(account.id, r.id, { ...r, enabled: e.target.checked })))} />
                      </label>
                      <div className="user-main">
                        <div className="user-name">{r.name}</div>
                        <div className="muted user-meta">
                          {r.instructions ? `“${r.instructions.slice(0, 120)}${r.instructions.length > 120 ? '…' : ''}”` : 'Exact conditions only'} → {r.actions.map(actionText).join(', ')}
                        </div>
                      </div>
                      <div className="user-actions">
                        <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => void run(async () => setRules(await api.orderAssistantRules(account.id, rules.map((x) => x.id).toSpliced(i - 1, 2, r.id, rules[i - 1]!.id))))}>
                          <ArrowUp size={15} />
                        </button>
                        <button className="icon-btn" title="Move down" disabled={i === rules.length - 1} onClick={() => void run(async () => setRules(await api.orderAssistantRules(account.id, rules.map((x) => x.id).toSpliced(i, 2, rules[i + 1]!.id, r.id))))}>
                          <ArrowDown size={15} />
                        </button>
                        <button className="icon-btn" title="Edit" onClick={() => setEditing({ id: r.id, rule: r })}>
                          <Pencil size={15} />
                        </button>
                        <button className="icon-btn danger-text" title="Delete" onClick={() => window.confirm(`Delete the rule "${r.name}"?`) && void run(async () => setRules(await api.deleteAssistantRule(account.id, r.id)))}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {editing ? (
                <>
                  <RuleEditor
                    initial={editing.rule}
                    folders={folderPaths}
                    busy={busy}
                    onCancel={() => {
                      setEditing(null);
                      setPreview(null);
                    }}
                    onSave={(rule) =>
                      void run(async () => {
                        setRules(await api.saveAssistantRule(account.id, editing.id, rule));
                        setEditing(null);
                        setPreview(null);
                      })
                    }
                    onTest={(rule) => void run(async () => setPreview({ title: `"${rule.name}" on your newest ${limit} messages`, items: (await api.assistantPreview(account.id, limit, rule)).decisions }))}
                  />
                  {preview && (
                    <div>
                      <label className="label">{preview.title}</label>
                      <Decisions items={preview.items} rules={rules} busy={busy} />
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <button className="btn" onClick={() => setEditing({ id: null, rule: EMPTY_RULE })}>
                    <Plus size={15} /> New rule
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'test' && (
            <div className="stack">
              <div className="hint">See what your rules would do with the newest messages in the inbox. Nothing changes unless you press Do it.</div>
              <div className="row-buttons">
                <select className="input" style={{ width: 'auto' }} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      Newest {n}
                    </option>
                  ))}
                </select>
                <button className="btn primary" disabled={busy || !settings.connectionId || !rules.some((r) => r.enabled)} onClick={() => void run(async () => setPreview({ title: '', items: (await api.assistantPreview(account.id, limit)).decisions }))}>
                  <Sparkles size={15} /> {busy ? 'Checking…' : 'Check now'}
                </button>
              </div>
              {!settings.connectionId && <div className="hint">Choose an AI connection in Setup first.</div>}
              {preview && !editing && (
                <Decisions
                  items={preview.items}
                  rules={rules}
                  busy={busy}
                  onApply={(d) =>
                    void run(async () => {
                      await api.assistantApply(account.id, d);
                      setPreview({ ...preview, items: preview.items.filter((x) => !(x.uid === d.uid && x.uidValidity === d.uidValidity)) });
                      void qc.invalidateQueries({ queryKey: ['messages'] });
                    })
                  }
                />
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="stack">
              {!history.data ? (
                <div className="hint">{history.isFetching ? 'Loading…' : ''}</div>
              ) : history.data.length === 0 ? (
                <div className="muted">Nothing yet. What the assistant does shows up here.</div>
              ) : (
                <ul className="decisions">
                  {history.data.map((h) => (
                    <li key={h.id} className={h.error ? 'error' : h.undone ? 'undone' : ''}>
                      <div className="user-main">
                        <div className="decision-subject">{h.subject || '(no subject)'}</div>
                        <div className="muted user-meta">
                          {new Date(h.at).toLocaleString()} · {h.source === 'auto' ? 'automatic' : h.source === 'manual' ? 'from Test' : 'cleanup'} · {h.from}
                        </div>
                        {h.error ? (
                          <div className="error-text">{h.error}</div>
                        ) : (
                          <div className="decision-rule">
                            <strong>{h.ruleName}</strong>: {h.actions.map(actionText).join(', ')}
                            {h.undone && <span className="muted"> · undone</span>}
                          </div>
                        )}
                      </div>
                      {h.undoable && (
                        <button className="btn" disabled={busy} onClick={() => void run(async () => (qc.setQueryData(['ai', 'history', account.id], await api.assistantUndo(account.id, h.id)), void qc.invalidateQueries({ queryKey: ['messages'] })))}>
                          <Undo2 size={14} /> Undo
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && <div className="error-text">{error}</div>}
        </div>
      </>
    );
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`AI assistant for ${account.name}`} style={{ width: 'min(720px, 100%)', height: 'min(780px, calc(100dvh - 32px))' }}>
        <div className="dialog-head">
          <h2 className="assistant-title">
            <Sparkles size={17} /> AI assistant · <MailboxIcon icon={account.icon} image={account.iconImage} color={account.color} size={16} /> {account.name}
          </h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        {body()}
      </div>
    </div>
  );
}
