// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/**
 * Automatic inbox tabs, without AI: newsletters announce themselves with mailing-list headers,
 * automated mail with Auto-Submitted/Precedence or a no-reply style sender; the rest is personal.
 */

export type MailCategory = 'personal' | 'updates' | 'newsletters';

export const CATEGORY_TABS: { key: MailCategory; label: string }[] = [
  { key: 'personal', label: 'Personal' },
  { key: 'updates', label: 'Updates' },
  { key: 'newsletters', label: 'Newsletters' },
];

const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|updates?|mailer(-daemon)?|bounces?|postmaster|receipts?|orders?|billing|invoices?|accounts?|security|verify|verification|support|service|system|automated|auto|robot|bot|info|news|newsletter|marketing|hello|team)([._+-].*)?$/i;

export function categorize(h: { fromAddress: string; listId: string; listUnsubscribe: string; precedence: string; autoSubmitted: string }): MailCategory {
  const precedence = h.precedence.trim().toLowerCase();
  if (h.listId.trim() || h.listUnsubscribe.trim() || precedence === 'bulk' || precedence === 'list') return 'newsletters';
  const auto = h.autoSubmitted.trim().toLowerCase();
  if ((auto && auto !== 'no') || precedence === 'junk') return 'updates';
  const local = h.fromAddress.split('@')[0] ?? '';
  if (AUTOMATED_SENDER.test(local)) return 'updates';
  return 'personal';
}

/** The headers categorize() needs, from a raw header block. */
export function categoryFromHeaders(raw: string, fromAddress: string): MailCategory {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  const get = (name: string) => new RegExp(`^${name}:(.*)$`, 'im').exec(unfolded)?.[1] ?? '';
  return categorize({ fromAddress, listId: get('list-id'), listUnsubscribe: get('list-unsubscribe'), precedence: get('precedence'), autoSubmitted: get('auto-submitted') });
}
