// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Settings → Auto-replies: out of office, sick, on leave, … Each one answers for all mailboxes,
// or for chosen mailboxes and groups, optionally between two dates. The server sends them.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { AccountView, AutoReply, AutoReplyInput, MailboxGroupView } from '../../../shared/types';
import { api, fetchJson } from '../api';
import { useAccounts } from '../hooks';
import { fromLocalInput, toLocalInput } from '../snooze';

const TEMPLATES: { name: string; subject: string; body: string }[] = [
  {
    name: 'Out of office',
    subject: 'Out of office: {subject}',
    body: "Hello,\n\nThank you for your message. I'm out of the office and will reply as soon as I can after I'm back.\n\nBest regards",
  },
  {
    name: 'Out sick',
    subject: 'Out sick: {subject}',
    body: "Hello,\n\nThank you for your message. I'm out sick and will reply when I'm back. For anything urgent, please contact my colleagues.\n\nBest regards",
  },
  {
    name: 'On leave',
    subject: 'On leave: {subject}',
    body: "Hello,\n\nThank you for your message. I'm on leave and not reading email. I'll reply when I'm back.\n\nBest regards",
  },
  {
    name: 'On vacation',
    subject: 'On vacation: {subject}',
    body: "Hello,\n\nThank you for your message. I'm on vacation with limited access to email and will reply when I'm back.\n\nBest regards",
  },
];

const dateText = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Now", "Until Dec 1", "Dec 1 – Dec 8", "Over", "Off". */
function statusText(r: AutoReply): { text: string; live: boolean } {
  const now = Date.now();
  if (!r.enabled) return { text: 'Off', live: false };
  if (r.endsAt && Date.parse(r.endsAt) <= now) return { text: `Ended ${dateText(r.endsAt)}`, live: false };
  if (r.startsAt && Date.parse(r.startsAt) > now) return { text: `From ${dateText(r.startsAt)}${r.endsAt ? ` to ${dateText(r.endsAt)}` : ''}`, live: false };
  return { text: r.endsAt ? `On until ${dateText(r.endsAt)}` : 'On', live: true };
}

export function AutoRepliesSettings() {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups });
  const replies = useQuery({ queryKey: ['auto-replies'], queryFn: () => fetchJson<AutoReply[]>('GET', '/api/auto-replies') });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!accounts.data || !replies.data || !groups.data) return <div className="hint">Loading…</div>;
  const set = (list: AutoReply[]) => qc.setQueryData(['auto-replies'], list);
  const run = async (f: () => Promise<AutoReply[]>) => {
    setError(null);
    try {
      set(await f());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const toggle = (r: AutoReply) => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...input } = r;
    void run(() => fetchJson('PUT', `/api/auto-replies/${encodeURIComponent(r.id)}`, { ...input, enabled: !r.enabled }));
  };

  return (
    <div className="stack">
      <div className="hint">
        Automatic answers to new mail while you're away: out of office, sick, on leave and so on. Your server sends them, even with DreyMail closed. Each
        sender gets one at most once every few days, and mailing lists, newsletters, other automatic mail and no-reply addresses never get one. When
        several apply to a mailbox, the one that names the mailbox wins, then one for its group, then one for all mailboxes.
      </div>
      {replies.data.length === 0 && editing !== 'new' && <div className="empty-note">No auto-replies yet.</div>}
      {replies.data.map((r) => {
        if (editing === r.id) {
          const { id: _id, createdAt: _c, updatedAt: _u, ...initial } = r;
          return (
            <AutoReplyEditor
              key={r.id}
              initial={initial}
              accounts={accounts.data}
              groups={groups.data}
              error={error}
              onCancel={() => (setEditing(null), setError(null))}
              onSave={async (input) => (await run(() => fetchJson('PUT', `/api/auto-replies/${encodeURIComponent(r.id)}`, input))) && setEditing(null)}
              onDelete={async () => {
                if (!window.confirm(`Delete "${r.name}"?`)) return;
                if (await run(() => fetchJson('DELETE', `/api/auto-replies/${encodeURIComponent(r.id)}`))) setEditing(null);
              }}
            />
          );
        }
        const status = statusText(r);
        return (
          <div key={r.id} className="sig-card auto-reply-card">
            <span className="sig-card-head">
              <label className="check" title={r.enabled ? 'Turn off' : 'Turn on'}>
                <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} disabled={editing !== null} aria-label={`${r.name} on`} />
              </label>
              <strong>{r.name}</strong>
              <span className={`chip ${status.live ? 'live' : ''}`}>{status.text}</span>
              <span className="grow" />
              <button className="btn" onClick={() => setEditing(r.id)} disabled={editing !== null}>
                Edit
              </button>
            </span>
            <span className="sig-accounts">
              {r.allMailboxes ? (
                <span className="chip">All mailboxes</span>
              ) : (
                <>
                  {groups.data
                    .filter((g) => r.groupIds.includes(g.id))
                    .map((g) => (
                      <span key={g.id} className="chip">
                        <span className="dot" style={{ background: g.color }} />
                        {g.name} (group)
                      </span>
                    ))}
                  {accounts.data
                    .filter((a) => r.accountIds.includes(a.id))
                    .map((a) => (
                      <span key={a.id} className="chip">
                        <span className="dot" style={{ background: a.color }} />
                        {a.name}
                      </span>
                    ))}
                </>
              )}
            </span>
          </div>
        );
      })}
      {editing === 'new' ? (
        <AutoReplyEditor
          initial={{ ...TEMPLATES[0]!, enabled: true, startsAt: null, endsAt: null, allMailboxes: true, accountIds: [], groupIds: [], intervalDays: 4 }}
          isNew
          accounts={accounts.data}
          groups={groups.data}
          error={error}
          onCancel={() => (setEditing(null), setError(null))}
          onSave={async (input) => (await run(() => fetchJson('POST', '/api/auto-replies', input))) && setEditing(null)}
        />
      ) : (
        <div>
          <button className="btn" onClick={() => setEditing('new')} disabled={editing !== null}>
            <Plus size={15} /> New auto-reply
          </button>
        </div>
      )}
      {error && editing === null && <div className="error-text">{error}</div>}
    </div>
  );
}

function AutoReplyEditor({
  initial,
  isNew,
  accounts,
  groups,
  error,
  onCancel,
  onSave,
  onDelete,
}: {
  initial: AutoReplyInput;
  isNew?: boolean;
  accounts: AccountView[];
  groups: MailboxGroupView[];
  error: string | null;
  onCancel: () => void;
  onSave: (input: AutoReplyInput) => Promise<unknown>;
  onDelete?: () => void;
}) {
  const [v, setV] = useState(initial);
  const [starts, setStarts] = useState(initial.startsAt ? toLocalInput(new Date(initial.startsAt)) : '');
  const [ends, setEnds] = useState(initial.endsAt ? toLocalInput(new Date(initial.endsAt)) : '');
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<AutoReplyInput>) => setV((o) => ({ ...o, ...p }));
  const toggleIn = (key: 'accountIds' | 'groupIds', id: string, on: boolean) => patch({ [key]: on ? [...v[key], id] : v[key].filter((x) => x !== id) });

  return (
    <form
      className="sig-editor auto-reply-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSave({ ...v, startsAt: fromLocalInput(starts)?.toISOString() ?? null, endsAt: fromLocalInput(ends)?.toISOString() ?? null }).finally(() => setBusy(false));
      }}
    >
      {isNew && (
        <div>
          <label className="label">Start from</label>
          <div className="segmented" style={{ flexWrap: 'wrap' }}>
            {TEMPLATES.map((t) => (
              <button type="button" key={t.name} className={v.name === t.name ? 'on' : ''} onClick={() => patch(t)} style={{ padding: '6px 12px' }}>
                {t.name}
              </button>
            ))}
            <button type="button" className={TEMPLATES.some((t) => t.name === v.name) ? '' : 'on'} onClick={() => patch({ name: '', subject: 'Auto: {subject}', body: '' })} style={{ padding: '6px 12px' }}>
              Blank
            </button>
          </div>
        </div>
      )}
      <label className="label" htmlFor="ar-name">
        Name
      </label>
      <input id="ar-name" className="input" required maxLength={80} value={v.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Out of office" />
      <label className="label" htmlFor="ar-subject">
        Subject
      </label>
      <input id="ar-subject" className="input" required maxLength={300} value={v.subject} onChange={(e) => patch({ subject: e.target.value })} />
      <label className="label" htmlFor="ar-body">
        Message
      </label>
      <textarea id="ar-body" className="input" required rows={7} maxLength={20_000} value={v.body} onChange={(e) => patch({ body: e.target.value })} />
      <div className="hint">{'{subject}'} is replaced with the subject of the message being answered. Sent as plain text.</div>

      <label className="label">Answers for</label>
      <label className="check">
        <input type="checkbox" checked={v.allMailboxes} onChange={(e) => patch({ allMailboxes: e.target.checked })} /> All mailboxes
      </label>
      {!v.allMailboxes && (
        <div className="check-list auto-reply-scope">
          {groups.map((g) => (
            <label key={g.id} className="check">
              <input type="checkbox" checked={v.groupIds.includes(g.id)} onChange={(e) => toggleIn('groupIds', g.id, e.target.checked)} />
              <span className="dot" style={{ background: g.color }} /> {g.name} <span className="muted">(group: {g.accountIds.length} mailbox{g.accountIds.length === 1 ? '' : 'es'})</span>
            </label>
          ))}
          {accounts.map((a) => (
            <label key={a.id} className="check">
              <input type="checkbox" checked={v.accountIds.includes(a.id)} onChange={(e) => toggleIn('accountIds', a.id, e.target.checked)} />
              <span className="dot" style={{ background: a.color }} /> {a.name} <span className="muted">{a.email}</span>
            </label>
          ))}
        </div>
      )}

      <label className="label">When</label>
      <div className="auto-reply-dates">
        <label>
          <span className="muted">From</span>
          <input className="input" type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} aria-label="From" />
        </label>
        <label>
          <span className="muted">Until</span>
          <input className="input" type="datetime-local" value={ends} min={starts || undefined} onChange={(e) => setEnds(e.target.value)} aria-label="Until" />
        </label>
      </div>
      <div className="hint">Leave empty to start now or keep going until you turn it off.</div>

      <label className="label" htmlFor="ar-interval">
        Answer the same sender again after
      </label>
      <select id="ar-interval" className="input" value={v.intervalDays} onChange={(e) => patch({ intervalDays: Number(e.target.value) })} style={{ maxWidth: 200 }}>
        {[1, 2, 4, 7, 14, 30].map((n) => (
          <option key={n} value={n}>
            {n} day{n === 1 ? '' : 's'}
          </option>
        ))}
      </select>

      <label className="check">
        <input type="checkbox" checked={v.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> On
      </label>
      {error && <div className="error-text">{error}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete} style={{ marginLeft: 'auto' }}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
