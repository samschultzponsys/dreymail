// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Gmail labels of the open message: one message can carry several labels (each one a folder in
// DreyMail). Shown under the header, with × to take a label off and "Add label" to put one on.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Tag, X } from 'lucide-react';
import { useState } from 'react';
import type { AccountView, MessageDetail } from '../../../shared/types';
import { fetchJson, refQuery } from '../api';

type Labels = { labels: string[]; available: string[] } | null;

/** Gmail and Google Workspace mailboxes (signed in with Google, or with an app password). */
export const hasGmailLabels = (a: AccountView | undefined) => !!a && (a.auth === 'google' || /(^|\.)(gmail|googlemail)\.com$/i.test(a.imap?.host ?? ''));

const nameOf = (l: string) => (l === 'INBOX' ? 'Inbox' : l);

export function GmailLabels({ detail, account }: { detail: MessageDetail; account: AccountView | undefined }) {
  const qc = useQueryClient();
  const ref = { accountId: detail.accountId, folder: detail.folder, uid: detail.uid, uidValidity: detail.uidValidity };
  const key = ['labels', detail.accountId, detail.folder, detail.uidValidity, detail.uid];
  const q = useQuery({ queryKey: key, queryFn: () => fetchJson<{ labels: Labels }>('GET', `/api/message/labels?${refQuery(ref)}`).then((r) => r.labels), enabled: hasGmailLabels(account), staleTime: 30_000, retry: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const { labels, available } = q.data;

  const change = async (add: string[], remove: string[]) => {
    setBusy(true);
    try {
      const r = await fetchJson<{ labels: Labels }>('PUT', '/api/message/labels', { ref, add, remove });
      qc.setQueryData(key, r.labels);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['folders'] });
      // Taking off the label of the folder being looked at takes the message out of it.
      if (remove.includes(detail.folder)) void qc.invalidateQueries({ queryKey: ['messages'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addable = available.filter((l) => !labels.includes(l));

  return (
    <div className="gmail-labels" aria-label="Labels">
      <Tag size={13} className="muted" />
      {labels.length === 0 && <span className="muted">No labels (only in All Mail)</span>}
      {labels.map((l) => (
        <span key={l} className="label-chip">
          {nameOf(l)}
          <button disabled={busy} onClick={() => void change([], [l])} title={`Remove the label ${nameOf(l)}`} aria-label={`Remove the label ${nameOf(l)}`}>
            <X size={11} />
          </button>
        </span>
      ))}
      {addable.length > 0 && (
        <label className="label-add" title="Add a label">
          <Plus size={12} />
          <select
            value=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) void change([e.target.value], []);
            }}
            aria-label="Add a label"
          >
            <option value="">Add label</option>
            {addable.map((l) => (
              <option key={l} value={l}>
                {nameOf(l)}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
