// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-15: search filters (sender, dates, size, attachments, flags) and all-mail sources.
// Modified by samschultzponsys, 2026-11-16: automatic image loading rules (Settings → Images).
// Modified by samschultzponsys, 2026-11-16: folder lists served at once from the last known one.
// Modified by samschultzponsys, 2026-11-16: time taken per step when opening a message.
// Modified by samschultzponsys, 2026-11-17: every folder answered from the cache (filled in the background).
// Modified by samschultzponsys, 2026-11-17: other cached folders checked with the server before listing; Drafts never threaded.
// Modified by samschultzponsys, 2026-11-17: Not spam (back to the inbox, marked $NotJunk).
// Modified by samschultzponsys, 2026-11-17: Mark as spam (to Junk, made if missing, marked $Junk).
// Modified by samschultzponsys, 2026-11-17: finds a message by Message-ID (sent mail the server filed itself).
// Modified by samschultzponsys, 2026-11-17: Gmail: archive to All Mail; a message's labels, added and removed.
// Modified by samschultzponsys, 2026-11-18: keywords on a message ($MDNSent for read receipts); S/MIME on reading; Gmail labels in lists.
// Modified by samschultzponsys, 2026-11-18: mark a whole folder read.
// Modified by samschultzponsys, 2026-11-23: word searches answered from the search index where a folder is all cached and indexed.
// Modified by samschultzponsys, 2026-11-23: many folders searched a few at a time on connections of their own.
// Modified by samschultzponsys, 2026-11-23: an unchanged folder (one STATUS list per mailbox) is searched from the index without syncing it first.
// Modified by samschultzponsys, 2026-11-23: quick searches from the index alone, shown while the full search runs.
// Modified by samschultzponsys, 2026-11-25: messages opened on their own connection in one round trip, joining a download already under way; warm-up of likely next messages.
// Modified by samschultzponsys, 2026-11-27: an open waits at most a moment for a background download; warm-ups on the background connection.
// Modified by samschultzponsys, 2026-11-25: the last messages opened kept decoded in memory, so their pictures and attachments open at once.
// Modified by samschultzponsys, 2026-11-25: messages of one folder opened together fetched in one IMAP command.
// Modified by samschultzponsys, 2026-11-25: lists answered from the copy at once and checked in the background; a folder being cached for the first time isn't searched on the mail server for conversations.
// Modified by samschultzponsys, 2026-11-25: word searches from the index without asking about every folder; search connections within the mailbox's limit; actions on the connection for your requests.
// Modified by samschultzponsys, 2026-11-25: a refused search when paging is an error, not the end of the folder.

import { queryTerms } from '../cache/searchTerms.js';
import type { SmimeInfo } from '../mail/smime.js';
import { OpenedMemo, type OpenedMessage } from '../mail/openedMemo.js';
import type { FetchMessageObject, ImapFlow, ListResponse, SearchObject } from 'imapflow';
import type {
  AccountCursor,
  AccountFolders,
  Address,
  FolderView,
  ListResponse as MessageListResponse,
  MessageAction,
  MessageDetail,
  MessageRef,
  MessageSummary,
  SpecialUse,
  UndoInfo,
} from '../../../shared/types.js';
import { dateRange, filterCount, type SearchFilters } from '../../../shared/search.js';
import type { ThreadHeaders } from '../../../shared/threads.js';
import { CacheCorruptError, imapFlags, type CachedFolder, type MailCache } from '../cache/store.js';
import type { CacheSync } from '../cache/sync.js';
import { decideRemoteImages, displayDomain, type AutoImages } from '../mail/imageAllowlist.js';
import { attachmentBytes, buildMessageDetail, parseRaw, type ParsedEmail } from '../mail/parse.js';
import { collectRemoteImageUrls } from '../mail/sanitize.js';
import { imagesStillComing, inlineRemoteImages, type InlineOptions, type RemoteImageCache } from '../net/remoteImages.js';
import { MailServerError, describeError } from './connect.js';
import type { ImapPool, Lane } from './pool.js';
import { lookupTerms, matchesTerm, RelatedIndex, searchFor, termKey, type LookupTerm } from './related.js';
import { addresses, fetchSnippets, listFetch, searchOrThrow, sortTime, summaryOf, threadHeaders, toDate } from './summary.js';
import { setTimeout as sleep } from 'node:timers/promises';

export { threadHeaders };

const SPECIAL_USE: Record<string, SpecialUse> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Archive': 'archive',
  '\\Junk': 'junk',
  '\\All': 'all',
  '\\Flagged': 'flagged',
  // RFC 9979. Only marks the folder; IMAP has no wake-up time, so DreyMail keeps that itself.
  '\\Snoozed': 'snoozed',
};

/** Extra name fallbacks on top of ImapFlow's built-in localized name detection. */
const NAME_FALLBACKS: Partial<Record<SpecialUse, RegExp>> = {
  sent: /^(sent|sent items|sent mail|sent messages|gesendet|envoyés|skickat|sendt)$/i,
  drafts: /^(drafts?|entwürfe|brouillons|utkast|kladder)$/i,
  trash: /^(trash|deleted|deleted items|deleted messages|bin|papierkorb|corbeille|papperskorg|papirkurv)$/i,
  archive: /^(archives?|archiv|arkiv)$/i,
  junk: /^(junk|spam|junk e-?mail|bulk mail|skräppost|uønsket)$/i,
  snoozed: /^(snoozed|zurückgestellt|en attente|snoozade|udsat)$/i,
};

export class MessageGoneError extends Error {}

/** Messages larger than this are decoded in a worker thread (smaller ones are quicker where they are). */
const PARSE_IN_WORKER_BYTES = 256 * 1024;

/** A message decoded, with its flags when they were fetched along with it. */
interface Decoded {
  opened: OpenedMessage;
  meta: { flags: Set<string>; internalDate: Date | null } | null;
}

/** A message as fetched for reading. */
interface RawMessage {
  raw: Buffer;
  flags: Set<string>;
  internalDate: Date | null;
}

/** Someone waiting for a message of a folder to be fetched for reading (DreyMail 14.2). */
interface ReadWaiter {
  uid: number;
  known: KnownMessage | null;
  maxBytes: number;
  resolve: (m: RawMessage) => void;
  reject: (err: unknown) => void;
}

interface ReadQueue {
  waiting: ReadWaiter[];
  running: boolean;
}

/** How long an open waits for a download of the same message already under way before fetching it itself (DreyMail 26.11). */
const JOIN_WAIT_MS = 400;
/** Most messages, and bytes, fetched for reading in one IMAP command. */
const READ_BATCH = 25;
const READ_BATCH_BYTES = 64 * 1024 * 1024;

/** What the cache already knows of a message before fetching it. */
interface KnownMessage {
  flags: Set<string>;
  internalDate: Date | null;
  size: number;
}
export class StaleError extends Error {}

export interface ListSource {
  accountId: string;
  folder: string;
}

/** Server-side filtering of a listing: a text query and/or unread only. */
export interface ListFilter {
  /** '' = no text query */
  text: string;
  unread: boolean;
  /** From the filter builder (see shared/search.ts). */
  filters?: SearchFilters;
}

export const NO_FILTER: ListFilter = { text: '', unread: false };
/** Filtering the IMAP server must do (the cache only answers plain and unread-only listings). */
export const needsSearch = (f: ListFilter) => f.text !== '' || (!!f.filters && filterCount(f.filters) > 0);
/**
 * Connections a search of many folders of one mailbox uses at once (DreyMail 12.6); never the main
 * one (12.8), so opening a message or another folder doesn't wait behind a long search.
 */
export const isFiltered = (f: ListFilter) => f.unread || needsSearch(f);
/** A plain word search (unread only allowed) that the cache's search index can answer (DreyMail 12.3). */
export const indexable = (f: ListFilter) => !!f.text && !(f.filters && filterCount(f.filters) > 0) && queryTerms(f.text).length > 0;

/** A message of a listing, fetched from the IMAP server (`msg`, no snippet yet) or from the cache (`summary`). */
interface FetchedItem {
  source: ListSource;
  uidValidity: string;
  uid: number;
  sortTime: number;
  headers: ThreadHeaders;
  msg?: FetchMessageObject;
  summary?: MessageSummary;
}

interface SourcePage {
  source: ListSource;
  uidValidity: string;
  items: FetchedItem[];
  /** True if there are no messages older than the oldest item returned. */
  exhausted: boolean;
  reset: boolean;
}

type CursorMap = Record<string, AccountCursor>;

const sourceKey = (s: ListSource) => `${s.accountId}\u0000${s.folder}`;

function fetchedItem(source: ListSource, uidValidity: string, msg: FetchMessageObject): FetchedItem {
  return { source, uidValidity, uid: msg.uid, sortTime: sortTime(msg), headers: threadHeaders(msg), msg };
}

function cachedItem(source: ListSource, uidValidity: string, m: { summary: MessageSummary; sortTime: number }): FetchedItem {
  return { source, uidValidity, uid: m.summary.uid, sortTime: m.sortTime, headers: m.summary, summary: m.summary };
}

export function encodeCursor(c: CursorMap): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): CursorMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: CursorMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const c = v as Partial<AccountCursor>;
      if (typeof c.uidValidity === 'string' && Number.isInteger(c.beforeUid) && typeof c.done === 'boolean') {
        out[k] = { uidValidity: c.uidValidity, beforeUid: c.beforeUid!, done: c.done };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Related messages fetched per folder and page. */
const MAX_RELATED = 200;
/** A listing of a current cached INBOX checks the cached Sent folder in the background when it is older than this. */
const SENT_REFRESH_MS = 5000;
/** A listed folder (not a watched inbox) synced longer ago than this is checked in the background. */
const LISTED_CHECK_MS = 3000;
/** A copy checked this recently (and nothing known to have changed) answers word searches at once (DreyMail 14.5). */
const SEARCH_TRUST_MS = 10 * 60_000;

/**
 * K-way merge of per-source pages. Each source's items are a queue ordered newest-UID-first; at
 * every step the queue head with the most recent date wins. Because each source is consumed as a
 * strict UID-descending prefix, "the lowest UID consumed" is an exact per-source cursor even when
 * dates and UIDs disagree.
 */
export function mergePages(pages: SourcePage[], limit: number, previous: CursorMap) {
  const queues = pages.map((p) => ({ page: p, idx: 0 }));
  const picked: FetchedItem[] = [];
  while (picked.length < limit) {
    let best: (typeof queues)[number] | null = null;
    for (const q of queues) {
      const head = q.page.items[q.idx];
      if (!head) continue;
      const bestHead = best ? best.page.items[best.idx]! : null;
      if (!bestHead || head.sortTime > bestHead.sortTime) best = q;
    }
    if (!best) break;
    picked.push(best.page.items[best.idx]!);
    best.idx++;
  }
  const cursor: CursorMap = {};
  let more = false;
  for (const q of queues) {
    const key = sourceKey(q.page.source);
    const prev = q.page.reset ? undefined : previous[key];
    const consumedAll = q.idx >= q.page.items.length;
    const lastConsumed = q.idx > 0 ? q.page.items[q.idx - 1]!.uid : null;
    const firstUid = q.page.items[0]?.uid;
    const beforeUid = lastConsumed ?? prev?.beforeUid ?? (firstUid !== undefined ? firstUid + 1 : Number.MAX_SAFE_INTEGER);
    const done = consumedAll && q.page.exhausted;
    cursor[key] = { uidValidity: q.page.uidValidity, beforeUid, done };
    if (!done) more = true;
  }
  return { picked, cursor, more };
}

/**
 * IMAP SEARCH criteria for a filtered listing, in order of preference. Each source (folder) of a
 * listing gets its own set, scoped below its cursor so paging stays exact; unread-only adds
 * UNSEEN to every attempt. The text query prefers subject/sender/recipients/body; some servers
 * reject parts of that (e.g. FROM/TO with spaces), which fails the whole command, so it falls
 * back to the standard TEXT search (headers + body), then to SUBJECT alone.
 */
export function searchAttempts(filter: ListFilter, cursor?: Pick<AccountCursor, 'beforeUid'>, now = new Date()): SearchObject[] {
  const scope: SearchObject = {};
  if (cursor) scope.uid = `1:${cursor.beforeUid - 1}`;
  if (filter.unread) scope.seen = false;
  const f = filter.filters ?? {};
  if (f.from) scope.from = f.from;
  if (f.to) scope.to = f.to;
  if (f.subject) scope.subject = f.subject;
  if (f.body) scope.body = f.body;
  if (f.flagged) scope.flagged = true;
  if (f.answered) scope.answered = true;
  const { since, before } = dateRange(f, now);
  if (since) scope.since = since;
  if (before) scope.before = before;
  if (f.largerMb) scope.larger = f.largerMb * 1024 * 1024;
  // IMAP has no "has attachment" key. Gmail understands its own search; elsewhere, messages with
  // attachments are multipart/mixed.
  const scopes: SearchObject[] = f.attachment
    ? [
        { ...scope, gmraw: 'has:attachment' },
        { ...scope, header: { 'content-type': 'multipart/mixed' } },
      ]
    : [scope];
  const q = filter.text;
  if (!q) return scopes.map((s) => (Object.keys(s).length ? s : { all: true }));
  return scopes.flatMap((s) => [
    { ...s, or: [{ subject: q }, { from: q }, { to: q }, { body: q }] },
    { ...s, text: q },
    { ...s, subject: q },
  ]);
}

/** Run the first search attempt the server accepts. */
export async function searchWithFallback(client: ImapFlow, attempts: SearchObject[]): Promise<number[]> {
  for (const criteria of attempts) {
    const res = await client.search(criteria, { uid: true }).catch(() => false as const);
    if (Array.isArray(res)) return res;
  }
  return [];
}

/** The mail cache (see cache/store.ts), when it is switched on. */
export interface MailCacheDeps {
  cache: MailCache;
  sync: CacheSync;
  /** Largest message whose content is kept, and how much content one account may keep. */
  maxBodyBytes: number;
  bodyBytesPerAccount: number;
}

export class MailService {
  private readonly relatedIndex = new RelatedIndex();
  /** The last messages opened, decoded (DreyMail 14.1), and those being decoded right now. */
  private readonly opened = new OpenedMemo();
  private readonly decoding = new Map<string, Promise<Decoded>>();
  /** Messages waiting to be fetched for reading, per folder (DreyMail 14.2). */
  private readonly reads = new Map<string, ReadQueue>();
  /** S/MIME: decrypts and checks signed mail before it is read (DreyMail 10.6). */
  smime?: { open(userId: string, accountId: string, raw: Buffer): { raw: Buffer; info: SmimeInfo } | null };
  /** Decodes larger messages in a worker thread, so the server stays free meanwhile (DreyMail 14.1). */
  parser?: (raw: Buffer) => Promise<ParsedEmail>;

  constructor(
    private readonly pool: ImapPool,
    private readonly cached: MailCacheDeps | null = null,
  ) {}

  // ---- cache -----------------------------------------------------------------

  /**
   * Run `fn` against the cache. Any problem with it is handled (see CacheSync.handleError) and
   * `fallback` returned instead, so a broken cache only ever means going to the IMAP server.
   */
  private fromCache<T>(userId: string, accountId: string, folder: string, fallback: T, fn: (c: MailCacheDeps) => T): T {
    if (!this.cached) return fallback;
    try {
      return fn(this.cached);
    } catch (err) {
      this.cached.sync.handleError(err, userId, accountId, folder);
      if (err instanceof CacheCorruptError) this.cached.sync.syncSoon(userId, accountId, folder);
      return fallback;
    }
  }

  /** The cached copy of a folder, if it is cached, filled and for this UIDVALIDITY (if given). */
  private cachedFolder(userId: string, accountId: string, folder: string, uidValidity?: string): CachedFolder | null {
    return this.fromCache(userId, accountId, folder, null, ({ sync }) => {
      const f = sync.ready(userId, accountId, folder);
      return f && (uidValidity === undefined || f.uidValidity === uidValidity) ? f : null;
    });
  }

  /** Keep the cache of INBOX and Sent of an account up to date (called when its INBOX is watched). */
  syncAccount(userId: string, accountId: string) {
    this.fromCache(userId, accountId, 'INBOX', undefined, ({ sync }) => sync.syncAccount(userId, accountId));
  }

  /** Something changed in a folder: if it is cached, sync it soon. */
  folderChanged(userId: string, accountId: string, folder: string) {
    this.foldersChanged(userId, accountId);
    this.fromCache(userId, accountId, folder, undefined, ({ sync }) => sync.syncSoon(userId, accountId, folder));
  }

  /** Apply a change we just made on the IMAP server to the cached copy of the folder, if there is one. */
  private updateCache(userId: string, accountId: string, folder: string, uidValidity: string, fn: (cache: MailCache, f: CachedFolder) => void) {
    this.foldersChanged(userId, accountId);
    const f = this.cachedFolder(userId, accountId, folder, uidValidity);
    if (f) this.fromCache(userId, accountId, folder, undefined, ({ cache }) => fn(cache, f));
  }

  /** Forget everything cached for an account (deleted, or now pointing at another mailbox). */
  forgetAccount(userId: string, accountId: string) {
    this.opened.deletePrefix(`${userId}\u0000${accountId}\u0000`);
    this.forgetFolders(userId, accountId);
    this.fromCache(userId, accountId, 'INBOX', undefined, ({ cache, sync }) =>
      sync.forgetAccount(userId, accountId, () => {
        try {
          cache.dropAccount(userId, accountId);
        } catch {
          /* the cache is optional */
        }
      }),
    );
  }

  // ---- folders -------------------------------------------------------------

  private static specialUse(f: ListResponse): SpecialUse | null {
    if (f.path.toUpperCase() === 'INBOX') return 'inbox';
    const su = f.specialUse ? SPECIAL_USE[f.specialUse] : undefined;
    if (su) return su;
    for (const [use, re] of Object.entries(NAME_FALLBACKS)) if (re!.test(f.name)) return use as SpecialUse;
    return null;
  }

  /** The last folder list of each mailbox, served at once while a fresh one is fetched (DreyMail). */
  private readonly folderMemo = new Map<string, { at: number; value: AccountFolders; dirty?: boolean }>();
  private readonly folderJobs = new Map<string, Promise<AccountFolders>>();

  /** Remembered list: in memory, else from the encrypted mail cache (which survives restarts). */
  private knownFolders(userId: string, accountId: string, key: string) {
    let known = this.folderMemo.get(key);
    if (!known && this.cached) {
      try {
        const saved = this.cached.cache.folderList<AccountFolders>(userId, accountId);
        if (saved) this.folderMemo.set(key, (known = { at: saved.savedAt, value: saved.value }));
      } catch {
        /* cache unreadable: fetch fresh */
      }
    }
    return known;
  }

  /** Fetches a fresh folder list (once at a time per mailbox) and remembers it. */
  private refreshFolderList(userId: string, accountId: string, key: string): Promise<AccountFolders> {
    let job = this.folderJobs.get(key);
    if (!job) {
      const current = this.listFoldersLive(userId, accountId)
        .then((r) => {
          // Only the latest fetch counts: one overtaken by a change brings back old counts.
          if (!r.error && this.folderJobs.get(key) === current) {
            this.folderMemo.set(key, { at: Date.now(), value: r });
            try {
              this.cached?.cache.putFolderList(userId, accountId, r);
            } catch {
              /* the cache is optional */
            }
          }
          return r;
        })
        .finally(() => {
          if (this.folderJobs.get(key) === current) this.folderJobs.delete(key);
        });
      job = current;
      this.folderJobs.set(key, current);
    }
    return job;
  }

  /**
   * A mailbox's folders with unread counts. A list fetched in the last 30 seconds is served as is;
   * an older one (also one saved before a restart) comes back at once, marked `refreshing`, while a
   * fresh one is fetched in the background, so opening DreyMail doesn't wait for the mail server.
   */
  async listFolders(userId: string, accountId: string): Promise<AccountFolders> {
    const key = `${userId}\u0000${accountId}`;
    const known = this.knownFolders(userId, accountId, key);
    if (known && !known.dirty && !this.folderJobs.has(key) && Date.now() - known.at < 30_000) return known.value;
    const job = this.refreshFolderList(userId, accountId, key);
    // Changed by an action (read, moved, a folder made…): wait for the real counts, never show old ones.
    if (known && !known.dirty) {
      void job.catch(() => undefined);
      return { ...known.value, refreshing: true };
    }
    return job;
  }

  /** Keeps a mailbox's remembered folder list current (the background refresh); never throws. */
  async refreshFolders(userId: string, accountId: string): Promise<void> {
    const key = `${userId}\u0000${accountId}`;
    const known = this.knownFolders(userId, accountId, key);
    if (known && !known.dirty && Date.now() - known.at < 60_000) return;
    await this.refreshFolderList(userId, accountId, key).catch(() => undefined);
  }

  /** New mail or other changes: the remembered unread counts are out of date. */
  foldersChanged(userId: string, accountId: string) {
    const known = this.folderMemo.get(`${userId}\u0000${accountId}`);
    if (known) known.dirty = true;
    // A fetch that started before the change could bring back the old counts: let the next one decide.
    this.folderJobs.delete(`${userId}\u0000${accountId}`);
  }

  /** Forget a mailbox's remembered folder list (after it's edited or removed). */
  forgetFolders(userId: string, accountId: string) {
    this.folderMemo.delete(`${userId}\u0000${accountId}`);
  }

  private async listFoldersLive(userId: string, accountId: string): Promise<AccountFolders> {
    try {
      const list = await this.pool.folders(userId, accountId, true);
      const folders: FolderView[] = list.map((f) => ({
        path: f.path,
        name: f.name,
        delimiter: f.delimiter,
        parentPath: f.parentPath,
        specialUse: MailService.specialUse(f),
        selectable: !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'),
        unread: f.status?.unseen ?? null,
        total: f.status?.messages ?? null,
      }));
      return { accountId, folders };
    } catch (err) {
      return { accountId, folders: [], error: describeError(err, 'IMAP').message };
    }
  }

  /**
   * Folders an "All mail" search looks in: Gmail-style \\All when the server has one (it holds
   * everything once), otherwise every folder except Trash, Junk, Drafts and Snoozed.
   */
  async allMailFolders(userId: string, accountId: string): Promise<string[]> {
    const list = await this.pool.folders(userId, accountId);
    const all = list.find((f) => f.specialUse === '\\All' && !f.flags.has('\\Noselect'));
    if (all) return [all.path];
    const skip = new Set<SpecialUse | null>(['trash', 'junk', 'drafts', 'snoozed', 'all', 'flagged']);
    return list
      .filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent') && !skip.has(MailService.specialUse(f)))
      .map((f) => f.path)
      .slice(0, 150);
  }

  /**
   * Every folder that can hold messages, for filling the mail cache (DreyMail): the special ones
   * (Drafts, Archive, Junk, Trash, …) first, then the rest in the server's order. Throws if the
   * folder list can't be had.
   */
  async cacheableFolders(userId: string, accountId: string): Promise<string[]> {
    const list = (await this.pool.folders(userId, accountId)).filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'));
    const special = list.filter((f) => MailService.specialUse(f) !== null);
    const rest = list.filter((f) => MailService.specialUse(f) === null);
    return [...special, ...rest].map((f) => f.path);
  }

  /** What a folder is for (inbox, sent, junk, …), or null for an ordinary folder (DreyMail). */
  async folderUse(userId: string, accountId: string, path: string): Promise<SpecialUse | null> {
    const f = (await this.pool.folders(userId, accountId)).find((x) => x.path === path);
    // Gmail's Important only shows mail kept in other folders, like All mail.
    if (f?.specialUse === '\\Important') return 'all';
    return f ? MailService.specialUse(f) : null;
  }

  /** Find a special-use folder, preferring server-declared SPECIAL-USE over name matches. */
  async specialFolder(userId: string, accountId: string, use: SpecialUse): Promise<string | null> {
    const list = await this.pool.folders(userId, accountId);
    const declared = list.find((f) => f.specialUse && SPECIAL_USE[f.specialUse] === use);
    if (declared) return declared.path;
    const byName = list.find((f) => MailService.specialUse(f) === use && !f.flags.has('\\Noselect'));
    return byName?.path ?? null;
  }

  // ---- listing -------------------------------------------------------------

  private async fetchSourcePage(
    userId: string,
    source: ListSource,
    cursor: AccountCursor | undefined,
    limit: number,
    filter: ListFilter,
    lane: Lane = 'main',
  ): Promise<SourcePage> {
    return this.pool.withMailbox(userId, source.accountId, source.folder, async (client, selected) => {
      // The pooled connection may have had this folder selected for a while. Not every server
      // pushes EXISTS for mail delivered meanwhile; a NOOP makes it report new messages, so the
      // listing (which counts from EXISTS) never misses the newest mail.
      await client.noop();
      const mailbox = (client.mailbox || selected) as typeof selected;
      const uidValidity = mailbox.uidValidity.toString();
      let reset = false;
      if (cursor && cursor.uidValidity !== uidValidity) {
        reset = true;
        cursor = undefined;
      }
      const empty: SourcePage = { source, uidValidity, items: [], exhausted: true, reset };
      if (cursor?.done || mailbox.exists === 0) return empty;
      if (cursor && cursor.beforeUid <= 1) return empty;

      let range: string;
      let useUid: boolean;
      let exhausted: boolean;
      if (isFiltered(filter)) {
        const uids = (await searchWithFallback(client, searchAttempts(filter, cursor))).sort((a, b) => a - b);
        const page = uids.slice(-limit);
        if (page.length === 0) return empty;
        range = page.join(',');
        useUid = true;
        exhausted = uids.length <= limit;
      } else {
        let top = mailbox.exists;
        if (cursor && cursor.beforeUid < mailbox.uidNext) {
          // Find the sequence number just below the cursor UID.
          // A refused search is an error, not the end of the folder (DreyMail 14.6).
          const exact = await searchOrThrow(client, { uid: String(cursor.beforeUid) }, { uid: false });
          if (exact.length) top = exact[0]! - 1;
          else {
            const below = await searchOrThrow(client, { uid: `1:${cursor.beforeUid - 1}` }, { uid: false });
            top = below.length ? Math.max(...below) : 0;
          }
        }
        if (top < 1) return empty;
        const start = Math.max(1, top - limit + 1);
        range = `${start}:${top}`;
        useUid = false;
        exhausted = start === 1;
      }

      const msgs = await client.fetchAll(range, listFetch(client), { uid: useUid });
      const items = msgs
        .filter((m) => !cursor || m.uid < cursor.beforeUid)
        .sort((a, b) => b.uid - a.uid)
        .map((msg) => fetchedItem(source, uidValidity, msg));
      return { source, uidValidity, items, exhausted, reset };
    }, lane);
  }

  /** A word search from the search index alone (see listMessages' `quick`): never asks a mail server. */
  private async quickSearch(userId: string, sources: ListSource[], previous: Record<string, AccountCursor>, limit: number, filter: ListFilter): Promise<MessageListResponse> {
    const none: MessageListResponse = { messages: [], related: [], cursor: null, errors: [], reset: false, partial: true };
    if (!this.cached || !indexable(filter)) return none;
    const terms = queryTerms(filter.text);
    const pages = sources
      .map((source) =>
        this.fromCache(userId, source.accountId, source.folder, null, ({ cache, sync }): SourcePage | null => {
          const f = sync.ready(userId, source.accountId, source.folder);
          if (!f) return null;
          const cursor = previous[sourceKey(source)];
          if (cursor?.done || (cursor && cursor.uidValidity !== f.uidValidity)) return { source, uidValidity: f.uidValidity, items: [], exhausted: true, reset: false };
          const rows = cache.search(f, terms, cursor?.beforeUid ?? null, limit, filter.unread);
          return { source, uidValidity: f.uidValidity, items: rows.map((m) => cachedItem(source, f.uidValidity, m)), exhausted: rows.length < limit, reset: false };
        }),
      )
      .filter((p): p is SourcePage => p !== null);
    const { picked, cursor, more } = mergePages(pages, limit, previous);
    return { messages: picked.map((it) => this.toSummary(it, '')), related: [], cursor: more ? encodeCursor(cursor) : null, errors: [], reset: false, partial: true };
  }

  /**
   * The searched folders whose copy matches the server (DreyMail 12.7): one folder list with STATUS
   * per mailbox (newest UID and message count) compared with the cache, instead of syncing every
   * folder first. Changed folders are synced in the background; this search asks the server.
   */
  private async unchangedFolders(userId: string, sources: ListSource[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!this.cached) return out;
    const { sync } = this.cached;
    const accounts = [...new Set(sources.map((s) => s.accountId))];
    await Promise.all(
      accounts.map(async (accountId) => {
        const ask: { source: ListSource; f: CachedFolder }[] = [];
        for (const s of sources.filter((x) => x.accountId === accountId)) {
          const f = sync.ready(userId, accountId, s.folder);
          if (!f) continue;
          // Known to match (DreyMail 14.5): a watched inbox, or another folder whose copy was checked a
          // few minutes ago with nothing known to have changed since. Answered at once; a check runs
          // in the background, and what it finds reaches the results by itself (as for listing, 14.3).
          // An inbox not being watched is always asked about (new mail can't be heard of otherwise).
          if (sync.isCurrent(userId, accountId, s.folder)) out.add(sourceKey(s));
          else if (s.folder !== 'INBOX' && !sync.hasPendingChange(userId, accountId, s.folder) && Date.now() - f.syncedAt < SEARCH_TRUST_MS) {
            out.add(sourceKey(s));
            sync.checkSoon(userId, accountId, s.folder, LISTED_CHECK_MS);
          } else ask.push({ source: s, f });
        }
        if (!ask.length) return;
        // Only the folders in question are asked about (it was the whole folder list, one request per folder on most servers).
        const status = await Promise.resolve()
          .then(() => this.pool.status(userId, accountId, ask.map((x) => x.source.folder)))
          .catch(() => null);
        for (const { source, f } of ask) {
          const st = status?.get(source.folder);
          if (st && st.uidNext === f.uidNext && st.messages === f.exists) out.add(sourceKey(source));
          else sync.syncSoon(userId, accountId, source.folder);
        }
      }),
    );
    return out;
  }


  /**
   * A text search answered from the search index (DreyMail 12.3), at once, when the folder's copy
   * holds all its mail and every message's content is indexed; otherwise null (the IMAP server
   * searches). Only plain word searches (and unread only) are answered here.
   */
  private indexedSourcePage(userId: string, source: ListSource, cursor: AccountCursor | undefined, limit: number, filter: ListFilter, current: Set<string>): SourcePage | null {
    if (!this.cached || !indexable(filter)) return null;
    const terms = queryTerms(filter.text);
    const { accountId, folder } = source;
    return this.fromCache(userId, accountId, folder, null, ({ cache, sync }) => {
      const f = sync.ready(userId, accountId, folder);
      // All of the folder's mail, and known to match the server (see unchangedFolders).
      if (!f || !f.complete || !current.has(sourceKey(source))) return null;
      const state = cache.indexState(f);
      if (state.messages === 0 || state.indexed < state.messages) return null;
      let reset = false;
      if (cursor && cursor.uidValidity !== f.uidValidity) {
        reset = true;
        cursor = undefined;
      }
      if (cursor?.done) return { source, uidValidity: f.uidValidity, items: [], exhausted: true, reset };
      const rows = cache.search(f, terms, cursor?.beforeUid ?? null, limit, filter.unread);
      return { source, uidValidity: f.uidValidity, items: rows.map((m) => cachedItem(source, f.uidValidity, m)), exhausted: rows.length < limit, reset };
    });
  }

  /**
   * A page of `source` from the cache, or null if the cache can't answer it: the folder isn't
   * cached (or not filled yet; it starts filling), there is a text search (always done by the IMAP
   * server), or the page reaches below the oldest cached message.
   */
  private cachedSourcePage(userId: string, source: ListSource, cursor: AccountCursor | undefined, limit: number, filter: ListFilter): SourcePage | null {
    if (!this.cached || needsSearch(filter)) return null;
    const { accountId, folder } = source;
    return this.fromCache(userId, accountId, folder, null, ({ cache, sync }) => {
      const f = sync.ready(userId, accountId, folder);
      if (!f) {
        // Not cached yet: start filling it (the IMAP server answers meanwhile).
        if (folder === 'INBOX' || cache.folder(userId, accountId, folder)) sync.syncAccount(userId, accountId);
        else sync.startFolder(userId, accountId, folder);
        return null;
      }
      let reset = false;
      if (cursor && cursor.uidValidity !== f.uidValidity) {
        reset = true;
        cursor = undefined;
      }
      const empty: SourcePage = { source, uidValidity: f.uidValidity, items: [], exhausted: true, reset };
      if (cursor?.done) return empty;
      // A copy missing messages the server has is not trusted: the mail server answers until the
      // copy is filled again (DreyMail 14.6).
      if (!sync.isIntact(f)) {
        sync.syncSoon(userId, accountId, folder);
        return null;
      }
      const rows = cache.page(f, cursor?.beforeUid ?? null, limit, filter.unread);
      if (rows.length < limit && !f.complete) return null;
      return { source, uidValidity: f.uidValidity, items: rows.map((m) => cachedItem(source, f.uidValidity, m)), exhausted: rows.length < limit, reset };
    });
  }

  /**
   * Messages in `source` that match any of `terms` (see related.ts). Header searches can be slow
   * on big folders, so the RelatedIndex remembers results and later only searches new mail.
   */
  private async findByTerms(userId: string, source: ListSource, terms: LookupTerm[]): Promise<FetchedItem[]> {
    return this.pool.withMailbox(userId, source.accountId, source.folder, async (client, selected) => {
      await client.noop();
      const mailbox = (client.mailbox || selected) as typeof selected;
      if (mailbox.exists === 0) return [];
      const uidValidity = mailbox.uidValidity.toString();
      const uidNext = Number(mailbox.uidNext);
      const key = `${userId}\u0000${sourceKey(source)}`;
      const { searches, known } = this.relatedIndex.plan(key, uidValidity, uidNext, terms);
      const candidates = new Set(known);
      const searched = new Set<string>();
      for (const s of searches) {
        const res = await client.search(searchFor(s.terms, s.fromUid), { uid: true }).catch(() => false as const);
        if (!Array.isArray(res)) continue;
        // "n:*" includes the highest UID even when it is below n.
        for (const uid of res) if (uid >= s.fromUid) candidates.add(uid);
        for (const t of s.terms) searched.add(termKey(t));
      }
      const uids = [...candidates].sort((a, b) => b - a).slice(0, MAX_RELATED);
      const msgs = uids.length ? await client.fetchAll(uids.join(','), listFetch(client), { uid: true }) : [];
      const found = msgs.map((msg) => fetchedItem(source, uidValidity, msg));
      this.relatedIndex.record(key, uidValidity, uidNext, terms, searched, found);
      return found.filter((f) => terms.some((t) => matchesTerm(t, f.headers)));
    });
  }

  /**
   * The rest of the listed messages' conversations: your replies in the account's Sent folder
   * (wherever they were sent from) and older messages in the listed folder. Best effort: the
   * listing never fails because of this. Drafts are not threaded.
   */
  private async relatedItems(userId: string, picked: FetchedItem[]): Promise<FetchedItem[]> {
    const bySource = new Map<string, FetchedItem[]>();
    for (const it of picked) {
      const k = sourceKey(it.source);
      bySource.set(k, [...(bySource.get(k) ?? []), it]);
    }
    const listed = new Set(picked.map((it) => `${sourceKey(it.source)}\u0000${it.uid}`));
    const out = new Map<string, FetchedItem>();
    await Promise.all(
      [...bySource.values()].map(async (group) => {
        const { accountId, folder } = group[0]!.source;
        try {
          const terms = new Map<string, LookupTerm>();
          for (const it of group) for (const t of lookupTerms(it.headers)) terms.set(termKey(t), t);
          if (terms.size === 0) return;
          // A cached INBOX or Sent is never Drafts, and its account's Sent folder is known without
          // asking the IMAP server. Other cached folders (DreyMail) may be Drafts: checked below.
          const cachedSent = this.cachedFolderList(userId, accountId, folder);
          let lookIn: string[];
          if (cachedSent) lookIn = cachedSent;
          else {
            const [sent, drafts] = await Promise.all([
              this.specialFolder(userId, accountId, 'sent'),
              this.specialFolder(userId, accountId, 'drafts'),
            ]);
            if (folder === drafts) return;
            lookIn = [...new Set([folder, ...(sent ? [sent] : [])])];
          }
          for (const f of lookIn) {
            // The listed folder, opened before it was cached, isn't searched on the mail server for
            // older messages of its conversations (slow on a big folder): its copy is ready in a
            // moment, and the list then comes again from it, whole conversations included (DreyMail 14.3).
            if (f === folder && this.cached?.sync.isFilling(userId, accountId, f)) continue;
            const source = { accountId, folder: f };
            const items = await this.findRelated(userId, source, [...terms.values()]).catch(() => [] as FetchedItem[]);
            for (const it of items) {
              const k = `${sourceKey(source)}\u0000${it.uid}`;
              if (!listed.has(k)) out.set(k, it);
            }
          }
        } catch {
          /* threading is best-effort */
        }
      }),
    );
    return [...out.values()];
  }

  /**
   * Where the rest of the conversations of a listed cached folder are: the folder and the
   * account's Sent folder, if both are cached. Null if the IMAP server has to be asked.
   */
  private cachedFolderList(userId: string, accountId: string, folder: string): string[] | null {
    return this.fromCache(userId, accountId, folder, null, ({ cache, sync }) => {
      const listed = sync.ready(userId, accountId, folder);
      const sent = cache.folderByRole(userId, accountId, 'sent');
      if (!listed || listed.role === 'folder' || !sent || sent.syncedAt === 0) return null;
      return [...new Set([folder, sent.path])];
    });
  }

  /**
   * Before listing cached folders: make sure they (and the Sent folder their conversations come
   * from) are up to date, unless they are known to be. See CacheSync.beforeListing.
   */
  private async prepareCached(userId: string, sources: ListSource[], filter: ListFilter, fresh: boolean) {
    if (!this.cached || needsSearch(filter)) return;
    const { cache, sync } = this.cached;
    await Promise.all(
      sources.map(async ({ accountId, folder }) => {
        try {
          if (!sync.ready(userId, accountId, folder)) return;
          const sent = cache.folderByRole(userId, accountId, 'sent');
          const others = sent && sent.path !== folder ? [sent.path] : [];
          if (fresh) {
            // The refresh button: the user wants what the mail server has now.
            await sync.beforeListing(userId, accountId, [folder, ...others], { force: true });
            return;
          }
          if (!sync.isCurrent(userId, accountId, folder)) {
            // An inbox not being watched right now (new mail can't be heard of otherwise), or a folder
            // where something DreyMail knows of changed (a move, a sent message, activity the
            // watcher saw): wait for the check, up to 0.4 s, as before.
            const known = [folder, ...others].filter((p) => sync.hasPendingChange(userId, accountId, p));
            if (folder === 'INBOX' || known.length) {
              await sync.beforeListing(userId, accountId, folder === 'INBOX' ? [folder, ...others] : known);
              return;
            }
            // Any other folder is answered from the copy at once (DreyMail 14.3; it waited up to 0.4 s
            // every time). The check runs in the background; what it finds (changes made by other
            // mail clients) reaches the list by itself.
            sync.checkSoon(userId, accountId, folder, LISTED_CHECK_MS);
          }
          // Nothing tells us about changes in Sent; have a look in the background now and then.
          for (const p of others) sync.refreshIfOlder(userId, accountId, p, SENT_REFRESH_MS);
        } catch (err) {
          sync.handleError(err, userId, accountId, folder);
        }
      }),
    );
  }

  /** Messages of a folder matching conversation terms: from the cache if it has the folder, else by IMAP search. */
  private async findRelated(userId: string, source: ListSource, terms: LookupTerm[]): Promise<FetchedItem[]> {
    const fromCache = this.fromCache(userId, source.accountId, source.folder, null, ({ cache, sync }) => {
      const f = sync.ready(userId, source.accountId, source.folder);
      return f ? cache.related(f, terms, MAX_RELATED).map((m) => cachedItem(source, f.uidValidity, m)) : null;
    });
    return fromCache ?? this.findByTerms(userId, source, terms);
  }

  /** Snippets of messages fetched from the IMAP server (cached ones already have theirs). */
  private async snippets(userId: string, items: FetchedItem[]): Promise<Map<FetchedItem, string>> {
    const out = new Map<FetchedItem, string>();
    const bySource = new Map<string, FetchedItem[]>();
    for (const it of items) {
      if (!it.msg) continue;
      const k = sourceKey(it.source);
      bySource.set(k, [...(bySource.get(k) ?? []), it]);
    }
    await Promise.all(
      [...bySource.values()].map(async (group) => {
        const { accountId, folder } = group[0]!.source;
        try {
          const byUid = new Map(group.map((it) => [it.uid, it]));
          const snippets = await this.pool.withMailbox(userId, accountId, folder, (client) => fetchSnippets(client, group.map((it) => it.msg!)));
          for (const [uid, snippet] of snippets) out.set(byUid.get(uid)!, snippet);
        } catch {
          /* snippets are best-effort */
        }
      }),
    );
    return out;
  }

  private toSummary(it: FetchedItem, snippet: string): MessageSummary {
    return it.summary ? { ...it.summary } : summaryOf(it.source, it.uidValidity, it.msg!, snippet);
  }

  /**
   * List the newest messages across one or more mailboxes (a single folder, or every account's
   * INBOX for the unified view), merged by date with per-source cursors. The rest of their
   * conversations comes along in `related` (see relatedItems).
   */
  async listMessages(
    userId: string,
    sources: ListSource[],
    rawCursor: string | null,
    limit: number,
    filter: ListFilter = NO_FILTER,
    /**
     * fresh: the user asked to refresh, so cached folders are checked with the server first (see
     * prepareCached). quick (DreyMail 12.8): a word search answered only from the search index, at
     * once, from whatever the cache holds (the client shows it while the full search runs).
     */
    opts: { fresh?: boolean; quick?: boolean; signal?: AbortSignal } = {},
  ): Promise<MessageListResponse> {
    const previous = decodeCursor(rawCursor);
    const errors: MessageListResponse['errors'] = [];
    if (opts.quick) return this.quickSearch(userId, sources, previous, limit, filter);
    await this.prepareCached(userId, sources, filter, !!opts.fresh);
    const current = indexable(filter) ? await this.unchangedFolders(userId, sources) : new Set<string>();
    const one = async (s: ListSource, lane: Lane): Promise<SourcePage | null> => {
      try {
        return (
          this.indexedSourcePage(userId, s, previous[sourceKey(s)], limit, filter, current) ??
          this.cachedSourcePage(userId, s, previous[sourceKey(s)], limit, filter) ??
          (await this.fetchSourcePage(userId, s, previous[sourceKey(s)], limit, filter, lane))
        );
      } catch (err) {
        errors.push({ accountId: s.accountId, folder: s.folder, error: describeError(err, 'IMAP').message });
        return null;
      }
    };
    // Searching many folders of a mailbox (DreyMail 12.6): a few at a time, each on a connection of
    // its own, instead of all queued on one connection (where the last ones gave up waiting).
    const byAccount = new Map<string, ListSource[]>();
    for (const s of sources) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);
    const pages = (
      await Promise.all(
        [...byAccount.values()].map(async (list) => {
          if (list.length === 1) return [await one(list[0]!, 'main')];
          const out: (SourcePage | null)[] = new Array(list.length).fill(null);
          let next = 0;
          await Promise.all(
            // As many search connections as the mailbox's connection limit leaves room for (DreyMail 14.5).
            this.pool.searchLanes(userId, list[0]!.accountId, Math.min(4, list.length)).map(async (lane) => {
              // A search the browser has given up on stops after the folders already under way.
              for (let i = next++; i < list.length && !opts.signal?.aborted; i = next++) out[i] = await one(list[i]!, lane);
            }),
          );
          return out;
        }),
      )
    )
      .flat()
      .filter((p): p is SourcePage => p !== null);

    const reset = pages.some((p) => p.reset) && rawCursor !== null;
    const { picked, cursor, more } = mergePages(pages, limit, previous);
    // Sources that failed keep their previous cursor so a later page can retry them.
    for (const s of sources) {
      const k = sourceKey(s);
      if (!cursor[k] && previous[k]) cursor[k] = previous[k];
    }
    const related = await this.relatedItems(userId, picked);
    const snippets = await this.snippets(userId, [...picked, ...related]);
    return {
      messages: picked.map((it) => this.toSummary(it, snippets.get(it) ?? '')),
      related: related.map((it) => this.toSummary(it, snippets.get(it) ?? '')),
      cursor: more ? encodeCursor(cursor) : null,
      errors,
      reset,
    };
  }

  // ---- single message ------------------------------------------------------

  private checkValidity(mailbox: { uidValidity: bigint }, ref: MessageRef) {
    if (mailbox.uidValidity.toString() !== ref.uidValidity) {
      throw new StaleError('The folder changed on the server (UIDVALIDITY). Reload the message list.');
    }
  }

  /** Throws StaleError if the folder's UIDVALIDITY no longer matches. */
  async assertUidValidity(userId: string, ref: Omit<MessageRef, 'uid'>) {
    await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (_client, mailbox) => this.checkValidity(mailbox, { ...ref, uid: 0 }));
  }

  async fetchRaw(
    userId: string,
    ref: MessageRef,
    maxBytes: number,
  ): Promise<{ raw: Buffer; flags: Set<string>; internalDate: Date | null }> {
    const f = this.cachedFolder(userId, ref.accountId, ref.folder, ref.uidValidity);
    let known: KnownMessage | null = null;
    if (f) {
      const hit = this.fromCache(userId, ref.accountId, ref.folder, null, ({ cache }) => {
        const m = cache.message(f, ref.uid);
        if (!m) return null;
        const meta: KnownMessage = { flags: imapFlags(m.summary), internalDate: toDate(m.internalDate ?? undefined), size: m.summary.size };
        return { meta, raw: cache.body(f, ref.uid) };
      });
      if (hit?.raw) return { raw: hit.raw, flags: hit.meta.flags, internalDate: hit.meta.internalDate };
      if (hit) {
        // Content on its way right now (new mail, loading ahead): wait for that instead of fetching it
        // twice (DreyMail 14.0), but only a moment (26.11): it may be on the background connection,
        // behind other downloads. Then it is fetched here too, and whichever comes first is used.
        const coming = this.cached?.sync.downloadingBody(userId, ref.accountId, ref.folder, ref.uid);
        known = hit.meta;
        if (coming) {
          const meta = { flags: hit.meta.flags, internalDate: hit.meta.internalDate };
          const soon = await Promise.race([coming, sleep(JOIN_WAIT_MS).then(() => 'late' as const)]);
          if (soon instanceof Buffer) return { raw: soon, ...meta };
          if (soon === 'late') {
            const live = this.fetchRawLive(userId, ref, maxBytes, known);
            live.catch(() => undefined);
            return Promise.race([live, coming.then((raw) => (raw ? { raw, ...meta } : live))]);
          }
        }
      }
    }
    const res = await this.fetchRawLive(userId, ref, maxBytes, known);
    if (f && this.cached && res.raw.length <= this.cached.maxBodyBytes) {
      this.fromCache(userId, ref.accountId, ref.folder, undefined, ({ cache, sync }) => {
        if (sync.budgetOf(userId, ref.accountId) <= 0) return;
        cache.putBody(f, ref.uid, res.raw);
        sync.enforceBudget(userId, ref.accountId);
      });
    }
    return res;
  }

  /**
   * Fetch a message from the mail server, on a connection of its own ('read', DreyMail 14.0) so
   * opening it never waits behind a sync or an action. With its size known from the cache it takes
   * one round trip instead of two. Messages of one folder asked for while a fetch is under way (a
   * conversation opening, several at once) go together in the next IMAP command (DreyMail 14.2).
   */
  private fetchRawLive(userId: string, ref: MessageRef, maxBytes: number, known: KnownMessage | null = null): Promise<RawMessage> {
    const key = `${userId}\u0000${ref.accountId}\u0000${ref.folder}\u0000${ref.uidValidity}`;
    let queue = this.reads.get(key);
    if (!queue) this.reads.set(key, (queue = { waiting: [], running: false }));
    const q = queue;
    return new Promise((resolve, reject) => {
      q.waiting.push({ uid: ref.uid, known, maxBytes, resolve, reject });
      if (q.running) return;
      q.running = true;
      // Requests of this same moment (one page of a conversation) join the first command too.
      setImmediate(() => void this.drainReads(userId, ref, key, q));
    });
  }

  private async drainReads(userId: string, ref: MessageRef, key: string, q: ReadQueue) {
    while (q.waiting.length) {
      const batch = q.waiting.splice(0, READ_BATCH);
      try {
        await this.readBatch(userId, ref, batch);
      } catch (err) {
        for (const w of batch) w.reject(err);
      }
    }
    q.running = false;
    if (this.reads.get(key) === q) this.reads.delete(key);
  }

  /** One folder's waiting messages: sizes where unknown, then the messages, each handed over as it arrives. */
  private async readBatch(userId: string, ref: MessageRef, batch: ReadWaiter[]) {
    await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      this.checkValidity(mailbox, ref);
      const sizes = new Map<number, number>();
      for (const w of batch) if (w.known && w.known.size > 0) sizes.set(w.uid, w.known.size);
      const unknown = [...new Set(batch.filter((w) => !sizes.has(w.uid)).map((w) => w.uid))];
      if (unknown.length) for (const m of await client.fetchAll(unknown.join(','), { uid: true, size: true }, { uid: true })) sizes.set(m.uid, m.size ?? 0);
      const byUid = new Map<number, ReadWaiter[]>();
      for (const w of batch) {
        const size = sizes.get(w.uid);
        if (size === undefined) w.reject(new MessageGoneError('Message not found'));
        else if (size > w.maxBytes) w.reject(new MailServerError(`Message is too large to display (${Math.round(size / 1048576)} MB)`, 'protocol'));
        else byUid.set(w.uid, [...(byUid.get(w.uid) ?? []), w]);
      }
      // A few large messages per command, so a batch never holds much in memory at once.
      const groups: number[][] = [];
      let group: number[] = [];
      let bytes = 0;
      for (const uid of byUid.keys()) {
        const size = sizes.get(uid)!;
        if (group.length && bytes + size > READ_BATCH_BYTES) {
          groups.push(group);
          group = [];
          bytes = 0;
        }
        group.push(uid);
        bytes += size;
      }
      if (group.length) groups.push(group);
      for (const uids of groups) {
        // `source` is fetched with BODY.PEEK, so reading never sets \Seen implicitly.
        for await (const m of client.fetch(uids.join(','), { uid: true, flags: true, internalDate: true, source: true }, { uid: true })) {
          const waiters = byUid.get(m.uid);
          if (!waiters || !m.source) continue;
          byUid.delete(m.uid);
          for (const w of waiters) w.resolve({ raw: m.source, flags: m.flags ?? w.known?.flags ?? new Set(), internalDate: toDate(m.internalDate) ?? w.known?.internalDate ?? null });
        }
      }
      for (const waiters of byUid.values()) for (const w of waiters) w.reject(new MessageGoneError('Message not found'));
    }, 'read');
  }

  /**
   * Fetch the content of messages the user is likely to open next (the ones around the open one,
   * or one under the pointer) into the cache ahead, so opening them doesn't wait for the mail
   * server (DreyMail 14.0). Only cached messages without their content; on the background connection
   * (26.11; it was the main one, where lists and actions waited behind it). Never rejects.
   */
  async warm(userId: string, refs: MessageRef[]): Promise<void> {
    if (!this.cached) return;
    const { sync, maxBodyBytes } = this.cached;
    const byFolder = new Map<string, { ref: MessageRef; uids: number[] }>();
    for (const ref of refs) {
      const f = this.cachedFolder(userId, ref.accountId, ref.folder, ref.uidValidity);
      if (!f) continue;
      const wanted = this.fromCache(userId, ref.accountId, ref.folder, false, ({ cache }) => {
        const m = cache.message(f, ref.uid);
        return !!m && m.summary.size > 0 && m.summary.size <= maxBodyBytes && !cache.hasBody(f, ref.uid);
      });
      if (!wanted || sync.downloadingBody(userId, ref.accountId, ref.folder, ref.uid)) continue;
      const k = `${ref.accountId}\u0000${ref.folder}`;
      const group = byFolder.get(k) ?? { ref, uids: [] };
      group.uids.push(ref.uid);
      byFolder.set(k, group);
    }
    if (!byFolder.size || sync.budgetOf(userId, [...byFolder.values()][0]!.ref.accountId) <= 0) return;
    for (const { ref, uids } of byFolder.values()) await sync.fetchBodies(userId, ref.accountId, ref.folder, uids, 'sync');
  }

  async getMessage(
    userId: string,
    ref: MessageRef,
    opts: {
      /** true = load remote images, false = keep them blocked, undefined = per the sender-domain allowlist. */
      allowRemote: boolean | undefined;
      imageDomains?: readonly string[];
      /** Automatic loading for your own domains, people you wrote to, the sender's own images (DreyMail). */
      autoImages?: Omit<AutoImages, 'imageUrls'>;
      maxBytes: number;
      imageCache?: RemoteImageCache;
      fetchImage?: InlineOptions['fetchImage'];
      /** Filled with how long each step took, in ms (for the Server-Timing header). */
      timing?: Record<string, number>;
    },
  ): Promise<MessageDetail> {
    let t = performance.now();
    const step = (name: string) => {
      const now = performance.now();
      if (opts.timing) opts.timing[name] = Math.round(now - t);
      t = now;
    };
    const decoded = await this.decode(userId, ref, opts.maxBytes, opts.timing);
    const { email, smime } = decoded.opened;
    // Decoded a moment ago (opened again, or asked again for pictures still coming): only its flags
    // are fetched, not the whole message (DreyMail 14.1).
    const { flags, internalDate } = decoded.meta ?? (await this.currentMeta(userId, ref));
    t = performance.now();
    const urls = email.html ? collectRemoteImageUrls(email.html) : [];
    const decision = decideRemoteImages(email, opts.allowRemote, opts.imageDomains ?? [], opts.autoImages ? { ...opts.autoImages, imageUrls: urls } : undefined);
    // Remote images are fetched here and inlined as data: URIs; the browser never fetches them.
    let inlined = new Map<string, string | null>();
    if (decision.load && email.html) {
      inlined = await inlineRemoteImages(urls, {
        userId,
        cache: opts.imageCache,
        fetchImage: opts.fetchImage,
      });
      step('images');
    }
    const detail = buildMessageDetail(
      email,
      { ...ref, flags, internalDate },
      {
        allowRemote: decision.load,
        resolveRemote: (u) => inlined.get(u) ?? null,
        allowlist: {
          senderDomain: decision.senderDomain ? displayDomain(decision.senderDomain) : null,
          allowedBy: decision.allowedBy ? displayDomain(decision.allowedBy) : null,
          skipped: decision.skipped,
        },
      },
    );
    if (smime) detail.smime = smime;
    if (decision.load && email.html && imagesStillComing(urls.slice(0, 100), inlined)) detail.imagesPending = true;
    return detail;
  }

  async getParsed(userId: string, ref: MessageRef, maxBytes: number): Promise<ParsedEmail> {
    // Replies, forwards, invitations and attachments see the decrypted message too.
    return (await this.decode(userId, ref, maxBytes)).opened.email;
  }

  /**
   * A message decoded (and decrypted): from memory when it was opened in the last few minutes
   * (DreyMail 14.1), else fetched and decoded once, however many ask at the same time. `meta` (its
   * flags) comes along only when it was fetched just now.
   */
  private async decode(userId: string, ref: MessageRef, maxBytes: number, timing?: Record<string, number>): Promise<Decoded> {
    const key = `${userId}\u0000${ref.accountId}\u0000${ref.folder}\u0000${ref.uidValidity}\u0000${ref.uid}`;
    const known = this.opened.get(key);
    if (known) {
      if (timing) timing.memory = 0;
      return { opened: known, meta: null };
    }
    let job = this.decoding.get(key);
    if (!job) {
      job = (async () => {
        let t = performance.now();
        const fetched = await this.fetchRaw(userId, ref, maxBytes);
        const decrypted = this.smime?.open(userId, ref.accountId, fetched.raw) ?? null;
        if (timing) timing.fetch = Math.round(performance.now() - t);
        t = performance.now();
        const raw = decrypted?.raw ?? fetched.raw;
        const email = await (this.parser && raw.length > PARSE_IN_WORKER_BYTES ? this.parser(raw) : parseRaw(raw));
        if (timing) timing.parse = Math.round(performance.now() - t);
        const opened: OpenedMessage = { email, smime: decrypted?.info ?? null };
        this.opened.set(key, opened, Math.max(fetched.raw.length, decrypted?.raw.length ?? 0));
        return { opened, meta: { flags: fetched.flags, internalDate: fetched.internalDate } };
      })().finally(() => this.decoding.delete(key));
      this.decoding.set(key, job);
    }
    return job;
  }

  /** A message's flags and date: from the cache where it is cached, else a small request to the mail server. */
  private async currentMeta(userId: string, ref: MessageRef): Promise<{ flags: Set<string>; internalDate: Date | null }> {
    const f = this.cachedFolder(userId, ref.accountId, ref.folder, ref.uidValidity);
    const m = f ? this.fromCache(userId, ref.accountId, ref.folder, null, ({ cache }) => cache.message(f, ref.uid)) : null;
    if (m) return { flags: imapFlags(m.summary), internalDate: toDate(m.internalDate ?? undefined) };
    return this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      this.checkValidity(mailbox, ref);
      const meta = await client.fetchOne(String(ref.uid), { uid: true, flags: true, internalDate: true }, { uid: true });
      if (!meta) throw new MessageGoneError('Message not found');
      return { flags: meta.flags ?? new Set(), internalDate: toDate(meta.internalDate) };
    }, 'read');
  }

  async getAttachment(userId: string, ref: MessageRef, index: number, maxBytes: number) {
    const email = await this.getParsed(userId, ref, maxBytes);
    const att = email.attachments[index];
    if (!att) throw new MessageGoneError('Attachment not found');
    return {
      filename: att.filename || `attachment-${index + 1}`,
      mimeType: att.mimeType || 'application/octet-stream',
      content: attachmentBytes(att),
    };
  }

  // ---- actions ---------------------------------------------------------------

  /**
   * Find a special-use folder, creating one (inside the personal namespace) if the account has
   * none. Creating it is the least surprising fallback: "archive" and "snooze" keep working like
   * in other clients.
   */
  async ensureFolder(userId: string, accountId: string, use: 'archive' | 'snoozed' | 'junk'): Promise<{ path: string; created: boolean }> {
    const existing = await this.specialFolder(userId, accountId, use);
    if (existing) return { path: existing, created: false };
    const name = use === 'archive' ? 'Archive' : use === 'junk' ? 'Junk' : 'Snoozed';
    try {
      const res = await this.pool.withClient(userId, accountId, async (client) => {
        const created = await client.mailboxCreate([name]);
        await client.mailboxSubscribe(created.path).catch(() => undefined);
        return created;
      });
      await this.pool.folders(userId, accountId, true);
      this.foldersChanged(userId, accountId);
      return { path: res.path, created: true };
    } catch (err) {
      // Perhaps it was made meanwhile (elsewhere): the remembered folder list can be a minute old.
      await this.pool.folders(userId, accountId, true).catch(() => undefined);
      const now = await this.specialFolder(userId, accountId, use).catch(() => null);
      if (now) return { path: now, created: false };
      const e = err as { responseText?: string; message?: string };
      throw new MailServerError(`This account has no ${name} folder and one could not be created: ${e.responseText || e.message}`, 'protocol');
    }
  }

  /**
   * Put a message back into INBOX as if it had just arrived (the end of a snooze): it is appended
   * with the current time as its arrival date, so it sorts to the top, and removed from `ref`'s
   * folder. Flags are kept, except \Seen when `markUnread`. Messages too large to download are
   * moved instead (keeping their old date). `beforeAppend` runs first with the Message-ID, so the
   * new-mail watcher can tell this message from real new mail.
   *
   * Returns null if the message is no longer there.
   */
  async resurface(
    userId: string,
    ref: MessageRef,
    opts: { markUnread: boolean; maxBytes: number; beforeAppend?: (messageId: string | null) => void },
  ): Promise<{ uid: number | null; uidValidity: string | null; messageId: string | null; from: Address | null; subject: string } | null> {
    const moved = await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      if (mailbox.uidValidity.toString() !== ref.uidValidity) return null;
      const uid = String(ref.uid);
      const meta = await client.fetchOne(uid, { uid: true, flags: true, envelope: true, size: true }, { uid: true });
      if (!meta) return null;
      const messageId = meta.envelope?.messageId ?? null;
      const info = { messageId, from: addresses(meta.envelope?.from)[0] ?? null, subject: meta.envelope?.subject ?? '' };
      opts.beforeAppend?.(messageId);
      const drop = new Set(['\\Deleted', '\\Recent', ...(opts.markUnread ? ['\\Seen'] : [])]);
      const flags = [...(meta.flags ?? [])].filter((f) => !drop.has(f));
      if ((meta.size ?? 0) <= opts.maxBytes) {
        const full = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
        if (!full || !full.source) return null;
        const res = await client.append('INBOX', full.source, flags, new Date());
        if (!res) throw new MailServerError('Could not put the message back into the inbox', 'protocol');
        await client.messageDelete(uid, { uid: true });
        return { ...info, uid: res.uid ?? null, uidValidity: res.uidValidity?.toString() ?? null };
      }
      if (opts.markUnread) await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
      const res = await client.messageMove(uid, 'INBOX', { uid: true });
      return { ...info, uid: (res ? res.uidMap?.get(ref.uid) : undefined) ?? null, uidValidity: (res ? res.uidValidity?.toString() : undefined) ?? null };
    });
    if (moved) {
      this.updateCache(userId, ref.accountId, ref.folder, ref.uidValidity, (cache, f) => cache.removeMessages(f, [ref.uid]));
      this.folderChanged(userId, ref.accountId, 'INBOX');
    }
    if (!moved || (moved.uid && moved.uidValidity) || !moved.messageId) return moved;
    // No UIDPLUS: find the message in INBOX by Message-ID.
    const id = moved.messageId;
    return this.pool.withMailbox(userId, ref.accountId, 'INBOX', async (client, mailbox) => {
      const hits = (await client.search({ header: { 'message-id': id } }, { uid: true })) || [];
      return { ...moved, uid: hits.length ? Math.max(...hits) : null, uidValidity: mailbox.uidValidity.toString() };
    });
  }

  /**
   * Apply an action to messages that all live in the same account and folder. For moves (move,
   * archive, delete-to-Trash) the result describes where the messages went, so the client can
   * undo the action by moving them back.
   */
  /** Marks everything in a folder read (DreyMail 11.3): the unread messages, found on the server. */
  async markFolderRead(userId: string, accountId: string, folder: string): Promise<{ uids: number[]; uidValidity: string }> {
    const r = await this.pool.withMailbox(userId, accountId, folder, async (client: ImapFlow, mailbox) => {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []) as number[];
      if (uids.length) await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
      return { uids, uidValidity: mailbox.uidValidity.toString() };
    }, 'read');
    if (r.uids.length) this.updateCache(userId, accountId, folder, r.uidValidity, (cache, f) => cache.changeFlag(f, r.uids, 'seen', true));
    else this.foldersChanged(userId, accountId);
    return r;
  }

  async applyAction(
    userId: string,
    accountId: string,
    folder: string,
    uidValidity: string,
    uids: number[],
    action: MessageAction,
  ): Promise<{ undo: UndoInfo | null; permanent: boolean; createdFolder: string | null; senders?: string[] }> {
    const none = { undo: null, permanent: false, createdFolder: null };
    if (action.type === 'snooze' || action.type === 'unsnooze') throw new Error('Snoozing is handled by SnoozeService');
    if (uids.length === 0) return none;
    const range = uids.join(',');
    const ref = { accountId, folder, uid: 0, uidValidity };

    let destination: string | null = null;
    let expunge = false;
    let createdFolder: string | null = null;
    if (action.type === 'move') destination = action.destination;
    if (action.type === 'notJunk') destination = 'INBOX';
    if (action.type === 'junk') {
      const junk = await this.ensureFolder(userId, accountId, 'junk');
      destination = junk.path;
      if (junk.created) createdFolder = junk.path;
    }
    if (action.type === 'archive') {
      // Gmail has no Archive folder: archiving there is moving to All Mail (dropping the Inbox
      // label), never making an "Archive" label (DreyMail).
      const allMail = (await this.specialFolder(userId, accountId, 'archive')) ? null : await this.specialFolder(userId, accountId, 'all');
      if (allMail) destination = allMail;
      else {
        const archive = await this.ensureFolder(userId, accountId, 'archive');
        destination = archive.path;
        if (archive.created) createdFolder = archive.path;
      }
    }
    if (action.type === 'delete') {
      const trash = await this.specialFolder(userId, accountId, 'trash');
      // Only messages already in Trash are permanently removed; everything else moves to Trash.
      if (trash && trash !== folder) destination = trash;
      else if (trash === folder) expunge = true;
      else throw new MailServerError('This account has no Trash folder', 'protocol');
    }
    if (destination === folder) return none;

    const moved = await this.pool.withMailbox(userId, accountId, folder, async (client: ImapFlow, mailbox) => {
      this.checkValidity(mailbox, ref);
      switch (action.type) {
        case 'seen':
          await (action.value ? client.messageFlagsAdd(range, ['\\Seen'], { uid: true }) : client.messageFlagsRemove(range, ['\\Seen'], { uid: true }));
          return null;
        case 'flagged':
          await (action.value ? client.messageFlagsAdd(range, ['\\Flagged'], { uid: true }) : client.messageFlagsRemove(range, ['\\Flagged'], { uid: true }));
          return null;
        default: {
          if (expunge) {
            await client.messageDelete(range, { uid: true });
            return null;
          }
          if (!destination) return null;
          // Remember Message-IDs in case the server can't tell us the new UIDs (no UIDPLUS).
          const envelopes = await client.fetchAll(range, { uid: true, envelope: true }, { uid: true });
          const ids = envelopes.map((m) => m.envelope?.messageId).filter((id): id is string => !!id);
          const senders = [...new Set(envelopes.map((m) => m.envelope?.from?.[0]?.address?.toLowerCase()).filter((a): a is string => !!a))];
          if (action.type === 'notJunk') {
            // Tell the server's spam filter (RFC 5788 keywords, and Thunderbird's). Best effort:
            // not every server keeps keywords, and the move matters most (Gmail learns from it).
            await client.messageFlagsRemove(range, ['$Junk', 'Junk'], { uid: true }).catch(() => undefined);
            await client.messageFlagsAdd(range, ['$NotJunk', 'NonJunk'], { uid: true }).catch(() => undefined);
          }
          if (action.type === 'junk') {
            await client.messageFlagsRemove(range, ['$NotJunk', 'NonJunk'], { uid: true }).catch(() => undefined);
            await client.messageFlagsAdd(range, ['$Junk', 'Junk'], { uid: true }).catch(() => undefined);
          }
          const res = await client.messageMove(range, destination, { uid: true });
          return { res, ids, senders };
        }
      }
      // Your own action: on the connection for your requests, never queued behind a sync (DreyMail 14.5).
    }, 'read');

    if (action.type === 'seen' || action.type === 'flagged') {
      this.updateCache(userId, accountId, folder, uidValidity, (cache, f) => cache.changeFlag(f, uids, action.type as 'seen' | 'flagged', action.value));
    } else {
      this.updateCache(userId, accountId, folder, uidValidity, (cache, f) => cache.removeMessages(f, uids));
      if (destination) this.folderChanged(userId, accountId, destination);
    }
    if (expunge) return { ...none, permanent: true };
    if (!moved || !destination) return { ...none, createdFolder };
    const senders = action.type === 'notJunk' ? moved.senders : undefined;
    let newUids = moved.res && moved.res.uidMap ? [...moved.res.uidMap.values()] : [];
    let destValidity = moved.res && moved.res.uidValidity ? moved.res.uidValidity.toString() : null;
    if (!newUids.length || !destValidity) {
      // No UIDPLUS: locate the moved messages by Message-ID.
      const found = await this.pool.withMailbox(userId, accountId, destination, async (client, mailbox) => {
        const out: number[] = [];
        for (const id of moved.ids) {
          const hits = (await client.search({ header: { 'message-id': id } }, { uid: true })) || [];
          if (hits.length) out.push(Math.max(...hits));
        }
        return { uids: out, uidValidity: mailbox.uidValidity.toString() };
      });
      newUids = found.uids;
      destValidity = found.uidValidity;
    }
    const undo: UndoInfo | null = newUids.length
      ? { accountId, folder: destination, uidValidity: destValidity, uids: newUids, restoreTo: folder }
      : null;
    return { undo, permanent: false, createdFolder, ...(senders ? { senders } : {}) };
  }

  /** Mark the message a reply/forward refers to as \Answered (best effort). */
  async markAnswered(userId: string, ref: MessageRef) {
    try {
      await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
        if (mailbox.uidValidity.toString() !== ref.uidValidity) return;
        await client.messageFlagsAdd(String(ref.uid), ['\\Answered'], { uid: true });
      });
      this.updateCache(userId, ref.accountId, ref.folder, ref.uidValidity, (cache, f) => cache.changeFlag(f, [ref.uid], 'answered', true));
    } catch {
      /* not critical */
    }
  }

  /**
   * Gmail labels of a message (null when the server has no labels), with the labels it could have:
   * the account's folders, as Gmail shows labels as folders (DreyMail).
   */
  async labels(userId: string, ref: MessageRef): Promise<{ labels: string[]; available: string[] } | null> {
    const list = await this.pool.folders(userId, ref.accountId);
    if (!list.some((f) => f.specialUse === '\\All')) return null;
    const labels = await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      this.checkValidity(mailbox, ref);
      if (!client.capabilities.has('X-GM-EXT-1')) return null;
      const m = await client.fetchOne(String(ref.uid), { uid: true, labels: true }, { uid: true });
      if (!m) throw new MessageGoneError('Message not found');
      return [...(m.labels ?? [])];
    });
    if (!labels) return null;
    // System labels other than Inbox are folders of their own (Sent, Starred…) or not labels at all.
    const shown = labels.filter((l) => l === '\\Inbox' || !l.startsWith('\\')).map((l) => (l === '\\Inbox' ? 'INBOX' : l));
    const available = list.filter((f) => !f.specialUse && !f.flags.has('\\Noselect') && f.path !== 'INBOX').map((f) => f.path);
    return { labels: shown, available: ['INBOX', ...available] };
  }

  /** Adds and removes Gmail labels of a message (a label is a folder there). */
  async setLabels(userId: string, ref: MessageRef, add: string[], remove: string[]) {
    const label = (l: string) => (l === 'INBOX' ? '\\Inbox' : l);
    await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      this.checkValidity(mailbox, ref);
      if (!client.capabilities.has('X-GM-EXT-1')) throw new MailServerError('This mailbox has no labels', 'protocol');
      if (add.length) await client.messageFlagsAdd(String(ref.uid), add.map(label), { uid: true, useLabels: true });
      if (remove.length) await client.messageFlagsRemove(String(ref.uid), remove.map(label), { uid: true, useLabels: true });
    });
    for (const f of new Set([...add, ...remove, ref.folder])) this.folderChanged(userId, ref.accountId, f);
  }

  /** Sets an IMAP keyword on a message (e.g. $MDNSent), best effort: not every server keeps them. */
  async addKeyword(userId: string, ref: MessageRef, keyword: string) {
    await this.pool
      .withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
        this.checkValidity(mailbox, ref);
        await client.messageFlagsAdd(String(ref.uid), [keyword], { uid: true });
      })
      .catch(() => undefined);
  }

  /** Whether a message with this Message-ID is in the folder (DreyMail: a provider that filed sent mail itself). */
  async hasMessageId(userId: string, accountId: string, folder: string, messageId: string): Promise<boolean> {
    return this.pool.withMailbox(userId, accountId, folder, async (client) => {
      const found = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      return Array.isArray(found) && found.length > 0;
    });
  }

  async append(userId: string, accountId: string, folder: string, raw: Buffer, flags: string[]) {
    // On the main connection, which syncs the folder next: it sees the new message at once.
    const res = await this.pool.withClient(userId, accountId, (client) => client.append(folder, raw, flags));
    this.folderChanged(userId, accountId, folder);
    return res;
  }

  async deleteDraft(userId: string, ref: MessageRef) {
    await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      if (mailbox.uidValidity.toString() !== ref.uidValidity) return;
      await client.messageDelete(String(ref.uid), { uid: true });
    });
    this.updateCache(userId, ref.accountId, ref.folder, ref.uidValidity, (cache, f) => cache.removeMessages(f, [ref.uid]));
  }
}
