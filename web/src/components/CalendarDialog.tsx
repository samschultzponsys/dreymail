// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The calendar: a list of calendars with show/hide checkboxes (grouped as My calendars, by
// mailbox, and Shared with me), month / week / day / agenda views, and the event and calendar
// editors. Repeating events are expanded here, in the browser's time zone. Shown as a page of its
// own (/calendar), filling the space of the message list and reader.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Link2, MapPin, Menu, Pencil, Plus, RefreshCw, Repeat, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { occurrences, type CalendarEvent, type CalendarSourceView, type CalendarView, type EventInput, type EventOccurrence, type Recurrence } from '../../../shared/calendar';
import type { AccountView } from '../../../shared/types';
import { fetchJson } from '../api';
import { ACCOUNT_COLORS } from '../util';

type Mode = 'month' | 'week' | 'day' | 'agenda';
const DAY = 86_400_000;
const AGENDA_DAYS = 30;

const pad = (n: number) => String(n).padStart(2, '0');
/** Local calendar day as YYYY-MM-DD. */
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const utcKeyOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d: Date) => addDays(startOfDay(d), -d.getDay());
const timeLabel = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The local days an occurrence covers. */
function daysOf(o: EventOccurrence): string[] {
  const out: string[] = [];
  if (o.allDay) {
    const end = Date.parse(o.occurrenceEnd);
    for (let t = Date.parse(o.occurrenceStart); t < end && out.length < 400; t += DAY) out.push(utcKeyOf(new Date(t)));
    return out.length ? out : [utcKeyOf(new Date(o.occurrenceStart))];
  }
  const end = Math.max(Date.parse(o.occurrenceStart), Date.parse(o.occurrenceEnd) - 1);
  for (let d = startOfDay(new Date(o.occurrenceStart)); d.getTime() <= end && out.length < 400; d = addDays(d, 1)) out.push(keyOf(d));
  return out;
}

const calendarsApi = {
  list: (refresh = false) => fetchJson<CalendarView[]>('GET', `/api/calendars${refresh ? '?refresh=1' : ''}`),
  sources: () => fetchJson<CalendarSourceView[]>('GET', '/api/calendar-sources'),
  people: () => fetchJson<{ id: string; name: string }[]>('GET', '/api/calendars/people'),
  events: (from: number, to: number) => fetchJson<CalendarEvent[]>('GET', `/api/events?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`),
};

/** The calendar page; `onNav` opens the folder drawer (phones and tablets). */
export function CalendarDialog({ accounts, onNav }: { accounts: AccountView[]; onNav: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>(() => (window.matchMedia('(max-width: 700px)').matches ? 'agenda' : 'month'));
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [editing, setEditing] = useState<{ event: Partial<CalendarEvent> } | null>(null);
  const [calEditing, setCalEditing] = useState<CalendarView | 'new' | null>(null);
  const [showList, setShowList] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cals = useQuery({ queryKey: ['calendars'], queryFn: () => calendarsApi.list() });
  const sources = useQuery({ queryKey: ['calendar-sources'], queryFn: calendarsApi.sources, enabled: !!cals.data });
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const calMap = useMemo(() => new Map((cals.data ?? []).map((c) => [c.id, c])), [cals.data]);

  // The days shown.
  const [from, to] = useMemo(() => {
    if (mode === 'month') {
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const start = startOfWeek(first);
      return [start, addDays(start, 42)];
    }
    if (mode === 'week') return [startOfWeek(cursor), addDays(startOfWeek(cursor), 7)];
    if (mode === 'day') return [cursor, addDays(cursor, 1)];
    return [cursor, addDays(cursor, AGENDA_DAYS)];
  }, [mode, cursor]);
  // All-day events sit on UTC midnights, so ask for a day more on each side.
  const evQ = useQuery({
    queryKey: ['events', from.getTime(), to.getTime()],
    // Provider problems are found while reading events: refresh the connection list afterwards.
    queryFn: () => calendarsApi.events(from.getTime() - DAY, to.getTime() + DAY).finally(() => void qc.invalidateQueries({ queryKey: ['calendar-sources'] })),
    enabled: !!cals.data,
  });

  /** Occurrences per local day key, all-day events first, then by start. */
  const byDay = useMemo(() => {
    const map = new Map<string, EventOccurrence[]>();
    const firstKey = keyOf(from);
    const lastKey = keyOf(addDays(to, -1));
    for (const e of evQ.data ?? []) {
      if (!calMap.get(e.calendarId)?.visible) continue;
      for (const o of occurrences(e, from.getTime() - DAY, to.getTime() + DAY))
        for (const k of daysOf(o)) if (k >= firstKey && k <= lastKey) map.set(k, [...(map.get(k) ?? []), o]);
    }
    for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.occurrenceStart.localeCompare(b.occurrenceStart));
    return map;
  }, [evQ.data, calMap, from, to]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['events'] });
  };
  const syncNow = async () => {
    setSyncing(true);
    try {
      qc.setQueryData(['calendars'], await calendarsApi.list(true));
      refresh();
      void qc.invalidateQueries({ queryKey: ['calendar-sources'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };
  const reconnect = async (src: CalendarSourceView) => {
    const acc = accounts.find((a) => a.id === src.id);
    try {
      const { url } = await fetchJson<{ url: string }>('POST', `/api/oauth/${src.kind}/start`, { color: acc?.color ?? '#22d3ee' });
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const setCals = (l: CalendarView[]) => {
    qc.setQueryData(['calendars'], l);
    refresh();
  };
  const toggle = (c: CalendarView) => void fetchJson<CalendarView[]>('PUT', `/api/calendars/${encodeURIComponent(c.id)}/visible`, { visible: !c.visible }).then(setCals, (e: Error) => setError(e.message));

  const step = (dir: number) =>
    setCursor((c) =>
      mode === 'month' ? new Date(c.getFullYear(), c.getMonth() + dir, 1) : addDays(c, dir * (mode === 'week' ? 7 : mode === 'day' ? 1 : AGENDA_DAYS)),
    );
  const title =
    mode === 'month'
      ? cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })
      : mode === 'day'
        ? cursor.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        : `${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${addDays(to, -1).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const writable = (cals.data ?? []).filter((c) => c.access !== 'view');
  const newEvent = (day: Date, hour?: number) => {
    const cal = writable.find((c) => c.visible) ?? writable[0];
    if (!cal) return setError('None of your calendars can take new events. Make a calendar first.');
    const start = hour === undefined ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.min(new Date().getHours() + 1, 23)) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
    setEditing({ event: { calendarId: cal.id, start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(), allDay: false, recurrence: 'none', until: null, title: '', location: '', notes: '' } });
  };
  const open = (o: EventOccurrence) => setEditing({ event: o });

  const chip = (o: EventOccurrence, compact = false) => {
    const c = calMap.get(o.calendarId);
    return (
      <button
        key={`${o.id}-${o.occurrenceStart}`}
        className={`cal-chip ${o.allDay ? 'allday' : ''}`}
        style={{ ['--cal' as string]: c?.color ?? 'var(--accent)' }}
        onClick={(e) => {
          e.stopPropagation();
          open(o);
        }}
        title={o.title}
      >
        {!o.allDay && <span className="cal-time">{timeLabel(new Date(o.occurrenceStart))}</span>}
        <span className="cal-title">{o.title}</span>
        {!compact && (o.recurrence !== 'none' || o.instance) && <Repeat size={11} />}
      </button>
    );
  };

  // ---- the calendar list ----------------------------------------------------------------
  // My calendars, then each mailbox (its own calendars, its Google/Outlook calendars and CalDAV
  // accounts shown under it), then CalDAV accounts of their own, then calendars shared with me.
  const all = cals.data ?? [];
  const srcs = sources.data ?? [];
  const groups: { key: string; label: string; items: CalendarView[]; problems: CalendarSourceView[]; caldav: CalendarSourceView[] }[] = [];
  const isMine = (c: CalendarView) => c.source !== 'local' || c.access === 'owner';
  const known = (id: string | null) => !!id && accounts.some((a) => a.id === id);
  groups.push({ key: 'mine', label: 'My calendars', items: all.filter((c) => c.source === 'local' && c.access === 'owner' && !known(c.accountId)), problems: [], caldav: [] });
  for (const a of accounts) {
    const items = all.filter((c) => isMine(c) && c.accountId === a.id);
    const here = srcs.filter((x) => x.accountId === a.id);
    if (items.length || here.some((x) => x.error)) groups.push({ key: a.id, label: a.name, items, problems: here.filter((x) => x.error), caldav: here.filter((x) => x.kind === 'caldav') });
  }
  for (const x of srcs.filter((x) => x.kind === 'caldav' && !known(x.accountId)))
    groups.push({ key: x.id, label: x.name, items: all.filter((c) => c.source === 'caldav' && c.sourceId === x.id), problems: x.error ? [x] : [], caldav: [x] });
  const shared = all.filter((c) => c.source === 'local' && c.access !== 'owner');
  if (shared.length) groups.push({ key: 'shared', label: 'Shared with me', items: shared, problems: [], caldav: [] });

  const list = (
    <aside className={`cal-list ${showList ? 'open' : ''}`}>
      {groups.map((g) => (
        <div key={g.key} className="cal-group">
          <div className="cal-group-label">{g.label}</div>
          {g.items.map((c) => (
            <div key={c.id} className="cal-item">
              <label className="check" title={c.visible ? 'Hide this calendar' : 'Show this calendar'}>
                <input type="checkbox" checked={c.visible} onChange={() => toggle(c)} style={{ accentColor: c.color }} />
                <span className="cal-dot" style={{ background: c.color }} />
                <span className="cal-name">{c.name}</span>
              </label>
              {c.source === 'local' && c.access !== 'owner' && <span className="muted cal-owner">{c.ownerName}</span>}
              <button className="icon-btn" title={c.source === 'local' && c.access === 'owner' ? 'Edit and share' : 'Details'} onClick={() => setCalEditing(c)}>
                <Pencil size={13} />
              </button>
            </div>
          ))}
          {g.problems.map((x) => (
            <div key={x.id} className="cal-problem">
              <AlertTriangle size={13} />
              <span>{x.error}</span>
              {x.reconnect && (
                <button className="btn" onClick={() => void reconnect(x)}>
                  Reconnect
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
      <button className="btn" onClick={() => setCalEditing('new')}>
        <Plus size={14} /> New calendar
      </button>
      <button className="btn" onClick={() => setConnecting(true)} title="Nextcloud, iCloud, Fastmail and other CalDAV calendars">
        <Link2 size={14} /> Connect CalDAV
      </button>
      {srcs.some((x) => x.kind !== 'caldav') ? null : accounts.some((a) => a.auth === 'password') && <div className="hint">Google and Outlook calendars appear here for mailboxes added with Google or Microsoft sign-in.</div>}
    </aside>
  );

  // ---- the views ------------------------------------------------------------------------
  const today = keyOf(new Date());
  let body: React.ReactNode;
  if (mode === 'month') {
    const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
    body = (
      <div className="cal-month">
        {days.slice(0, 7).map((d) => (
          <div key={`h${d.getDay()}`} className="cal-weekday">
            {d.toLocaleDateString([], { weekday: 'short' })}
          </div>
        ))}
        {days.map((d) => {
          const k = keyOf(d);
          const items = byDay.get(k) ?? [];
          return (
            <div key={k} className={`cal-cell ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${k === today ? 'today' : ''}`} onClick={() => newEvent(d)}>
              <button
                className="cal-daynum"
                onClick={(e) => {
                  e.stopPropagation();
                  setCursor(d);
                  setMode('day');
                }}
              >
                {d.getDate()}
              </button>
              {items.slice(0, 3).map((o) => chip(o, true))}
              {items.length > 3 && (
                <button
                  className="cal-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCursor(d);
                    setMode('day');
                  }}
                >
                  +{items.length - 3} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  } else if (mode === 'agenda') {
    const days = Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(from, i)).filter((d) => byDay.has(keyOf(d)));
    body = (
      <div className="cal-agenda">
        {days.length === 0 && <div className="muted">Nothing in the next {AGENDA_DAYS} days.</div>}
        {days.map((d) => (
          <div key={keyOf(d)} className="cal-agenda-day">
            <div className={`cal-agenda-date ${keyOf(d) === today ? 'today' : ''}`}>{d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>
            <div className="cal-agenda-items">
              {(byDay.get(keyOf(d)) ?? []).map((o) => (
                <button key={`${o.id}-${o.occurrenceStart}`} className="cal-agenda-item" onClick={() => open(o)}>
                  <span className="cal-dot" style={{ background: calMap.get(o.calendarId)?.color }} />
                  <span className="cal-agenda-time">{o.allDay ? 'All day' : `${timeLabel(new Date(o.occurrenceStart))} – ${timeLabel(new Date(o.occurrenceEnd))}`}</span>
                  <span className="cal-title">{o.title}</span>
                  {o.location && (
                    <span className="muted cal-loc">
                      <MapPin size={11} /> {o.location}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  } else {
    const days = Array.from({ length: mode === 'week' ? 7 : 1 }, (_, i) => addDays(from, i));
    body = (
      <div className="cal-time-grid" style={{ ['--cols' as string]: days.length }}>
        <div className="cal-tg-head">
          <div />
          {days.map((d) => (
            <button
              key={keyOf(d)}
              className={`cal-tg-day ${keyOf(d) === today ? 'today' : ''}`}
              onClick={() => {
                setCursor(d);
                setMode('day');
              }}
            >
              {d.toLocaleDateString([], { weekday: 'short' })} <b>{d.getDate()}</b>
            </button>
          ))}
          <div className="cal-tg-label muted">All day</div>
          {days.map((d) => (
            <div key={keyOf(d)} className="cal-tg-allday">
              {(byDay.get(keyOf(d)) ?? []).filter((o) => o.allDay).map((o) => chip(o, true))}
            </div>
          ))}
        </div>
        <div className="cal-tg-body">
          <div className="cal-tg-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="cal-tg-hour muted">
                {h ? timeLabel(new Date(2000, 0, 1, h)) : ''}
              </div>
            ))}
          </div>
          {days.map((d) => (
            <DayColumn key={keyOf(d)} day={d} items={(byDay.get(keyOf(d)) ?? []).filter((o) => !o.allDay)} color={(id) => calMap.get(id)?.color} onNew={(h) => newEvent(d, h)} onOpen={open} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="pane cal-pane" aria-label="Calendar">
      <div className="cal-page">
        <div className="dialog-head cal-head">
          <button className="icon-btn mobile-only" onClick={onNav} title="Folders">
            <Menu size={18} />
          </button>
          <button className="icon-btn cal-list-toggle" title="Calendars" onClick={() => setShowList((s) => !s)}>
            <CalendarDays size={17} />
          </button>
          <h2 className="cal-range">{title}</h2>
          <button className="btn" onClick={() => setCursor(startOfDay(new Date()))}>
            Today
          </button>
          <button className={`icon-btn ${syncing || evQ.isFetching ? 'spinning' : ''}`} title="Refresh from Google, Outlook and CalDAV" onClick={() => void syncNow()}>
            <RefreshCw size={16} />
          </button>
          <button className="icon-btn" title="Previous" onClick={() => step(-1)}>
            <ChevronLeft size={17} />
          </button>
          <button className="icon-btn" title="Next" onClick={() => step(1)}>
            <ChevronRight size={17} />
          </button>
          <div className="segmented cal-modes">
            {(['month', 'week', 'day', 'agenda'] as Mode[]).map((m) => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {m[0]!.toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={() => newEvent(mode === 'month' && cursor.getMonth() !== new Date().getMonth() ? cursor : startOfDay(new Date()))} title="New event">
            <Plus size={15} /> <span className="cal-new-label">Event</span>
          </button>
        </div>
        {error && (
          <div className="error-text cal-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        <div className="cal-main">
          {list}
          <div className="cal-view">{!cals.data ? <div className="hint">Loading…</div> : body}</div>
        </div>
      </div>
      {editing && (
        <EventEditor
          event={editing.event}
          calendars={cals.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {calEditing && (
        <CalendarEditor
          calendar={calEditing === 'new' ? null : calEditing}
          source={calEditing === 'new' ? null : srcs.find((x) => x.id === calEditing.sourceId) ?? null}
          accounts={accounts}
          onClose={() => setCalEditing(null)}
          onSaved={(l) => (setCals(l), setCalEditing(null), void qc.invalidateQueries({ queryKey: ['calendar-sources'] }))}
        />
      )}
      {connecting && (
        <CalDavDialog
          accounts={accounts}
          onClose={() => setConnecting(false)}
          onSaved={(l) => {
            setCals(l);
            setConnecting(false);
            void qc.invalidateQueries({ queryKey: ['calendar-sources'] });
          }}
        />
      )}
    </section>
  );
}

/** One day in the week or day view: hour rows, with overlapping events side by side. */
function DayColumn({ day, items, color, onNew, onOpen }: { day: Date; items: EventOccurrence[]; color: (calendarId: string) => string | undefined; onNew: (hour: number) => void; onOpen: (o: EventOccurrence) => void }) {
  const dayStart = day.getTime();
  const dayEnd = addDays(day, 1).getTime();
  // Lanes: each event goes in the first lane that is free at its start.
  const placed = useMemo(() => {
    const lanes: number[] = [];
    const out = items.map((o) => {
      const s = Math.max(Date.parse(o.occurrenceStart), dayStart);
      const e = Math.min(Math.max(Date.parse(o.occurrenceEnd), s + 15 * 60_000), dayEnd);
      let lane = lanes.findIndex((end) => end <= s);
      if (lane < 0) lane = lanes.push(0) - 1;
      lanes[lane] = e;
      return { o, s, e, lane };
    });
    return out.map((p) => ({ ...p, lanes: Math.max(1, ...out.filter((q) => q.s < p.e && q.e > p.s).map((q) => q.lane + 1)) }));
  }, [items, dayStart, dayEnd]);
  const now = Date.now();
  return (
    <div className="cal-tg-col">
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} className="cal-tg-slot" onClick={() => onNew(h)} />
      ))}
      {now >= dayStart && now < dayEnd && <div className="cal-now" style={{ top: `${((now - dayStart) / DAY) * 100}%` }} />}
      {placed.map(({ o, s, e, lane, lanes }) => (
        <button
          key={`${o.id}-${o.occurrenceStart}`}
          className={`cal-block ${e - s < 45 * 60_000 ? 'short' : ''}`}
          style={{
            ['--cal' as string]: color(o.calendarId) ?? 'var(--accent)',
            top: `${((s - dayStart) / DAY) * 100}%`,
            height: `${((e - s) / DAY) * 100}%`,
            left: `${(lane / lanes) * 100}%`,
            width: `${100 / lanes}%`,
          }}
          onClick={() => onOpen(o)}
          title={o.title}
        >
          <span className="cal-title">{o.title}</span>
          <span className="cal-time">{e - s < 45 * 60_000 ? timeLabel(new Date(o.occurrenceStart)) : `${timeLabel(new Date(o.occurrenceStart))} – ${timeLabel(new Date(o.occurrenceEnd))}`}</span>
        </button>
      ))}
    </div>
  );
}

// ---- the event editor -----------------------------------------------------------------------

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return { date: keyOf(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
};

function EventEditor({ event, calendars, onClose, onSaved }: { event: Partial<CalendarEvent>; calendars: CalendarView[]; onClose: () => void; onSaved: () => void }) {
  const cal = calendars.find((c) => c.id === event.calendarId);
  const readOnly = !!event.id && (cal?.access === 'view' || !!event.readOnly);
  const writable = calendars.filter((c) => c.access !== 'view');
  /** Provider events stay in their calendar; one occurrence of a series can't change the series. */
  const fromProvider = !!event.id && !!cal && cal.source !== 'local';
  const s0 = event.allDay ? { date: utcKeyOf(new Date(event.start!)), time: '09:00' } : toLocalInput(event.start!);
  const e0 = event.allDay ? { date: utcKeyOf(new Date(Date.parse(event.end!) - DAY)), time: '10:00' } : toLocalInput(event.end!);
  const [title, setTitle] = useState(event.title ?? '');
  const [calendarId, setCalendarId] = useState(event.calendarId ?? writable[0]?.id ?? '');
  const [allDay, setAllDay] = useState(!!event.allDay);
  const [startDate, setStartDate] = useState(s0.date);
  const [startTime, setStartTime] = useState(s0.time);
  const [endDate, setEndDate] = useState(e0.date);
  const [endTime, setEndTime] = useState(e0.time);
  const [recurrence, setRecurrence] = useState<Recurrence>(event.recurrence ?? 'none');
  const [until, setUntil] = useState(event.until ?? '');
  const [location, setLocation] = useState(event.location ?? '');
  const [notes, setNotes] = useState(event.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    let start: string;
    let end: string;
    if (allDay) {
      start = `${startDate}T00:00:00.000Z`;
      end = new Date(Date.parse(`${endDate < startDate ? startDate : endDate}T00:00:00.000Z`) + DAY).toISOString();
    } else {
      const s = new Date(`${startDate}T${startTime}`);
      const e = new Date(`${endDate}T${endTime}`);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return setError('Check the start and end');
      if (e < s) return setError('The end must be after the start');
      start = s.toISOString();
      end = e.toISOString();
    }
    const body: EventInput & { instance?: boolean } = {
      calendarId,
      title: title.trim() || '(no title)',
      start,
      end,
      allDay,
      location,
      notes,
      recurrence: event.instance ? 'none' : recurrence,
      until: recurrence === 'none' || !until ? null : until,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      instance: event.instance,
    };
    setBusy(true);
    try {
      if (event.id) await fetchJson('PUT', `/api/events/${encodeURIComponent(event.id)}`, body);
      else await fetchJson('POST', '/api/events', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const remove = async () => {
    const question = event.instance ? 'Delete this occurrence? The other repeats stay.' : event.recurrence && event.recurrence !== 'none' ? 'Delete this event and all its repeats?' : 'Delete this event?';
    if (!event.id || !window.confirm(question)) return;
    try {
      await fetchJson('DELETE', `/api/events/${encodeURIComponent(event.id)}`);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (readOnly) {
    const s = new Date((event as EventOccurrence).occurrenceStart ?? event.start!);
    const e = new Date((event as EventOccurrence).occurrenceEnd ?? event.end!);
    return (
      <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
        <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(440px, 100%)' }}>
          <div className="dialog-head">
            <h2>{event.title}</h2>
            <button className="icon-btn" onClick={onClose} title="Close">
              <X size={17} />
            </button>
          </div>
          <div className="dialog-body">
            <div>
              {event.allDay
                ? `${utcKeyOf(s) === utcKeyOf(new Date(e.getTime() - DAY)) ? fromKey(utcKeyOf(s)).toLocaleDateString([], { dateStyle: 'full' }) : `${fromKey(utcKeyOf(s)).toLocaleDateString()} – ${fromKey(utcKeyOf(new Date(e.getTime() - DAY))).toLocaleDateString()}`} · All day`
                : `${s.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })} – ${timeLabel(e)}`}
            </div>
            {event.location && (
              <div>
                <MapPin size={13} /> {event.location}
              </div>
            )}
            {event.notes && <div style={{ whiteSpace: 'pre-wrap' }}>{event.notes}</div>}
            <div className="hint">
              <span className="cal-dot" style={{ background: cal?.color }} /> {cal?.name} ·{' '}
              {cal?.source === 'local'
                ? `shared by ${cal.ownerName} (view only)`
                : event.readOnly && cal?.access !== 'view'
                  ? 'repeating events of this calendar are changed in its own app'
                  : 'read-only calendar'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(520px, 100%)' }}>
        <div className="dialog-head">
          <h2>{event.id ? 'Edit event' : 'New event'}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">
          <div>
            <label className="label" htmlFor="ev-title">
              Title
            </label>
            <input id="ev-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoFocus onKeyDown={(e) => e.key === 'Enter' && void save()} />
          </div>
          <div>
            <label className="label" htmlFor="ev-cal">
              Calendar
            </label>
            <select id="ev-cal" className="select" value={calendarId} disabled={fromProvider} onChange={(e) => setCalendarId(e.target.value)}>
              {writable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.access === 'edit' ? ` (${c.ownerName})` : ''}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
          </label>
          <div className="cal-when">
            <div>
              <label className="label">Starts</label>
              <div className="cal-when-row">
                <input
                  type="date"
                  className="input"
                  value={startDate}
                  onChange={(e) => {
                    // Keep the length when the start moves.
                    const shift = fromKey(e.target.value).getTime() - fromKey(startDate).getTime();
                    setStartDate(e.target.value);
                    if (e.target.value && !Number.isNaN(shift)) setEndDate(keyOf(new Date(fromKey(endDate).getTime() + shift + 12 * 3_600_000)));
                  }}
                  aria-label="Start date"
                />
                {!allDay && <input type="time" className="input" value={startTime} onChange={(e) => setStartTime(e.target.value)} aria-label="Start time" />}
              </div>
            </div>
            <div>
              <label className="label">Ends</label>
              <div className="cal-when-row">
                <input type="date" className="input" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} aria-label="End date" />
                {!allDay && <input type="time" className="input" value={endTime} onChange={(e) => setEndTime(e.target.value)} aria-label="End time" />}
              </div>
            </div>
          </div>
          {!event.instance && (
          <div className="cal-when">
            <div>
              <label className="label" htmlFor="ev-repeat">
                Repeats
              </label>
              <select id="ev-repeat" className="select" value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)}>
                <option value="none">Does not repeat</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
                <option value="yearly">Every year</option>
              </select>
            </div>
            {recurrence !== 'none' && (
              <div>
                <label className="label" htmlFor="ev-until">
                  Until (optional)
                </label>
                <input id="ev-until" type="date" className="input" value={until} min={startDate} onChange={(e) => setUntil(e.target.value)} />
              </div>
            )}
          </div>
          )}
          <div>
            <label className="label" htmlFor="ev-loc">
              Location
            </label>
            <input id="ev-loc" className="input" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={500} />
          </div>
          <div>
            <label className="label" htmlFor="ev-notes">
              Notes
            </label>
            <textarea id="ev-notes" className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={10_000} />
          </div>
          {event.id && event.recurrence && event.recurrence !== 'none' && <div className="hint">Changes apply to every repeat of this event.</div>}
          {event.instance && <div className="hint">One occurrence of a repeating event: changes apply to this occurrence only.</div>}
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="dialog-foot">
          {event.id && (
            <button className="btn" onClick={() => void remove()}>
              <Trash2 size={14} /> Delete
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !calendarId} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- the calendar editor ------------------------------------------------------------------------

function CalendarEditor({
  calendar,
  source,
  accounts,
  onClose,
  onSaved,
}: {
  calendar: CalendarView | null;
  source: CalendarSourceView | null;
  accounts: AccountView[];
  onClose: () => void;
  onSaved: (l: CalendarView[]) => void;
}) {
  if (calendar && calendar.source !== 'local') return <ProviderCalendarEditor calendar={calendar} source={source} onClose={onClose} onSaved={onSaved} />;
  return <OwnCalendarEditor calendar={calendar} accounts={accounts} onClose={onClose} onSaved={onSaved} />;
}

const PROVIDER_NAMES = { google: 'Google Calendar', microsoft: 'Outlook', caldav: 'CalDAV' } as const;

/** A Google / Outlook / CalDAV calendar: its color here, and disconnecting a CalDAV account. */
function ProviderCalendarEditor({ calendar, source, onClose, onSaved }: { calendar: CalendarView; source: CalendarSourceView | null; onClose: () => void; onSaved: (l: CalendarView[]) => void }) {
  const [color, setColor] = useState(calendar.color);
  const [error, setError] = useState<string | null>(null);
  const kind = calendar.source as keyof typeof PROVIDER_NAMES;
  const save = async () => {
    try {
      onSaved(await fetchJson<CalendarView[]>('PUT', `/api/calendars/${encodeURIComponent(calendar.id)}`, { name: calendar.name, color, accountId: null }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const disconnect = async () => {
    if (!source || !window.confirm(`Disconnect “${source.name}”? Its calendars disappear from DreyMail; nothing is deleted on the server.`)) return;
    try {
      onSaved((await fetchJson<{ calendars: CalendarView[] }>('DELETE', `/api/calendar-sources/${encodeURIComponent(source.id)}`)).calendars);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(460px, 100%)' }}>
        <div className="dialog-head">
          <h2>{calendar.name}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="muted">
            From {PROVIDER_NAMES[kind]}
            {source ? ` · ${source.name}` : ''}
            {calendar.access === 'view' ? ' · read-only' : ''}. Events are read from there and changes go straight back.
          </div>
          {source?.kind === 'caldav' && source.url && (
            <div className="hint">
              {source.username} at {source.url}
            </div>
          )}
          <div>
            <label className="label">Color in DreyMail</label>
            <div className="cal-colors">
              {ACCOUNT_COLORS.map((c) => (
                <button key={c} className={`cal-swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} title={c} aria-label={`Color ${c}`} />
              ))}
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Any color" aria-label="Any color" />
            </div>
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="dialog-foot">
          {source?.kind === 'caldav' && (
            <button className="btn" onClick={() => void disconnect()}>
              <Trash2 size={14} /> Disconnect
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** Connect a CalDAV account: Nextcloud, iCloud, Fastmail, Radicale, Baïkal… */
function CalDavDialog({ accounts, onClose, onSaved }: { accounts: AccountView[]; onClose: () => void; onSaved: (l: CalendarView[]) => void }) {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved((await fetchJson<{ calendars: CalendarView[] }>('POST', '/api/calendar-sources', { url, username, password, name, accountId })).calendars);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(500px, 100%)' }}>
        <div className="dialog-head">
          <h2>Connect a CalDAV calendar</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">
          <div>
            <label className="label" htmlFor="dav-url">
              Server address
            </label>
            <input id="dav-url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://cloud.example.com/remote.php/dav" autoFocus />
            <div className="hint">
              Nextcloud: https://your-cloud/remote.php/dav · iCloud: https://caldav.icloud.com · Fastmail: https://caldav.fastmail.com · Radicale or Baïkal: the server&apos;s address. Use https unless the server is on
              your own network.
            </div>
          </div>
          <div className="cal-when">
            <div>
              <label className="label" htmlFor="dav-user">
                Username
              </label>
              <input id="dav-user" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label className="label" htmlFor="dav-pass">
                Password
              </label>
              <input id="dav-pass" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" onKeyDown={(e) => e.key === 'Enter' && void save()} />
            </div>
          </div>
          <div className="hint">iCloud and Fastmail need an app-specific password. It is stored encrypted, like mailbox passwords.</div>
          <div className="cal-when">
            <div>
              <label className="label" htmlFor="dav-name">
                Name (optional)
              </label>
              <input id="dav-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="The server's name" maxLength={80} />
            </div>
            {accounts.length > 0 && (
              <div>
                <label className="label" htmlFor="dav-acct">
                  Show under
                </label>
                <select id="dav-acct" className="select" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || null)}>
                  <option value="">Its own name</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="dialog-foot">
          <span className="grow muted">{busy ? 'Looking for calendars…' : ''}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !url.trim() || !username.trim() || !password} onClick={() => void save()}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}

function OwnCalendarEditor({ calendar, accounts, onClose, onSaved }: { calendar: CalendarView | null; accounts: AccountView[]; onClose: () => void; onSaved: (l: CalendarView[]) => void }) {
  const owner = !calendar || calendar.access === 'owner';
  const [name, setName] = useState(calendar?.name ?? '');
  const [color, setColor] = useState(calendar?.color ?? ACCOUNT_COLORS[1]!);
  const [accountId, setAccountId] = useState<string | null>(calendar?.accountId ?? null);
  const [shares, setShares] = useState(calendar?.shares ?? []);
  const [error, setError] = useState<string | null>(null);
  const people = useQuery({ queryKey: ['calendar-people'], queryFn: calendarsApi.people, enabled: owner && !!calendar });
  const others = (people.data ?? []).filter((p) => !shares.some((s) => s.userId === p.id));

  const save = async () => {
    try {
      const body = { name, color, accountId };
      let l = calendar
        ? await fetchJson<CalendarView[]>('PUT', `/api/calendars/${encodeURIComponent(calendar.id)}`, body)
        : await fetchJson<CalendarView[]>('POST', '/api/calendars', body);
      if (calendar && JSON.stringify(shares) !== JSON.stringify(calendar.shares))
        l = await fetchJson<CalendarView[]>('PUT', `/api/calendars/${encodeURIComponent(calendar.id)}/shares`, { shares: shares.map((s) => ({ userId: s.userId, canEdit: s.canEdit })) });
      onSaved(l);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!calendar) return;
    const question = owner ? `Delete “${calendar.name}” and all its events? People it is shared with lose it too.` : `Remove “${calendar.name}” from your calendars? ${calendar.ownerName} can share it again.`;
    if (!window.confirm(question)) return;
    try {
      onSaved(await fetchJson<CalendarView[]>('DELETE', `/api/calendars/${encodeURIComponent(calendar.id)}`));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(480px, 100%)' }}>
        <div className="dialog-head">
          <h2>{!calendar ? 'New calendar' : owner ? 'Calendar' : calendar.name}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">
          {owner ? (
            <>
              <div>
                <label className="label" htmlFor="cal-name">
                  Name
                </label>
                <input id="cal-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
              </div>
              <div>
                <label className="label">Color</label>
                <div className="cal-colors">
                  {ACCOUNT_COLORS.map((c) => (
                    <button key={c} className={`cal-swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} title={c} aria-label={`Color ${c}`} />
                  ))}
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Any color" aria-label="Any color" />
                </div>
              </div>
              {accounts.length > 0 && (
                <div>
                  <label className="label" htmlFor="cal-acct">
                    Show under
                  </label>
                  <select id="cal-acct" className="select" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || null)}>
                    <option value="">My calendars</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <div className="hint">Only groups it in the calendar list.</div>
                </div>
              )}
              {calendar && (
                <div>
                  <label className="label">Shared with</label>
                  {shares.length === 0 && <div className="muted">Only you.</div>}
                  <div className="check-list">
                    {shares.map((s) => (
                      <div key={s.userId} className="cal-share">
                        <span className="cal-name">{s.name}</span>
                        <label className="check">
                          <input type="checkbox" checked={s.canEdit} onChange={(e) => setShares((l) => l.map((x) => (x.userId === s.userId ? { ...x, canEdit: e.target.checked } : x)))} /> Can edit
                        </label>
                        <button className="icon-btn" title={`Stop sharing with ${s.name}`} onClick={() => setShares((l) => l.filter((x) => x.userId !== s.userId))}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {others.length > 0 && (
                    <select
                      className="select"
                      value=""
                      style={{ marginTop: 8 }}
                      onChange={(e) => {
                        const p = others.find((o) => o.id === e.target.value);
                        if (p) setShares((l) => [...l, { userId: p.id, name: p.name, canEdit: false }]);
                      }}
                    >
                      <option value="">Share with…</option>
                      {others.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="hint">Shared calendars appear for others under “Shared with me”. View only, unless you tick “Can edit”.</div>
                </div>
              )}
            </>
          ) : (
            <div>
              Shared with you by {calendar!.ownerName}, {calendar!.access === 'edit' ? 'and you can add and change its events' : 'to view'}.
            </div>
          )}
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="dialog-foot">
          {calendar && (
            <button className="btn" onClick={() => void remove()}>
              <Trash2 size={14} /> {owner ? 'Delete' : 'Remove'}
            </button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {owner ? 'Cancel' : 'Close'}
          </button>
          {owner && (
            <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
