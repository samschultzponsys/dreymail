// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { OpenedMemo, type OpenedMessage } from '../src/mail/openedMemo.js';

const msg = (subject: string) => ({ email: { subject }, smime: null }) as unknown as OpenedMessage;

describe('opened messages in memory', () => {
  it('keeps the most recently used within its size, and forgets after a while', () => {
    let now = 0;
    const memo = new OpenedMemo(100, 1000, () => now);
    memo.set('a', msg('A'), 40);
    memo.set('b', msg('B'), 40);
    expect(memo.get('a')?.email.subject).toBe('A'); // a is now the most recent
    memo.set('c', msg('C'), 40); // over 100: the least recently used (b) goes
    expect(memo.get('b')).toBeNull();
    expect(memo.get('a')).not.toBeNull();
    expect(memo.bytes).toBe(80);
    memo.set('huge', msg('H'), 60); // more than half of everything: not kept
    expect(memo.get('huge')).toBeNull();
    now = 2000;
    expect(memo.get('a')).toBeNull();
  });

  it('forgets an account', () => {
    const memo = new OpenedMemo();
    memo.set('u\u0000acc1\u0000INBOX\u00001\u00001', msg('1'), 10);
    memo.set('u\u0000acc2\u0000INBOX\u00001\u00001', msg('2'), 10);
    memo.deletePrefix('u\u0000acc1\u0000');
    expect(memo.get('u\u0000acc1\u0000INBOX\u00001\u00001')).toBeNull();
    expect(memo.get('u\u0000acc2\u0000INBOX\u00001\u00001')).not.toBeNull();
    expect(memo.bytes).toBe(10);
  });
});
