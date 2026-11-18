// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Meeting rooms (10.7): the administrator's list and Microsoft 365's rooms, merged; rooms invited
// as resources in Outlook, Google and iCalendar.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Rooms } from '../src/calendar/rooms.js';
import { newEventIcs, fieldsOfIcs } from '../src/calendar/ical.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

describe('meeting rooms', () => {
  it("merges the administrator's list with Microsoft 365's rooms", async () => {
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
    store.saveMicrosoftAccount(user.id, { email: 'sam@corp.com', name: 'Work', displayName: 'Sam', color: '#0078d4', refreshToken: 'rt' });
    const r = new Rooms({
      store,
      microsoft: { accessToken: async () => 't' } as never,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ value: [{ emailAddress: 'Board@Corp.com', displayName: 'Boardroom', capacity: 12, building: 'HQ' }, { emailAddress: 'atlas@corp.com', displayName: 'Atlas', capacity: 4 }] }) }),
    });
    r.saveConfigured([{ email: 'board@corp.com', name: 'Big boardroom', capacity: 14 }, { email: 'not an address', name: 'x' }]);
    expect(r.configured()).toEqual([{ email: 'board@corp.com', name: 'Big boardroom', capacity: 14, building: '', source: 'list' }]);
    expect((await r.list(user.id)).map((x) => `${x.name} (${x.source})`)).toEqual(['Atlas (microsoft)', 'Big boardroom (list)']);
  });

  it('invites a room as a resource in iCalendar', () => {
    const { ics } = newEventIcs({ title: 'Review', location: 'Boardroom', notes: '', start: '2026-11-20T15:00:00.000Z', end: '2026-11-20T16:00:00.000Z', allDay: false, recurrence: 'none', until: null, organizer: { email: 'sam@corp.com', name: 'Sam' }, attendees: [{ email: 'board@corp.com', name: 'Boardroom', status: 'needs-action', resource: true }] });
    expect(ics.replace(/\r\n /g, '')).toContain('CUTYPE=ROOM;ROLE=NON-PARTICIPANT');
    expect(fieldsOfIcs(ics)!.attendees).toEqual([expect.objectContaining({ email: 'board@corp.com', resource: true })]);
  });
});
