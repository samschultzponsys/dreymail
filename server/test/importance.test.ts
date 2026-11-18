// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { importanceOf, receiptAddressOf } from '../../shared/importance.js';
import { buildRawMessage } from '../src/mail/compose.js';

describe('importance and read receipts (9.9)', () => {
  it('reads importance from Importance, Priority and X-Priority', () => {
    expect(importanceOf('Importance: High\r\n')).toBe('high');
    expect(importanceOf('X-Priority: 5 (Lowest)\r\n')).toBe('low');
    expect(importanceOf('Priority: urgent\r\n')).toBe('high');
    expect(importanceOf('X-Priority: 3\r\nSubject: x\r\n')).toBeUndefined();
  });

  it('finds where a read receipt goes', () => {
    expect(receiptAddressOf('Disposition-Notification-To: "Ada" <Ada@Example.com>\r\n')).toBe('ada@example.com');
    expect(receiptAddressOf('Subject: hi\r\n')).toBeNull();
  });

  it('writes importance and the receipt request when sending', async () => {
    const { raw } = await buildRawMessage(
      { from: { name: 'Sam', address: 'sam@example.com' }, to: [{ name: '', address: 'ada@example.com' }], cc: [], bcc: [], subject: 'Hi', html: '<p>Hi</p>', inReplyTo: null, references: [], attachments: [], importance: 'high', readReceipt: true },
      { keepBcc: false },
    );
    const text = raw.toString();
    expect(importanceOf(text)).toBe('high');
    expect(receiptAddressOf(text)).toBe('sam@example.com');
  });
});
