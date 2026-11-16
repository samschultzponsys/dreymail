// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-16: a name shown next to the icon in the larger toolbar.

import { AlarmClock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { defaultCustomTime, formatSnoozeTime, fromLocalInput, snoozePresets, toLocalInput } from '../snooze';

interface Props {
  disabled?: boolean;
  iconSize: number;
  /** Opens the menu whenever this number changes (keyboard shortcut). */
  openSignal?: number;
  onSnooze: (until: Date) => void;
  /** Its name, shown in the larger toolbar. */
  label?: string;
}

/** Snooze button: quick choices plus a date and time picker. */
export function SnoozeMenu({ disabled, iconSize, openSignal, onSnooze, label }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [now, setNow] = useState(() => new Date());
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(openSignal);

  const show = () => {
    const n = new Date();
    setNow(n);
    setCustom(toLocalInput(defaultCustomTime(n)));
    setOpen(true);
  };
  useEffect(() => {
    if (openSignal !== first.current && !disabled) show();
  }, [openSignal, disabled]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const pick = (d: Date) => {
    setOpen(false);
    onSnooze(d);
  };
  const customDate = fromLocalInput(custom);
  const customOk = !!customDate && customDate.getTime() > Date.now();

  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" title="Snooze (b)" disabled={disabled} onClick={() => (open ? setOpen(false) : show())}>
        <AlarmClock size={iconSize} />
        {label && <span className="tb-label">{label}</span>}
      </button>
      {open && (
        <div className="menu snooze-menu">
          <div className="menu-label">Snooze until</div>
          {snoozePresets(now).map((p) => (
            <button key={p.id} onClick={() => pick(p.until)}>
              <span className="grow">{p.label}</span>
              <span className="muted">{formatSnoozeTime(p.until, now)}</span>
            </button>
          ))}
          <form
            className="snooze-custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (customOk) pick(customDate);
            }}
          >
            <div className="menu-label">Pick date &amp; time</div>
            <input
              className="input"
              type="datetime-local"
              value={custom}
              min={toLocalInput(now)}
              onChange={(e) => setCustom(e.target.value)}
              aria-label="Snooze until date and time"
            />
            <button type="submit" className="btn primary" disabled={!customOk}>
              Snooze
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
