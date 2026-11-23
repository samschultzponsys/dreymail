// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-17: every folder of a mailbox is cached, filled in the background on its own connection.
// Modified by samschultzponsys, 2026-11-17: listings of other folders always check with the server first, ahead of the filling.
// Modified by samschultzponsys, 2026-11-17: tells about new messages and filled folders (address suggestions).
// Modified by samschultzponsys, 2026-11-18: Gmail labels fetched with message lists.
// Modified by samschultzponsys, 2026-11-23: the search index filled in the background; space per mailbox from the user's share.

import type { FetchMessageObject, ImapFlow, MailboxObject } from 'imapflow';
import type { MessageSummary } from '../../../shared/types.js';
import type { CacheConfig } from '../config.js';
import type { ImapPool, Lane } from '../imap/pool.js';
import { fetchSnippets, listFetch, sortTime, summaryOf, toDate } from '../imap/summary.js';
import { CacheCorruptError, flagsOf, type CachedFolder, type CachedRole, type MailCache, type MessageEntry } from './store.js';

/** Messages fetched per IMAP command while filling a folder, so other requests get their turn in between. */
export const FILL_CHUNK = 200;
/** Unread messages (among the newest) whose content is loaded ahead after a sync of INBOX. */
const PREFETCH_COUNT = 25;
const PREFETCH_AMONG = 200;
/** How long a listing waits for a sync before it answers from the (possibly older) cache. */
export const LISTING_WAIT_MS = 1500;
const DEBOUNCE_MS = 300;
/** Other folders synced longer ago than this are brought up to date again when a session opens (DreyMail). */
export const WARM_MAX_AGE_MS = 10 * 60_000;
/** At most this many other folders per mailbox are cached (the special ones first). */
export const WARM_MAX_FOLDERS = 100;
/** Messages read per round when filling the search index, and how much of each (DreyMail 12.3). */
const INDEX_BATCH = 50;
export const INDEX_BYTES = 96 * 1024;
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
  /** Plain text of a message (for the search index); null when it can't be read. */
  textOf?: (raw: Buffer) => Promise<string | null>;
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
  /** Accounts whose search index is being filled, and whether to go round again (DreyMail 12.3). */
  private readonly indexing = new Map<string, { again: boolean }>();
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
  sync(userId: string, accountId: string, path: string, role: CachedRole, urgent = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const k = this.key(userId, accountId, path);
    const job = this.job(userId, accountId, path);
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    const done = new Promise<void>((resolve) => job.waiters.push(resolve));
    if (urgent) job.urgent = true;
    if (job.running) {
      job.again = true;
      return done;
    }
    const run = async () => {
      while (!this.stopped) {
        job.again = false;
        const waiting = job.waiters.splice(0);
        this.dirty.delete(k);
        const lane: Lane = job.urgent ? 'main' : this.lane(role);
        job.urgent = false;
        try {
          const changed = await this.update(userId, accountId, path, role, lane);
          if (changed) this.deps.onChanged(userId, accountId, path);
        } catch (err) {
          this.handleError(err, userId, accountId, path);
        }
        for (const resolve of waiting) resolve();
        // Extras, interrupted by anyone waiting for the next sync; they continue after it.
        const interrupted = () => this.stopped || job.again || job.waiters.length > 0;
        try {
          if (role === 'inbox') await this.prefetch(userId, accountId, path, interrupted);
          await this.fill(userId, accountId, path, interrupted);
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
  private async update(userId: string, accountId: string, path: string, role: CachedRole, lane: Lane = this.lane(role)): Promise<boolean> {
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
      const uidNext = Math.max(f.uidNext, ...fresh.map((m) => m.uid + 1));

      // Flag changes in the cached range: only what changed since the last sync if the server can tell.
      const since = condstore && f.modseq ? BigInt(f.modseq) : undefined;
      const flagged = await client.fetchAll(`${f.lowUid}:*`, { uid: true, flags: true }, { uid: true, changedSince: since });
      const updates = flagged.filter((m) => m.uid >= f!.lowUid && m.uid < f!.uidNext).map((m) => ({ uid: m.uid, flags: flagsOf(m.flags) }));
      if (cache.setFlags(f, updates) > 0) changed = true;
      for (const m of flagged) if (m.modseq !== undefined && (modseq === null || m.modseq > modseq)) modseq = m.modseq;

      // Messages that are gone (deleted, or moved by another client).
      const present = new Set(((await client.search({ uid: `${f.lowUid}:*` }, { uid: true })) || []) as number[]);
      const gone = cache.uids(f).filter((u) => !present.has(u));
      if (gone.length && cache.removeMessages(f, gone) > 0) changed = true;

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
        const exact = (await client.search({ uid: String(f.lowUid) }, { uid: false })) || [];
        if (exact.length) top = exact[0]! - 1;
        else {
          const below = (await client.search({ uid: `1:${f.lowUid - 1}` }, { uid: false })) || [];
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
      }, this.lane(f.role));
      if (!more) return;
    }
  }

  /** Load the content of the newest unread messages ahead, so opening them doesn't wait for IMAP. */
  private async prefetch(userId: string, accountId: string, path: string, interrupted: () => boolean) {
    const { cache, pool, config } = this.deps;
    if (config.maxBodyBytes <= 0 || this.budgetOf(userId, accountId) <= 0) return;
    const f = cache.folder(userId, accountId, path);
    if (!f) return;
    for (const uid of cache.prefetchCandidates(f, PREFETCH_AMONG, config.maxBodyBytes, PREFETCH_COUNT)) {
      if (interrupted()) break;
      const raw = await pool.withMailbox(userId, accountId, path, async (client, selected) => {
        const mailbox = (client.mailbox || selected) as MailboxObject;
        if (mailbox.uidValidity.toString() !== f.uidValidity) return null;
        // `source` is fetched with BODY.PEEK, so this never marks the message as read.
        const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        return msg && msg.source ? msg.source : null;
      });
      if (raw && raw.length <= config.maxBodyBytes) cache.putBody(f, uid, raw);
    }
    this.enforceBudget(userId, accountId);
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
    if (this.stopped || !this.deps.textOf) return;
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
          const batch = this.cache.unindexed(userId, accountId, INDEX_BATCH);
          if (!batch.length) break;
          for (const { folder: f, uids } of batch) {
            if (this.stopped) return;
            const got = await this.deps.pool
              .withMailbox(
                userId,
                accountId,
                f.path,
                async (client, selected) => {
                  const mailbox = (client.mailbox || selected) as MailboxObject;
                  if (mailbox.uidValidity.toString() !== f.uidValidity) return null;
                  const out = new Map<number, Buffer>();
                  for (const m of await client.fetchAll(uids.join(','), { uid: true, source: { start: 0, maxLength: INDEX_BYTES } } as never, { uid: true })) if (m.source) out.set(m.uid, m.source);
                  return out;
                },
                'sync',
              )
              .catch(() => null);
            // The folder can't be read now (or changed): try again after its next sync.
            if (!got) return;
            for (const uid of uids) {
              const raw = got.get(uid);
              const text = raw ? await this.deps.textOf!(raw).catch(() => null) : null;
              if (text === null) this.cache.markUnindexable(f, uid);
              else this.cache.indexBody(f, uid, text);
            }
          }
          this.enforceBudget(userId, accountId);
          await sleep(20);
        }
      } while (state.again && !this.stopped);
    })()
      .catch((err: unknown) => {
        this.deps.log?.('search index filling failed', { accountId, error: (err as Error).message });
      })
      .finally(() => this.indexing.delete(k));
  }

  /** Whether an account's search index is being filled right now. */
  isIndexing(userId: string, accountId: string): boolean {
    return this.indexing.has(`${userId}\u0000${accountId}`);
  }
}
