// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The event editor: when, how it repeats (every N days, weeks, months or years; on chosen weekdays;
// on the n-th or last weekday; until a day or a number of times), the reminder, guests (invitations
// go out from a mailbox, or from Outlook / Google themselves) and a Teams or Meet meeting. An
// occurrence of a repeating event can be changed on its own, with the ones after it, or as the
// whole series.

import { Bell, DoorOpen, MapPin, Repeat, Trash2, Users, Video, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_REMINDER,
  describeRepeat,
  REMINDER_CHOICES,
  SHOW_AS_LABELS,
  reminderLabel,
  type Attendee,
  type CalendarEvent,
  type CalendarView,
  type EventInput,
  type EventOccurrence,
  type MonthlyBy,
  type Recurrence,
  type Room,
  type SeriesScope,
  type ShowAs,
} from '../../../shared/calendar';
import type { AccountView } from '../../../shared/types';
import { isAddress, splitAddresses } from '../addresses';
import { fetchJson } from '../api';
import { AddressField } from './AddressField';
import { SchedulingAssistant } from './SchedulingAssistant';

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const utcKeyOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
/** An ISO time as a wall time (its UTC fields are this computer's local fields; all-day: UTC). */
const wallOf = (iso: string, allDay: boolean) => {
  const d = new Date(iso);
  return allDay ? d.getTime() : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
};
const timeLabel = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return { date: keyOf(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
};
const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
const UNITS: Record<Exclude<Recurrence, 'none'>, [string, string]> = { daily: ['day', 'days'], weekly: ['week', 'weeks'], monthly: ['month', 'months'], yearly: ['year', 'years'] };
const STATUS_LABEL: Record<Attendee['status'], string> = { accepted: 'Accepted', tentative: 'Maybe', declined: 'Declined', 'needs-action': 'No answer yet' };
const PROVIDER = { google: 'Google', microsoft: 'Outlook', caldav: 'CalDAV', local: 'DreyMail' } as const;

/** "Name <a@b>" or "a@b" as a guest. */
function guestOf(entry: string): Attendee | null {
  if (!isAddress(entry)) return null;
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(entry);
  const email = (m ? m[2]! : entry).trim().toLowerCase();
  return { email, name: m ? m[1]!.trim() : '', status: 'needs-action' };
}

type Saved = { warning?: string };

/**
 * The editor for a new event, an event, or an occurrence of a repeating one. `event` is what was
 * clicked (an occurrence carries occurrenceStart).
 */
export function EventEditor({
  event,
  calendars,
  accounts,
  onClose,
  onSaved,
}: {
  event: Partial<CalendarEvent> & Partial<Pick<EventOccurrence, 'occurrenceStart' | 'occurrenceEnd'>>;
  calendars: CalendarView[];
  accounts: AccountView[];
  onClose: () => void;
  onSaved: (warning?: string) => void;
}) {
  const cal = calendars.find((c) => c.id === event.calendarId);
  const local = !cal || cal.source === 'local';
  /** A DreyMail event that repeats, opened on one occurrence. */
  const localSeries = !!event.id && local && !!event.recurrence && event.recurrence !== 'none' && !!event.occurrenceStart;
  /** An occurrence of a provider series. */
  const providerSeries = !!event.id && !local && !!event.instance && !!event.seriesId;
  const [scope, setScope] = useState<SeriesScope>(localSeries || providerSeries ? 'this' : 'all');
  const [series, setSeries] = useState<CalendarEvent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The whole series of a provider event comes from the provider.
  useEffect(() => {
    if (!providerSeries || scope !== 'all' || series) return;
    fetchJson<CalendarEvent>('GET', `/api/events/${encodeURIComponent(event.seriesId!)}`).then(setSeries, (e: Error) => setLoadError(e.message));
  }, [providerSeries, scope, series, event.seriesId]);

  /** What the form shows: the occurrence, or the series it belongs to. */
  const base: Partial<CalendarEvent> | null = useMemo(() => {
    if (providerSeries) return scope === 'all' ? series : { ...event, recurrence: 'none', until: null };
    if (localSeries && scope !== 'all') return { ...event, start: event.occurrenceStart, end: event.occurrenceEnd, ...(scope === 'this' ? { recurrence: 'none' as const, until: null, count: null } : {}) };
    return event;
  }, [event, scope, series, providerSeries, localSeries]);

  const scopes: { value: SeriesScope; label: string }[] = localSeries
    ? [
        { value: 'this', label: 'This event' },
        { value: 'following', label: 'This and following' },
        { value: 'all', label: 'All events' },
      ]
    : providerSeries
      ? [
          { value: 'this', label: 'This event' },
          { value: 'all', label: 'All events' },
        ]
      : [];

  return (
    <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="dialog event-dialog" role="dialog" aria-modal="true" style={{ width: 'min(560px, 100%)' }}>
        {scopes.length > 0 && (
          <div className="ev-scope" role="radiogroup" aria-label="Change">
            <Repeat size={14} />
            <span className="muted">Repeating event:</span>
            <div className="segmented">
              {scopes.map((s) => (
                <button key={s.value} role="radio" aria-checked={scope === s.value} className={scope === s.value ? 'on' : ''} onClick={() => setScope(s.value)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {loadError ? (
          <div className="dialog-body">
            <div className="error-text">{loadError}</div>
          </div>
        ) : !base ? (
          <div className="dialog-body">
            <div className="hint">Loading the series…</div>
          </div>
        ) : (
          <EventForm key={`${scope}:${base.id ?? 'new'}`} base={base} clicked={event} scope={scope} calendars={calendars} accounts={accounts} onClose={onClose} onSaved={onSaved} />
        )}
      </div>
    </div>
  );
}

function EventForm({
  base,
  clicked,
  scope,
  calendars,
  accounts,
  onClose,
  onSaved,
}: {
  base: Partial<CalendarEvent>;
  clicked: Partial<CalendarEvent> & Partial<Pick<EventOccurrence, 'occurrenceStart'>>;
  scope: SeriesScope;
  calendars: CalendarView[];
  accounts: AccountView[];
  onClose: () => void;
  onSaved: (warning?: string) => void;
}) {
  const cal = calendars.find((c) => c.id === base.calendarId);
  const readOnly = !!base.id && (cal?.access === 'view' || !!base.readOnly);
  const writable = calendars.filter((c) => c.access !== 'view');
  const isNew = !base.id;
  const fromProvider = !isNew && !!cal && cal.source !== 'local';
  const organizer = base.isOrganizer !== false;
  const s0 = base.allDay ? { date: utcKeyOf(new Date(base.start!)), time: '09:00' } : toLocalInput(base.start!);
  const e0 = base.allDay ? { date: utcKeyOf(new Date(Date.parse(base.end!) - DAY)), time: '10:00' } : toLocalInput(base.end!);
  const [title, setTitle] = useState(base.title ?? '');
  const [calendarId, setCalendarId] = useState(base.calendarId ?? writable[0]?.id ?? '');
  const [allDay, setAllDay] = useState(!!base.allDay);
  const [startDate, setStartDate] = useState(s0.date);
  const [startTime, setStartTime] = useState(s0.time);
  const [endDate, setEndDate] = useState(e0.date);
  const [endTime, setEndTime] = useState(e0.time);
  const [recurrence, setRecurrence] = useState<Recurrence>(base.recurrence ?? 'none');
  const [interval, setInterval] = useState(base.interval ?? 1);
  const [byDay, setByDay] = useState<number[]>(base.byDay ?? []);
  const [monthlyBy, setMonthlyBy] = useState<MonthlyBy>(base.monthlyBy ?? 'day');
  const [ends, setEnds] = useState<'never' | 'until' | 'count'>(base.count ? 'count' : base.until ? 'until' : 'never');
  const [until, setUntil] = useState(base.until ?? '');
  const [count, setCount] = useState(base.count ?? 10);
  const [reminder, setReminder] = useState<number | null>(isNew ? (base.allDay ? null : DEFAULT_REMINDER) : (base.reminder ?? null));
  const [reminderTouched, setReminderTouched] = useState(!isNew);
  const [showAs, setShowAs] = useState<ShowAs>(base.showAs ?? 'busy');
  const [showSched, setShowSched] = useState(false);
  const [location, setLocation] = useState(base.location ?? '');
  const [notes, setNotes] = useState(base.notes ?? '');
  const [guests, setGuests] = useState<Attendee[]>(base.attendees ?? []);
  const [typed, setTyped] = useState('');
  const [sendFrom, setSendFrom] = useState<string>(base.sendFrom ?? '');
  const [meeting, setMeeting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selCal = calendars.find((c) => c.id === calendarId);
  const meetingKind = selCal?.meetings?.[0];
  /** The start as typed, in this computer's time. */
  const startLocal = allDay ? fromKey(startDate) : new Date(`${startDate}T${startTime}`);
  const validStart = !Number.isNaN(startLocal.getTime());
  const weekday = validStart ? startLocal.getDay() : 1;
  const dayOfMonth = validStart ? startLocal.getDate() : 1;
  const nth = Math.ceil(dayOfMonth / 7);
  const lastWeek = validStart && dayOfMonth + 7 > new Date(startLocal.getFullYear(), startLocal.getMonth() + 1, 0).getDate();
  const startWall = Date.UTC(startLocal.getFullYear(), startLocal.getMonth(), startLocal.getDate(), startLocal.getHours(), startLocal.getMinutes());
  const canRepeat = scope !== 'this';
  // Invitations from DreyMail (its own and CalDAV calendars) go out from a mailbox; Google and Outlook send their own.
  const mailsInvites = !selCal || selCal.source === 'local' || selCal.source === 'caldav';
  const repeat = { recurrence, until: ends === 'until' ? until || null : null, interval, byDay: recurrence === 'weekly' ? (byDay.length ? byDay : [weekday]) : undefined, monthlyBy: recurrence === 'monthly' || recurrence === 'yearly' ? monthlyBy : undefined, count: ends === 'count' ? count : null };

  const allGuests = (): Attendee[] => {
    const extra = [...splitAddresses(typed).done, splitAddresses(typed).draft].map(guestOf).filter((g): g is Attendee => !!g);
    const out = [...guests];
    for (const g of extra) if (!out.some((x) => x.email === g.email)) out.push(g);
    return out;
  };

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
    if (splitAddresses(typed).draft.trim() && !guestOf(splitAddresses(typed).draft)) return setError(`"${splitAddresses(typed).draft.trim()}" is not a complete address`);
    if (canRepeat && recurrence !== 'none' && ends === 'until' && until && until < startDate) return setError('The repeat ends before it starts');
    const people = organizer ? allGuests() : undefined;
    const body: EventInput & { instance?: boolean; scope?: SeriesScope; occurrenceStart?: string } = {
      calendarId,
      title: title.trim() || '(no title)',
      start,
      end,
      allDay,
      location,
      notes,
      ...(canRepeat ? repeat : { recurrence: 'none' as const, until: null }),
      timeZone: base.timeZone && !isNew && scope === 'all' ? base.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone,
      reminder,
      showAs,
      ...(people ? { attendees: people, sendFrom: people.length && mailsInvites ? sendFrom || null : null } : {}),
      ...(meeting && meetingKind ? { meeting: meetingKind } : {}),
    };
    let url = '/api/events';
    let method: 'POST' | 'PUT' = 'POST';
    if (!isNew) {
      method = 'PUT';
      url = `/api/events/${encodeURIComponent(base.id!)}`;
      if (fromProvider) body.instance = scope === 'this' && !!clicked.instance;
      else if (clicked.recurrence && clicked.recurrence !== 'none' && clicked.occurrenceStart) {
        body.scope = scope;
        body.occurrenceStart = clicked.occurrenceStart;
      }
    }
    setBusy(true);
    try {
      const r = await fetchJson<Saved>(method, url, body);
      onSaved(r?.warning);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!base.id) return;
    const repeating = (clicked.recurrence && clicked.recurrence !== 'none') || clicked.instance;
    const question =
      !repeating || scope === 'all'
        ? repeating
          ? 'Delete every occurrence of this event?'
          : 'Delete this event?'
        : scope === 'this'
          ? 'Delete this occurrence? The other repeats stay.'
          : 'Delete this occurrence and the ones after it?';
    const told = guests.length && organizer ? `${question} Guests get a cancellation.` : question;
    if (!window.confirm(told)) return;
    try {
      const local = !fromProvider && clicked.recurrence && clicked.recurrence !== 'none' && clicked.occurrenceStart;
      const q = local ? `?scope=${scope}&occurrence=${encodeURIComponent(clicked.occurrenceStart!)}` : '';
      await fetchJson('DELETE', `/api/events/${encodeURIComponent(base.id)}${q}`);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const join = base.joinUrl ? (
    <a className="btn primary" href={base.joinUrl} target="_blank" rel="noreferrer" title={base.joinUrl}>
      <Video size={14} /> Join
    </a>
  ) : null;

  if (readOnly) {
    const s = new Date(clicked.occurrenceStart ?? base.start!);
    const e = new Date((clicked as EventOccurrence).occurrenceEnd ?? base.end!);
    return (
      <>
        <div className="dialog-head">
          <h2>{base.title}</h2>
          {join}
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">
          <div>
            {base.allDay
              ? `${utcKeyOf(s) === utcKeyOf(new Date(e.getTime() - DAY)) ? fromKey(utcKeyOf(s)).toLocaleDateString([], { dateStyle: 'full' }) : `${fromKey(utcKeyOf(s)).toLocaleDateString()} – ${fromKey(utcKeyOf(new Date(e.getTime() - DAY))).toLocaleDateString()}`} · All day`
              : `${s.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })} – ${timeLabel(e)}`}
          </div>
          {base.recurrence && base.recurrence !== 'none' && (
            <div className="muted">
              <Repeat size={13} /> {describeRepeat(base as CalendarEvent, wallOf(base.start!, !!base.allDay))}
            </div>
          )}
          {base.location && (
            <div>
              <MapPin size={13} /> {base.location}
            </div>
          )}
          {base.reminder !== null && base.reminder !== undefined && (
            <div className="muted">
              <Bell size={13} /> {reminderLabel(base.reminder)}
            </div>
          )}
          {!!base.attendees?.length && <GuestList guests={base.attendees} organizer={base.organizer ?? null} />}
          {base.notes && <div style={{ whiteSpace: 'pre-wrap' }}>{base.notes}</div>}
          <div className="hint">
            <span className="cal-dot" style={{ background: cal?.color }} /> {cal?.name} ·{' '}
            {cal?.source === 'local' ? `shared by ${cal.ownerName} (view only)` : base.readOnly && cal?.access !== 'view' ? `this series repeats in a way DreyMail can't change; change single occurrences here, or the series in ${PROVIDER[cal?.source ?? 'local']}` : 'read-only calendar'}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="dialog-head">
        <h2>{isNew ? 'New event' : scope === 'all' && (base.recurrence ?? 'none') !== 'none' ? 'Edit series' : 'Edit event'}</h2>
        {join}
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
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => {
              setAllDay(e.target.checked);
              if (!reminderTouched) setReminder(e.target.checked ? null : DEFAULT_REMINDER);
            }}
          />{' '}
          All day
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

        {canRepeat && (
          <div className="ev-repeat">
            <div className="cal-when">
              <div>
                <label className="label" htmlFor="ev-repeat">
                  Repeats
                </label>
                <select
                  id="ev-repeat"
                  className="select"
                  value={recurrence}
                  onChange={(e) => {
                    const r = e.target.value as Recurrence;
                    setRecurrence(r);
                    if (r === 'weekly' && !byDay.length) setByDay([weekday]);
                  }}
                >
                  <option value="none">Does not repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              {recurrence !== 'none' && (
                <div>
                  <label className="label" htmlFor="ev-interval">
                    Every
                  </label>
                  <div className="cal-when-row">
                    <input id="ev-interval" type="number" className="input ev-num" min={1} max={999} value={interval} onChange={(e) => setInterval(Math.max(1, Math.min(999, Number(e.target.value) || 1)))} />
                    <span>{UNITS[recurrence][interval === 1 ? 0 : 1]}</span>
                  </div>
                </div>
              )}
            </div>
            {recurrence === 'weekly' && (
              <div className="ev-weekdays" role="group" aria-label="On these days">
                {WEEKDAY_LETTERS.map((l, d) => {
                  const on = (byDay.length ? byDay : [weekday]).includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      className={on ? 'on' : ''}
                      aria-pressed={on}
                      title={WEEKDAYS[d]}
                      onClick={() => {
                        const cur = byDay.length ? byDay : [weekday];
                        const next = on ? cur.filter((x) => x !== d) : [...cur, d].sort();
                        setByDay(next.length ? next : cur);
                      }}
                    >
                      {l}
                    </button>
                  );
                })}
                <button type="button" className="ev-weekdays-preset" onClick={() => setByDay([1, 2, 3, 4, 5])} title="Monday to Friday">
                  Weekdays
                </button>
              </div>
            )}
            {(recurrence === 'monthly' || recurrence === 'yearly') && (
              <select className="select" value={monthlyBy} onChange={(e) => setMonthlyBy(e.target.value as MonthlyBy)} aria-label="On">
                <option value="day">
                  On {recurrence === 'yearly' ? startLocal.toLocaleDateString([], { month: 'long', day: 'numeric' }) : `day ${dayOfMonth}`}
                </option>
                {nth <= 4 && (
                  <option value="weekday">
                    On the {ORDINALS[nth]} {WEEKDAYS[weekday]}
                    {recurrence === 'yearly' ? ` of ${startLocal.toLocaleDateString([], { month: 'long' })}` : ''}
                  </option>
                )}
                {lastWeek && (
                  <option value="last">
                    On the last {WEEKDAYS[weekday]}
                    {recurrence === 'yearly' ? ` of ${startLocal.toLocaleDateString([], { month: 'long' })}` : ''}
                  </option>
                )}
              </select>
            )}
            {recurrence !== 'none' && (
              <div className="cal-when-row ev-ends">
                <label className="label" htmlFor="ev-ends">
                  Ends
                </label>
                <select id="ev-ends" className="select" value={ends} onChange={(e) => setEnds(e.target.value as typeof ends)}>
                  <option value="never">Never</option>
                  <option value="until">On a day</option>
                  <option value="count">After a number of times</option>
                </select>
                {ends === 'until' && <input type="date" className="input" value={until} min={startDate} onChange={(e) => setUntil(e.target.value)} aria-label="Last day" />}
                {ends === 'count' && (
                  <>
                    <input type="number" className="input ev-num" min={1} max={999} value={count} onChange={(e) => setCount(Math.max(1, Math.min(999, Number(e.target.value) || 1)))} aria-label="Times" />
                    <span>times</span>
                  </>
                )}
              </div>
            )}
            {recurrence !== 'none' && validStart && <div className="hint">{describeRepeat(repeat, startWall)}</div>}
          </div>
        )}

        <div className="cal-when">
          <div>
            <label className="label" htmlFor="ev-reminder">
              Reminder
            </label>
            <select
              id="ev-reminder"
              className="select"
              value={reminder === null ? 'none' : String(reminder)}
              onChange={(e) => {
                setReminderTouched(true);
                setReminder(e.target.value === 'none' ? null : Number(e.target.value));
              }}
            >
              <option value="none">None</option>
              {[...new Set([...REMINDER_CHOICES, ...(reminder !== null ? [reminder] : [])])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {reminderLabel(m)}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ev-show">
              Show as
            </label>
            <select id="ev-show" className="select" value={showAs} onChange={(e) => setShowAs(e.target.value as ShowAs)}>
              {(Object.keys(SHOW_AS_LABELS) as ShowAs[]).map((k) => (
                <option key={k} value={k}>
                  {SHOW_AS_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="cal-when">
          <div>
            <label className="label" htmlFor="ev-loc">
              Location
            </label>
            <input id="ev-loc" className="input" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={500} placeholder="A place, or a meeting link" />
          </div>
        </div>

        {meetingKind && !base.joinUrl && organizer && (
          <label className="check">
            <input type="checkbox" checked={meeting} onChange={(e) => setMeeting(e.target.checked)} /> <Video size={14} /> {meetingKind === 'teams' ? 'Add a Teams meeting' : 'Add a Google Meet video call'}
          </label>
        )}

        <div className="ev-guests">
          <label className="label">
            <Users size={13} /> Guests
          </label>
          {guests.length > 0 && <GuestList guests={guests} organizer={base.organizer ?? null} onRemove={organizer ? (email) => setGuests((g) => g.filter((x) => x.email !== email)) : undefined} onOptional={organizer ? (email) => setGuests((g) => g.map((x) => (x.email === email ? { ...x, optional: !x.optional } : x))) : undefined} />}
          {organizer ? (
            <>
              <div className="ev-guests-field">
                <AddressField label="Invite" value={typed} onChange={setTyped} from={sendFrom || accounts[0]?.id || ''} />
              </div>
              {!allDay && validStart && (
                <RoomPicker
                  accounts={accounts}
                  start={new Date(`${startDate}T${startTime}`)}
                  end={new Date(`${endDate}T${endTime}`)}
                  calendarId={calendarId || null}
                  booked={guests.filter((g) => g.resource).map((g) => g.email)}
                  onPick={(r) => {
                    setGuests((g) => (g.some((x) => x.email === r.email) ? g : [...g, { email: r.email, name: r.name, status: 'needs-action', resource: true }]));
                    if (!location.trim()) setLocation(r.name);
                  }}
                />
              )}
            </>
          ) : (
            base.organizer && <div className="hint">Organized by {base.organizer.name || base.organizer.email}; only they change the guest list.</div>
          )}
          {organizer && mailsInvites && (guests.length > 0 || typed.trim()) && accounts.length > 0 && (
            <div className="cal-when-row">
              <label className="label" htmlFor="ev-from">
                Invite from
              </label>
              <select id="ev-from" className="select" value={sendFrom} onChange={(e) => setSendFrom(e.target.value)}>
                <option value="">{accounts.find((a) => a.id === selCal?.accountId)?.email ?? accounts[0]?.email} (default)</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.email}
                  </option>
                ))}
              </select>
            </div>
          )}
          {organizer && !mailsInvites && (guests.length > 0 || typed.trim()) && <div className="hint">{PROVIDER[selCal!.source]} sends the invitations and updates.</div>}
        </div>

        {!allDay && allGuests().length > 0 && validStart && (
          <div>
            <button type="button" className="link-btn" onClick={() => setShowSched((v) => !v)} aria-expanded={showSched}>
              {showSched ? 'Hide' : 'Show'} the scheduling assistant
            </button>
            {showSched && (
              <SchedulingAssistant
                calendarId={calendarId || null}
                guests={allGuests().map((g) => g.email)}
                start={new Date(`${startDate}T${startTime}`)}
                end={new Date(`${endDate}T${endTime}`)}
                onPick={(t) => {
                  const len = new Date(`${endDate}T${endTime}`).getTime() - new Date(`${startDate}T${startTime}`).getTime();
                  const e = new Date(t.getTime() + Math.max(len, 15 * 60_000));
                  setStartDate(keyOf(t));
                  setStartTime(`${pad(t.getHours())}:${pad(t.getMinutes())}`);
                  setEndDate(keyOf(e));
                  setEndTime(`${pad(e.getHours())}:${pad(e.getMinutes())}`);
                }}
              />
            )}
          </div>
        )}

        <div>
          <label className="label" htmlFor="ev-notes">
            Notes
          </label>
          <textarea id="ev-notes" className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={10_000} />
        </div>
        {scope === 'all' && !isNew && (base.recurrence ?? 'none') !== 'none' && <div className="hint">Changes apply to every occurrence of this event.</div>}
        {scope === 'following' && <div className="hint">This occurrence and the ones after it become a series of their own with these changes.</div>}
        {scope === 'this' && (clicked.instance || (clicked.recurrence && clicked.recurrence !== 'none')) && <div className="hint">Changes apply to this occurrence only.</div>}
        {error && <div className="error-text">{error}</div>}
      </div>
      <div className="dialog-foot">
        {!isNew && (
          <button className="btn" onClick={() => void remove()}>
            <Trash2 size={14} /> Delete
          </button>
        )}
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !calendarId} onClick={() => void save()}>
          {busy ? 'Saving…' : allGuests().length && organizer ? (isNew ? 'Send' : 'Save and send') : 'Save'}
        </button>
      </div>
    </>
  );
}

function GuestList({ guests, organizer, onRemove, onOptional }: { guests: Attendee[]; organizer: { email: string; name: string } | null; onRemove?: (email: string) => void; onOptional?: (email: string) => void }) {
  const answered = guests.filter((g) => g.status === 'accepted' && !g.resource).length;
  const people = guests.filter((g) => !g.resource).length;
  return (
    <div className="ev-guest-list">
      {organizer && (
        <div className="ev-guest">
          <span className="ev-status organizer" title="Organizer" />
          <span className="ev-guest-name">{organizer.name || organizer.email}</span>
          <span className="muted">Organizer</span>
        </div>
      )}
      {guests.map((g) => (
        <div key={g.email} className="ev-guest">
          <span className={`ev-status ${g.status}`} title={STATUS_LABEL[g.status]} />
          <span className="ev-guest-name" title={g.email}>
            {g.resource && <DoorOpen size={12} />} {g.name || g.email}
          </span>
          <span className="muted">
            {g.resource ? (g.status === 'accepted' ? 'Booked' : g.status === 'declined' ? 'Not available' : g.status === 'tentative' ? 'Tentative' : 'Waiting for the room') : STATUS_LABEL[g.status]}
            {g.optional ? ' · optional' : ''}
          </span>
          {onOptional && !g.resource && (
            <button className="link-btn" onClick={() => onOptional(g.email)} title={g.optional ? 'Make required' : 'Make optional'}>
              {g.optional ? 'Required' : 'Optional'}
            </button>
          )}
          {onRemove && (
            <button className="icon-btn" onClick={() => onRemove(g.email)} title={`Remove ${g.email}`}>
              <X size={13} />
            </button>
          )}
        </div>
      ))}
      <div className="hint">
        {people} guest{people === 1 ? '' : 's'} · {answered} accepted
        {guests.length > people ? ` · ${guests.length - people} room${guests.length - people === 1 ? '' : 's'}` : ''}
      </div>
    </div>
  );
}

/**
 * Booking a meeting room (DreyMail 10.7): the rooms you can book, each marked free or busy at the
 * meeting's time; a pick invites the room as a resource (it accepts or declines by itself).
 */
function RoomPicker({ accounts, start, end, calendarId, booked, onPick }: { accounts: AccountView[]; start: Date; end: Date; calendarId: string | null; booked: string[]; onPick: (r: Room) => void }) {
  const [open, setOpen] = useState(false);
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => fetchJson<{ rooms: Room[]; microsoft: { accountId: string; allowed: boolean }[] }>('GET', '/api/rooms'), staleTime: 300_000, enabled: open });
  const list = (rooms.data?.rooms ?? []).filter((r) => !booked.includes(r.email));
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const fb = useQuery({
    queryKey: ['freebusy', 'rooms', calendarId, list.slice(0, 50).map((r) => r.email).join(','), day.toISOString()],
    queryFn: () => fetchJson<{ people: Record<string, { busy: { start: string; end: string }[]; error?: string }> }>('POST', '/api/freebusy', { calendarId, emails: list.slice(0, 50).map((r) => r.email), from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString() }),
    enabled: open && list.length > 0,
    staleTime: 60_000,
  });
  const state = (r: Room) => {
    const p = fb.data?.people[r.email];
    if (!p || p.error) return 'unknown';
    return p.busy.some((b) => Date.parse(b.start) < end.getTime() && Date.parse(b.end) > start.getTime()) ? 'busy' : 'free';
  };
  const notAllowed = (rooms.data?.microsoft ?? []).filter((m) => !m.allowed);
  if (!open)
    return (
      <button type="button" className="link-btn" onClick={() => setOpen(true)}>
        <DoorOpen size={13} /> Book a room
      </button>
    );
  return (
    <div className="room-picker">
      <div className="room-head">
        <strong>Rooms</strong>
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={() => setOpen(false)} title="Close">
          <X size={14} />
        </button>
      </div>
      {rooms.isLoading && <div className="hint">Loading rooms…</div>}
      {rooms.data && list.length === 0 && <div className="hint">No rooms to book yet.</div>}
      <div className="room-list">
        {[...list].sort((a, b) => Number(state(b) === 'free') - Number(state(a) === 'free')).map((r) => {
          const st = state(r);
          return (
            <button key={r.email} type="button" className="room-row" onClick={() => onPick(r)} title={r.email}>
              <span className={`room-dot ${st}`} />
              <span className="grow">
                {r.name}
                <span className="muted">
                  {r.capacity ? ` · ${r.capacity} seats` : ''}
                  {r.building ? ` · ${r.building}` : ''}
                </span>
              </span>
              <span className="muted">{st === 'free' ? 'Free' : st === 'busy' ? 'Busy' : ''}</span>
            </button>
          );
        })}
      </div>
      {notAllowed.map((m) => {
        const a = accounts.find((x) => x.id === m.accountId);
        return a ? (
          <div key={m.accountId} className="hint">
            Show your organization&apos;s rooms from Microsoft 365 ({a.name})?{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                void fetchJson<{ url: string }>('POST', '/api/oauth/microsoft/start', { color: a.color, allow: ['rooms'] }).then(
                  ({ url }) => (window.location.href = url),
                  (e: Error) => window.alert(e.message),
                )
              }
            >
              Allow
            </button>{' '}
            (an administrator approves this once for everyone).
          </div>
        ) : null;
      })}
      <div className="hint">An administrator can also list rooms in Settings → Server → Meeting rooms.</div>
    </div>
  );
}
