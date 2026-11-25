// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: sign-in settings service and administration routes.
// Modified by samschultzponsys, 2026-11-13: dreymail.db and the one-time data upgrade.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-13: new-mail notifications also go to open sessions (desktop app).
// Modified by samschultzponsys, 2026-11-13: Android app notifications (Firebase).
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.
// Modified by samschultzponsys, 2026-11-15: Outlook / Microsoft 365 accounts (Microsoft sign-in, Graph sending).
// Modified by samschultzponsys, 2026-11-15: Sign in with Google for Gmail.
// Modified by samschultzponsys, 2026-11-15: roles and permissions (Access).
// Modified by samschultzponsys, 2026-11-15: AI mailbox assistant.
// Modified by samschultzponsys, 2026-11-15: AI assistant learning mode.
// Modified by samschultzponsys, 2026-11-15: copy codes, unsubscribe, block sender, mailbox health.
// Modified by samschultzponsys, 2026-11-15: send later and undo send.
// Modified by samschultzponsys, 2026-11-15: passkey sign-in.
// Modified by samschultzponsys, 2026-11-15: calendar.
// Modified by samschultzponsys, 2026-11-15: Google, Outlook and CalDAV calendars; invitations.
// Modified by samschultzponsys, 2026-11-15: privacy page at /privacy.
// Modified by samschultzponsys, 2026-11-16: folder lists kept current in the background.
// Modified by samschultzponsys, 2026-11-17: auto-replies.
// Modified by samschultzponsys, 2026-11-17: every folder of a mailbox cached in the background.
// Modified by samschultzponsys, 2026-11-17: Settings → Storage (space used per user).
// Modified by samschultzponsys, 2026-11-17: address suggestions from sent and received mail.
// Modified by samschultzponsys, 2026-11-17: event reminders (notifications and the reminder window).
// Modified by samschultzponsys, 2026-11-17: server settings saved in the UI; the assistant's sending actions; follow-up flags; contacts and tasks; S/MIME; meeting rooms.
// Modified by samschultzponsys, 2026-11-21: backups (the user's own file; daily copies of the database).
// Modified by samschultzponsys, 2026-11-23: the search index and each user's cache space; Microsoft 365 group calendars; background indexing waits while DreyMail is in use.
// Modified by samschultzponsys, 2026-11-25: larger messages being opened are decoded on worker threads of their own.
// Modified by samschultzponsys, 2026-11-25: the web app sent compressed (made at build), its hashed files cached for good.
// Modified by samschultzponsys, 2026-11-25: connections per mailbox; speed measured for Settings → Server → Speed.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/routes.js';
import { Sessions } from './auth/session.js';
import type { Config } from './config.js';
import { MailCache, type CachedRole } from './cache/store.js';
import { CacheSync } from './cache/sync.js';
import { Keyring } from './crypto.js';
import { Store } from './db.js';
import { MailService } from './imap/mail.js';
import { ImapPool } from './imap/pool.js';
import { ComposeService } from './mail/send.js';
import { AddressBook } from './addressBook.js';
import { SnoozeService } from './mail/snooze.js';
import { PushService } from './push/service.js';
import { createPushTransport, vapidKeysFromSeed, type PushTransport } from './push/webpush.js';
import type { AvatarService } from './net/avatars.js';
import type { RemoteImage } from './net/remoteImages.js';
import { registerApiRoutes } from './routes/api.js';
import { Access } from './access.js';
import { registerPasskeyRoutes } from './auth/passkeys.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { CalendarService } from './calendar/service.js';
import { Reminders } from './calendar/reminders.js';
import { Followups } from './mail/followups.js';
import { Rooms } from './calendar/rooms.js';
import { Directory } from './directory.js';
import { People } from './people.js';
import { SmimeStore } from './mail/smimeStore.js';
import { registerPeopleRoutes } from './routes/people.js';
import { ServerSettings, storedServerSettings, withStoredSettings } from './serverSettings.js';
import { Snapshots } from './backup.js';
import { CacheBudget, cacheShares } from './cacheBudget.js';
import { TextPool } from './cache/textPool.js';
import { registerBackupRoutes } from './routes/backup.js';
import { serverVersion } from './version.js';
import { assistantOutgoing } from './ai/outgoing.js';
import type { Http } from './calendar/remote.js';
import { Blocklist } from './blocklist.js';
import { ScheduledSends } from './mail/scheduled.js';
import { AssistantEngine } from './ai/engine.js';
import { AiClient, type FetchLike as AiFetch } from './ai/providers.js';
import { AssistantStore } from './ai/store.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAndroidPushRoutes } from './routes/android.js';
import { registerMicrosoftRoutes } from './routes/microsoft.js';
import { registerGoogleRoutes } from './routes/google.js';
import { GoogleAuth, GoogleConfig } from './oauth/google.js';
import { MicrosoftAuth, MicrosoftConfig, type FetchLike as MicrosoftFetch } from './oauth/microsoft.js';
import { setOAuthTokenProvider } from './imap/connect.js';
import { LoginSettings } from './loginSettings.js';
import { DB_FILE, moveOldDataFiles, rekeyOldSecrets } from './upgrade.js';
import { buildNotification, buildSnoozeNotification, type NotificationPayload } from './push/notify.js';
import { FcmSender, FirebaseConfig, type FetchLike } from './push/fcm.js';
import type { NotificationContent } from '../../shared/types.js';
import { inboxUnread } from '../../shared/unread.js';
import { registerWebSocket, type LiveSessions } from './routes/ws.js';
import { AutoReplies } from './autoReply.js';
import { registerAutoReplyRoutes } from './routes/autoReplies.js';
import { SpeedStats, speedMetricOf } from './speed.js';

/** CSP for the application itself. Message iframes (srcdoc) inherit it, plus their own. */
/**
 * The page's Content-Security-Policy, also allowing the page's own inline scripts by their hash
 * (DreyMail 14.4: the one that starts the first requests while the app's script downloads). Any
 * other inline script stays blocked.
 */
export function cspFor(html: string | null): string {
  const hashes = [...(html ?? '').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
  return hashes.length ? APP_CSP.replace("script-src 'self'", `script-src 'self' ${hashes.join(' ')}`) : APP_CSP;
}

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Client-side routes (e.g. /mail/<account>/<folder>) are served the SPA shell. Only browser
 * navigations qualify (GET/HEAD asking for HTML), and never anything under /api or /auth, so API
 * typos still get a JSON 404 and missing assets aren't answered with HTML.
 */
export function isSpaRequest(method: string, url: string, accept: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = url.split('?')[0]!;
  if (/^\/(api|auth)(\/|$)/.test(path) || path === '/healthz') return false;
  return (accept ?? '').includes('text/html');
}

export interface App {
  app: FastifyInstance;
  store: Store;
  pool: ImapPool;
  mail: MailService;
  cache: MailCache | null;
  cacheSync: CacheSync | null;
  push: PushService;
  snooze: SnoozeService;
  microsoft: MicrosoftAuth;
  google: GoogleAuth;
}

export async function buildApp(
  config: Config,
  opts: {
    store?: Store;
    logger?: boolean;
    fetchImage?: (url: string) => Promise<RemoteImage>;
    /** Replaces the contact picture lookup (tests only). */
    avatars?: AvatarService;
    /** Replaces fetch for AI services (tests only). */
    aiFetch?: AiFetch;
    /** Replaces real Web Push delivery (tests only). */
    pushTransport?: PushTransport;
    /** Replaces HTTP calls to Google for the Android app's notifications (tests only). */
    fcmFetch?: FetchLike;
    /** Replaces the GitHub release check (tests only). */
    updates?: { get(): Promise<{ version: string; url: string } | null> };
    /** Replaces HTTP calls to Microsoft (tests only). */
    microsoftFetch?: MicrosoftFetch;
    /** HTTP for provider calendars (Google, Graph, CalDAV); tests pass a fake. */
    calendarFetch?: Http;
    /** Replaces HTTP calls to Google sign-in (tests only). */
    googleFetch?: MicrosoftFetch;
    /** Replaces the DNS check of push service hosts (tests only). */
    pushHostCheck?: (host: string) => Promise<void>;
    /** Where the mail cache lives, null for none. Defaults to cache.db in the data directory (memory with `store`). */
    cacheFile?: string | null;
  } = {},
): Promise<App> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });
  const keyring = new Keyring(config.secretKey);
  if (!opts.store) moveOldDataFiles(config.dataDir, (m) => app.log.info(m));
  const store = opts.store ?? new Store(path.join(config.dataDir, DB_FILE), keyring.credentialKey);
  rekeyOldSecrets(store, config.secretKey, (m) => app.log.info(m));
  // Server settings saved in the UI, under the environment (which wins) (DreyMail).
  config = withStoredSettings(config, store, (m) => app.log.warn(m));
  const serverSettings = new ServerSettings(config, store);
  const sessions = new Sessions(keyring.sessionKey, config.baseUrl.protocol === 'https:');
  const pool = new ImapPool(store, {
    idleTimeoutMs: config.imapIdleTimeoutMs,
    maxConnections: config.imapConnections,
    blockPrivateHosts: config.blockPrivateMailHosts,
    log: (msg, extra) => app.log.info(extra ?? {}, msg),
  });
  // The mail cache: copies of INBOX and Sent (and of every other folder), kept in step with the IMAP server. Disposable, so a
  // separate file from the main database.
  const cacheLog = (msg: string, extra?: Record<string, unknown>) => app.log.warn(extra ?? {}, msg);
  // With an injected store (tests) the cache defaults to memory too.
  const cacheFile = opts.cacheFile !== undefined ? opts.cacheFile : opts.store ? ':memory:' : path.join(config.dataDir, 'cache.db');
  const cache = config.cache && cacheFile !== null ? new MailCache(cacheFile, { cacheKey: keyring.cacheKey, indexKey: keyring.cacheIndexKey }, cacheLog) : null;
  // Address suggestions (DreyMail): filled from the mail cache (each folder's existing mail once,
  // then new mail) and from what is sent.
  const addressBook = new AddressBook(store);
  const harvesting = new Set<string>();
  const useOf = async (userId: string, accountId: string, folder: string, role: CachedRole) =>
    role === 'inbox' ? 'inbox' : role === 'sent' ? 'sent' : await mail.folderUse(userId, accountId, folder);
  const cacheBudget = new CacheBudget(store);
  // Worker threads that read messages for the search index (DreyMail 12.10).
  const textPool = new TextPool();
  app.addHook('onClose', async () => textPool.close());
  // Someone is using DreyMail (a request under way, or one in the last few seconds): background
  // work that takes the server's time, like filling the search index, waits (DreyMail 12.10).
  let inFlight = 0;
  let lastUse = 0;
  const QUIET = new Set(['/api/cache/usage']);
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || QUIET.has(path)) return;
    inFlight++;
    lastUse = Date.now();
    (req as { countsAsUse?: boolean }).countsAsUse = true;
  });
  app.addHook('onResponse', async (req) => {
    if ((req as { countsAsUse?: boolean }).countsAsUse) {
      inFlight = Math.max(0, inFlight - 1);
      lastUse = Date.now();
    }
  });
  const busy = () => inFlight > 0 || Date.now() - lastUse < 4000;
  const cacheSync =
    cache && config.cache
      ? new CacheSync({
          cache,
          pool,
          config: config.cache,
          // Called only once a sync runs, after `mail` exists.
          sentFolder: (userId, accountId) => mail.specialFolder(userId, accountId, 'sent'),
          cacheableFolders: (userId, accountId) => mail.cacheableFolders(userId, accountId),
          isWatched: (userId, accountId) => pool.isWatching(userId, accountId),
          // Space and the search index (DreyMail 12.3).
          budget: (userId, accountId) => cacheBudget.accountBytes(userId, accountId),
          busy,
          termsOf: (raw) => textPool.terms(raw),
          onChanged: (userId, accountId, folder) => pool.onEvent(userId, { type: 'mailbox', accountId, folder }),
          onNewMessages: (userId, accountId, folder, role, messages) => {
            if (!addressBook.filled(accountId, folder)) return; // counted with the rest once the folder has filled
            void useOf(userId, accountId, folder, role)
              .then((use) => addressBook.harvest(userId, accountId, use, messages))
              .catch(() => undefined);
          },
          onFilled: (userId, accountId, folder, role, f) => {
            const k = `${accountId}\u0000${folder}`;
            if (harvesting.has(k) || addressBook.filled(accountId, folder)) return;
            harvesting.add(k);
            void useOf(userId, accountId, folder, role)
              .then((use) => {
                if (!store.listAccounts(userId).some((a) => a.id === accountId)) return;
                addressBook.harvest(userId, accountId, use, cache!.page(f, null, cache!.count(f)).map((m) => m.summary));
                addressBook.markFilled(accountId, folder);
              })
              .catch(() => undefined)
              .finally(() => harvesting.delete(k));
          },
          log: cacheLog,
        })
      : null;
  const mail = new MailService(
    pool,
    cache && cacheSync && config.cache
      ? { cache, sync: cacheSync, maxBodyBytes: config.cache.maxBodyBytes, bodyBytesPerAccount: config.cache.bodyBytesPerAccount }
      : null,
  );
  pool.onWatching = (userId, accountId) => mail.syncAccount(userId, accountId);
  // S/MIME: encrypted mail opened and signatures checked when read; sent mail signed and encrypted (DreyMail 10.6).
  const smime = new SmimeStore(store);
  mail.smime = smime;
  // Larger messages being opened are decoded on threads of their own, never queued behind the
  // index's (DreyMail 14.1).
  const readPool = new TextPool(2);
  app.addHook('onClose', async () => readPool.close());
  mail.parser = (raw) => readPool.parse(raw);
  pool.onInboxActivity = (userId, accountId) => mail.folderChanged(userId, accountId, 'INBOX');
  const vapid = vapidKeysFromSeed(keyring.vapidSeed);
  let live: LiveSessions = { isUserActive: () => false };
  const firebase = new FirebaseConfig(config, store);
  const fcm = new FcmSender(firebase, store, opts.fcmFetch, (msg, extra) => app.log.warn(extra ?? {}, msg));
  const push = new PushService({
    store,
    fcm,
    transport: opts.pushTransport ?? createPushTransport(vapid, config.vapidSubject),
    isUserActive: (userId) => live.isUserActive(userId),
    onNoSubscriptions: (userId) => pool.setBackground(userId, false),
    unreadCount: async (userId) => {
      const folders = await Promise.all(store.listAccounts(userId).map((a) => mail.listFolders(userId, a.id)));
      return folders.some((f) => f.error) ? null : inboxUnread(folders);
    },
    unreadInInbox: (userId, accountId, uidValidity, uids) =>
      pool.withMailbox(userId, accountId, 'INBOX', async (client, mailbox) => {
        if (mailbox.uidValidity.toString() !== uidValidity) return new Set<number>();
        return new Set((await client.search({ uid: uids.join(','), seen: false }, { uid: true })) || []);
      }),
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
  });
  /** The same notification Web Push gets, to open sessions (shown by the desktop app). */
  const liveNotify = (
    userId: string,
    accountId: string,
    build: (account: { id: string; name: string }, content: NotificationContent) => NotificationPayload | null,
  ) => {
    const user = store.getUser(userId);
    const account = store.listAccounts(userId).find((a) => a.id === accountId);
    const n = user && account ? build(account, user.preferences.notificationContent) : null;
    if (n) pool.onEvent(userId, { type: 'notify', accountId, title: n.title, body: n.body, tag: n.tag, url: n.url });
  };
  const snooze = new SnoozeService({
    store,
    mail,
    maxMessageBytes: config.maxMessageBytes,
    notify: (userId, accountId, messages) => {
      liveNotify(userId, accountId, (account, content) => buildSnoozeNotification(account, messages, content));
      return push.notifySnoozeEnded(userId, accountId, messages);
    },
    emit: (userId, event) => pool.onEvent(userId, event),
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
  });
  // AI mailbox assistant: acts on new mail before it becomes a notification.
  const access = new Access(config, store);
  const assistantStore = new AssistantStore(store);
  const aiClient = new AiClient(opts.aiFetch);
  const blocklist = new Blocklist({ store, pool, mail });
  // Send later / undo send: due messages are sent by the server.
  const scheduled = new ScheduledSends(store, (userId, payload, files) => compose.send(userId, payload, files), (msg, extra) => app.log.warn(extra ?? {}, msg));
  scheduled.start();
  app.addHook('onClose', async () => scheduled.stop());
  // Auto-replies (out of office, …): sent by the server to new mail in the mailboxes they cover.
  const autoReplies = new AutoReplies({ store, pool, send: (userId, accountId, r) => compose.sendAutoReply(userId, accountId, r), log: (msg, extra) => app.log.warn(extra ?? {}, msg) });
  const assistant = new AssistantEngine({
    store,
    ai: assistantStore,
    client: aiClient,
    pool,
    mail,
    access,
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
    alsoWatch: () => [...blocklist.users(), ...autoReplies.users()],
    // Forwarding, reply drafts and Outlook categories (compose and Microsoft sign-in are made below).
    outgoing: assistantOutgoing({ store, mail, compose: () => compose, microsoft: { addCategory: (...a: Parameters<MicrosoftAuth['addCategory']>) => microsoft.addCategory(...a) } as MicrosoftAuth, maxMessageBytes: config.maxMessageBytes }),
  });
  pool.onNewMail = (userId, accountId, messages) => {
    // Snoozed mail coming back gets its own notification from the snooze service.
    let fresh = messages.filter((m) => !snooze.wasResurfaced(userId, accountId, m.messageId));
    if (fresh.length === 0) return;
    void (async () => {
      // Blocked senders go to Junk first, without a notification.
      const unblocked = await blocklist.handleNew(userId, accountId, fresh).catch(() => fresh.map((m) => m.uid));
      fresh = fresh.filter((m) => unblocked.includes(m.uid));
      if (fresh.length === 0) return;
      // Auto-replies read the headers before anything moves the mail; they send in the background.
      await autoReplies.handleNew(userId, accountId, fresh).catch((err: Error) => app.log.warn({ accountId, error: err.message }, 'auto-reply check failed'));
      // Mail the assistant moves out of the inbox doesn't need a notification.
      const stays = await assistant.handleNew(userId, accountId, fresh.map((m) => m.uid)).catch(() => null);
      if (stays) fresh = fresh.filter((m) => stays.includes(m.uid));
      // Learning mode looks at what stayed in the inbox, without holding up the notification.
      void assistant.learnArrivals(userId, accountId, fresh.map((m) => m.uid)).catch(() => undefined);
      if (fresh.length === 0 || !pool.notifiesNewMail(userId)) return;
      liveNotify(userId, accountId, (account, content) => buildNotification(account, fresh, content));
      if (!store.notifiesFor(userId, accountId)) return; // its group's notifications are off
      await push.notifyNewMail(userId, accountId, fresh);
    })();
  };
  // Mail read (or moved away) elsewhere: close its notifications on the user's devices.
  pool.onInboxChanged = (userId, accountId) => push.inboxChanged(userId, accountId);
  // Outlook / Microsoft 365: sign in with Microsoft; IMAP gets OAuth tokens, sending goes through Graph.
  const microsoftConfig = new MicrosoftConfig(config, store);
  const microsoft = new MicrosoftAuth(microsoftConfig, store, config.baseUrl, opts.microsoftFetch);
  // Gmail with Sign in with Google: IMAP and SMTP with OAuth.
  const googleConfig = new GoogleConfig(config, store);
  const google = new GoogleAuth(googleConfig, store, config.baseUrl, opts.googleFetch);
  setOAuthTokenProvider((o) => (o.provider === 'google' ? google.accessToken(o.userId, o.accountId) : microsoft.accessToken(o.userId, o.accountId, 'imap')));
  const compose = new ComposeService(store, mail, {
    maxMessageBytes: config.maxMessageBytes,
    blockPrivateHosts: config.blockPrivateMailHosts,
    graphSend: (userId, accountId, raw) => microsoft.sendRaw(userId, accountId, raw),
    smtpToken: (userId, accountId) => google.accessToken(userId, accountId),
    smime,
    onSent: (userId, accountId, recipients) => addressBook.sent(userId, accountId, recipients),
  });
  const calendars = new CalendarService({
    store,
    google,
    microsoft,
    mail,
    compose,
    http: opts.calendarFetch ?? (fetch as unknown as Http),
    blockPrivateHosts: config.blockPrivateMailHosts,
    maxMessageBytes: config.maxMessageBytes,
  });
  // Event reminders: notifications on every device and the reminder window, sent by the server.
  const followups = new Followups(store);
  // Meeting rooms: Microsoft 365's and the administrator's list (DreyMail 10.7).
  const rooms = new Rooms({ store, microsoft });
  // Contacts and tasks: DreyMail's own, Outlook and Google (DreyMail 10.4).
  const people = new People({ store, microsoft, google });
  const reminders = new Reminders({
    store,
    calendars,
    followups,
    push: (userId, payload) => push.notifyReminder(userId, payload),
    emit: (userId, event) => pool.onEvent(userId, event),
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
  });
  reminders.start();
  app.addHook('onClose', async () => reminders.stop());

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 50, fieldSize: 6 * 1024 * 1024 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // How long requests take, for Settings → Server → Speed (DreyMail 14.5).
  const speed = new SpeedStats();
  app.addHook('onResponse', async (req, reply) => {
    const metric = speedMetricOf(req.method, req.routeOptions.url, (req.query ?? {}) as Record<string, unknown>, reply.statusCode);
    if (metric) speed.record(metric, reply.elapsedTime);
  });
  const indexFile = path.join(config.webDir, 'index.html');
  const appCsp = cspFor(fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : null);
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', appCsp);
    return payload;
  });

  app.get('/healthz', async () => ({ ok: true }));

  const login = new LoginSettings(config, store);
  await registerAuthRoutes(app, config, store, sessions, login);
  await registerApiRoutes(app, {
    speed,
    config,
    store,
    sessions,
    followups,
    onFollowupsChanged: (userId) => reminders.changed(userId),
    directory: new Directory({ store, microsoft, google }),
    people,
    smime,
    pool,
    mail,
    compose,
    push,
    snooze,
    vapidPublicKey: vapid.publicKey,
    pushHostCheck: opts.pushHostCheck,
    fetchImage: opts.fetchImage,
    avatars: opts.avatars,
    updates: opts.updates,
    access,
    onAction: (userId, accountId, folder, uids, action) => assistant.observeAction(userId, accountId, folder, uids, action),
    blocklist,
    onBlocklistChanged: (userId) => assistant.syncWatching(userId),
    scheduled,
    addressBook,
  });
  await registerAdminRoutes(app, {
    config,
    store,
    sessions,
    access,
    login,
    serverSettings,
    rooms,
    pool,
    mail,
    firebase,
    storage: {
      cache,
      files: [
        { name: DB_FILE, path: opts.store ? null : path.join(config.dataDir, DB_FILE) },
        ...(cache ? [{ name: 'cache.db', path: cacheFile }] : []),
      ],
    },
    onAiAccess: (id) => assistant.syncWatching(id),
    speed,
  });
  registerAndroidPushRoutes(app, { store, pool, firebase });
  registerMicrosoftRoutes(app, { config, store, sessions, access, microsoft, microsoftConfig, onSignedIn: (userId, accountId) => calendars.signedIn(userId, accountId) });
  registerGoogleRoutes(app, { config, store, sessions, access, google, googleConfig });
  registerPasskeyRoutes(app, { config, store, sessions });
  registerCalendarRoutes(app, { store, calendars, reminders, rooms });
  registerPeopleRoutes(app, { people });
  // Search and storage (DreyMail 12.3): each mailbox's share of the user's cache space, what it
  // uses, and how far its search index has got.
  app.get('/api/cache/usage', async (req) => {
    const userId = req.user!.id;
    const accounts = store.listAccounts(userId);
    const shares = cacheShares(accounts.map((a) => a.id), req.user!.preferences.cacheSplit);
    return {
      enabled: !!(cache && cacheSync),
      userMb: cacheBudget.userMb(),
      split: req.user!.preferences.cacheSplit ?? { mode: 'even', shares: {} },
      accounts: accounts.map((a) => ({
        accountId: a.id,
        share: shares.get(a.id) ?? 0,
        budget: cacheBudget.accountBytes(userId, a.id),
        used: cache ? cache.accountBytes(userId, a.id) : { messages: 0, bodies: 0, index: 0, total: 0, count: 0, indexed: 0 },
        indexing: !!cacheSync?.isIndexing(userId, a.id),
        coverage: cache ? cache.searchCoverage(userId, a.id) : { folders: 0, instant: 0 },
      })),
    };
  });
  // Shares changed: shrink what is over, and fill the index where there is room now.
  app.post('/api/cache/rebalance', async (req) => {
    const userId = req.user!.id;
    for (const a of store.listAccounts(userId)) {
      cacheSync?.enforceBudget(userId, a.id);
      cacheSync?.indexAccount(userId, a.id);
    }
    return { ok: true };
  });

  // Backups (DreyMail 11.9): the user's own file, and daily copies of the database in <data>/backups.
  const backupDays = () => {
    const raw = process.env.DREYMAIL_BACKUP_DAYS ?? storedServerSettings(store).DREYMAIL_BACKUP_DAYS ?? '';
    const n = raw === '' ? 7 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 365) : 7;
  };
  const snapshots = new Snapshots({ db: store.db, dir: opts.store ? null : path.join(config.dataDir, 'backups'), keepDays: backupDays, log: (m) => app.log.info(m) });
  registerBackupRoutes(app, {
    store,
    credentialKey: keyring.credentialKey,
    snapshots,
    access,
    version: serverVersion(),
    keepDays: backupDays,
    onRestored: (userId, summary) => {
      for (const id of summary.accountIds) {
        pool.invalidate(userId, id);
        mail.forgetFolders(userId, id);
      }
    },
  });
  const backupTimer = setInterval(() => snapshots.tick(), 3600_000);
  backupTimer.unref();
  setTimeout(() => snapshots.tick(), 60_000).unref();
  app.addHook('onClose', async () => clearInterval(backupTimer));
  registerAutoReplyRoutes(app, { autoReplies, onChanged: (userId) => assistant.syncWatching(userId) });
  registerAssistantRoutes(app, { store, ai: assistantStore, engine: assistant, client: aiClient, access });
  assistant.syncWatching();
  // Learning periods end on their own: stop watching inboxes that no longer need it.
  const learningTimer = setInterval(() => assistant.syncWatching(), 3600_000);
  learningTimer.unref();
  app.addHook('onClose', async () => clearInterval(learningTimer));
  live = await registerWebSocket(app, config, store, sessions, pool);
  // New mail and other changes make the remembered unread counts out of date.
  const sendEvent = pool.onEvent;
  pool.onEvent = (userId, event) => {
    if (event.type === 'mailbox' || event.type === 'reset') mail.foldersChanged(userId, event.accountId);
    sendEvent(userId, event);
  };
  // Folder lists of the mailboxes people are using are kept current in the background (three
  // mail servers at a time), so the sidebar shows right away on any device.
  let refreshingFolders = false;
  const folderTimer = setInterval(() => {
    if (refreshingFolders) return;
    refreshingFolders = true;
    const jobs = pool.watchedUserIds().flatMap((userId) => store.listAccounts(userId).map((a) => [userId, a.id] as const));
    const next = async (): Promise<void> => {
      const job = jobs.shift();
      if (!job) return;
      await mail.refreshFolders(job[0], job[1]);
      return next();
    };
    void Promise.all([next(), next(), next()]).finally(() => (refreshingFolders = false));
  }, 5 * 60_000);
  folderTimer.unref();
  app.addHook('onClose', async () => clearInterval(folderTimer));

  // Static frontend (production build). In development Vite serves the UI and proxies /api.
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      wildcard: false,
      index: ['index.html'],
      // Compressed at build (scripts/compress-web.mjs), sent to browsers that accept it (DreyMail 14.4).
      preCompressed: true,
      // Files under assets/ have their content's hash in their name: a browser keeps them for good
      // instead of asking the server again on every start (DreyMail 14.4).
      setHeaders: (res, file) => {
        if (/[/\\]assets[/\\]/.test(file)) res.header('cache-control', 'public, max-age=31536000, immutable');
        // Pages name the current assets: always checked again.
        else if (file.endsWith('.html')) res.header('cache-control', 'no-cache');
      },
    });
    // The privacy page Google and Microsoft app registrations link to (https://your-dreymail/privacy).
    app.get('/privacy', async (_req, reply) => reply.header('cache-control', 'no-cache').sendFile('privacy.html'));
    app.setNotFoundHandler((req, reply) => {
      if (isSpaRequest(req.method, req.url, req.headers.accept)) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  // Users with notifications on some device are watched even while no browser is open.
  app.addHook('onReady', async () => {
    cache?.prune(store.allAccountKeys());
    for (const userId of store.pushUserIds()) pool.setBackground(userId, true);
    // Also wakes messages whose snooze ended while the server was down.
    snooze.start();
  });

  app.addHook('onClose', async () => {
    await snooze.stop();
    await cacheSync?.stop();
    await pool.close();
    cache?.close();
    if (!opts.store) store.close();
  });

  return { app, store, pool, mail, cache, cacheSync, push, snooze, microsoft, google };
}
