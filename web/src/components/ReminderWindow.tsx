// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The reminder window, as in Outlook: event reminders whose time has come, over whatever is open,
// with Join (online meetings), Snooze and Dismiss. Snoozing or dismissing on one device does it on
// every device. Follow-up flags with due dates (10.1) remind here too, opening their message.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Video, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReminderAlert } from '../../../shared/calendar';
import { fetchJson } from '../api';

const SNOOZES: { label: string; value: number | 'start' }[] = [
  { label: '5 minutes', value: 5 },
  { label: '10 minutes', value: 10 },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '4 hours', value: 240 },
  { label: '1 day', value: 1440 },
  { label: 'Until it starts', value: 'start' },
];

/** "In 15 minutes", "Now", "Started 5 minutes ago", "Today" (all day). */
export function dueText(a: Pick<ReminderAlert, 'start' | 'end' | 'allDay'>, now: number): string {
  const start = Date.parse(a.start);
  if (a.allDay) {
    const d = new Date(start);
    const day = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const today = new Date(now);
    const diff = Math.round((day.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
    return diff <= 0 ? 'Today, all day' : diff === 1 ? 'Tomorrow, all day' : `${day.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}, all day`;
  }
  const min = Math.round((start - now) / 60_000);
  const span = (m: number) => (m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : m < 1440 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'}` : `${Math.round(m / 1440)} day${Math.round(m / 1440) === 1 ? '' : 's'}`);
  if (Math.abs(min) < 1) return 'Now';
  if (min > 0) return `In ${span(min)}`;
  return Date.parse(a.end) > now ? `Started ${span(-min)} ago` : 'Over';
}

export function ReminderWindow({ enabled, onOpenCalendar, onOpenMessage }: { enabled: boolean; onOpenCalendar: () => void; onOpenMessage?: (m: NonNullable<ReminderAlert['message']>) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['reminders'], queryFn: () => fetchJson<ReminderAlert[]>('GET', '/api/reminders'), enabled, refetchInterval: 60_000 });
  const [now, setNow] = useState(() => Date.now());
  const [snooze, setSnooze] = useState<number | 'start'>(5);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const list = q.data ?? [];
  if (!enabled || list.length === 0) return null;

  const act = async (path: 'dismiss' | 'snooze', keys: string[]) => {
    try {
      const next = await fetchJson<ReminderAlert[]>('POST', `/api/reminders/${path}`, path === 'snooze' ? { keys, minutes: snooze } : { keys });
      qc.setQueryData(['reminders'], next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <aside className="reminders" role="alertdialog" aria-label={`${list.length} reminder${list.length === 1 ? '' : 's'}`}>
      <div className="reminders-head">
        <Bell size={15} />
        <strong>
          {list.length} reminder{list.length === 1 ? '' : 's'}
        </strong>
        <span className="grow" />
        <label className="reminders-snooze">
          <span className="muted">Snooze</span>
          <select className="select" value={String(snooze)} onChange={(e) => setSnooze(e.target.value === 'start' ? 'start' : Number(e.target.value))} aria-label="Snooze for">
            {SNOOZES.map((s) => (
              <option key={String(s.value)} value={String(s.value)}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {list.length > 1 && (
          <button className="btn" onClick={() => void act('dismiss', list.map((a) => a.key))}>
            Dismiss all
          </button>
        )}
      </div>
      <div className="reminders-list">
        {list.map((a) => (
          <div key={a.key} className="reminder" style={{ ['--cal' as string]: a.color || 'var(--accent)' }}>
            <button className="reminder-main" onClick={() => (a.message && onOpenMessage ? onOpenMessage(a.message) : onOpenCalendar())} title={a.message ? 'Open the message' : 'Open the calendar'}>
              <span className="reminder-title">{a.title}</span>
              <span className={`reminder-when ${Date.parse(a.start) <= now ? 'due' : ''}`}>
                {dueText(a, now)}
                {!a.allDay && ` · ${new Date(a.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
                {a.location && !/^https?:\/\//.test(a.location) ? ` · ${a.location}` : ''}
              </span>
            </button>
            <div className="reminder-actions">
              {a.joinUrl && (
                <a className="btn primary" href={a.joinUrl} target="_blank" rel="noreferrer" onClick={() => void act('dismiss', [a.key])} title={a.joinUrl}>
                  <Video size={14} /> Join
                </a>
              )}
              {a.message && (
                <button
                  className="btn"
                  title="Mark the follow-up complete"
                  onClick={() =>
                    void fetchJson('PUT', '/api/followup', { ref: { accountId: a.message!.accountId, folder: a.message!.folder, uid: a.message!.uid, uidValidity: a.message!.uidValidity }, done: true })
                      .then(() => act('dismiss', [a.key]))
                      .catch((e: Error) => setError(e.message))
                  }
                >
                  Complete
                </button>
              )}
              <button className="btn" onClick={() => void act('snooze', [a.key])}>
                Snooze
              </button>
              <button className="icon-btn" onClick={() => void act('dismiss', [a.key])} title="Dismiss" aria-label={`Dismiss ${a.title}`}>
                <X size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <div className="error-text">{error}</div>}
    </aside>
  );
}
