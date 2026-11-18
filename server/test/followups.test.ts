// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Follow-up flags (10.1): kept by Message-ID, shown with their due date, reminded at the due time
// with a link to the message, and gone when completed or unflagged.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Reminders } from '../src/calendar/reminders.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { Followups } from '../src/mail/followups.js';

describe('follow-up flags', () => {
  it('remind at the due time with a link to the message, and end when cleared', async () => {
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
    const acc = store.createAccount(user.id, { name: 'Work', displayName: 'Sam', email: 'sam@example.com', color: '#22d3ee', imap: { host: 'i', port: 993, tls: 'tls', user: 's', password: 'p' }, smtp: { host: 's', port: 465, tls: 'tls', user: 's', password: 'p' }, appendSent: true } as never);
    const f = new Followups(store);
    const due = Date.parse('2026-11-20T09:00:00Z');
    const ref = { accountId: acc.id, folder: 'INBOX', uid: 7, uidValidity: '3' };
    f.set(user.id, ref, '<m@x>', { subject: 'Contract', sender: 'Ada' }, due);
    expect(f.lookup(user.id)(acc.id, '<m@x>')).toEqual({ due: '2026-11-20T09:00:00.000Z' });
    expect(f.lookup(user.id)(acc.id, '<other@x>')).toBeUndefined();

    let now = due - 3_600_000;
    const pushed: { title: string; url: string }[] = [];
    const r = new Reminders({ store, calendars: { upcoming: async () => ({ items: [], failed: new Set<string>() }) } as never, followups: f, push: async (_u, p) => (pushed.push(p), 1), emit: () => undefined, now: () => now });
    await r.scan(user.id);
    await r.fireDue();
    expect(pushed).toEqual([]);
    now = due;
    await r.fireDue();
    expect(pushed).toEqual([expect.objectContaining({ title: 'Follow up: Contract', url: `/mail/${acc.id}/INBOX?open=${acc.id}.3.7` })]);
    expect(r.active(user.id)[0]?.message).toEqual({ ...ref, messageId: '<m@x>' });

    // Unflagged: the follow-up and its coming reminders go.
    f.set(user.id, ref, '<m@x>', { subject: 'Contract', sender: 'Ada' }, due + 86_400_000);
    f.clearRefs(user.id, acc.id, 'INBOX', '3', [7]);
    expect(f.lookup(user.id)(acc.id, '<m@x>')).toBeUndefined();
    await r.scan(user.id);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM calendar_alerts WHERE key LIKE 'followup|%' AND start_at > ?").get(now)).toEqual({ n: 0 });
  });
});
