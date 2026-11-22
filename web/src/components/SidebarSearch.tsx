// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Search in the folder bar (DreyMail 12.1): a box per mailbox (opened from its heading, pinned to
// stay) that searches that whole mailbox, and the search at the top: all mail in every mailbox,
// and (switched on with the icons at its end) contacts, tasks, the calendar and settings.

import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ContactRound, ListTodo, Mail, Pin, PinOff, Search, Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CalendarEvent } from '../../../shared/calendar';
import type { Contact, Task, TaskList } from '../../../shared/people';
import { fetchJson } from '../api';
import { matchContacts, matchEvents, matchSettings, matchTasks, saveSources, savedSources, type SearchSource, type SettingEntry } from '../globalSearch';

const PINNED_KEY = 'dreymail.mailboxSearchPinned';

/** Mailboxes whose search box stays shown (this device). */
export function pinnedMailboxSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function setPinnedMailboxSearches(ids: string[]) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
}

export function MailboxSearch({
  name,
  pinned,
  onPin,
  onClose,
  onSearch,
  autoFocus,
}: {
  name: string;
  pinned: boolean;
  onPin: (on: boolean) => void;
  onClose: () => void;
  onSearch: (q: string) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  return (
    <form
      className="nav-search mailbox-search"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) onSearch(q.trim());
      }}
    >
      <Search size={13} />
      <input
        className="input"
        placeholder={`Search ${name}`}
        aria-label={`Search ${name}`}
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQ('');
            if (!pinned) onClose();
          }
        }}
      />
      <button type="button" className="icon-btn" title={pinned ? 'Unpin: hide this box until the search button is used' : 'Pin: always show this box'} aria-pressed={pinned} onClick={() => onPin(!pinned)}>
        {pinned ? <PinOff size={13} /> : <Pin size={13} />}
      </button>
      {!pinned && (
        <button type="button" className="icon-btn" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      )}
    </form>
  );
}

const SOURCE_UI: Record<SearchSource, { label: string; icon: React.ReactNode }> = {
  contacts: { label: 'Contacts', icon: <ContactRound size={14} /> },
  tasks: { label: 'Tasks', icon: <ListTodo size={14} /> },
  calendar: { label: 'Calendar', icon: <CalendarDays size={14} /> },
  settings: { label: 'Settings', icon: <Settings size={14} /> },
};
const DAY = 86_400_000;

export interface GlobalSearchTargets {
  /** All mail in every mailbox. */
  onMail: (q: string) => void;
  onContact: (c: Contact, q: string) => void;
  onTask: (t: Task, q: string) => void;
  onEvent: (e: CalendarEvent) => void;
  onSetting: (tab: string) => void;
  /** Settings tabs this user has (others aren't offered). */
  settingTabs: string[];
}

/** The search at the top of the folder bar (DreyMail 12.1). */
export function GlobalSearch(t: GlobalSearchTargets) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<SearchSource[]>(savedSources);
  const box = useRef<HTMLDivElement>(null);
  const on = (s: SearchSource) => sources.includes(s);
  const ready = open && q.trim().length >= 2;

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: () => fetchJson<{ contacts: Contact[] }>('GET', '/api/contacts'),
    enabled: ready && on('contacts'),
    staleTime: 120_000,
  });
  const tasks = useQuery({
    queryKey: ['search', 'tasks'],
    queryFn: async () => {
      const r = await fetchJson<{ lists: TaskList[] }>('GET', '/api/tasklists');
      const all = await Promise.all(
        r.lists.map((l) =>
          fetchJson<Task[]>('GET', `/api/tasklists/${encodeURIComponent(l.id)}/tasks`)
            .then((ts) => ts.map((x) => ({ ...x, listName: l.name })))
            .catch(() => []),
        ),
      );
      return all.flat();
    },
    enabled: ready && on('tasks'),
    staleTime: 120_000,
  });
  const events = useQuery({
    queryKey: ['search', 'events'],
    queryFn: () => {
      const now = Date.now();
      return fetchJson<CalendarEvent[]>('GET', `/api/events?from=${encodeURIComponent(new Date(now - 180 * DAY).toISOString())}&to=${encodeURIComponent(new Date(now + 215 * DAY).toISOString())}`);
    },
    enabled: ready && on('calendar'),
    staleTime: 120_000,
  });

  const text = q.trim();
  const found = {
    contacts: ready && on('contacts') ? matchContacts(text, contacts.data?.contacts ?? []) : [],
    tasks: ready && on('tasks') ? matchTasks(text, tasks.data ?? []) : [],
    calendar: ready && on('calendar') ? matchEvents(text, events.data ?? []) : [],
    settings: ready && on('settings') ? matchSettings(text, t.settingTabs) : [],
  };
  const loading = (on('contacts') && contacts.isLoading) || (on('tasks') && tasks.isLoading) || (on('calendar') && events.isLoading);
  const done = () => {
    setOpen(false);
    setQ('');
  };
  const toggle = (s: SearchSource) => {
    const next = on(s) ? sources.filter((x) => x !== s) : [...sources, s];
    saveSources(next);
    setSources(next);
  };
  const when = (e: CalendarEvent) => {
    const d = new Date(e.start);
    return e.allDay ? new Date(e.start.slice(0, 10) + 'T12:00:00').toLocaleDateString(undefined, { dateStyle: 'medium' }) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };

  return (
    <div className="global-search" ref={box}>
      <form
        className="nav-search"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          t.onMail(text);
          done();
        }}
      >
        <Search size={14} />
        <input
          className="input"
          placeholder="Search everything"
          aria-label="Search all mailboxes"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') done();
          }}
        />
        <span className="global-search-sources" role="group" aria-label="Also search in">
          {(Object.keys(SOURCE_UI) as SearchSource[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`icon-btn ${on(s) ? 'on' : ''}`}
              title={`${on(s) ? 'Searching' : 'Also search'} ${SOURCE_UI[s].label.toLowerCase()} (click to turn ${on(s) ? 'off' : 'on'})`}
              aria-label={`Also search ${SOURCE_UI[s].label}`}
              aria-pressed={on(s)}
              onClick={() => toggle(s)}
            >
              {SOURCE_UI[s].icon}
            </button>
          ))}
        </span>
      </form>
      {ready && (
        <div className="global-search-results" role="listbox">
          <button
            className="gs-row gs-mail"
            onClick={() => {
              t.onMail(text);
              done();
            }}
          >
            <Mail size={14} />
            <span>
              Search all mailboxes for <b>{text}</b>
            </span>
            <kbd>Enter</kbd>
          </button>
          {found.contacts.length > 0 && <div className="gs-head">Contacts</div>}
          {found.contacts.map((c) => (
            <button
              key={c.id}
              className="gs-row"
              onClick={() => {
                t.onContact(c, text);
                done();
              }}
            >
              <ContactRound size={14} />
              <span className="gs-main">{c.name || c.emails[0]}</span>
              <span className="gs-sub">{c.emails[0] ?? c.company}</span>
            </button>
          ))}
          {found.tasks.length > 0 && <div className="gs-head">Tasks</div>}
          {found.tasks.map((x) => (
            <button
              key={`${x.listId}:${x.id}`}
              className={`gs-row ${x.done ? 'gs-done' : ''}`}
              onClick={() => {
                t.onTask(x, text);
                done();
              }}
            >
              <ListTodo size={14} />
              <span className="gs-main">{x.title}</span>
              <span className="gs-sub">{x.due ?? x.listName}</span>
            </button>
          ))}
          {found.calendar.length > 0 && <div className="gs-head">Calendar</div>}
          {found.calendar.map((e) => (
            <button
              key={`${e.calendarId}:${e.id}:${e.start}`}
              className="gs-row"
              onClick={() => {
                t.onEvent(e);
                done();
              }}
            >
              <CalendarDays size={14} />
              <span className="gs-main">{e.title || '(no title)'}</span>
              <span className="gs-sub">
                {when(e)}
                {e.recurrence !== 'none' ? ' · repeats' : ''}
              </span>
            </button>
          ))}
          {found.settings.length > 0 && <div className="gs-head">Settings</div>}
          {found.settings.map((s: SettingEntry) => (
            <button
              key={s.label}
              className="gs-row"
              onClick={() => {
                t.onSetting(s.tab);
                done();
              }}
            >
              <Settings size={14} />
              <span className="gs-main">{s.label}</span>
            </button>
          ))}
          {loading && <div className="gs-head muted">Looking…</div>}
          {!loading && sources.length > 0 && !found.contacts.length && !found.tasks.length && !found.calendar.length && !found.settings.length && (
            <div className="gs-head muted">Nothing in {sources.map((s) => SOURCE_UI[s].label.toLowerCase()).join(', ')}</div>
          )}
        </div>
      )}
    </div>
  );
}
