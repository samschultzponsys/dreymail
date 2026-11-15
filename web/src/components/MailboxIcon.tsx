// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// A mailbox's icon (shared/mailboxIcons.ts) in its colour, and the picker for it.

import { useState } from 'react';
import { MAILBOX_ICONS } from '../../../shared/mailboxIcons';

/** The mailbox icon in its colour, or the coloured dot for a mailbox without one. */
export function MailboxIcon({ icon, color, size = 14 }: { icon: string; color: string; size?: number }) {
  const path = MAILBOX_ICONS[icon]?.path;
  if (!path) return <span className="dot" style={{ background: color }} aria-hidden="true" />;
  return (
    <svg className="mailbox-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

/** Pick an icon (or none) for a mailbox; shown in its colour. */
export function MailboxIconPicker({ value, color, onChange }: { value: string; color: string; onChange: (icon: string) => void }) {
  const [open, setOpen] = useState(!!value);
  return (
    <div>
      <label className="label">Icon</label>
      {open ? (
        <div className="icon-grid" role="radiogroup" aria-label="Mailbox icon">
          <button type="button" role="radio" aria-checked={!value} className={`icon-choice ${!value ? 'on' : ''}`} title="No icon (coloured dot)" onClick={() => onChange('')}>
            <span className="dot" style={{ background: color }} />
          </button>
          {Object.entries(MAILBOX_ICONS).map(([key, { label }]) => (
            <button type="button" key={key} role="radio" aria-checked={value === key} className={`icon-choice ${value === key ? 'on' : ''}`} title={label} aria-label={label} onClick={() => onChange(key)}>
              <MailboxIcon icon={key} color={color} size={18} />
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          <MailboxIcon icon="" color={color} /> Choose an icon
        </button>
      )}
      <div className="hint">Shown in the sidebar and on this mailbox's notifications (desktop app, Android app and browsers that can draw it).</div>
    </div>
  );
}
