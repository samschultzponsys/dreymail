// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Mail in its "undo send" wait, shown under Compose with Undo until it goes out.

import type { AttachmentView, ComposePayload, ScheduledSend } from '../../shared/types';
import type { ComposerInit } from './components/Composer';

/** The longest undo-send wait (Settings → General allows up to 10 minutes), plus a little slack. */
const UNDO_WINDOW_MS = 10 * 60_000 + 30_000;

/** Sent with an undo wait (not scheduled for later) and not failed: it's on its way. */
export function isSending(s: ScheduledSend): boolean {
  if (s.status === 'failed' || !s.createdAt) return false;
  return Date.parse(s.sendAt) - Date.parse(s.createdAt) <= UNDO_WINDOW_MS;
}

/** Seconds left as "0:07" or "9:41". */
export function countdown(sendAt: string, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((Date.parse(sendAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Files handed back by the server (base64) as File objects for the composer. */
export function filesFrom(list: { filename: string; contentType: string; content: string }[]): File[] {
  return list.map((f) => {
    const bin = atob(f.content);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.filename, { type: f.contentType });
  });
}

/** A composer with the message again, as it was when sent. */
export function composerFromPayload(p: ComposePayload, files: File[], forwarded: AttachmentView[]): ComposerInit {
  return {
    accountId: p.accountId,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject,
    html: p.html,
    inReplyTo: p.inReplyTo,
    references: p.references,
    forwardFrom: p.forwardFrom && forwarded.length ? { accountId: p.forwardFrom.accountId, folder: p.forwardFrom.folder, uid: p.forwardFrom.uid, uidValidity: p.forwardFrom.uidValidity } : null,
    forwardAttachments: forwarded,
    replaceDraft: p.replaceDraft,
    answering: p.answering,
    files,
  };
}
