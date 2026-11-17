// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { Send, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ScheduledSend } from '../../../shared/types';
import { countdown } from '../sending';

/**
 * Under Compose: mail in its undo-send wait, with Undo (opens it again) and Send now, so it can be
 * taken back also after the "Sending…" notice is gone.
 */
export function SendingBox({ items, onUndo, onSendNow, busy }: { items: ScheduledSend[]; onUndo: (id: string) => void; onSendNow: (id: string) => void; busy: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!items.length) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [items.length]);
  if (!items.length) return null;
  return (
    <div className="sending-box" aria-live="polite">
      <div className="sending-head">Sending</div>
      {items.map((s) => {
        const going = s.status === 'sending' || Date.parse(s.sendAt) <= now;
        return (
          <div key={s.id} className="sending-item">
            <div className="sending-text" title={`${s.subject || '(no subject)'}\nTo: ${s.to}`}>
              <span className="sending-subject">{s.subject || '(no subject)'}</span>
              <span className="muted">To {s.to.replace(/,\s*$/, '')}</span>
            </div>
            <span className="sending-time muted">{going ? 'now' : countdown(s.sendAt, now)}</span>
            {!going && (
              <>
                <button className="icon-btn" title="Undo: stop it and open it again" disabled={busy === s.id} onClick={() => onUndo(s.id)}>
                  <Undo2 size={15} />
                </button>
                <button className="icon-btn" title="Send now" disabled={busy === s.id} onClick={() => onSendNow(s.id)}>
                  <Send size={14} />
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
