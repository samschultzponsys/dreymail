// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { findCode } from '../../shared/codes.js';
import { blocks, normaliseBlock } from '../src/blocklist.js';

describe('one-time codes', () => {
  it('finds codes next to words that announce them', () => {
    expect(findCode('Your verification code', 'Use 482913 to sign in. It expires in 10 minutes.')).toBe('482913');
    expect(findCode('482913 is your Instagram code', '')).toBe('482913');
    expect(findCode('Sign in to Acme', 'Your one-time code: 123 456')).toBe('123456');
    expect(findCode('Security code', 'Enter K7P2QX to continue')).toBe('K7P2QX');
  });

  it('ignores numbers that are not codes', () => {
    expect(findCode('Your order #55821 has shipped', 'Total: $129.99. Track it online.')).toBeNull();
    expect(findCode('Meeting notes', 'We met in 2024 and talked about the code review.')).toBeNull();
    expect(findCode('Invoice', 'Amount 4,500.00 due 12/01/2026')).toBeNull();
  });
});

describe('blocked senders', () => {
  it('accepts addresses and whole domains', () => {
    expect(normaliseBlock(' Spam <SPAM@Example.com> ')).toBe('spam@example.com');
    expect(normaliseBlock('@marketing.example.com')).toBe('@marketing.example.com');
    expect(normaliseBlock('not an address')).toBeNull();
  });

  it('matches exact addresses and domain suffixes', () => {
    expect(blocks('Spam@example.com', 'spam@example.com')).toBe(true);
    expect(blocks('news@marketing.example.com', '@example.com')).toBe(true);
    expect(blocks('friend@example.org', '@example.com')).toBe(false);
  });
});

describe('message detail', () => {
  it('carries unsubscribe options and a code', async () => {
    const { parseRaw, buildMessageDetail } = await import('../src/mail/parse.js');
    const raw = Buffer.from(
      'From: Shop <news@shop.example>\r\nTo: sam@example.com\r\nSubject: Your code is 739204\r\nList-Unsubscribe: <https://shop.example/u/1>, <mailto:u@shop.example>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nContent-Type: text/plain\r\n\r\nHello\r\n',
    );
    const email = await parseRaw(raw);
    const d = buildMessageDetail(email, { accountId: 'a', folder: 'INBOX', uid: 1, uidValidity: '1', flags: new Set<string>(), internalDate: null }, { allowRemote: false, resolveRemote: () => null });
    expect(d.code).toBe('739204');
    expect(d.unsubscribe).toEqual({ oneClick: 'https://shop.example/u/1', url: 'https://shop.example/u/1', mailto: 'mailto:u@shop.example' });
  });
});
