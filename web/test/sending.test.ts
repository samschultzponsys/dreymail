// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { ScheduledSend } from '../../shared/types';
import { composerFromPayload, countdown, isSending } from '../src/sending';

const s = (createdAt: string, sendAt: string, status: ScheduledSend['status'] = 'pending'): ScheduledSend => ({
  id: '1', accountId: 'a', subject: 'Hi', to: 'x@example.com', error: '', status, createdAt, sendAt,
});

describe('Sending (undo send)', () => {
  it('tells an undo-send wait from mail scheduled for later', () => {
    expect(isSending(s('2026-11-17T10:00:00Z', '2026-11-17T10:00:10Z'))).toBe(true);
    expect(isSending(s('2026-11-17T10:00:00Z', '2026-11-17T10:10:00Z'))).toBe(true);
    expect(isSending(s('2026-11-17T10:00:00Z', '2026-11-18T08:00:00Z'))).toBe(false);
    expect(isSending(s('2026-11-17T10:00:00Z', '2026-11-17T10:00:10Z', 'failed'))).toBe(false);
    expect(isSending(s('2026-11-17T10:00:00Z', '2026-11-17T10:00:10Z', 'sending'))).toBe(true);
  });

  it('counts down', () => {
    const t = Date.parse('2026-11-17T10:00:00Z');
    expect(countdown('2026-11-17T10:00:07Z', t)).toBe('0:07');
    expect(countdown('2026-11-17T10:09:41Z', t)).toBe('9:41');
    expect(countdown('2026-11-17T09:59:00Z', t)).toBe('0:00');
  });

  it('opens the message again as it was', () => {
    const init = composerFromPayload(
      { accountId: 'a', to: 'x@example.com, ', cc: '', bcc: 'b@example.com', subject: 'Hi', html: '<div>Hello</div>', inReplyTo: '<1@x>', references: ['<1@x>'], forwardFrom: { accountId: 'a', folder: 'INBOX', uid: 3, uidValidity: '9', indices: [1] }, replaceDraft: null, answering: null },
      [],
      [{ index: 1, filename: 'a.pdf', mimeType: 'application/pdf', size: 10, inline: false, contentId: null }],
    );
    expect(init).toMatchObject({ to: 'x@example.com, ', bcc: 'b@example.com', html: '<div>Hello</div>', forwardFrom: { uid: 3 }, forwardAttachments: [{ filename: 'a.pdf' }] });
    expect(composerFromPayload({ ...(init as never), forwardFrom: null, replaceDraft: null, answering: null } as never, [], []).forwardFrom).toBeNull();
  });
});
