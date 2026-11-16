// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: new mail is also reported for open desktop-app sessions.
// Modified by samschultzponsys, 2026-11-15: inboxes also watched for the AI assistant.
// Modified by samschultzponsys, 2026-11-16: who is being followed (for keeping folder lists current).
// Modified by samschultzponsys, 2026-11-16: start of new messages fetched for notification previews.
// Modified by samschultzponsys, 2026-11-16: folder lists on their own connection, so opening a message never waits behind them.

import type { ImapFlow, ListResponse, MailboxObject } from 'imapflow';
import type { ServerEvent } from '../../../shared/types.js';
import type { AccountSecret, Store } from '../db.js';
import type { NewMail } from '../push/notify.js';
import { connectImap, MailServerError } from './connect.js';
import { fetchSnippets } from './summary.js';

/** How much of a new message's text a notification preview shows (the payload has room for it). */
const NOTIFICATION_PREVIEW_CHARS = 1000;

export interface PoolOptions {
  idleTimeoutMs: number;
  blockPrivateHosts: boolean;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface CommandConnection {
  client: ImapFlow | null;
  connecting: Promise<ImapFlow> | null;
  lastUsed: number;
  inFlight: number;
}

interface Watcher {
  client: ImapFlow | null;
  uidValidity: string | null;
  stopped: boolean;
  retry: NodeJS.Timeout | null;
  backoffMs: number;
  /** Serialises new-mail checks so one arrival is never reported twice. */
  checking: Promise<void>;
  /** The client listening for changes right now (set once its listeners are in place). */
  listening: ImapFlow | null;
}

export class NotFoundError extends Error {}

const FOLDER_CACHE_MS = 60_000;

/**
 * Lazily opened IMAP connections, one command connection per (user, account), closed after an
 * idle timeout. Separately, while a user has a live browser session or notifications enabled on
 * some device ("background" users), one IDLE connection per account watches INBOX and reports
 * changes. For background users it also reports newly arrived unread messages (onNewMail),
 * remembering the highest UID seen per account so nothing is reported twice, even across restarts.
 *
 * Message data is not kept here; the mail cache (cache/) follows the watchers' activity.
 */
export class ImapPool {
  private readonly conns = new Map<string, CommandConnection>();
  private readonly watchers = new Map<string, Map<string, Watcher>>();
  private readonly watchRefs = new Map<string, number>();
  /** The last folder list per account, for a minute (kept apart from connections, which come and go). */
  private readonly folderLists = new Map<string, { at: number; list: ListResponse[] }>();
  private readonly background = new Set<string>();
  /** Users with the AI assistant on for some mailbox: their inboxes are watched for new mail too (DreyMail). */
  private readonly assistant = new Set<string>();
  /** Open sessions that show their own notifications (the desktop app), per user. */
  private readonly liveNotify = new Map<string, number>();
  private readonly sweeper: NodeJS.Timeout;
  onEvent: (userId: string, event: ServerEvent) => void = () => {};
  onNewMail: (userId: string, accountId: string, messages: NewMail[]) => void = () => {};
  /** Flags changed or messages left INBOX (also called after reconnecting, since changes may have been missed). */
  onInboxChanged: (userId: string, accountId: string) => void = () => {};
  /** A watcher (re)connected to an account's INBOX: anything may have changed while it wasn't. */
  onWatching: (userId: string, accountId: string) => void = () => {};
  /** Anything happened in a watched INBOX: new mail, flags changed or messages left. */
  onInboxActivity: (userId: string, accountId: string) => void = () => {};

  constructor(
    private readonly store: Store,
    private readonly opts: PoolOptions,
  ) {
    this.sweeper = setInterval(() => this.sweep(), Math.min(30_000, opts.idleTimeoutMs));
    this.sweeper.unref();
  }

  private key(userId: string, accountId: string) {
    return `${userId}:${accountId}`;
  }

  private account(userId: string, accountId: string): AccountSecret {
    const acc = this.store.getAccountSecret(userId, accountId);
    if (!acc) throw new NotFoundError('Account not found');
    return acc;
  }

  /**
   * The account's command connection, or (`lane` 'folders') a second one that only lists folders:
   * listing every folder with its counts can take seconds on a big account, and opening a message
   * must never wait behind it (DreyMail).
   */
  private async client(userId: string, accountId: string, lane: 'main' | 'folders' = 'main'): Promise<{ conn: CommandConnection; client: ImapFlow }> {
    const key = lane === 'main' ? this.key(userId, accountId) : `${this.key(userId, accountId)}#folders`;
    let conn = this.conns.get(key);
    if (!conn) {
      conn = { client: null, connecting: null, lastUsed: Date.now(), inFlight: 0 };
      this.conns.set(key, conn);
    }
    conn.lastUsed = Date.now();
    if (conn.client?.usable) return { conn, client: conn.client };
    if (!conn.connecting) {
      const acc = this.account(userId, accountId);
      const c = conn;
      c.connecting = connectImap(acc.imap, { blockPrivateHosts: this.opts.blockPrivateHosts, autoIdle: false })
        .then((client) => {
          client.on('close', () => {
            if (c.client === client) c.client = null;
          });
          c.client = client;
          return client;
        })
        .finally(() => {
          c.connecting = null;
        });
    }
    return { conn, client: await conn.connecting! };
  }

  /** Run `fn` with a connection, without selecting a mailbox. */
  async withClient<T>(userId: string, accountId: string, fn: (client: ImapFlow) => Promise<T>, lane: 'main' | 'folders' = 'main'): Promise<T> {
    const { conn, client } = await this.client(userId, accountId, lane);
    conn.inFlight++;
    try {
      return await fn(client);
    } finally {
      conn.inFlight--;
      conn.lastUsed = Date.now();
    }
  }

  /** Run `fn` with `path` selected and locked on the account's command connection. */
  async withMailbox<T>(
    userId: string,
    accountId: string,
    path: string,
    fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>,
  ): Promise<T> {
    return this.withClient(userId, accountId, async (client) => {
      let lock;
      try {
        lock = await client.getMailboxLock(path, { acquireTimeout: 60_000 });
      } catch (err) {
        const e = err as { responseText?: string; message?: string };
        throw new MailServerError(`Cannot open folder "${path}": ${e.responseText || e.message}`, 'protocol');
      }
      try {
        return await fn(client, client.mailbox as MailboxObject);
      } finally {
        lock.release();
      }
    });
  }

  /** Folder list with a short cache (special-use lookups happen on most actions). */
  async folders(userId: string, accountId: string, fresh = false): Promise<ListResponse[]> {
    const key = this.key(userId, accountId);
    const known = this.folderLists.get(key);
    if (!fresh && known && Date.now() - known.at < FOLDER_CACHE_MS) return known.list;
    const list = await this.withClient(userId, accountId, (c) => c.list({ statusQuery: { unseen: true, messages: true } }), 'folders');
    this.folderLists.set(key, { at: Date.now(), list });
    return list;
  }

  /** Close and forget every connection for an account (after edit or delete). */
  invalidate(userId: string, accountId: string) {
    const key = this.key(userId, accountId);
    this.folderLists.delete(key);
    for (const k of [key, `${key}#folders`]) {
      const conn = this.conns.get(k);
      this.conns.delete(k);
      conn?.client?.logout().catch(() => conn.client?.close());
    }
    const w = this.watchers.get(userId)?.get(accountId);
    if (w) {
      this.stopWatcher(w);
      this.watchers.get(userId)!.delete(accountId);
      if (this.watching(userId)) this.startWatcher(userId, accountId);
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [key, conn] of this.conns) {
      if (conn.inFlight === 0 && !conn.connecting && now - conn.lastUsed > this.opts.idleTimeoutMs) {
        this.conns.delete(key);
        const c = conn.client;
        if (c) c.logout().catch(() => c.close());
      }
    }
  }

  // ---- live updates --------------------------------------------------------

  /** Users whose mail is being followed now: open sessions, notifications or the AI assistant (DreyMail). */
  watchedUserIds(): string[] {
    const ids = new Set<string>([...this.background, ...this.assistant]);
    for (const [id, n] of this.watchRefs) if (n > 0) ids.add(id);
    return [...ids];
  }

  private watching(userId: string): boolean {
    return (this.watchRefs.get(userId) ?? 0) > 0 || this.keepsWatching(userId);
  }

  /** Watched without a browser session: notifications on some device, or the AI assistant. */
  private keepsWatching(userId: string): boolean {
    return this.background.has(userId) || this.assistant.has(userId);
  }

  /** Called when a browser session for this user opens. Reference counted per user. */
  watch(userId: string) {
    const refs = (this.watchRefs.get(userId) ?? 0) + 1;
    this.watchRefs.set(userId, refs);
    if (refs > 1 || this.keepsWatching(userId)) return;
    for (const acc of this.store.listAccounts(userId)) this.startWatcher(userId, acc.id);
  }

  unwatch(userId: string) {
    const refs = (this.watchRefs.get(userId) ?? 1) - 1;
    if (refs > 0) {
      this.watchRefs.set(userId, refs);
      return;
    }
    this.watchRefs.delete(userId);
    if (!this.keepsWatching(userId)) this.stopAll(userId);
  }

  /**
   * Keep watching a user's inboxes without a browser session and report new mail (the user has
   * notifications enabled on some device), or stop doing so.
   *
   * `fromNow` (notifications were just switched on) drops the stored marks, so mail that arrived
   * while notifications were off is not reported. Without it (server start) the marks are kept and
   * mail that arrived while the server was down is reported.
   */
  setBackground(userId: string, on: boolean, fromNow = false) {
    if (on === this.background.has(userId)) return;
    if (!on) {
      this.background.delete(userId);
      if ((this.watchRefs.get(userId) ?? 0) === 0 && !this.assistant.has(userId)) this.stopAll(userId);
      return;
    }
    if (fromNow) this.store.clearInboxState(userId);
    this.background.add(userId);
    for (const acc of this.store.listAccounts(userId)) {
      const w = this.watchers.get(userId)?.get(acc.id);
      if (!w) this.startWatcher(userId, acc.id);
      else if (w.client?.usable) this.checkNewMail(userId, acc.id, w, w.client); // starts tracking from now
    }
  }

  /**
   * Watch a user's inboxes for the AI assistant (DreyMail), or stop. Like setBackground, but mail
   * that arrived while it was off is never handed to it: it starts from now.
   */
  setAssistant(userId: string, on: boolean) {
    if (on === this.assistant.has(userId)) return;
    if (!on) {
      this.assistant.delete(userId);
      if ((this.watchRefs.get(userId) ?? 0) === 0 && !this.background.has(userId)) this.stopAll(userId);
      return;
    }
    const wasReporting = this.wantsNewMail(userId);
    if (!wasReporting) this.store.clearInboxState(userId);
    this.assistant.add(userId);
    for (const acc of this.store.listAccounts(userId)) {
      const w = this.watchers.get(userId)?.get(acc.id);
      if (!w) this.startWatcher(userId, acc.id);
      else if (w.client?.usable) this.checkNewMail(userId, acc.id, w, w.client);
    }
  }

  /** Report new mail (onNewMail) for this user: notifications on a device, a desktop app open, or the AI assistant. */
  private wantsNewMail(userId: string): boolean {
    return this.background.has(userId) || this.assistant.has(userId) || (this.liveNotify.get(userId) ?? 0) > 0;
  }

  /** Whether new mail of this user should become notifications (as opposed to only reaching the assistant). */
  notifiesNewMail(userId: string): boolean {
    return this.background.has(userId) || (this.liveNotify.get(userId) ?? 0) > 0;
  }

  /**
   * A live session that shows its own notifications (the desktop app) opened or closed. Reference
   * counted. While any is open, new mail is reported even without Web Push.
   */
  setLiveNotify(userId: string, on: boolean) {
    const before = this.liveNotify.get(userId) ?? 0;
    const after = Math.max(0, before + (on ? 1 : -1));
    if (after) this.liveNotify.set(userId, after);
    else this.liveNotify.delete(userId);
    if (before === 0 && after > 0 && !this.background.has(userId) && !this.assistant.has(userId)) {
      // Start from now: don't report mail that arrived while nothing was listening.
      this.store.clearInboxState(userId);
      for (const [accountId, w] of this.watchers.get(userId) ?? []) if (w.client?.usable) this.checkNewMail(userId, accountId, w, w.client);
    }
  }

  /** True while the account's INBOX watcher is connected (so every change there is reported). */
  isWatching(userId: string, accountId: string): boolean {
    const w = this.watchers.get(userId)?.get(accountId);
    return !!w && !!w.client?.usable && w.listening === w.client;
  }

  isBackground(userId: string): boolean {
    return this.background.has(userId);
  }

  private stopAll(userId: string) {
    const ws = this.watchers.get(userId);
    this.watchers.delete(userId);
    for (const w of ws?.values() ?? []) this.stopWatcher(w);
  }

  /** Start watching a newly added account if the user is online or has notifications on. */
  accountAdded(userId: string, accountId: string) {
    if (this.watching(userId)) this.startWatcher(userId, accountId);
  }

  private stopWatcher(w: Watcher) {
    w.stopped = true;
    if (w.retry) clearTimeout(w.retry);
    const c = w.client;
    w.client = null;
    if (c) c.logout().catch(() => c.close());
  }

  private startWatcher(userId: string, accountId: string) {
    let byAccount = this.watchers.get(userId);
    if (!byAccount) {
      byAccount = new Map();
      this.watchers.set(userId, byAccount);
    }
    if (byAccount.has(accountId)) return;
    const w: Watcher = {
      client: null,
      uidValidity: null,
      stopped: false,
      retry: null,
      backoffMs: 5_000,
      checking: Promise.resolve(),
      listening: null,
    };
    byAccount.set(accountId, w);
    void this.runWatcher(userId, accountId, w);
  }

  private async runWatcher(userId: string, accountId: string, w: Watcher) {
    if (w.stopped) return;
    const folder = 'INBOX';
    const emit = (event: ServerEvent) => this.onEvent(userId, event);
    try {
      const acc = this.account(userId, accountId);
      const client = await connectImap(acc.imap, { blockPrivateHosts: this.opts.blockPrivateHosts, autoIdle: true });
      if (w.stopped) {
        await client.logout().catch(() => client.close());
        return;
      }
      w.client = client;
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      const uv = mailbox.uidValidity.toString();
      if (w.uidValidity !== null && w.uidValidity !== uv) emit({ type: 'reset', accountId, folder });
      else if (w.uidValidity !== null) emit({ type: 'mailbox', accountId, folder }); // catch up after reconnect
      if (w.uidValidity !== null) this.onInboxChanged(userId, accountId);
      w.uidValidity = uv;
      w.backoffMs = 5_000;
      // Also reports mail that arrived while disconnected (or while the server was down).
      if (this.wantsNewMail(userId)) this.checkNewMail(userId, accountId, w, client);
      this.onWatching(userId, accountId);
      const changed = () => {
        emit({ type: 'mailbox', accountId, folder });
        this.onInboxActivity(userId, accountId);
      };
      client.on('exists', () => {
        changed();
        if (this.wantsNewMail(userId)) this.checkNewMail(userId, accountId, w, client);
      });
      const inboxChanged = () => {
        changed();
        this.onInboxChanged(userId, accountId);
      };
      client.on('expunge', inboxChanged);
      client.on('flags', inboxChanged);
      client.on('close', () => {
        if (w.client === client) w.client = null;
        if (w.listening === client) w.listening = null;
        this.scheduleWatcher(userId, accountId, w);
      });
      w.listening = client;
    } catch (err) {
      if (err instanceof NotFoundError) return;
      this.opts.log?.('IMAP watcher failed', { accountId, error: (err as Error).message });
      this.scheduleWatcher(userId, accountId, w);
    }
  }

  /**
   * Report INBOX messages above the stored high-water UID that are still unread, then move the
   * mark. Without a stored mark (first run, or UIDVALIDITY changed) only the mark is set, so
   * enabling notifications never reports old mail.
   */
  private checkNewMail(userId: string, accountId: string, w: Watcher, client: ImapFlow) {
    w.checking = w.checking.then(async () => {
      if (w.stopped || w.client !== client || !this.wantsNewMail(userId)) return;
      const mailbox = client.mailbox;
      if (!mailbox || mailbox.path !== 'INBOX') return;
      const uidValidity = mailbox.uidValidity.toString();
      const state = this.store.getInboxState(userId, accountId);
      if (!state || state.uidValidity !== uidValidity) {
        // UIDNEXT is only as fresh as the SELECT, so ask for the newest message's UID instead.
        const newest = mailbox.exists > 0 ? await client.fetchOne('*', { uid: true }) : false;
        this.store.setInboxState(userId, accountId, uidValidity, newest ? newest.uid : Math.max(0, mailbox.uidNext - 1));
        return;
      }
      // "n:*" always matches at least the newest message, even if its UID is below n.
      const msgs = (await client.fetchAll(`${state.lastUid + 1}:*`, { uid: true, flags: true, envelope: true }, { uid: true }))
        .filter((m) => m.uid > state.lastUid);
      if (msgs.length === 0) return;
      this.store.setInboxState(userId, accountId, uidValidity, Math.max(...msgs.map((m) => m.uid)));
      const unread: NewMail[] = msgs
        .filter((m) => !m.flags?.has('\\Seen'))
        .map((m) => {
          const from = m.envelope?.from?.[0];
          return {
            uid: m.uid,
            uidValidity,
            from: from ? { name: from.name ?? '', address: from.address ?? '' } : null,
            subject: m.envelope?.subject ?? '',
            messageId: m.envelope?.messageId ?? null,
          };
        });
      if (unread.length === 0) return;
      // Notifications that show the start of the message: fetch it for the one that is shown alone.
      if (unread.length === 1 && this.store.getUser(userId)?.preferences.notificationContent === 'preview') {
        try {
          const withParts = await client.fetchAll(String(unread[0]!.uid), { uid: true, bodyStructure: true }, { uid: true });
          // Enough for an expanded notification (about 1,000 characters), keeping its paragraphs.
          const snippet = (await fetchSnippets(client, withParts, { bytes: 16_384, length: NOTIFICATION_PREVIEW_CHARS, keepLines: true })).get(unread[0]!.uid);
          if (snippet) unread[0]!.snippet = snippet;
        } catch (err) {
          this.opts.log?.('notification preview failed', { accountId, error: (err as Error).message });
        }
      }
      this.onNewMail(userId, accountId, unread);
    }).catch((err: unknown) => {
      this.opts.log?.('new mail check failed', { accountId, error: (err as Error).message });
    });
  }

  private scheduleWatcher(userId: string, accountId: string, w: Watcher) {
    if (w.stopped || w.retry) return;
    w.retry = setTimeout(() => {
      w.retry = null;
      void this.runWatcher(userId, accountId, w);
    }, w.backoffMs);
    w.retry.unref();
    w.backoffMs = Math.min(w.backoffMs * 2, 5 * 60_000);
  }

  async close() {
    clearInterval(this.sweeper);
    this.background.clear();
    this.assistant.clear();
    for (const userId of [...this.watchers.keys()]) this.stopAll(userId);
    for (const userId of [...this.watchRefs.keys()]) {
      this.watchRefs.set(userId, 1);
      this.unwatch(userId);
    }
    await Promise.all(
      [...this.conns.values()].map((c) => c.client?.logout().catch(() => c.client?.close())),
    );
    this.conns.clear();
  }
}
