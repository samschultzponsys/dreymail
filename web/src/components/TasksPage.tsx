// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The Tasks page (DreyMail 10.4): DreyMail's own task lists next to Microsoft To Do and Google
// Tasks lists where allowed; add a task with Enter, tick it off, give it a due day and notes.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Menu, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Task, TaskList } from '../../../shared/people';
import type { AccountView } from '../../../shared/types';
import { fetchJson } from '../api';
import { AllowBar } from './ContactsPage';

const SOURCE_NAME = { local: 'DreyMail', microsoft: 'To Do', google: 'Google Tasks' } as const;
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dueLabel = (due: string) => {
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!);
  const diff = Math.round((date.getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : date.toLocaleDateString([], { weekday: diff > 0 && diff < 7 ? 'long' : undefined, month: 'short', day: 'numeric' });
};

export function TasksPage({ accounts, onNav, focus }: { accounts: AccountView[]; onNav: () => void; focus?: { listId: string; taskId: string } }) {
  const qc = useQueryClient();
  const lists = useQuery({ queryKey: ['tasklists'], queryFn: () => fetchJson<{ lists: TaskList[]; errors: { accountId: string; message: string }[] }>('GET', '/api/tasklists') });
  // Opened from the search at the top (DreyMail 12.1): that list, that task open.
  const [listId, setListId] = useState<string | null>(focus?.listId ?? null);
  useEffect(() => {
    if (!listId && lists.data?.lists[0]) setListId(lists.data.lists[0].id);
  }, [lists.data, listId]);
  const list = lists.data?.lists.find((l) => l.id === listId) ?? null;
  const tasks = useQuery({ queryKey: ['tasks', listId], queryFn: () => fetchJson<Task[]>('GET', `/api/tasklists/${encodeURIComponent(listId!)}/tasks`), enabled: !!listId });
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [open, setOpen] = useState<string | null>(focus?.taskId ?? null);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = () => `/api/tasklists/${encodeURIComponent(listId!)}/tasks`;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tasks', listId] });
  const fail = (e: Error) => setError(e.message);
  const add = async () => {
    if (!title.trim() || !listId) return;
    try {
      await fetchJson('POST', base(), { title: title.trim(), notes: '', due: due || null, done: false });
      setTitle('');
      setDue('');
      setError(null);
      refresh();
    } catch (e) {
      fail(e as Error);
    }
  };
  const update = (t: Task, change: Partial<Task>) => {
    // Shown at once; the list is read again after.
    qc.setQueryData<Task[]>(['tasks', listId], (cur) => cur?.map((x) => (x.id === t.id ? { ...x, ...change } : x)));
    void fetchJson('PUT', `${base()}/${encodeURIComponent(t.id)}`, { title: t.title, notes: t.notes, due: t.due, done: t.done, ...change }).then(refresh, fail);
  };
  const remove = (t: Task) => void fetchJson('DELETE', `${base()}/${encodeURIComponent(t.id)}`).then(refresh, fail);
  const newList = async () => {
    const name = window.prompt('Name of the new list');
    if (!name?.trim()) return;
    const l = await fetchJson<TaskList>('POST', '/api/tasklists', { name }).catch((e: Error) => (fail(e), null));
    if (l) {
      await qc.invalidateQueries({ queryKey: ['tasklists'] });
      setListId(l.id);
    }
  };

  const all = tasks.data ?? [];
  const pending = all.filter((t) => !t.done);
  const done = all.filter((t) => t.done);
  const today = todayKey();
  const row = (t: Task) => (
    <li key={t.id} className={`task ${t.done ? 'done' : ''}`}>
      <button className={`task-check ${t.done ? 'on' : ''}`} onClick={() => update(t, { done: !t.done })} title={t.done ? 'Mark not done' : 'Mark done'} aria-pressed={t.done}>
        {t.done && <Check size={13} />}
      </button>
      <button className="task-main" onClick={() => setOpen(open === t.id ? null : t.id)}>
        <span className="task-title">{t.title}</span>
        {t.due && <span className={`task-due ${!t.done && t.due < today ? 'overdue' : ''}`}>{dueLabel(t.due)}</span>}
        {t.notes && open !== t.id && <span className="muted task-notes-hint">{t.notes.split('\n')[0]}</span>}
      </button>
      {open === t.id && (
        <div className="task-edit">
          <input className="input" defaultValue={t.title} onBlur={(e) => e.target.value.trim() && e.target.value !== t.title && update(t, { title: e.target.value.trim() })} aria-label="Title" />
          <div className="cal-when-row">
            <label className="label" style={{ margin: 0 }}>
              Due
            </label>
            <input className="input" type="date" value={t.due ?? ''} onChange={(e) => update(t, { due: e.target.value || null })} />
            <span className="grow" />
            <button className="btn" onClick={() => remove(t)}>
              <Trash2 size={14} /> Delete
            </button>
          </div>
          <textarea className="input" rows={3} placeholder="Notes" defaultValue={t.notes} onBlur={(e) => e.target.value !== t.notes && update(t, { notes: e.target.value })} />
        </div>
      )}
    </li>
  );

  return (
    <section className="pane cal-pane people-pane" aria-label="Tasks">
      <div className="cal-page">
        <div className="dialog-head cal-head">
          <button className="icon-btn mobile-only" onClick={onNav} title="Folders">
            <Menu size={18} />
          </button>
          <h2 className="cal-range">Tasks</h2>
        </div>
        <AllowBar accounts={accounts} what="tasks" />
        {!!(error || lists.data?.errors.length || tasks.error) && <div className="error-text cal-error">{error ?? (tasks.error as Error | null)?.message ?? lists.data?.errors.map((e) => e.message).join(' ')}</div>}
        <div className="people-main">
          <ul className="people-list task-lists">
            {(lists.data?.lists ?? []).map((l) => (
              <li key={l.id}>
                <button className={`people-row ${l.id === listId ? 'on' : ''}`} onClick={() => setListId(l.id)}>
                  <span className="people-text">
                    <strong>{l.name}</strong>
                    <span className="muted">{SOURCE_NAME[l.source]}{l.accountId ? ` · ${accounts.find((a) => a.id === l.accountId)?.name ?? ''}` : ''}</span>
                  </span>
                </button>
              </li>
            ))}
            <li>
              <button className="btn" style={{ margin: 8 }} onClick={() => void newList()}>
                <Plus size={14} /> New list
              </button>
            </li>
          </ul>
          <div className="people-detail tasks-detail">
            {list && (
              <>
                <form
                  className="task-add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void add();
                  }}
                >
                  <Plus size={16} />
                  <input className="input" placeholder={`Add a task to ${list.name}`} value={title} onChange={(e) => setTitle(e.target.value)} />
                  <input className="input task-add-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" />
                  <button className="btn primary" disabled={!title.trim()}>
                    Add
                  </button>
                </form>
                {tasks.isLoading && <div className="hint">Loading…</div>}
                <ul className="task-list">{pending.map(row)}</ul>
                {!tasks.isLoading && pending.length === 0 && <div className="hint">Nothing to do here.</div>}
                {done.length > 0 && (
                  <>
                    <button className="link-btn" onClick={() => setShowDone((v) => !v)}>
                      {showDone ? 'Hide' : 'Show'} {done.length} done
                    </button>
                    {showDone && <ul className="task-list">{done.map(row)}</ul>}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
