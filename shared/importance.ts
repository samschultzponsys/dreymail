// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Importance of a message (Outlook's high / low), from the Importance, Priority and X-Priority
// headers, and read receipts (Disposition-Notification-To, RFC 8098).

export type Importance = 'high' | 'low';

/** The importance a message's headers give it (raw header text, folded lines allowed). */
export function importanceOf(headers: string): Importance | undefined {
  const h = headers.replace(/\r?\n[ \t]+/g, ' ');
  const imp = /^importance:\s*(\w+)/im.exec(h)?.[1]?.toLowerCase();
  if (imp === 'high') return 'high';
  if (imp === 'low') return 'low';
  const pri = /^priority:\s*(\w+)/im.exec(h)?.[1]?.toLowerCase();
  if (pri === 'urgent') return 'high';
  if (pri === 'non-urgent') return 'low';
  const x = /^x-priority:\s*(\d)/im.exec(h)?.[1];
  if (x === '1' || x === '2') return 'high';
  if (x === '4' || x === '5') return 'low';
  return undefined;
}

/** Where a read receipt goes, from Disposition-Notification-To (an address), if asked for. */
export function receiptAddressOf(headers: string): string | null {
  const v = /^disposition-notification-to:\s*(.+)$/im.exec(headers.replace(/\r?\n[ \t]+/g, ' '))?.[1]?.trim() ?? '';
  const m = /<([^<>@\s]+@[^<>@\s]+)>/.exec(v) ?? /([^\s<>,;@]+@[^\s<>,;@]+)/.exec(v);
  return m ? m[1]!.toLowerCase() : null;
}
