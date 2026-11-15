// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The search filter builder: everything is picked or typed into labelled fields, no query syntax.

import { Check, Paperclip, Reply, Star, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { SIZE_CHOICES, type DatePreset, type SearchFilters, type SearchWhere } from '../../../shared/search';
import type { AccountView } from '../../../shared/types';
import { api } from '../api';

interface Props {
  filters: SearchFilters;
  /** The open view is one account's folder (else the unified view). */
  inFolder: boolean;
  accounts: AccountView[];
  onApply: (f: SearchFilters) => void;
  onClose: () => void;
}

/** Address suggestions from people you've written to, for the From/To fields. */
function useSuggestions(value: string) {
  const [list, setList] = useState<{ name: string; address: string }[]>([]);
  useEffect(() => {
    const q = value.trim();
    if (q.length < 2) return setList([]);
    const t = setTimeout(() => void api.recipients(q).then(setList, () => setList([])), 200);
    return () => clearTimeout(t);
  }, [value]);
  return list;
}

function AddressField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  const suggestions = useSuggestions(value);
  return (
    <label className="sp-field">
      <span>{label}</span>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} list={id} placeholder="Name or address" autoComplete="off" />
      <datalist id={id}>
        {suggestions.map((s) => (
          <option key={s.address} value={s.address}>
            {s.name}
          </option>
        ))}
      </datalist>
    </label>
  );
}

const DATES: { value: DatePreset | ''; label: string }[] = [
  { value: '', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Past week' },
  { value: 'month', label: 'Past month' },
  { value: 'year', label: 'Past year' },
  { value: 'custom', label: 'Choose dates…' },
];

export function SearchPanel({ filters, inFolder, accounts, onApply, onClose }: Props) {
  const [f, setF] = useState<SearchFilters>(filters);
  useEffect(() => setF(filters), [filters]);
  const set = <K extends keyof SearchFilters>(k: K, v: SearchFilters[K] | undefined) =>
    setF((cur) => {
      const next = { ...cur };
      if (v === undefined || v === '' || v === false) delete next[k];
      else next[k] = v;
      return next;
    });
  const where = f.where ?? 'folder';
  const picked = new Set(f.accounts ?? []);
  const toggleAccount = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (next.size === 0) return; // at least one account
    set('accounts', next.size && next.size < accounts.length ? [...next] : undefined);
  };
  // Account choice matters when the search covers more than one folder of one account.
  const showAccounts = accounts.length > 1 && (where !== 'folder' || !inFolder);

  const WHERE: { value: SearchWhere; label: string }[] = [
    { value: 'folder', label: inFolder ? 'This folder' : 'Inboxes' },
    ...(inFolder ? [{ value: 'inboxes' as const, label: 'All inboxes' }] : []),
    { value: 'all', label: 'All mail' },
  ];

  const toggle = (k: 'attachment' | 'flagged' | 'answered', label: string, icon: React.ReactNode) => (
    <button type="button" className={`sp-toggle ${f[k] ? 'on' : ''}`} aria-pressed={!!f[k]} onClick={() => set(k, !f[k])}>
      {f[k] ? <Check size={13} /> : icon} {label}
    </button>
  );

  return (
    <form
      className="search-panel"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(f);
      }}
    >
      <div className="sp-row">
        <span className="sp-label">Look in</span>
        <div className="segmented">
          {WHERE.map((w) => (
            <button type="button" key={w.value} className={where === w.value ? 'on' : ''} onClick={() => set('where', w.value === 'folder' ? undefined : w.value)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>
      {showAccounts && (
        <div className="sp-row">
          <span className="sp-label">Accounts</span>
          <div className="sp-accounts">
            {accounts.map((a) => {
              const on = picked.size === 0 || picked.has(a.id);
              return (
                <button
                  type="button"
                  key={a.id}
                  className={`sp-account ${on ? 'on' : ''}`}
                  style={{ '--acct': a.color } as React.CSSProperties}
                  aria-pressed={on}
                  onClick={() => (picked.size === 0 ? set('accounts', accounts.filter((x) => x.id !== a.id).map((x) => x.id)) : toggleAccount(a.id))}
                >
                  <span className="dot" /> {a.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="sp-grid">
        <AddressField label="From" value={f.from ?? ''} onChange={(v) => set('from', v)} />
        <AddressField label="To" value={f.to ?? ''} onChange={(v) => set('to', v)} />
        <label className="sp-field">
          <span>Subject has</span>
          <input className="input" value={f.subject ?? ''} onChange={(e) => set('subject', e.target.value)} />
        </label>
        <label className="sp-field">
          <span>Message has</span>
          <input className="input" value={f.body ?? ''} onChange={(e) => set('body', e.target.value)} />
        </label>
        <label className="sp-field">
          <span>Date</span>
          <select className="input" value={f.date ?? ''} onChange={(e) => setF((cur) => {
            const next = { ...cur };
            delete next.since;
            delete next.until;
            if (e.target.value) next.date = e.target.value as DatePreset;
            else delete next.date;
            return next;
          })}>
            {DATES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sp-field">
          <span>Size</span>
          <select className="input" value={f.largerMb ?? ''} onChange={(e) => set('largerMb', e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">Any size</option>
            {SIZE_CHOICES.map((mb) => (
              <option key={mb} value={mb}>
                Over {mb} MB
              </option>
            ))}
          </select>
        </label>
        {f.date === 'custom' && (
          <>
            <label className="sp-field">
              <span>From date</span>
              <input className="input" type="date" value={f.since ?? ''} max={f.until} onChange={(e) => set('since', e.target.value)} />
            </label>
            <label className="sp-field">
              <span>To date</span>
              <input className="input" type="date" value={f.until ?? ''} min={f.since} onChange={(e) => set('until', e.target.value)} />
            </label>
          </>
        )}
      </div>
      <div className="sp-row sp-toggles">
        {toggle('attachment', 'Has attachment', <Paperclip size={13} />)}
        {toggle('flagged', 'Starred', <Star size={13} />)}
        {toggle('answered', 'Replied to', <Reply size={13} />)}
      </div>
      <div className="sp-actions">
        <button type="button" className="btn" onClick={() => setF({})}>
          Clear
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onClose}>
          <X size={14} /> Close
        </button>
        <button type="submit" className="btn primary">
          Search
        </button>
      </div>
    </form>
  );
}
