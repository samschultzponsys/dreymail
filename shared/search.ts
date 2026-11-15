// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/**
 * Search filters picked in the filter builder (no query syntax). They travel in the URL (`f`) and
 * in saved searches, so every value is checked here, on both sides, before use.
 */

export type SearchWhere = 'folder' | 'inboxes' | 'all';
export type DatePreset = 'today' | 'week' | 'month' | 'year' | 'custom';

export interface SearchFilters {
  /** Where to look: the open folder (default), every inbox, or all mail. */
  where?: SearchWhere;
  /** Only these accounts (with `where` inboxes/all, or in the unified view). Empty = all. */
  accounts?: string[];
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  attachment?: boolean;
  flagged?: boolean;
  answered?: boolean;
  date?: DatePreset;
  /** YYYY-MM-DD, with date 'custom'. */
  since?: string;
  /** YYYY-MM-DD (inclusive), with date 'custom'. */
  until?: string;
  /** Larger than this many MB. */
  largerMb?: number;
}

/** A saved search, shown in the sidebar. */
export interface SavedSearch {
  id: string;
  name: string;
  q: string;
  unread: boolean;
  filters: SearchFilters;
  /** The folder it was saved in (with where 'folder'); null = the unified view. */
  accountId: string | null;
  folder: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WHERE: SearchWhere[] = ['folder', 'inboxes', 'all'];
const DATES: DatePreset[] = ['today', 'week', 'month', 'year', 'custom'];
export const SIZE_CHOICES = [1, 5, 10, 25];

function str(v: unknown, max = 200): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
}

function day(v: unknown): string | undefined {
  return typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined;
}

/** Keeps only valid values; anything unknown or malformed is dropped. */
export function normalizeFilters(raw: unknown): SearchFilters {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const f: SearchFilters = {};
  if (WHERE.includes(r.where as SearchWhere) && r.where !== 'folder') f.where = r.where as SearchWhere;
  if (Array.isArray(r.accounts)) {
    const ids = [...new Set(r.accounts.filter((a): a is string => typeof a === 'string' && ID_RE.test(a)))].slice(0, 50);
    if (ids.length) f.accounts = ids;
  }
  for (const k of ['from', 'to', 'subject', 'body'] as const) {
    const s = str(r[k]);
    if (s) f[k] = s;
  }
  for (const k of ['attachment', 'flagged', 'answered'] as const) if (r[k] === true) f[k] = true;
  if (DATES.includes(r.date as DatePreset)) {
    f.date = r.date as DatePreset;
    if (f.date === 'custom') {
      const since = day(r.since);
      const until = day(r.until);
      if (since) f.since = since;
      if (until) f.until = until;
      if (!since && !until) delete f.date;
    }
  }
  if (typeof r.largerMb === 'number' && SIZE_CHOICES.includes(r.largerMb)) f.largerMb = r.largerMb;
  return f;
}

export function hasFilters(f: SearchFilters): boolean {
  return Object.keys(f).length > 0;
}

/** Filters that narrow the results (where/accounts only say where to look). */
export function filterCount(f: SearchFilters): number {
  return Object.keys(f).filter((k) => k !== 'where' && k !== 'accounts' && k !== 'since' && k !== 'until').length;
}

/** For the URL: compact, stable JSON, or '' when there are no filters. */
export function encodeFilters(f: SearchFilters): string {
  const n = normalizeFilters(f);
  return hasFilters(n) ? JSON.stringify(n) : '';
}

export function decodeFilters(s: string | null | undefined): SearchFilters {
  if (!s) return {};
  try {
    return normalizeFilters(JSON.parse(s.slice(0, 4000)));
  } catch {
    return {};
  }
}

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/**
 * The date range of a filter as IMAP wants it: messages on or after `since`, and strictly before
 * `before` (both whole days). Relative presets are counted from `now`, so saved searches stay current.
 */
export function dateRange(f: SearchFilters, now = new Date()): { since?: Date; before?: Date } {
  const today = utcDay(now);
  const back = (days: number) => new Date(today.getTime() - days * 86_400_000);
  switch (f.date) {
    case 'today':
      return { since: today };
    case 'week':
      return { since: back(7) };
    case 'month':
      return { since: back(30) };
    case 'year':
      return { since: back(365) };
    case 'custom': {
      const r: { since?: Date; before?: Date } = {};
      if (f.since) r.since = new Date(`${f.since}T00:00:00Z`);
      if (f.until) r.before = new Date(new Date(`${f.until}T00:00:00Z`).getTime() + 86_400_000);
      return r;
    }
    default:
      return {};
  }
}

const DATE_LABELS: Record<DatePreset, string> = { today: 'Today', week: 'Past week', month: 'Past month', year: 'Past year', custom: 'Dates' };

/** One removable chip per active filter, for the bar under the search box. */
export function filterChips(f: SearchFilters, accountName: (id: string) => string): { key: keyof SearchFilters; label: string }[] {
  const chips: { key: keyof SearchFilters; label: string }[] = [];
  if (f.where === 'inboxes') chips.push({ key: 'where', label: 'All inboxes' });
  if (f.where === 'all') chips.push({ key: 'where', label: 'All mail' });
  if (f.accounts?.length) chips.push({ key: 'accounts', label: f.accounts.map(accountName).join(', ') });
  if (f.from) chips.push({ key: 'from', label: `From: ${f.from}` });
  if (f.to) chips.push({ key: 'to', label: `To: ${f.to}` });
  if (f.subject) chips.push({ key: 'subject', label: `Subject: ${f.subject}` });
  if (f.body) chips.push({ key: 'body', label: `Text: ${f.body}` });
  if (f.attachment) chips.push({ key: 'attachment', label: 'Has attachment' });
  if (f.flagged) chips.push({ key: 'flagged', label: 'Starred' });
  if (f.answered) chips.push({ key: 'answered', label: 'Replied' });
  if (f.date) {
    const label =
      f.date !== 'custom' ? DATE_LABELS[f.date] : f.since && f.until ? `${f.since} – ${f.until}` : f.since ? `Since ${f.since}` : `Until ${f.until}`;
    chips.push({ key: 'date', label });
  }
  if (f.largerMb) chips.push({ key: 'largerMb', label: `Over ${f.largerMb} MB` });
  return chips;
}

/** Removes one chip's filter (the date chip takes its range with it). */
export function withoutFilter(f: SearchFilters, key: keyof SearchFilters): SearchFilters {
  const next = { ...f };
  delete next[key];
  if (key === 'date') {
    delete next.since;
    delete next.until;
  }
  return next;
}
