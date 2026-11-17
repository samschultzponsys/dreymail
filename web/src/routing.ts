// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-15: search filters (f) and messages opened from another folder (of).
// Modified by samschultzponsys, 2026-11-17: the calendar page (/calendar).

import { decodeFilters, encodeFilters, type SearchFilters } from '../../shared/search';

/**
 * Navigation state <-> URL. Pure functions, no DOM access, so they can be unit tested.
 *
 *   /                                     unified inbox (all accounts' INBOX)
 *   /mail/<accountId>/<folder>            a folder of one account (folder is URI-encoded)
 *   ...?q=<text>                          server-side search in that view
 *   ...&unread=1                          only unread messages (IMAP UNSEEN, on the server)
 *   ...&f=<json>                          filter builder choices (shared/search.ts)
 *   ...?open=<accountId>.<uidValidity>.<uid>
 *                                         an open message. Its folder is always the list's
 *                                         folder (INBOX in the unified view), so it isn't repeated,
 *                                         except for search results from other folders: &of=<folder>.
 *
 * Overlays (compose, settings, accounts, the phone folder drawer) are not part of the URL: they
 * live in history.state on an entry with the same URL, so Back closes them and a reload doesn't
 * reopen a half-written message.
 */

export interface OpenMessage {
  accountId: string;
  uidValidity: string;
  uid: number;
  /** Set when the message is in another folder than the list's (search across folders). */
  folder?: string;
}

export interface Route {
  /** null = unified inbox */
  accountId: string | null;
  folder: string;
  q: string;
  unread: boolean;
  filters: SearchFilters;
  open: OpenMessage | null;
  /** The calendar page instead of mail (DreyMail). */
  calendar?: boolean;
}

export type Overlay = 'compose' | 'settings' | 'accounts' | 'nav';

export interface HistoryState {
  /** Set on entries the app pushed itself; Back from them stays inside the app. */
  app: true;
  overlay?: Overlay;
}

export const HOME: Route = { accountId: null, folder: 'INBOX', q: '', unread: false, filters: {}, open: null };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parseOpen(raw: string | null, folder: string | null): OpenMessage | null {
  if (!raw) return null;
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{1,20})\.(\d{1,10})$/.exec(raw);
  if (!m) return null;
  const uid = Number(m[3]);
  if (!Number.isSafeInteger(uid) || uid < 1) return null;
  const open: OpenMessage = { accountId: m[1]!, uidValidity: m[2]!, uid };
  if (folder && folder.length <= 1000) open.folder = folder;
  return open;
}

export function parseLocation(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const q = (params.get('q') ?? '').slice(0, 500);
  const unread = params.get('unread') === '1';
  const filters = decodeFilters(params.get('f'));
  const open = parseOpen(params.get('open'), params.get('of'));
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'calendar') return { ...HOME, calendar: true };
  if (parts[0] === 'mail' && parts.length >= 3) {
    const accountId = parts[1]!;
    let folder: string;
    try {
      // Folder paths may contain '/', which is encoded; tolerate an unencoded one too.
      folder = parts.slice(2).map(decodeURIComponent).join('/');
    } catch {
      return { ...HOME };
    }
    if (!ID_RE.test(accountId) || !folder || folder.length > 1000) return { ...HOME };
    // An open message must belong to the account whose folder is shown, unless the search looks
    // beyond this folder.
    const elsewhere = filters.where === 'inboxes' || filters.where === 'all';
    return { accountId, folder, q, unread, filters, open: open && (elsewhere || open.accountId === accountId) ? open : null };
  }
  return { accountId: null, folder: 'INBOX', q, unread, filters, open };
}

export function buildUrl(route: Route): string {
  if (route.calendar) return '/calendar';
  const path = route.accountId ? `/mail/${encodeURIComponent(route.accountId)}/${encodeURIComponent(route.folder)}` : '/';
  const params = new URLSearchParams();
  if (route.q) params.set('q', route.q);
  if (route.unread) params.set('unread', '1');
  const f = encodeFilters(route.filters);
  if (f) params.set('f', f);
  if (route.open) {
    params.set('open', `${route.open.accountId}.${route.open.uidValidity}.${route.open.uid}`);
    if (route.open.folder) params.set('of', route.open.folder);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function sameRoute(a: Route, b: Route): boolean {
  return buildUrl(a) === buildUrl(b);
}

/** The folder an open message lives in, given the route it was opened from. */
export function openMessageFolder(route: Route): string {
  return route.open?.folder ?? (route.accountId ? route.folder : 'INBOX');
}

/** The list a message view belongs to (used for "back" and for stale-message fallback). */
export function listRoute(route: Route): Route {
  return { ...route, open: null };
}

export function readHistoryState(state: unknown): HistoryState | null {
  if (!state || typeof state !== 'object' || (state as HistoryState).app !== true) return null;
  const overlay = (state as HistoryState).overlay;
  const valid: Overlay[] = ['compose', 'settings', 'accounts', 'nav'];
  return { app: true, ...(overlay && valid.includes(overlay) ? { overlay } : {}) };
}

/** Identity of a list view (what the list shows, ignoring which message is open). */
export function viewKey(route: Route): string {
  return buildUrl(listRoute(route));
}
