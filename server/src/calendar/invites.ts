// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Calendar invitations in mail: the text/calendar part (or .ics attachment) of a message, and what
// the reader's invitation card shows.

import type { Attachment, Email } from 'postal-mime';
import type { InviteView } from '../../../shared/calendar.js';
import { describeRule, eventsOf, parseIcal, prop, type IcalComponent, type IcalEvent } from './ical.js';

const bytesOf = (a: Attachment): Buffer =>
  typeof a.content === 'string' ? Buffer.from(a.content, a.encoding === 'base64' ? 'base64' : 'utf8') : a.content instanceof ArrayBuffer ? Buffer.from(a.content) : Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength);

export interface FoundInvite {
  method: string;
  calendar: IcalComponent;
  event: IcalEvent;
}

/** The invitation in a message: its text/calendar part or .ics attachment. */
export function findInvite(email: Pick<Email, 'attachments'>): FoundInvite | null {
  for (const a of email.attachments) {
    const type = (a.mimeType ?? '').toLowerCase();
    if (type !== 'text/calendar' && type !== 'application/ics' && !/\.ics$/i.test(a.filename ?? '')) continue;
    const bytes = bytesOf(a);
    if (bytes.length > 1_000_000) continue;
    const cal = parseIcal(bytes.toString('utf8')).find((c) => c.name === 'VCALENDAR');
    if (!cal) continue;
    const events = eventsOf(cal);
    const event = events.find((e) => e.recurrenceId === null) ?? events[0];
    if (!event || !event.uid) continue;
    return { method: (prop(cal, 'METHOD')?.value ?? 'PUBLISH').trim().toUpperCase(), calendar: cal, event };
  }
  return null;
}

export function inviteView(found: FoundInvite | null): InviteView | null {
  if (!found) return null;
  const e = found.event;
  return {
    method: found.method,
    uid: e.uid,
    title: e.title,
    start: new Date(e.start.ms).toISOString(),
    end: new Date(e.end).toISOString(),
    allDay: e.allDay,
    location: e.location.slice(0, 500),
    description: e.description.slice(0, 2000),
    organizer: e.organizer ? { email: e.organizer.email, name: e.organizer.name } : null,
    attendees: e.attendees.slice(0, 100),
    repeats: e.rrule ? describeRule(e.rrule) : null,
  };
}
