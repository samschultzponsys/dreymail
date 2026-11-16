// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-16: a name shown next to the icon in the larger toolbar.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountFolders } from '../../../shared/types';

interface Props {
  account: AccountFolders | undefined;
  exclude?: string;
  disabled?: boolean;
  icon: ReactNode;
  onMove: (path: string) => void;
  /** Its name, shown in the larger toolbar. */
  label?: string;
}

export function MoveMenu({ account, exclude, disabled, icon, onMove, label }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const targets = (account?.folders ?? []).filter((f) => f.selectable && f.path !== exclude);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" title={disabled ? 'Select messages from one account to move' : 'Move to…'} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {icon}
        {label && <span className="tb-label">{label}</span>}
      </button>
      {open && (
        <div className="menu">
          <div className="menu-label">Move to</div>
          {targets.map((f) => (
            <button
              key={f.path}
              onClick={() => {
                setOpen(false);
                onMove(f.path);
              }}
            >
              {f.specialUse === 'inbox' ? 'Inbox' : f.path}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
