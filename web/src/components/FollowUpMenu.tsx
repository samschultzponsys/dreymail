// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Follow up, as in Outlook: flag a message with a due date (today, tomorrow, this week, next week,
// a date and time, or none). A reminder comes at the due time on every device.

import { FlagTriangleRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatSnoozeTime, fromLocalInput, toLocalInput } from '../snooze';

/** Outlook's follow-up choices, as times. */
export function followUpPresets(now: Date): { id: string; label: string; due: Date | null }[] {
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0, 0);
  const friday = (5 - now.getDay() + 7) % 7;
  const monday = ((1 - now.getDay() + 7) % 7) || 7;
  const out: { id: string; label: string; due: Date | null }[] = [];
  if (now.getHours() < 16) out.push({ id: 'today', label: 'Today', due: at(0, 17) });
  out.push({ id: 'tomorrow', label: 'Tomorrow', due: at(1, 9) });
  if (friday > 1) out.push({ id: 'week', label: 'This week', due: at(friday, 17) });
  out.push({ id: 'next', label: 'Next week', due: at(monday, 9) });
  out.push({ id: 'none', label: 'No date', due: null });
  return out;
}

export function FollowUpMenu({ iconSize, label, current, onSet, onDone }: { iconSize: number; label?: string; current: string | null | undefined; onSet: (due: Date | null) => void; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [now, setNow] = useState(() => new Date());
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const show = () => {
    const n = new Date();
    setNow(n);
    setCustom(toLocalInput(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 9)));
    setOpen(true);
  };
  const pick = (d: Date | null) => {
    setOpen(false);
    onSet(d);
  };
  const customDate = fromLocalInput(custom);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`icon-btn ${current !== undefined ? 'active' : ''}`} title="Follow up: flag with a due date" onClick={() => (open ? setOpen(false) : show())}>
        <FlagTriangleRight size={iconSize} />
        {label && <span className="tb-label">{label}</span>}
      </button>
      {open && (
        <div className="menu snooze-menu">
          <div className="menu-label">Follow up</div>
          {followUpPresets(now).map((p) => (
            <button key={p.id} onClick={() => pick(p.due)}>
              <span className="grow">{p.label}</span>
              {p.due && <span className="muted">{formatSnoozeTime(p.due.toISOString(), now)}</span>}
            </button>
          ))}
          {current !== undefined && (
            <button
              onClick={() => {
                setOpen(false);
                onDone();
              }}
            >
              <span className="grow">Mark complete</span>
            </button>
          )}
          <form
            className="snooze-custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (customDate) pick(customDate);
            }}
          >
            <div className="menu-label">Pick date &amp; time</div>
            <input className="input" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Follow up by" />
            <button type="submit" className="btn primary" disabled={!customDate}>
              Set
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
