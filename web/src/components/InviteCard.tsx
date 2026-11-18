// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The invitation card above a message with a calendar invitation: what, when, where, who, and
// Yes / Maybe / No. Google and Outlook mailboxes answer through their own calendar; other
// mailboxes email the answer to the organizer and add the event to the calendar you pick.
// Modified by samschultzponsys, 2026-11-17: guests' answers to your invitations go on your events.
// Modified by samschultzponsys, 2026-11-18: propose a new time; accept or decline proposals for your events.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, HelpCircle, MapPin, Repeat, Users, X } from 'lucide-react';
import { useState } from 'react';
import type { CalendarView, InviteAnswer, InviteState, InviteView } from '../../../shared/calendar';
import type { AccountView, MessageDetail } from '../../../shared/types';
import { fetchJson } from '../api';

const CAL_KEY = 'dm-invite-calendar';
const readChoice = () => {
  try {
    return localStorage.getItem(CAL_KEY);
  } catch {
    return null;
  }
};

function when(inv: InviteView): string {
  const s = new Date(inv.start);
  const e = new Date(inv.end);
  if (inv.allDay) {
    const day = (d: Date) => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const last = day(new Date(e.getTime() - 86_400_000));
    const first = day(s);
    const fmt = (d: Date) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return first.getTime() >= last.getTime() ? `${fmt(first)} · All day` : `${fmt(first)} – ${fmt(last)}`;
  }
  const sameDay = s.toDateString() === e.toDateString();
  const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${time(s)} – ${sameDay ? time(e) : e.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

const STATUS_WORDS: Record<string, string> = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'might attend', DELEGATED: 'delegated' };

export function InviteCard({ invite, detail, account }: { invite: InviteView; detail: MessageDetail; account: AccountView | undefined }) {
  const qc = useQueryClient();
  const answerable = invite.method === 'REQUEST';
  const tracked = answerable || invite.method === 'CANCEL';
  const state = useQuery({
    queryKey: ['invite', detail.accountId, invite.uid],
    queryFn: () => fetchJson<InviteState>('GET', `/api/invite?accountId=${encodeURIComponent(detail.accountId)}&uid=${encodeURIComponent(invite.uid)}`),
    enabled: tracked && !!account,
  });
  // A guest's answer to an invitation you sent from DreyMail goes on your event (once per message).
  useQuery({
    queryKey: ['invite-reply', detail.accountId, detail.uidValidity, detail.uid],
    queryFn: async () => {
      const r = await fetchJson<{ updated: boolean }>('POST', '/api/invite/reply', { ref: { accountId: detail.accountId, folder: detail.folder, uid: detail.uid, uidValidity: detail.uidValidity } });
      if (r.updated) void qc.invalidateQueries({ queryKey: ['events'] });
      return r;
    },
    enabled: invite.method === 'REPLY' && !!account,
    staleTime: Infinity,
    retry: false,
  });
  const cals = useQuery({ queryKey: ['calendars'], queryFn: () => fetchJson<CalendarView[]>('GET', '/api/calendars'), enabled: answerable && state.data?.viaProvider === false });
  const writable = (cals.data ?? []).filter((c) => c.access !== 'view');
  const [calendarId, setCalendarId] = useState<string | null>(readChoice);
  const chosen = writable.find((c) => c.id === calendarId) ?? writable.find((c) => c.source === 'local' && c.access === 'owner') ?? writable[0] ?? null;
  const [busy, setBusy] = useState<InviteAnswer | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (a: InviteAnswer) => {
    setBusy(a);
    setError(null);
    try {
      const next = await fetchJson<InviteState>('POST', '/api/invite/answer', {
        ref: { accountId: detail.accountId, folder: detail.folder, uid: detail.uid, uidValidity: detail.uidValidity },
        answer: a,
        calendarId: state.data?.viaProvider ? null : (chosen?.id ?? null),
      });
      qc.setQueryData(['invite', detail.accountId, invite.uid], next);
      void qc.invalidateQueries({ queryKey: ['events'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('remove');
    try {
      await fetchJson('POST', '/api/invite/remove', { uid: invite.uid });
      void qc.invalidateQueries({ queryKey: ['invite', detail.accountId, invite.uid] });
      void qc.invalidateQueries({ queryKey: ['events'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const organizer = invite.organizer ? invite.organizer.name || invite.organizer.email : null;
  const current = state.data?.answer ?? null;
  const replyFrom = invite.method === 'REPLY' ? invite.attendees[0] : undefined;

  return (
    <div className={`invite-card ${invite.method === 'CANCEL' ? 'canceled' : ''}`}>
      <div className="invite-head">
        <CalendarDays size={18} />
        <div className="invite-main">
          <div className="invite-title">
            {invite.method === 'CANCEL' && <span className="invite-badge">Canceled</span>}
            {invite.method === 'COUNTER' && <span className="invite-badge">New time proposed</span>}
            {invite.title || '(no title)'}
          </div>
          <div className="invite-when">{when(invite)}</div>
          {invite.repeats && (
            <div className="invite-line">
              <Repeat size={13} /> {invite.repeats}
            </div>
          )}
          {invite.location && (
            <div className="invite-line">
              <MapPin size={13} /> {invite.location}
            </div>
          )}
          {(organizer || invite.attendees.length > 0) && (
            <div className="invite-line muted">
              <Users size={13} />
              {organizer ? `From ${organizer}` : ''}
              {invite.attendees.length > 0 ? `${organizer ? ' · ' : ''}${invite.attendees.length} ${invite.attendees.length === 1 ? 'guest' : 'guests'}` : ''}
            </div>
          )}
        </div>
      </div>

      {replyFrom && (
        <div className="invite-note">
          {replyFrom.name || replyFrom.email} {STATUS_WORDS[replyFrom.status] ?? 'answered'}.
        </div>
      )}

      {invite.method === 'CANCEL' && (
        <div className="invite-actions">
          <span className="grow muted">{organizer ? `${organizer} canceled this event.` : 'This event was canceled.'}</span>
          {state.data?.removable && (
            <button className="btn" disabled={!!busy} onClick={() => void remove()}>
              Remove from {state.data.calendar ?? 'calendar'}
            </button>
          )}
        </div>
      )}

      {answerable && account && (
        <>
          <div className="invite-actions">
            <span className="invite-going">Going?</span>
            {(
              [
                ['accepted', 'Yes', <Check size={14} key="y" />],
                ['tentative', 'Maybe', <HelpCircle size={14} key="m" />],
                ['declined', 'No', <X size={14} key="n" />],
              ] as const
            ).map(([a, label, icon]) => (
              <button key={a} className={`btn ${current === a ? 'primary' : ''}`} disabled={!!busy || !state.data} onClick={() => void answer(a)} aria-pressed={current === a}>
                {icon} {busy === a ? '…' : label}
              </button>
            ))}
            {state.data?.viaProvider === false && writable.length > 0 && (
              <label className="invite-cal">
                <span className="muted">Add to</span>
                <select
                  className="select"
                  value={chosen?.id ?? ''}
                  onChange={(e) => {
                    setCalendarId(e.target.value);
                    try {
                      localStorage.setItem(CAL_KEY, e.target.value);
                    } catch {
                      /* private mode */
                    }
                  }}
                >
                  {writable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="hint">
            {state.data?.viaProvider
              ? `Answered in ${state.data.calendar}${organizer ? `, which tells ${organizer}` : ''}.`
              : `${organizer ? `Your answer is emailed to ${organizer}` : 'Your answer is emailed to the organizer'} from ${account.email}${current && current !== 'declined' && state.data?.calendar ? `; it's in ${state.data.calendar}` : ''}.`}
          </div>
        </>
      )}
      {answerable && account && <ProposeTime invite={invite} detail={detail} onDone={(next) => qc.setQueryData(['invite', detail.accountId, invite.uid], next)} />}

      {invite.method === 'COUNTER' && account && <CounterAnswer invite={invite} detail={detail} />}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

const refOf = (d: MessageDetail) => ({ accountId: d.accountId, folder: d.folder, uid: d.uid, uidValidity: d.uidValidity });
const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Answer Maybe or No with a new time (DreyMail 10.8). */
function ProposeTime({ invite, detail, onDone }: { invite: InviteView; detail: MessageDetail; onDone: (s: InviteState) => void }) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(() => localInput(invite.start));
  const [end, setEnd] = useState(() => localInput(invite.end));
  const [answer, setAnswer] = useState<'tentative' | 'declined'>('tentative');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  if (invite.allDay) return null;
  if (sent) return <div className="hint">New time proposed.</div>;
  if (!open)
    return (
      <button className="link-btn invite-propose" onClick={() => setOpen(true)}>
        Propose a new time
      </button>
    );
  const send = async () => {
    const s = new Date(start);
    const e = new Date(end);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return setError('The end must be after the start');
    setBusy(true);
    try {
      onDone(await fetchJson<InviteState>('POST', '/api/invite/propose', { ref: refOf(detail), answer, start: s.toISOString(), end: e.toISOString(), comment }));
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="invite-propose-form">
      <div className="cal-when-row">
        <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-label="New start" />
        <span>to</span>
        <input className="input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="New end" />
      </div>
      <div className="cal-when-row">
        <select className="select" value={answer} onChange={(e) => setAnswer(e.target.value as 'tentative' | 'declined')} aria-label="Answer">
          <option value="tentative">Maybe, at the new time</option>
          <option value="declined">No, but propose the new time</option>
        </select>
      </div>
      <input className="input" placeholder="A note (optional)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
      <div className="cal-when-row">
        <button className="btn primary" disabled={busy} onClick={() => void send()}>
          Propose
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** A guest proposed a new time for your event: accept (moves it) or decline (DreyMail 10.8). */
function CounterAnswer({ invite, detail }: { invite: InviteView; detail: MessageDetail }) {
  const qc = useQueryClient();
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = invite.attendees[0]?.name || invite.attendees[0]?.email || 'A guest';
  const go = async (accept: boolean) => {
    setBusy(true);
    try {
      await fetchJson('POST', '/api/invite/counter', { ref: refOf(detail), accept });
      setDone(accept ? 'Moved to the new time; the guests were told.' : `${who} was told the original time stays.`);
      void qc.invalidateQueries({ queryKey: ['events'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="invite-actions">
      <span className="grow">{done ?? `${who} proposes this new time.`}</span>
      {!done && (
        <>
          <button className="btn primary" disabled={busy} onClick={() => void go(true)}>
            <Check size={14} /> Accept proposal
          </button>
          <button className="btn" disabled={busy} onClick={() => void go(false)}>
            Decline
          </button>
        </>
      )}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
