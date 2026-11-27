// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-17: every folder of a mailbox is cached, filled in the background on its own connection.
// Modified by samschultzponsys, 2026-11-17: listings of other folders always check with the server first, ahead of the filling.
// Modified by samschultzponsys, 2026-11-17: tells about new messages and filled folders (address suggestions).
// Modified by samschultzponsys, 2026-11-18: Gmail labels fetched with message lists.
// Modified by samschultzponsys, 2026-11-23: the search index filled in the background; space per mailbox from the user's share.
// Modified by samschultzponsys, 2026-11-23: messages for the index read in worker threads, in parallel; requests of people using DreyMail go first.
// Modified by samschultzponsys, 2026-11-24: whole messages kept while indexing (opening needs no mail server), newest kept longest; shorter wait before lists.
// Modified by samschultzponsys, 2026-11-24: new messages' content fetched as they arrive, in every folder.
// Modified by samschultzponsys, 2026-11-25: new messages listed before their content comes, in small newest-first batches an open joins; content kept by a warm-up.
// Modified by samschultzponsys, 2026-11-25: background reads in batches of bounded size (bigger messages kept); only the start of messages too big to keep is read for the index.
// Modified by samschultzponsys, 2026-11-25: unread mail loaded ahead a few messages per command (was one round trip each), batches capped by size.
// Modified by samschultzponsys, 2026-11-25: listings checked in the background (checkSoon); a folder opened before it was cached says when its copy is ready.
// Modified by samschultzponsys, 2026-11-25: background downloading paced per mailbox; checks nobody waits for on the background connection.
// Modified by samschultzponsys, 2026-11-25: a refused search never empties the copy; a copy missing messages is filled again.
// Modified by samschultzponsys, 2026-11-27: loading unread mail ahead and older messages on the background connection, never the main one.
// Modified by samschultzponsys, 2026-11-27: without CONDSTORE, a check reads the newest messages' flags and skips the deletion search when nothing was deleted; the whole folder every few minutes.

import type { FetchMessageObject, ImapFlow, MailboxObject } from 'imapflow';
import type { MessageSummary } from '../../../shared/types.js';
import type { CacheConfig } from '../config.js';
import type { ImapPool, Lane } from '../imap/pool.js';
import { fetchSnippets, listFetch, searchOrThrow, sortTime, summaryOf, toDate } from '../imap/summary.js';
import { MAX_BODY_TERMS, termsOf } from './searchTerms.js';
import { CacheCorruptError, flagsOf, type CachedFolder, type CachedRole, type MailCache, type MessageEntry } from './store.js';

/** Messages fetched per IMAP command while filling a folder, so other requests get their turn in between. */
export const FILL_CHUNK = 200;
/**
 * Without CONDSTORE (Microsoft 365, many others) a check can't ask only for what changed: it reads
 * the flags of the newest FLAG_WINDOW cached messages, and those of the whole cached range (and the
 * full list of UIDs, for deletions) at most every FULL_CHECK_MS (DreyMail 26.11). Reading all of a
 * big inbox on every check took seconds, and lists and actions waited behind it.
 */
export const FLAG_WINDOW = 500;
export const FULL_CHECK_MS = 5 * 60_000;
/** Unread messages (among the newest) whose content is loaded ahead after a sync of INBOX. */
const PREFETCH_COUNT = 25;
const PREFETCH_AMONG = 200;
/** Newest arrivals whose content comes along with them in a sync (13.8). */
const FRESH_CONTENT = 30;
/** Messages the copy may lack against the server (arrived meanwhile) before it counts as damaged (14.6). */
const MISSING_TOLERANCE = 5;
/** Arrivals whose content is fetched per IMAP command, newest first (14.0), so the newest is ready soonest. */
const FRESH_BATCH = 5;
/** How long a listing waits for a sync before it answers from the (possibly older) cache. */
// DreyMail 13.6: 400 ms (was 1.5 s); what a slower check finds reaches the list by itself.
export const LISTING_WAIT_MS = 400;
const DEBOUNCE_MS = 300;
/** Other folders synced longer ago than this are brought up to date again when a session opens (DreyMail). */
export const WARM_MAX_AGE_MS = 10 * 60_000;
/** At most this many other folders per mailbox are cached (the special ones first). */
export const WARM_MAX_FOLDERS = 100;
/** Messages read per round when filling the search index, and how much of each (DreyMail 12.3). */
const INDEX_BATCH = 80;
export const INDEX_BYTES = 96 * 1024;
/** Most bytes one background IMAP command fetches (one larger message goes alone), so memory stays bounded (DreyMail 14.1). */
const FETCH_BYTES = 32 * 1024 * 1024;
/** What the index reads of a message too big to keep: its words are near the start. */
const INDEX_READ = INDEX_BYTES * 3;

/** A group of messages fetched with one IMAP command: whole (`length` null), or only their start. */
interface FetchGroup {
  folder: CachedFolder;
  uids: number[];
  length: number | null;
}
/** SQLite result codes for a damaged database file: SQLITE_IOERR, SQLITE_CORRUPT, SQLITE_NOTADB. */
const DAMAGED = new Set([10, 11, 26]);

interface Job {
  running: Promise<void> | null;
  /** Waiting for the next time the folder is brought up to date. */
  waiters: (() => void)[];
  /** Run once more when done (something happened meanwhile). */
  again: boolean;
  /** Someone waits for the next run: it goes on the main connection, ahead of background filling (DreyMail). */
  urgent?: boolean;
  timer: NodeJS.Timeout | null;
  /** The run under way started because something changed in the folder (DreyMail 14.3). */
  forChange?: boolean;
  /** Nobody waits for the next run: it goes on the background connection (DreyMail 14.5). */
  background?: boolean;
}

export interface CacheSyncDeps {
  cache: MailCache;
  pool: ImapPool;
  config: CacheConfig;
  /** The account's Sent folder, or null if it has none. */
  sentFolder: (userId: string, accountId: string) => Promise<string | null>;
  /** Every folder that can hold messages, most important first (DreyMail). Throws if the list can't be had. */
  cacheableFolders?: (userId: string, accountId: string) => Promise<string[]>;
  /** Whether the account's INBOX is being watched (IDLE) right now, so any change is reported. */
  isWatched: (userId: string, accountId: string) => boolean;
  /** New messages arrived in a cached folder (not those of a first fill or of filling older mail) (DreyMail). */
  onNewMessages?: (userId: string, accountId: string, folder: string, role: CachedRole, messages: MessageSummary[]) => void;
  /** A folder's copy holds all it will hold (everything, or as many as configured) (DreyMail). */
  onFilled?: (userId: string, accountId: string, folder: string, role: CachedRole, f: CachedFolder) => void;
  /** The cached copy of a folder changed (new, removed or re-flagged messages). */
  onChanged: (userId: string, accountId: string, folder: string) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Space (bytes) the account's cached mail may take: summaries, content and index (DreyMail 12.3). Default: bodyBytesPerAccount. */
  budget?: (userId: string, accountId: string) => number;
  /** Someone is using DreyMail right now: the search index waits (DreyMail 12.10). */
  busy?: () => boolean;
  /** Plain text of a message (for the search index); null when it can't be read. */
  textOf?: (raw: Buffer) => Promise<string | null>;
  /** A message's words, read in a worker thread (DreyMail 12.10); preferred over textOf. */
  termsOf?: (raw: Buffer) => Promise<string[] | null>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });

/**
 * Keeps the mail cache in step with the IMAP server, one folder at a time:
 *
 * - The first sync fetches the newest messages (with snippets) in chunks, newest first, until the
 *   folder holds `messagesPerFolder` messages or everything the server has.
 * - Later syncs fetch messages above the highest UID known, flag changes (only those since the last
 *   sync where the server supports CONDSTORE, otherwise all flags of the cached range) and the
 *   UIDs still on the server, so messages deleted or moved elsewhere disappear.
 * - A new UIDVALIDITY empties the folder and it is filled again.
 * - After a sync of INBOX, the newest unread messages' content is loaded ahead.
 * - Every other folder (DreyMail) gets a smaller copy (`messagesPerOtherFolder`), filled one
 *   folder at a time when a mailbox is added or a session opens (warmAccount), on a connection of
 *   its own so it never holds up what the user is doing.
 *
 * Syncs run on the account's pooled command connection, chunk by chunk, so user requests are not
 * stuck behind a long first fill. Only one sync per folder runs at a time; a request while one
 * runs makes it run once more afterwards.
 *
 * A watched INBOX (see ImapPool) reports every change, so once synced after the last change it is
 * known to be current. Anything else can have changed unnoticed, so a listing first gives a sync a
 * moment (LISTING_WAIT_MS); a slow server gets the cached copy, and the browser is told when the
 * sync finds something.
 */
export class CacheSync {
  private readonly jobs = new Map<string, Job>();
  /** Folders with activity that no sync has started on yet. */
  private readonly dirty = new Set<string>();
  /** Accounts whose other folders are being filled (warmAccount), and whether to go round again. */
  private readonly warming = new Map<string, { again: boolean }>();
  /** Per mailbox: when background downloading may go on (DreyMail 14.5, see pace). */
  private readonly pacedUntil = new Map<string, number>();
  /** Folders opened before they were cached: their first fill tells the browser (DreyMail 14.3). */
  private readonly opened = new Set<string>();
  /** Accounts whose search index is being filled, and whether to go round again (DreyMail 12.3). */
  private readonly indexing = new Map<string, { again: boolean }>();
  /** Content being downloaded right now, per folder key + UID: opening the message waits for it instead of fetching it twice. */
  private readonly downloading = new Map<string, Promise<Buffer | null>>();
  /** Per folder: when its whole cached range was last checked (flags and deletions) without CONDSTORE (26.11). */
  private readonly fullCheckAt = new Map<string, number>();
  /** The first full check of a folder comes FULL_CHECK_MS after starting, never with the first lists. */
  private readonly startedAt = Date.now();
  private stopped = false;

  constructor(private readonly deps: CacheSyncDeps) {}

  private get cache() {
    return this.deps.cache;
  }

  private key(userId: string, accountId: string, path: string) {
    return `${userId}\u0000${accountId}\u0000${path}`;
  }

  /** Whether folders other than INBOX and Sent are cached. */
  get cachesOtherFolders(): boolean {
    return this.deps.config.messagesPerOtherFolder > 0 && !!this.deps.cacheableFolders;
  }

  /** How many of the newest messages a folder in this role keeps. */
  private limit(role: CachedRole): number {
    return role === 'folder' ? this.deps.config.messagesPerOtherFolder : this.deps.config.messagesPerFolder;
  }

  /** Other folders are filled on their own connection, so the user's requests never queue behind them. */
  private lane(role: CachedRole): Lane {
    return role === 'folder' ? 'sync' : 'main';
  }

  /** The cached copy of a folder, if it has been filled at least once. */
  ready(userId: string, accountId: string, path: string): CachedFolder | null {
    const f = this.cache.folder(userId, accountId, path);
    return f && f.syncedAt > 0 ? f : null;
  }

  /**
   * True if the cached copy is known to match the server: INBOX, watched, and brought up to date
   * after the last thing that happened in it.
   */
  isCurrent(userId: string, accountId: string, path: string): boolean {
    const k = this.key(userId, accountId, path);
    const job = this.jobs.get(k);
    return path === 'INBOX' && !!this.ready(userId, accountId, path) && this.deps.isWatched(userId, accountId) && !this.dirty.has(k) && !job?.running && !job?.timer;
  }

  /**
   * Before a listing reads these cached folders: sync those that aren't current (all with `force`)
   * and wait for that, up to `maxWaitMs` (the sync carries on in the background after that).
   */
  async beforeListing(userId: string, accountId: string, paths: string[], opts: { force?: boolean; maxWaitMs?: number } = {}) {
    const waits: Promise<void>[] = [];
    for (const path of paths) {
      const role = this.roleOf(userId, accountId, path);
      if (!role || (!opts.force && this.isCurrent(userId, accountId, path))) continue;
      // Someone is waiting: on the main connection, not behind the background filling (DreyMail).
      waits.push(this.sync(userId, accountId, path, role, true));
    }
    if (waits.length) await Promise.race([Promise.all(waits), sleep(opts.maxWaitMs ?? LISTING_WAIT_MS)]);
  }

  /**
   * A listing or search was answered from the copy (DreyMail 14.3): check with the mail server
   * now, unless the copy was synced in the last `maxAgeMs` or a sync is already under way. On the
   * background connection (14.5: a search of ten folders queued ten checks on the main one, and
   * everything else waited seconds). What the check finds reaches the list by itself.
   */
  checkSoon(userId: string, accountId: string, path: string, maxAgeMs: number) {
    const f = this.cache.folder(userId, accountId, path);
    const job = this.jobs.get(this.key(userId, accountId, path));
    if (!f || job?.running || Date.now() - f.syncedAt < maxAgeMs) return;
    void this.sync(userId, accountId, path, f.role, false, true);
  }

  /**
   * Something is known to have changed in the folder (DreyMail moved or sent mail there, or the
   * watcher saw activity) that the copy doesn't have yet: a listing waits for it (DreyMail 14.3).
   */
  hasPendingChange(userId: string, accountId: string, path: string): boolean {
    const k = this.key(userId, accountId, path);
    const job = this.jobs.get(k);
    return this.dirty.has(k) || !!job?.timer || !!job?.forChange;
  }

  /**
   * An account was removed: nothing more is synced for it, and what a sync still under way writes
   * is dropped once it ends (DreyMail 14.3).
   */
  forgetAccount(userId: string, accountId: string, drop: () => void) {
    const prefix = `${userId}\u0000${accountId}\u0000`;
    const running: Promise<void>[] = [];
    for (const [k, job] of this.jobs) {
      if (!k.startsWith(prefix)) continue;
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
      this.dirty.delete(k);
      this.opened.delete(k);
      if (job.running) running.push(job.running);
    }
    drop();
    if (running.length) void Promise.all(running).then(drop, drop);
  }

  /**
   * The copy holds about as many messages as the server last said the folder has (up to what is
   * kept): a copy missing many (damaged before 14.6) isn't trusted for listing until it is filled
   * again (DreyMail 14.6).
   */
  isIntact(f: CachedFolder): boolean {
    return this.cache.count(f) + MISSING_TOLERANCE >= Math.min(f.exists, this.limit(f.role));
  }

  /** A folder's first fill is under way (it was opened, or is being cached): its copy is coming. */
  isFilling(userId: string, accountId: string, path: string): boolean {
    const job = this.jobs.get(this.key(userId, accountId, path));
    return !this.ready(userId, accountId, path) && !!(job?.running || job?.timer);
  }

  /** Sync in the background if the last sync is older than `maxAgeMs` and none is running or due. */
  refreshIfOlder(userId: string, accountId: string, path: string, maxAgeMs: number) {
    const f = this.cache.folder(userId, accountId, path);
    const job = this.jobs.get(this.key(userId, accountId, path));
    if (!f || job?.running || job?.timer || Date.now() - f.syncedAt < maxAgeMs) return;
    this.syncSoon(userId, accountId, path, f.role, 0);
  }

  /** Sync INBOX and the Sent folder of an account in the background, then fill the other folders. */
  syncAccount(userId: string, accountId: string) {
    this.syncSoon(userId, accountId, 'INBOX', 'inbox', 0);
    void this.deps
      .sentFolder(userId, accountId)
      .then((sent) => {
        if (sent && sent !== 'INBOX') this.syncSoon(userId, accountId, sent, 'sent', 0);
        else if (!sent) this.forget(userId, accountId, 'sent');
        this.warmAccount(userId, accountId, sent);
      })
      .catch(() => undefined);
  }

  /** Start caching an other folder now (it was just opened and isn't cached yet). */
  startFolder(userId: string, accountId: string, path: string) {
    if (!this.cachesOtherFolders || path === 'INBOX' || this.cache.folder(userId, accountId, path)) return;
    this.opened.add(this.key(userId, accountId, path));
    this.syncSoon(userId, accountId, path, 'folder', 0);
  }

  /**
   * Fill (or bring up to date) the copy of every other folder of an account, one folder at a time
   * in the background: those never cached first, then those not synced for a while. Folders no
   * longer on the server are dropped. Never rejects.
   */
  warmAccount(userId: string, accountId: string, sent: string | null) {
    if (!this.cachesOtherFolders || this.stopped) return;
    const k = `${userId}\u0000${accountId}`;
    const running = this.warming.get(k);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    this.warming.set(k, state);
    void (async () => {
      do {
        state.again = false;
        let paths: string[];
        try {
          paths = await this.deps.cacheableFolders!(userId, accountId);
        } catch {
          return;
        }
        const wanted = paths.filter((p) => p !== 'INBOX' && p !== sent).slice(0, WARM_MAX_FOLDERS);
        const keep = new Set(wanted);
        try {
          for (const f of this.cache.folders(userId, accountId, 'folder')) if (!keep.has(f.path)) this.cache.dropFolder(userId, accountId, f.path);
        } catch (err) {
          this.handleError(err, userId, accountId, 'INBOX');
        }
        const syncedAt = (p: string) => this.cache.folder(userId, accountId, p)?.syncedAt ?? 0;
        const due = wanted.filter((p) => Date.now() - syncedAt(p) >= WARM_MAX_AGE_MS).sort((a, b) => (syncedAt(a) === 0 ? 0 : 1) - (syncedAt(b) === 0 ? 0 : 1));
        for (const path of due) {
          if (this.stopped) return;
          const role = this.roleOf(userId, accountId, path) ?? 'folder';
          if (role !== 'folder') continue;
          await this.sync(userId, accountId, path, role);
          // Let the rest of the folder (older messages) come in before moving on.
          await this.jobs.get(this.key(userId, accountId, path))?.running;
        }
      } while (state.again && !this.stopped);
    })()
      .catch((err: unknown) => this.deps.log?.('mail cache warm-up failed', { accountId, error: (err as Error).message }))
      .finally(() => this.warming.delete(k));
  }

  private forget(userId: string, accountId: string, role: CachedRole) {
    const f = this.cache.folderByRole(userId, accountId, role);
    if (f) this.cache.dropFolder(userId, accountId, f.path);
  }

  /** The role a folder is cached in, if it is one of the cached folders. */
  roleOf(userId: string, accountId: string, path: string): CachedRole | null {
    if (path === 'INBOX') return 'inbox';
    return this.cache.folder(userId, accountId, path)?.role ?? null;
  }

  /** Something happened in a cached folder: sync it shortly (several events in a row become one sync). */
  syncSoon(userId: string, accountId: string, path: string, role: CachedRole | null = this.roleOf(userId, accountId, path), delayMs = DEBOUNCE_MS) {
    if (!role || this.stopped) return;
    this.dirty.add(this.key(userId, accountId, path));
    const job = this.job(userId, accountId, path);
    if (job.timer) return;
    job.timer = setTimeout(() => {
      job.timer = null;
      void this.sync(userId, accountId, path, role);
    }, delayMs);
    job.timer.unref();
  }

  private job(userId: string, accountId: string, path: string): Job {
    const k = this.key(userId, accountId, path);
    let job = this.jobs.get(k);
    if (!job) this.jobs.set(k, (job = { running: null, waiters: [], again: false, timer: null }));
    return job;
  }

  /**
   * Sync one folder now. Resolves once the folder has been brought up to date by a sync that
   * started after this call (loading older messages and message content may continue in the
   * background); never rejects.
   */
  sync(userId: string, accountId: string, path: string, role: CachedRole, urgent = false, background = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const k = this.key(userId, accountId, path);
    const job = this.job(userId, accountId, path);
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    const done = new Promise<void>((resolve) => job.waiters.push(resolve));
    if (urgent) job.urgent = true;
    // A check nobody waits for (DreyMail 14.5): on the background connection, never holding up the main one.
    if (background && !job.running) job.background = true;
    if (job.running) {
      job.again = true;
      return done;
    }
    const run = async () => {
      while (!this.stopped) {
        job.again = false;
        const waiting = job.waiters.splice(0);
        job.forChange = this.dirty.delete(k);
        const lane: Lane = job.urgent ? 'main' : job.background ? 'sync' : this.lane(role);
        job.urgent = false;
        job.background = false;
        try {
          const changed = await this.update(userId, accountId, path, role, lane).finally(() => (job.forChange = false));
          // The copy of a folder someone has open is ready: the list can now come from it, whole
          // conversations included (DreyMail 14.3).
          const firstFill = this.opened.has(k) && !!this.ready(userId, accountId, path);
          if (firstFill) this.opened.delete(k);
          if (changed || firstFill) this.deps.onChanged(userId, accountId, path);
        } catch (err) {
          this.handleError(err, userId, accountId, path);
        }
        for (const resolve of waiting) resolve();
        // Extras, interrupted by anyone waiting for the next sync; they continue after it.
        const interrupted = () => this.stopped || job.again || job.waiters.length > 0;
        try {
          if (role === 'inbox') await this.prefetch(userId, accountId, path, interrupted);
          await this.fill(userId, accountId, path, interrupted);
          // Without CONDSTORE, the whole cached range is checked every few minutes, in the
          // background (DreyMail 26.11): flags of older messages, and deletions the count missed.
          if (!interrupted() && this.ready(userId, accountId, path) && this.fullCheckDue(userId, accountId, path)) {
            if (await this.update(userId, accountId, path, role, 'sync', true)) this.deps.onChanged(userId, accountId, path);
          }
          this.indexAccount(userId, accountId);
          const f = this.cache.folder(userId, accountId, path);
          if (f && f.syncedAt > 0 && (f.complete || this.cache.count(f) >= this.limit(f.role))) {
            try {
              this.deps.onFilled?.(userId, accountId, path, f.role, f);
            } catch {
              /* a listener's problem is its own (and never the cache's) */
            }
          }
        } catch (err) {
          this.handleError(err, userId, accountId, path);
        }
        if (!job.again && job.waiters.length === 0) break;
      }
    };
    job.running = run().finally(() => {
      job.running = null;
      for (const resolve of job.waiters.splice(0)) resolve();
      if (!job.timer) this.jobs.delete(k);
    });
    return done;
  }

  /** Resolves once no sync is running or scheduled (tests). */
  async idle() {
    for (;;) {
      const busy = [...this.jobs.values()].filter((j) => j.running || j.timer);
      if (busy.length === 0) return;
      await Promise.all(busy.map((j) => j.running ?? sleep(DEBOUNCE_MS + 10)));
    }
  }

  /** Wait for running syncs and stop scheduling new ones. */
  async stop() {
    this.stopped = true;
    for (const job of this.jobs.values()) if (job.timer) clearTimeout(job.timer);
    await Promise.all([...this.jobs.values()].map((j) => j.running));
  }

  /** Cache trouble empties the cache (or the folder); IMAP trouble just ends this sync. */
  handleError(err: unknown, userId: string, accountId: string, path: string) {
    if (err instanceof CacheCorruptError) {
      this.deps.log?.('mail cache folder unreadable, refilling', { accountId, error: err.message });
      this.cache.dropFolder(userId, accountId, path);
      return;
    }
    const e = err as { code?: string; errcode?: number; message?: string };
    if (e.code === 'ERR_SQLITE_ERROR') {
      this.deps.log?.('mail cache database error', { accountId, error: e.message });
      try {
        // A damaged file (or a disk problem) empties the whole cache; anything else just the folder.
        if (DAMAGED.has((e.errcode ?? 0) & 0xff)) this.cache.reset();
        else this.cache.dropFolder(userId, accountId, path);
      } catch {
        /* nothing more to do */
      }
      return;
    }
    this.deps.log?.('mail cache sync failed', { accountId, error: (err as Error).message });
  }

  private async entries(client: ImapFlow, source: { accountId: string; folder: string }, uidValidity: string, msgs: FetchMessageObject[]): Promise<MessageEntry[]> {
    const snippets = msgs.length ? await fetchSnippets(client, msgs).catch(() => new Map<number, string>()) : new Map<number, string>();
    return msgs.map((m) => ({
      summary: summaryOf(source, uidValidity, m, snippets.get(m.uid) ?? ''),
      sortTime: sortTime(m),
      internalDate: toDate(m.internalDate)?.toISOString() ?? null,
    }));
  }

  /**
   * Bring the folder up to date (or start it: the newest chunk). Returns whether a listing would
   * look different now.
   */
  /** Without CONDSTORE: whether the folder's whole cached range is due for a check (see FULL_CHECK_MS). */
  private fullCheckDue(userId: string, accountId: string, path: string): boolean {
    return Date.now() - (this.fullCheckAt.get(this.key(userId, accountId, path)) ?? this.startedAt) >= (this.deps.config.fullCheckMs ?? FULL_CHECK_MS);
  }

  private async update(userId: string, accountId: string, path: string, role: CachedRole, lane: Lane = this.lane(role), deep = false): Promise<boolean> {
    const { cache, pool } = this.deps;
    const limit = this.limit(role);
    return pool.withMailbox(userId, accountId, path, async (client, selected) => {
      // Not every server reports new mail in a selected folder by itself.
      await client.noop();
      const mailbox = (client.mailbox || selected) as MailboxObject;
      const uidValidity = mailbox.uidValidity.toString();
      const source = { accountId, folder: path };
      let f = cache.folder(userId, accountId, path);
      let changed = false;
      if (!f || f.uidValidity !== uidValidity || f.role !== role) {
        changed = !!f && f.syncedAt > 0;
        f = cache.resetFolder(userId, accountId, path, role, uidValidity);
      }
      const condstore = client.enabled.has('CONDSTORE') && !mailbox.noModseq;
      let modseq = condstore && mailbox.highestModseq !== undefined ? mailbox.highestModseq : null;
      const now = Date.now();

      if (mailbox.exists === 0) {
        changed = cache.removeMessages(f, cache.uids(f)) > 0 || changed;
        cache.updateFolder(f, { uidNext: Number(mailbox.uidNext) || f.uidNext, lowUid: 1, complete: true, exists: 0, modseq: modseq?.toString() ?? null, syncedAt: now });
        return changed;
      }

      if (f.syncedAt === 0) {
        // First fill: the newest chunk, by sequence number (contiguous, so it covers every UID from its lowest up).
        const start = Math.max(1, mailbox.exists - Math.min(FILL_CHUNK, limit) + 1);
        const msgs = await client.fetchAll(`${start}:${mailbox.exists}`, listFetch(client));
        cache.putMessages(f, await this.entries(client, source, uidValidity, msgs));
        const uids = msgs.map((m) => m.uid);
        cache.updateFolder(f, {
          lowUid: uids.length ? Math.min(...uids) : 1,
          uidNext: Math.max(Number(mailbox.uidNext) || 0, ...uids.map((u) => u + 1), 1),
          complete: start === 1,
          exists: mailbox.exists,
          modseq: modseq?.toString() ?? null,
          syncedAt: now,
        });
        return changed;
      }

      // New messages. "n:*" always matches the newest message, even if its UID is below n.
      const fresh = (await client.fetchAll(`${f.uidNext}:*`, listFetch(client), { uid: true })).filter((m) => m.uid >= f!.uidNext);
      if (fresh.length) {
        const entries = await this.entries(client, source, uidValidity, fresh);
        cache.putMessages(f, entries);
        changed = true;
        try {
          this.deps.onNewMessages?.(userId, accountId, path, role, entries.map((e) => e.summary));
        } catch {
          /* a listener's problem is its own */
        }
      }
      // New mail is opened soonest, so its content is fetched at once (DreyMail 13.8), in any folder
      // (Sent Items too, for the reply you just sent): since 14.2 on the connection for reading,
      // alongside the rest of this sync, newest first, a few at a time; opening one joins its download.
      const { maxBodyBytes } = this.deps.config;
      if (fresh.length && maxBodyBytes > 0 && this.budgetOf(userId, accountId) > 0) {
        const small = fresh.filter((m) => (m.size ?? 0) > 0 && (m.size ?? 0) <= maxBodyBytes).map((m) => m.uid).sort((a, b) => b - a).slice(0, FRESH_CONTENT);
        // Measured (scripts/bench/open.mjs): starting it after the sync instead lists a burst of new
        // mail a little sooner but sometimes opens it seconds later; starting it now never does.
        if (small.length) void this.fetchBodies(userId, accountId, path, small, 'read');
      }
      const uidNext = Math.max(f.uidNext, ...fresh.map((m) => m.uid + 1));

      // Flag changes in the cached range: only what changed since the last sync if the server can tell;
      // else the newest messages' flags, and every cached message's now and then (DreyMail 26.11).
      const since = condstore && f.modseq ? BigInt(f.modseq) : undefined;
      const k = this.key(userId, accountId, path);
      // The whole range: with CONDSTORE (only what changed comes), or a deep check (in the background).
      const full = condstore || deep;
      let from = f.lowUid;
      if (!full) {
        const cached = cache.uids(f);
        if (cached.length > FLAG_WINDOW) from = Math.max(f.lowUid, cached[cached.length - FLAG_WINDOW]!);
      }
      const flagged = await client.fetchAll(`${from}:*`, { uid: true, flags: true }, { uid: true, changedSince: since });
      const updates = flagged.filter((m) => m.uid >= f!.lowUid && m.uid < f!.uidNext).map((m) => ({ uid: m.uid, flags: flagsOf(m.flags) }));
      if (cache.setFlags(f, updates) > 0) changed = true;
      for (const m of flagged) if (m.modseq !== undefined && (modseq === null || m.modseq > modseq)) modseq = m.modseq;

      // Messages that are gone (deleted, or moved by another client). The number of messages only
      // drops when some are deleted: if it grew by exactly the new ones, none were, and the list of
      // every UID needn't be asked for (DreyMail 26.11; it was, on every check). Asked for anyway
      // every few minutes. A refused search is an error, never "none left" (DreyMail 14.6: that
      // emptied the cached inbox); nor is an empty answer for a folder the server says holds messages.
      // A copy short of messages (see isIntact) is checked whole at once, to be filled again.
      if (!full && f.exists > 0 && mailbox.exists === f.exists + fresh.length && this.isIntact(f)) {
        cache.updateFolder(f, { uidNext, exists: mailbox.exists, modseq: null, syncedAt: now });
        cache.trim(f, limit);
        return changed;
      }
      this.fullCheckAt.set(k, now);
      const present = new Set(await searchOrThrow(client, { uid: `${f.lowUid}:*` }, { uid: true }));
      if (present.size === 0 && mailbox.exists > 0) throw new Error(`The mail server listed no messages in ${path}, which holds ${mailbox.exists}; trying again later`);
      const gone = cache.uids(f).filter((u) => !present.has(u));
      if (gone.length && cache.removeMessages(f, gone) > 0) changed = true;
      // The copy must hold every message the server has from its oldest one up. If it doesn't (a
      // copy damaged before 14.6), it is filled again from scratch (DreyMail 14.6).
      if (cache.count(f) + MISSING_TOLERANCE < present.size) {
        this.deps.log?.('mail cache folder incomplete, filling it again', { accountId, cached: cache.count(f), onServer: present.size });
        cache.resetFolder(userId, accountId, path, role, uidValidity);
        this.syncSoon(userId, accountId, path, role, 0);
        return true;
      }

      cache.updateFolder(f, {
        uidNext,
        exists: mailbox.exists,
        modseq: !condstore || modseq === null ? null : (f.modseq && BigInt(f.modseq) > modseq ? f.modseq : modseq.toString()),
        syncedAt: now,
      });
      cache.trim(f, limit);
      return changed;
    }, lane);
  }

  /**
   * The content of a message being downloaded right now (new mail, or a warm-up), if it is: opening
   * it waits for that download instead of starting a second one (DreyMail 14.0). Null when it
   * couldn't be fetched after all.
   */
  downloadingBody(userId: string, accountId: string, path: string, uid: number): Promise<Buffer | null> | null {
    return this.downloading.get(`${this.key(userId, accountId, path)}\u0000${uid}`) ?? null;
  }

  /**
   * Fetch and keep the content of these cached messages that don't have it yet (on `lane`), a few
   * per IMAP command so each batch is ready soon, and so an open waits at most for its own batch.
   * Never rejects.
   */
  async fetchBodies(userId: string, accountId: string, path: string, uids: number[], lane: Lane, interrupted: () => boolean = () => false) {
    const max = this.deps.config.maxBodyBytes;
    const k = this.key(userId, accountId, path);
    const first = this.cache.folder(userId, accountId, path);
    if (!first) return;
    // Every message is claimed at once (DreyMail 14.2), not batch by batch: an open waits for this
    // download, and loading ahead (prefetch) or a warm-up never fetches the same message meanwhile.
    const waiting = new Map<number, { resolve: (raw: Buffer | null) => void; promise: Promise<Buffer | null> }>();
    for (const uid of uids) {
      if (waiting.has(uid) || this.downloading.has(`${k}\u0000${uid}`) || this.cache.hasBody(first, uid)) continue;
      let resolve!: (raw: Buffer | null) => void;
      const promise = new Promise<Buffer | null>((r) => (resolve = r));
      waiting.set(uid, { resolve, promise });
      this.downloading.set(`${k}\u0000${uid}`, promise);
    }
    const release = (uid: number, raw: Buffer | null) => {
      const w = waiting.get(uid);
      if (!w) return;
      waiting.delete(uid);
      w.resolve(raw);
      if (this.downloading.get(`${k}\u0000${uid}`) === w.promise) this.downloading.delete(`${k}\u0000${uid}`);
    };
    // At most FRESH_BATCH messages and FETCH_BYTES per command (a larger message alone), in the order given.
    const sizes = this.cache.sizesOf(first, [...waiting.keys()]);
    const batches: number[][] = [];
    let bytes = 0;
    for (const uid of waiting.keys()) {
      const size = sizes.get(uid) ?? 0;
      const last = batches.at(-1);
      if (last && last.length < FRESH_BATCH && bytes + size <= FETCH_BYTES) last.push(uid);
      else {
        batches.push([uid]);
        bytes = 0;
      }
      bytes += size;
    }
    try {
      for (const batch of batches) {
        if (this.stopped || interrupted()) break;
        const f = this.cache.folder(userId, accountId, path);
        if (!f) break;
        try {
          await this.deps.pool.withMailbox(
            userId,
            accountId,
            path,
            async (client, selected) => {
              const mailbox = (client.mailbox || selected) as MailboxObject;
              if (mailbox.uidValidity.toString() !== f.uidValidity) return;
              // `source` is fetched with BODY.PEEK, so this never marks anything read.
              for await (const m of client.fetch(batch.join(','), { uid: true, source: true }, { uid: true })) {
                if (!m.source || m.source.length > max) continue;
                try {
                  this.cache.putBody(f, m.uid, m.source);
                } catch {
                  /* still handed to whoever is waiting */
                }
                release(m.uid, m.source);
              }
            },
            lane,
          );
        } catch {
          /* fetched when opened, as before */
        }
        for (const uid of batch) release(uid, null);
      }
    } finally {
      // Not fetched after all (stopped, interrupted, the folder gone): whoever waits fetches it themselves.
      for (const uid of [...waiting.keys()]) release(uid, null);
    }
    try {
      this.enforceBudget(userId, accountId);
    } catch (err) {
      this.handleError(err, userId, accountId, path);
    }
  }

  /** Extend the folder towards older messages, a chunk at a time, up to the configured size. */
  private async fill(userId: string, accountId: string, path: string, interrupted: () => boolean) {
    const { cache, pool } = this.deps;
    for (;;) {
      if (interrupted()) return;
      const f = cache.folder(userId, accountId, path);
      const limit = f ? this.limit(f.role) : 0;
      if (!f || f.syncedAt === 0 || f.complete || cache.count(f) >= limit) return;
      const more = await pool.withMailbox(userId, accountId, path, async (client, selected) => {
        const mailbox = (client.mailbox || selected) as MailboxObject;
        if (mailbox.uidValidity.toString() !== f.uidValidity) return false; // the next sync starts over
        // The sequence number just below the lowest cached UID.
        let top: number;
        // A refused search must not end the folder early (DreyMail 14.6: it marked it complete).
        const exact = await searchOrThrow(client, { uid: String(f.lowUid) }, { uid: false });
        if (exact.length) top = exact[0]! - 1;
        else {
          const below = await searchOrThrow(client, { uid: `1:${f.lowUid - 1}` }, { uid: false });
          top = below.length ? Math.max(...below) : 0;
        }
        if (top < 1) {
          cache.updateFolder(f, { complete: true });
          return false;
        }
        const want = Math.min(FILL_CHUNK, limit - cache.count(f));
        const start = Math.max(1, top - want + 1);
        const msgs = (await client.fetchAll(`${start}:${top}`, listFetch(client))).filter((m) => m.uid < f.lowUid);
        cache.putMessages(f, await this.entries(client, { accountId, folder: path }, f.uidValidity, msgs));
        const uids = msgs.map((m) => m.uid);
        cache.updateFolder(f, { lowUid: uids.length ? Math.min(...uids) : f.lowUid, complete: start === 1 });
        return uids.length > 0 && start > 1;
        // On the background connection (DreyMail 26.11): one chunk of an inbox took seconds on
        // Microsoft 365, and lists and actions on the main connection waited behind it.
      }, 'sync');
      if (!more) return;
    }
  }

  /**
   * Load the content of the newest unread messages ahead, so opening them doesn't wait for IMAP.
   * A few per IMAP command (DreyMail 14.2; it was one round trip per message), stopping between
   * commands when someone waits for the next sync.
   */
  private async prefetch(userId: string, accountId: string, path: string, interrupted: () => boolean) {
    const { cache, config } = this.deps;
    if (config.maxBodyBytes <= 0 || this.budgetOf(userId, accountId) <= 0) return;
    const f = cache.folder(userId, accountId, path);
    if (!f) return;
    const uids = cache.prefetchCandidates(f, PREFETCH_AMONG, config.maxBodyBytes, PREFETCH_COUNT);
    // On the background connection (DreyMail 26.11), never holding up lists and actions; an open
    // that wants one of these joins it, or fetches it itself if it doesn't come at once.
    if (uids.length) await this.fetchBodies(userId, accountId, path, uids, 'sync', interrupted);
  }

  // ---- space and the search index (DreyMail 12.3) ----------------------------------------------

  /** Space the account's cached mail may take (bytes). */
  budgetOf(userId: string, accountId: string): number {
    return this.deps.budget ? this.deps.budget(userId, accountId) : this.deps.config.bodyBytesPerAccount;
  }

  /** Stored content gives way (least recently read first) so the account stays within its space. */
  enforceBudget(userId: string, accountId: string) {
    const used = this.cache.accountBytes(userId, accountId);
    const forBodies = Math.max(0, this.budgetOf(userId, accountId) - used.messages - used.index);
    this.cache.enforceBodyBudget(userId, accountId, forBodies);
  }

  /**
   * Fill the search index of an account in the background: read the content of cached messages not
   * indexed yet (newest first, at most INDEX_BYTES of each, without marking anything read) and index
   * their words, until all are indexed or the account's space is used up. Never rejects.
   */
  indexAccount(userId: string, accountId: string) {
    if (this.stopped || (!this.deps.textOf && !this.deps.termsOf)) return;
    const k = `${userId}\u0000${accountId}`;
    const running = this.indexing.get(k);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    this.indexing.set(k, state);
    void (async () => {
      do {
        state.again = false;
        for (;;) {
          if (this.stopped) return;
          // The index has room as long as stored content can give way for it.
          const used = this.cache.accountBytes(userId, accountId);
          if (used.messages + used.index >= this.budgetOf(userId, accountId)) return;
          // Messages are read in worker threads, in parallel; between rounds, requests of people using
          // DreyMail go first.
          if (this.deps.busy?.()) await sleep(300);
          const batch = this.cache.unindexed(userId, accountId, INDEX_BATCH);
          if (!batch.length) break;
          for (const { folder: f, uids, length } of this.fetchGroups(batch, this.deps.config.maxBodyBytes)) {
            if (this.stopped) return;
            const got = await this.fetchSources(userId, accountId, f, uids, length);
            if (got) await this.pace(userId, accountId, got);
            // The folder can't be read now (or changed): try again after its next sync.
            if (!got) return;
            // Whole messages are kept as their content (DreyMail 13.6), so opening them needs no mail
            // server; newest kept longest when space runs short (each counts as last read when it arrived).
            if (length === null) {
              for (const [uid, raw] of got) {
                if (raw.length <= this.deps.config.maxBodyBytes && !this.cache.hasBody(f, uid)) this.cache.putBody(f, uid, raw, this.cache.sortTimeOf(f, uid) ?? Date.now());
              }
            }
            const read = await Promise.all(
              uids.map(async (uid) => {
                const full = got.get(uid);
                // The words are in the first part of a message; attachments needn't be read whole.
                const raw = full && full.length > INDEX_READ ? full.subarray(0, INDEX_READ) : full;
                if (!raw) return { uid, terms: null };
                if (this.deps.termsOf) return { uid, terms: await this.deps.termsOf(raw).catch(() => null) };
                const text = await this.deps.textOf!(raw).catch(() => null);
                return { uid, terms: text === null ? null : [...termsOf(text, MAX_BODY_TERMS)] };
              }),
            );
            for (const { uid, terms } of read) {
              if (terms === null) this.cache.markUnindexable(f, uid);
              else this.cache.indexTerms(f, uid, terms);
              await new Promise<void>((r) => setImmediate(r));
            }
          }
          this.enforceBudget(userId, accountId);
          await sleep(50);
        }
        // Then the content of the rest (indexed before 13.6 without keeping it), newest first,
        // while the mailbox has room: opening them needs no mail server either.
        await this.keepContent(userId, accountId);
      } while (state.again && !this.stopped);
    })()
      .catch((err: unknown) => {
        this.deps.log?.('search index filling failed', { accountId, error: (err as Error).message });
      })
      .finally(() => this.indexing.delete(k));
  }

  /** Store the content of cached messages that don't have it yet, newest first, until the mailbox's space is used (DreyMail 13.6). */
  private async keepContent(userId: string, accountId: string) {
    const max = this.deps.config.maxBodyBytes;
    if (max <= 0) return;
    for (;;) {
      if (this.stopped) return;
      if (this.deps.busy?.()) await sleep(300);
      const used = this.cache.accountBytes(userId, accountId, 5_000);
      if (used.total >= this.budgetOf(userId, accountId) * 0.97) return;
      const batch = this.cache.withoutBody(userId, accountId, max, INDEX_BATCH);
      if (!batch.length) return;
      let stored = 0;
      for (const { folder: f, uids, length } of this.fetchGroups(batch, max)) {
        // Only messages known to fit are fetched whole.
        if (length !== null) continue;
        const got = await this.fetchSources(userId, accountId, f, uids, null);
        if (got) await this.pace(userId, accountId, got);
        if (!got) return;
        for (const [uid, raw] of got) {
          if (raw.length > max) continue;
          this.cache.putBody(f, uid, raw, this.cache.sortTimeOf(f, uid) ?? Date.now());
          stored++;
        }
      }
      this.enforceBudget(userId, accountId);
      // Nothing more could be kept (all too big, or gone): done for now.
      if (!stored) return;
      await sleep(50);
    }
  }

  /**
   * Split messages to fetch in the background into groups of at most FETCH_BYTES (a larger message
   * alone), newest order kept (DreyMail 14.1): with bigger messages kept, a batch of 80 must never
   * hold gigabytes. Messages too big to keep (or of unknown size) are read only for their start.
   */
  private fetchGroups(batch: { folder: CachedFolder; uids: number[] }[], maxBodyBytes: number): FetchGroup[] {
    const out: FetchGroup[] = [];
    for (const { folder, uids } of batch) {
      const sizes = this.cache.sizesOf(folder, uids);
      const whole = uids.filter((u) => maxBodyBytes > 0 && (sizes.get(u) ?? 0) > 0 && sizes.get(u)! <= maxBodyBytes);
      const start = uids.filter((u) => !whole.includes(u));
      let group: number[] = [];
      let bytes = 0;
      for (const uid of whole) {
        const size = sizes.get(uid)!;
        if (group.length && bytes + size > FETCH_BYTES) {
          out.push({ folder, uids: group, length: null });
          group = [];
          bytes = 0;
        }
        group.push(uid);
        bytes += size;
      }
      if (group.length) out.push({ folder, uids: group, length: null });
      if (start.length) out.push({ folder, uids: start, length: INDEX_READ });
    }
    return out;
  }

  /** Fetch messages of a folder on the background connection: whole, or only their first `length` bytes. Null when the folder can't be read now. */
  private fetchSources(userId: string, accountId: string, f: CachedFolder, uids: number[], length: number | null): Promise<Map<number, Buffer> | null> {
    return this.deps.pool
      .withMailbox(
        userId,
        accountId,
        f.path,
        async (client, selected) => {
          const mailbox = (client.mailbox || selected) as MailboxObject;
          if (mailbox.uidValidity.toString() !== f.uidValidity) return null;
          const out = new Map<number, Buffer>();
          // `source` is fetched with BODY.PEEK, so nothing is marked read.
          const source = length === null ? true : { start: 0, maxLength: length };
          for (const m of await client.fetchAll(uids.join(','), { uid: true, source } as never, { uid: true })) if (m.source) out.set(m.uid, m.source);
          return out;
        },
        'sync',
      )
      .catch(() => null);
  }

  /**
   * Keep filling the copy in the background within the mailbox's download rate (DreyMail 14.5):
   * after downloading `got`, wait as long as those bytes take at that rate, so a big mailbox fills
   * steadily instead of taking the whole connection (and the mail server's patience).
   */
  private async pace(userId: string, accountId: string, got: Map<number, Buffer>) {
    const rate = this.deps.config.backgroundBytesPerSecond ?? 0;
    if (rate <= 0) return;
    let bytes = 0;
    for (const raw of got.values()) bytes += raw.length;
    const k = `${userId}\u0000${accountId}`;
    const now = Date.now();
    const until = Math.max(now, this.pacedUntil.get(k) ?? 0) + (bytes / rate) * 1000;
    this.pacedUntil.set(k, until);
    if (until > now) await sleep(until - now);
  }

  /** Whether an account's search index is being filled right now. */
  isIndexing(userId: string, accountId: string): boolean {
    return this.indexing.has(`${userId}\u0000${accountId}`);
  }
}
