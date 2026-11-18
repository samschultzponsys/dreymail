// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The Contacts page (DreyMail 10.4): DreyMail's own contacts with Outlook and Google contacts of
// mailboxes where they are allowed; search, add, edit, delete, write to someone.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Mail, Menu, Phone, Plus, Search, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Contact, ContactInput, PeopleSourceView } from '../../../shared/people';
import type { AccountView } from '../../../shared/types';
import { fetchJson } from '../api';

const SOURCE_NAME = { local: 'DreyMail', microsoft: 'Outlook', google: 'Google' } as const;

/** Asks the provider for one more permission for a mailbox (signs in to it again). */
export function allowFor(a: AccountView, kind: 'microsoft' | 'google', what: 'contacts' | 'tasks') {
  void fetchJson<{ url: string }>('POST', `/api/oauth/${kind}/start`, { color: a.color, allow: [what] }).then(
    ({ url }) => (window.location.href = url),
    (e: Error) => window.alert(e.message),
  );
}

/** "Allow" offers for mailboxes that could bring contacts or tasks but aren't allowed yet. */
export function AllowBar({ accounts, what }: { accounts: AccountView[]; what: 'contacts' | 'tasks' }) {
  const q = useQuery({ queryKey: ['people-sources'], queryFn: () => fetchJson<PeopleSourceView[]>('GET', '/api/people/sources'), staleTime: 60_000 });
  const missing = (q.data ?? []).filter((s) => !s[what]);
  if (!missing.length) return null;
  const label = what === 'contacts' ? { microsoft: 'Outlook contacts', google: 'Google Contacts' } : { microsoft: 'Microsoft To Do', google: 'Google Tasks' };
  return (
    <div className="allow-bar">
      {missing.map((s) => {
        const a = accounts.find((x) => x.id === s.accountId);
        return a ? (
          <span key={s.accountId}>
            Show {label[s.kind]} of <strong>{s.name}</strong>?{' '}
            <button className="link-btn" onClick={() => allowFor(a, s.kind, what)}>
              Allow
            </button>
          </span>
        ) : null;
      })}
    </div>
  );
}

const empty: ContactInput = { name: '', emails: [''], phones: [''], company: '', title: '', notes: '', source: 'local', accountId: null };

export function ContactsPage({ accounts, onNav, onWrite }: { accounts: AccountView[]; onNav: () => void; onWrite: (to: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contacts'], queryFn: () => fetchJson<{ contacts: Contact[]; errors: { accountId: string; message: string }[] }>('GET', '/api/contacts') });
  const sources = useQuery({ queryKey: ['people-sources'], queryFn: () => fetchJson<PeopleSourceView[]>('GET', '/api/people/sources'), staleTime: 60_000 });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; c: ContactInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = q.data?.contacts ?? [];
    return needle ? all.filter((c) => [c.name, c.company, ...c.emails, ...c.phones].some((x) => x.toLowerCase().includes(needle))) : all;
  }, [q.data, search]);
  const current = list.find((c) => c.id === selected) ?? null;
  const writable = [{ source: 'local' as const, accountId: null as string | null, label: 'DreyMail' }, ...(sources.data ?? []).filter((s) => s.contacts).map((s) => ({ source: s.kind, accountId: s.accountId as string | null, label: `${SOURCE_NAME[s.kind]} · ${s.name}` }))];

  const save = async () => {
    if (!editing) return;
    const c = { ...editing.c, emails: editing.c.emails.filter((x) => x.trim()), phones: editing.c.phones.filter((x) => x.trim()) };
    try {
      const saved = await fetchJson<Contact>(editing.id ? 'PUT' : 'POST', editing.id ? `/api/contacts/${encodeURIComponent(editing.id)}` : '/api/contacts', c);
      setEditing(null);
      setSelected(saved.id);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (c: Contact) => {
    if (!window.confirm(`Delete ${c.name || c.emails[0]}${c.source !== 'local' ? ` from ${SOURCE_NAME[c.source]}` : ''}?`)) return;
    try {
      await fetchJson('DELETE', `/api/contacts/${encodeURIComponent(c.id)}`);
      setSelected(null);
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const setList = (k: 'emails' | 'phones', i: number, v: string) => setEditing((e) => (e ? { ...e, c: { ...e.c, [k]: e.c[k].map((x, j) => (j === i ? v : x)) } } : e));

  return (
    <section className="pane cal-pane people-pane" aria-label="Contacts">
      <div className="cal-page">
        <div className="dialog-head cal-head">
          <button className="icon-btn mobile-only" onClick={onNav} title="Folders">
            <Menu size={18} />
          </button>
          <h2 className="cal-range">Contacts</h2>
          <label className="people-search">
            <Search size={15} />
            <input className="input" placeholder="Search contacts" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button className="btn primary" onClick={() => setEditing({ id: null, c: { ...empty } })}>
            <Plus size={15} /> Contact
          </button>
        </div>
        <AllowBar accounts={accounts} what="contacts" />
        {!!(error || q.data?.errors.length) && <div className="error-text cal-error">{error ?? q.data?.errors.map((e) => e.message).join(' ')}</div>}
        <div className="people-main">
          <ul className="people-list">
            {!q.data && <li className="hint">Loading…</li>}
            {q.data && list.length === 0 && <li className="hint">{search ? 'Nobody matches.' : 'No contacts yet.'}</li>}
            {list.map((c) => (
              <li key={c.id}>
                <button className={`people-row ${selected === c.id ? 'on' : ''}`} onClick={() => setSelected(c.id)}>
                  <span className="people-initial">{(c.name || c.emails[0] || '?').slice(0, 1).toUpperCase()}</span>
                  <span className="people-text">
                    <strong>{c.name || c.emails[0] || '(no name)'}</strong>
                    <span className="muted">{c.company || c.emails[0] || ''}</span>
                  </span>
                  {c.source !== 'local' && <span className="suggest-tag">{SOURCE_NAME[c.source]}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="people-detail">
            {current ? (
              <div className="contact-card">
                <h3>{current.name || current.emails[0]}</h3>
                {(current.title || current.company) && (
                  <div className="muted">
                    <Building2 size={13} /> {[current.title, current.company].filter(Boolean).join(', ')}
                  </div>
                )}
                {current.emails.map((e) => (
                  <div key={e}>
                    <Mail size={13} />{' '}
                    <button className="link-btn" onClick={() => onWrite(e)} title={`Write to ${e}`}>
                      {e}
                    </button>
                  </div>
                ))}
                {current.phones.map((p) => (
                  <div key={p}>
                    <Phone size={13} /> <a href={`tel:${p.replace(/[^\d+]/g, '')}`}>{p}</a>
                  </div>
                ))}
                {current.notes && <div style={{ whiteSpace: 'pre-wrap' }}>{current.notes}</div>}
                <div className="hint">From {SOURCE_NAME[current.source]}</div>
                <div className="cal-when-row">
                  <button className="btn" onClick={() => setEditing({ id: current.id, c: { ...current, emails: current.emails.length ? current.emails : [''], phones: current.phones.length ? current.phones : [''] } })}>
                    Edit
                  </button>
                  <button className="btn" onClick={() => void remove(current)}>
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              </div>
            ) : (
              <div className="hint">Pick a contact.</div>
            )}
          </div>
        </div>
      </div>
      {editing && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(480px, 100%)' }}>
            <div className="dialog-head">
              <h2>{editing.id ? 'Edit contact' : 'New contact'}</h2>
              <button className="icon-btn" onClick={() => setEditing(null)} title="Close">
                <X size={17} />
              </button>
            </div>
            <div className="dialog-body">
              {!editing.id && writable.length > 1 && (
                <div>
                  <label className="label" htmlFor="ct-where">
                    Save in
                  </label>
                  <select
                    id="ct-where"
                    className="select"
                    value={`${editing.c.source}|${editing.c.accountId ?? ''}`}
                    onChange={(e) => {
                      const [source, accountId] = e.target.value.split('|');
                      setEditing({ ...editing, c: { ...editing.c, source: source as ContactInput['source'], accountId: accountId || null } });
                    }}
                  >
                    {writable.map((w) => (
                      <option key={`${w.source}|${w.accountId ?? ''}`} value={`${w.source}|${w.accountId ?? ''}`}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {(['name', 'company', 'title'] as const).map((k) => (
                <div key={k}>
                  <label className="label" htmlFor={`ct-${k}`}>
                    {k === 'name' ? 'Name' : k === 'company' ? 'Company' : 'Job title'}
                  </label>
                  <input id={`ct-${k}`} className="input" value={editing.c[k]} onChange={(e) => setEditing({ ...editing, c: { ...editing.c, [k]: e.target.value } })} autoFocus={k === 'name'} />
                </div>
              ))}
              {(['emails', 'phones'] as const).map((k) => (
                <div key={k}>
                  <label className="label">{k === 'emails' ? 'Email addresses' : 'Phone numbers'}</label>
                  {editing.c[k].map((v, i) => (
                    <input key={i} className="input" style={{ marginBottom: 4 }} type={k === 'emails' ? 'email' : 'tel'} value={v} onChange={(e) => setList(k, i, e.target.value)} />
                  ))}
                  <button type="button" className="link-btn" onClick={() => setEditing({ ...editing, c: { ...editing.c, [k]: [...editing.c[k], ''] } })}>
                    Add another
                  </button>
                </div>
              ))}
              <div>
                <label className="label" htmlFor="ct-notes">
                  Notes
                </label>
                <textarea id="ct-notes" className="input" rows={3} value={editing.c.notes} onChange={(e) => setEditing({ ...editing, c: { ...editing.c, notes: e.target.value } })} />
              </div>
              {error && <div className="error-text">{error}</div>}
            </div>
            <div className="dialog-foot">
              <span className="grow" />
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void save()}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
