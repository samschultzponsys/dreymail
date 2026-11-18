// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The scheduling assistant, as in Outlook: the meeting's day as a timeline with you and each guest
// on a row, busy times filled in (from your calendars, and colleagues' through Outlook or Google),
// the meeting's time on top, a click to move it there, and "Next free time".

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchJson } from '../api';

interface Busy {
  start: string;
  end: string;
  status: string;
  title?: string;
}
interface FreeBusy {
  self: { busy: Busy[] };
  people: Record<string, { busy: Busy[]; error?: string }>;
  via: 'microsoft' | 'google' | null;
}

const FIRST_HOUR = 7;
const LAST_HOUR = 20;
const STEP = 15 * 60_000;

/** The first time from `after` on, within working hours, when nobody is busy for `length` ms. */
export function nextFreeSlot(busy: { start: number; end: number }[], after: number, length: number, limit = after + 14 * 86_400_000): number | null {
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  let t = Math.ceil(after / STEP) * STEP;
  while (t < limit) {
    const d = new Date(t);
    const open = new Date(d.getFullYear(), d.getMonth(), d.getDate(), FIRST_HOUR).getTime();
    const close = new Date(d.getFullYear(), d.getMonth(), d.getDate(), LAST_HOUR).getTime();
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    if (weekend || t >= close || t + length > close) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, FIRST_HOUR).getTime();
      continue;
    }
    if (t < open) {
      t = open;
      continue;
    }
    const clash = sorted.find((b) => b.start < t + length && b.end > t);
    if (!clash) return t;
    t = Math.ceil(clash.end / STEP) * STEP;
  }
  return null;
}

export function SchedulingAssistant({ calendarId, guests, start, end, onPick }: { calendarId: string | null; guests: string[]; start: Date; end: Date; onPick: (start: Date) => void }) {
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const from = new Date(day.getTime() - 86_400_000);
  const to = new Date(day.getTime() + 8 * 86_400_000);
  const q = useQuery({
    queryKey: ['freebusy', calendarId, guests.join(','), from.toISOString()],
    queryFn: () => fetchJson<FreeBusy>('POST', '/api/freebusy', { calendarId, emails: guests, from: from.toISOString(), to: to.toISOString() }),
    staleTime: 60_000,
    enabled: guests.length > 0,
  });
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), FIRST_HOUR).getTime();
  const span = (LAST_HOUR - FIRST_HOUR) * 3_600_000;
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - dayStart) / span) * 100))}%`;
  const length = Math.max(STEP, end.getTime() - start.getTime());
  const rows = [{ label: 'You', busy: q.data?.self.busy ?? [], error: undefined as string | undefined }, ...guests.map((g) => ({ label: g, busy: q.data?.people[g]?.busy ?? [], error: q.data?.people[g]?.error }))];
  const all = rows.flatMap((r) => r.busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })));
  // The meeting itself shouldn't count against its own time.
  const others = all.filter((b) => !(b.start === start.getTime() && b.end === end.getTime()));
  const conflict = others.some((b) => b.start < end.getTime() && b.end > start.getTime());
  const go = (dir: 1 | -1) => {
    if (dir === 1) {
      const t = nextFreeSlot(others, start.getTime() + STEP, length);
      if (t !== null) onPick(new Date(t));
    } else {
      // Earlier: walk back a step at a time from the current start.
      for (let t = start.getTime() - STEP; t > start.getTime() - 7 * 86_400_000; t -= STEP) {
        const d = new Date(t);
        if (d.getDay() === 0 || d.getDay() === 6 || d.getHours() < FIRST_HOUR || t + length > new Date(d.getFullYear(), d.getMonth(), d.getDate(), LAST_HOUR).getTime()) continue;
        if (!others.some((b) => b.start < t + length && b.end > t)) return onPick(new Date(t));
      }
    }
  };
  const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i).filter((h) => h % 2 === 0);
  return (
    <div className="sched">
      <div className="sched-head">
        <strong>{day.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</strong>
        <span className={conflict ? 'sched-state clash' : 'sched-state'}>{q.isLoading ? 'Checking…' : conflict ? 'Someone is busy then' : 'Everyone is free'}</span>
        <span className="grow" />
        <button type="button" className="icon-btn" title="Earlier free time" onClick={() => go(-1)}>
          <ChevronLeft size={15} />
        </button>
        <button type="button" className="btn" onClick={() => go(1)}>
          Next free time <ChevronRight size={14} />
        </button>
      </div>
      <div className="sched-grid">
        <div className="sched-row sched-hours">
          <span className="sched-name" />
          <div className="sched-track">
            {hours.map((h) => (
              <span key={h} className="sched-hour" style={{ left: pct(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime()) }}>
                {new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}
              </span>
            ))}
          </div>
        </div>
        {rows.map((r) => (
          <div key={r.label} className="sched-row">
            <span className="sched-name" title={r.error ?? r.label}>
              {r.label}
              {r.error && <span className="muted"> · {r.error}</span>}
            </span>
            <div
              className="sched-track"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const t = dayStart + Math.round((((e.clientX - rect.left) / rect.width) * span) / STEP) * STEP;
                onPick(new Date(t));
              }}
              title="Click to move the meeting here"
            >
              {r.busy
                .filter((b) => Date.parse(b.end) > dayStart && Date.parse(b.start) < dayStart + span)
                .map((b, i) => (
                  <span key={i} className={`sched-busy ${b.status}`} style={{ left: pct(Date.parse(b.start)), width: `calc(${pct(Date.parse(b.end))} - ${pct(Date.parse(b.start))})` }} title={`${b.title ? `${b.title}: ` : ''}${new Date(b.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${new Date(b.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`} />
                ))}
              <span className="sched-meeting" style={{ left: pct(start.getTime()), width: `calc(${pct(end.getTime())} - ${pct(start.getTime())})` }} />
            </div>
          </div>
        ))}
      </div>
      {q.data && !q.data.via && guests.length > 0 && <div className="hint">Guests&apos; free/busy times come from Outlook or Google: add a mailbox with Microsoft or Google sign-in to see them.</div>}
      {q.error && <div className="error-text">{(q.error as Error).message}</div>}
    </div>
  );
}
