// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Mail waiting to be sent later: when, to whom, and Cancel / Send now.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Send, X } from 'lucide-react';
import { useState } from 'react';
import type { AccountView } from '../../../shared/types';
import { api } from '../api';

export const useScheduled = (enabled: boolean) => useQuery({ queryKey: ['scheduled'], queryFn: api.scheduled, enabled, refetchInterval: 60_000 });

export function ScheduledDialog({ accounts, onClose }: { accounts: Map<string, AccountView>; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useScheduled(true);
  const [error, setError] = useState<string | null>(null);
  const set = (l: Awaited<ReturnType<typeof api.scheduled>>) => {
    qc.setQueryData(['scheduled'], l);
    void qc.invalidateQueries({ queryKey: ['messages'] });
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(600px, 100%)' }}>
        <div className="dialog-head">
          <h2>
            <Clock size={17} style={{ verticalAlign: -3 }} /> Scheduled
          </h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">
          {!list.data ? (
            <div className="hint">Loading…</div>
          ) : list.data.length === 0 ? (
            <div className="muted">Nothing waiting to be sent.</div>
          ) : (
            <ul className="decisions">
              {list.data.map((m) => {
                const a = accounts.get(m.accountId);
                return (
                  <li key={m.id} className={m.status === 'failed' ? 'error' : ''}>
                    <div className="user-main">
                      <div className="decision-subject">{m.subject || '(no subject)'}</div>
                      <div className="muted user-meta">
                        {m.status === 'sending' ? 'Sending now' : new Date(m.sendAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · to {m.to}
                        {a ? ` · from ${a.name}` : ''}
                      </div>
                      {m.error && <div className="error-text">{m.error}</div>}
                    </div>
                    {m.status !== 'sending' && (
                      <div className="user-actions">
                        <button className="btn" onClick={() => void api.sendScheduledNow(m.id).then(set, (e: Error) => setError(e.message))}>
                          <Send size={14} /> Send now
                        </button>
                        <button className="btn" onClick={() => window.confirm('Cancel this message? It will not be sent.') && void api.cancelScheduled(m.id).then(set, (e: Error) => setError(e.message))}>
                          Cancel
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {error && <div className="error-text">{error}</div>}
          <div className="hint">Your DreyMail server sends these at their time, even when no browser or app is open.</div>
        </div>
      </div>
    </div>
  );
}
