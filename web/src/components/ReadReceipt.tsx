// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// A sender asked for a read receipt: Send one, or Don't send. Nothing goes out unless asked; either
// answer marks the message ($MDNSent), so it isn't asked again (also in other mail apps).

import { MailCheck } from 'lucide-react';
import { useState } from 'react';
import type { MessageDetail } from '../../../shared/types';
import { fetchJson } from '../api';

export function ReadReceipt({ detail }: { detail: MessageDetail }) {
  const [answered, setAnswered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `${detail.accountId}:${detail.folder}:${detail.uidValidity}:${detail.uid}`;
  if (!detail.receiptTo || answered === key) return null;
  const answer = async (send: boolean) => {
    setBusy(true);
    try {
      await fetchJson('POST', '/api/message/receipt', { ref: { accountId: detail.accountId, folder: detail.folder, uid: detail.uid, uidValidity: detail.uidValidity }, send });
      setAnswered(key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notice">
      <MailCheck size={16} />
      <span className="grow">
        The sender asked for a read receipt (to {detail.receiptTo}).
        {error && <span className="error-text"> {error}</span>}
      </span>
      <button className="btn" disabled={busy} onClick={() => void answer(true)}>
        Send receipt
      </button>
      <button className="btn ghost" disabled={busy} onClick={() => void answer(false)}>
        Don&apos;t send
      </button>
    </div>
  );
}
