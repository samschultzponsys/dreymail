// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-15: mailbox icons.
// Modified by samschultzponsys, 2026-11-15: your own picture as a mailbox icon.
// Modified by samschultzponsys, 2026-11-16: notifications can show the start of the message.

import type { Address, NotificationContent } from '../../../shared/types.js';

/** A message that just arrived in an INBOX, as reported by the IMAP watcher. */
export interface NewMail {
  uid: number;
  uidValidity: string;
  from: Address | null;
  subject: string;
  /** Used to tell real new mail from snoozed mail coming back. */
  messageId?: string | null;
  /** The start of the message's text, fetched only when notifications show it. */
  snippet?: string;
}

/** A snoozed message that is back in INBOX. Its new UID is null if the server didn't report it. */
export interface WokenMail {
  uid: number | null;
  uidValidity: string | null;
  from: Address | null;
  subject: string;
}

/** What the service worker receives and shows (see web/public/sw.js). */
export interface NotificationPayload {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
  /** App URL to open when the notification is tapped. */
  url: string;
  /** Unread count for the app icon badge, if known. */
  badge?: number;
  /** The mailbox's colour and icon (a 24x24 SVG path), for the service worker to draw (DreyMail). */
  color?: string;
  iconPath?: string;
  /** Same-origin URL of the mailbox's uploaded picture, when that is its icon. */
  iconImage?: string;
}

/**
 * Tells the service worker to close notifications (by tag) whose messages have all been read or
 * have left the inbox, on another device or in another mail client.
 */
export interface ClearPayload {
  type: 'clear';
  tags: string[];
  badge?: number;
}

const MAX_FIELD = 200;
const MAX_LINES = 5;

function clip(s: string, max = MAX_FIELD): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function senderName(a: Address | null): string {
  return clip(a?.name || a?.address || 'Unknown sender', 80);
}

/**
 * One notification per account and batch of new mail. `preview` adds the start of a single
 * message's text under its subject. With `minimal` content the notification
 * only says that mail arrived (and in which account), never who sent it or what it is about: the
 * payload is end-to-end encrypted, but passes through Apple's/Google's push service.
 */
export function buildNotification(
  account: { id: string; name: string },
  messages: NewMail[],
  content: NotificationContent,
): NotificationPayload | null {
  if (messages.length === 0) return null;
  const newest = [...messages].sort((a, b) => b.uid - a.uid);
  const accountName = clip(account.name, 80);
  const count = messages.length;

  if (count === 1) {
    const m = newest[0]!;
    const subject = clip(m.subject) || '(no subject)';
    const snippet = content === 'preview' && m.snippet ? clip(m.snippet, 300) : '';
    return {
      title: content === 'minimal' ? 'New message' : senderName(m.from),
      body: content === 'minimal' ? accountName : snippet ? `${subject}\n${snippet}` : subject,
      tag: `${account.id}:${m.uid}`,
      url: `/?open=${encodeURIComponent(account.id)}.${m.uidValidity}.${m.uid}`,
    };
  }

  const lines = newest.slice(0, MAX_LINES).map((m) => `${senderName(m.from)}: ${clip(m.subject, 100) || '(no subject)'}`);
  if (count > MAX_LINES) lines.push(`and ${count - MAX_LINES} more`);
  return {
    title: content === 'minimal' ? `${count} new messages` : `${count} new messages in ${accountName}`,
    body: content === 'minimal' ? accountName : lines.join('\n'),
    tag: `${account.id}:batch`,
    url: '/',
  };
}

/**
 * One notification per account for snoozed messages that are back in the inbox. Same privacy rule
 * as for new mail: `minimal` never shows who sent it or what it is about. A single message uses
 * the same tag as a new-mail notification for that message would, so the two never stack.
 */
export function buildSnoozeNotification(
  account: { id: string; name: string },
  messages: WokenMail[],
  content: NotificationContent,
): NotificationPayload | null {
  if (messages.length === 0) return null;
  const accountName = clip(account.name, 80);
  const count = messages.length;

  if (count === 1) {
    const m = messages[0]!;
    const known = m.uid !== null && m.uidValidity !== null;
    return {
      title: 'Back from snooze',
      body: content !== 'minimal' ? `${senderName(m.from)}: ${clip(m.subject, 150) || '(no subject)'}` : accountName,
      tag: known ? `${account.id}:${m.uid}` : `${account.id}:snooze`,
      url: known ? `/?open=${encodeURIComponent(account.id)}.${m.uidValidity}.${m.uid}` : '/',
    };
  }

  const lines = messages.slice(0, MAX_LINES).map((m) => `${senderName(m.from)}: ${clip(m.subject, 100) || '(no subject)'}`);
  if (count > MAX_LINES) lines.push(`and ${count - MAX_LINES} more`);
  return {
    title: `${count} snoozed messages are back`,
    body: content !== 'minimal' ? lines.join('\n') : accountName,
    tag: `${account.id}:snooze`,
    url: '/',
  };
}
