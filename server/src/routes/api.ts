// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: unifiedInbox preference validation.
// Modified by samschultzponsys, 2026-11-13: signature API (list, create, update, delete).
// Modified by samschultzponsys, 2026-11-13: Me.admin.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-13: your name; interface size.
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.
// Modified by samschultzponsys, 2026-11-15: Outlook / Microsoft 365 accounts (Microsoft sign-in, Graph sending).
// Modified by samschultzponsys, 2026-11-15: Sign in with Google for Gmail.
// Modified by samschultzponsys, 2026-11-15: search filters, all-mail search and saved searches.
// Modified by samschultzponsys, 2026-11-15: roles and permissions; profile pictures.
// Modified by samschultzponsys, 2026-11-15: mailbox icons.
// Modified by samschultzponsys, 2026-11-15: unsubscribe and blocked senders.
// Modified by samschultzponsys, 2026-11-15: send later and undo send.
// Modified by samschultzponsys, 2026-11-15: choose what the bottom left shows (photo, name or both).
// Modified by samschultzponsys, 2026-11-15: your own picture as a mailbox icon.
// Modified by samschultzponsys, 2026-11-15: AI assistant learning mode.
// Modified by samschultzponsys, 2026-11-15: automatic inbox tabs.
// Modified by samschultzponsys, 2026-11-16: notifications can show the start of the message.
// Modified by samschultzponsys, 2026-11-16: provider icon from a list or any website.
// Modified by samschultzponsys, 2026-11-16: signatures up to 1.5 MB, pictures included.
// Modified by samschultzponsys, 2026-11-16: buttons pinned to each message (preference).
// Modified by samschultzponsys, 2026-11-16: sidebar order by dragging.
// Modified by samschultzponsys, 2026-11-16: group pictures; right-click a group to edit it.
// Modified by samschultzponsys, 2026-11-17: Not spam (unblocks the sender).
// Modified by samschultzponsys, 2026-11-17: address suggestions per mailbox, group or all.
// Modified by samschultzponsys, 2026-11-17: the idle app lock and trusted devices (sliding sessions).
// Modified by samschultzponsys, 2026-11-17: Gmail labels of a message.

import { normaliseBlock, type Blocklist } from '../blocklist.js';
import type { AddressBook } from '../addressBook.js';
import type { ScheduledSends } from '../mail/scheduled.js';
import { oneClickUnsubscribe } from '../net/unsubscribe.js';
import { isMailboxIcon } from '../../../shared/mailboxIcons.js';
import { PROVIDER_CHOICES, providerByKey, providerIcon, providerSite } from '../net/siteIcon.js';
import { isFreemail } from '../net/avatars.js';
import { MAIL_PROVIDERS, MICROSOFT_DOMAINS } from '../../../shared/mailProviders.js';

const PUBLIC_MAIL_DOMAINS = new Set([...MAIL_PROVIDERS.flatMap((p) => p.domains), ...MICROSOFT_DOMAINS]);
/** gmail.com, outlook.com, yahoo.com…: shared by everyone. */
const isPublicMailDomain = (d: string) => PUBLIC_MAIL_DOMAINS.has(d) || isFreemail(d);
import { decodeFilters, normalizeFilters } from '../../../shared/search.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountInput, ActionResult, ComposePayload, Me, MessageAction, MessageRef, VersionInfo } from '../../../shared/types.js';
import { DEFAULT_MESSAGE_BUTTONS, MESSAGE_BUTTONS, type MessageButton } from '../../../shared/types.js';
import { DEFAULT_ADDRESS_LINES } from '../../../shared/addressLines.js';
import { accountDefaultsFor, withDefaultPassword, type TemplateValues } from '../accountDefaults.js';
import type { Config } from '../config.js';
import type { Store, User } from '../db.js';
import { connectImap, MailServerError, testConnection } from '../imap/connect.js';
import { MessageGoneError, StaleError, type ListSource, type MailService } from '../imap/mail.js';
import { NotFoundError, type ImapPool } from '../imap/pool.js';
import { AvatarService, normaliseEmail } from '../net/avatars.js';
import { RemoteImageCache, type RemoteImage } from '../net/remoteImages.js';
import { displayDomain, MAX_ALLOWED_DOMAINS, normaliseDomain } from '../mail/imageAllowlist.js';
import { FailureLimiter, hashPassword, passwordSchema, verifyPassword } from '../auth/password.js';
import { TRUSTED_TTL, type Sessions } from '../auth/session.js';
import { ComposeError, type ComposeService } from '../mail/send.js';
import { sanitizeOutgoingHtml } from '../mail/compose.js';
import type { Access } from '../access.js';
import { gravatarEmail, parsePicture, PictureError, pictureUrl } from '../profilePicture.js';
import { isNewer, readChangelog, serverVersion, UpdateChecker } from '../version.js';
import { SnoozeError, type SnoozeService } from '../mail/snooze.js';
import { PushSubscriptionError, validateSubscription, type PushService } from '../push/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

// ---- validation schemas -----------------------------------------------------

const tls = z.enum(['tls', 'starttls', 'none']);
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.\-:[\]]+$/, 'Invalid host name');
const server = z.object({
  host,
  port: z.coerce.number().int().min(1).max(65535),
  tls,
  user: z.string().max(320),
  password: z.string().max(1024).optional(),
});
const accountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  displayName: z.string().trim().max(200),
  email: z.string().trim().min(3).max(320),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  icon: z.string().max(40).optional(),
  threaded: z.boolean().optional(),
  imap: server,
  smtp: server,
  appendSent: z.boolean(),
});

const refSchema = z.object({
  accountId: z.string().min(1).max(64),
  folder: z.string().min(1).max(1000),
  uid: z.coerce.number().int().positive(),
  uidValidity: z.string().regex(/^\d+$/),
});

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('seen'), value: z.boolean() }),
  z.object({ type: z.literal('flagged'), value: z.boolean() }),
  z.object({ type: z.literal('move'), destination: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('archive') }),
  z.object({ type: z.literal('delete') }),
  z.object({ type: z.literal('snooze'), until: z.string().max(64) }),
  z.object({ type: z.literal('unsnooze') }),
  z.object({ type: z.literal('notJunk') }),
  z.object({ type: z.literal('junk') }),
]);

const swipe = z.enum(['none', 'delete', 'archive', 'toggleRead', 'toggleFlag']);
export const prefsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  pageSize: z.number().int().min(10).max(200),
  markReadOnOpen: z.boolean(),
  swipeLeft: swipe,
  swipeRight: swipe,
  notificationContent: z.enum(['full', 'preview', 'minimal']).default('full'),
  screenTransitions: z.enum(['off', 'fast', 'medium', 'slow']).default('fast'),
  contactPhotos: z.boolean().default(true),
  unifiedInbox: z.boolean().default(true),
  showFullName: z.boolean().default(false),
  footerIdentity: z.enum(['both', 'name', 'photo']).default('both'),
  inboxTabs: z.boolean().default(true),
  imagesOwnDomains: z.boolean().default(true),
  imagesContacts: z.boolean().default(true),
  imagesSenderHosted: z.boolean().default(false),
  sidebarCalendar: z.boolean().default(true),
  sidebarScheduled: z.boolean().default(true),
  sidebarSearches: z.boolean().default(true),
  suggestScope: z.enum(['all', 'mailbox', 'group', 'chosen']).default('all'),
  suggestAccounts: z.array(z.string().max(64)).max(200).default([]),
  addressLines: z
    .object({
      all: z.object({ cc: z.boolean(), bcc: z.boolean() }),
      groups: z.record(z.string().max(64), z.object({ cc: z.boolean().optional(), bcc: z.boolean().optional() })),
      accounts: z.record(z.string().max(64), z.object({ cc: z.boolean().optional(), bcc: z.boolean().optional() })),
    })
    .default(DEFAULT_ADDRESS_LINES),
  collapsedFolders: z
    .record(z.string().max(64), z.array(z.string().max(1000)).max(500))
    .refine((r) => Object.keys(r).length <= 200)
    .default({}),
  messageButtons: z.array(z.enum(MESSAGE_BUTTONS as [MessageButton, ...MessageButton[]])).max(MESSAGE_BUTTONS.length).default([...DEFAULT_MESSAGE_BUTTONS]),
  // Up to 10 minutes: longer than that is what Send later is for.
  undoSendSeconds: z.number().int().min(0).max(600).default(10),
});

/** Collapses spaces and, for all-lowercase input, capitalises each word. Mixed case is kept (McDonald). */
export function capitalizeName(input: string): string {
  const name = input.replace(/\s+/g, ' ').trim();
  return name === name.toLowerCase() ? name.replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase()) : name;
}

export const signatureSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Pictures are kept inside the signature (data: URLs), e.g. an animated logo: room for them.
  html: z.string().max(1_500_000, 'This signature is too big to save (1.5 MB at most, pictures included). Use smaller pictures.'),
  accountIds: z.array(z.string().max(100)).max(100),
  onReplies: z.boolean().default(true),
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

const composeSchema = z.object({
  accountId: z.string().min(1).max(64),
  to: z.string().max(10_000),
  cc: z.string().max(10_000),
  bcc: z.string().max(10_000),
  subject: z.string().max(1000),
  html: z.string().max(5_000_000),
  inReplyTo: z.string().max(1000).nullable(),
  references: z.array(z.string().max(1000)).max(100),
  forwardFrom: refSchema.extend({ indices: z.array(z.number().int().min(0)).max(100) }).nullable(),
  replaceDraft: refSchema.nullable(),
  answering: refSchema.nullable(),
});

// ---- helpers ------------------------------------------------------------------

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }
  if (err instanceof NotFoundError || err instanceof MessageGoneError) return reply.code(404).send({ error: err.message });
  if (err instanceof StaleError) return reply.code(409).send({ error: err.message, stale: true });
  if (err instanceof ComposeError || err instanceof PushSubscriptionError || err instanceof SnoozeError) return reply.code(400).send({ error: err.message });
  if (err instanceof MailServerError) return reply.code(502).send({ error: err.message });
  reply.log.error({ err }, 'request failed');
  return reply.code(500).send({ error: 'Internal error' });
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface ApiDeps {
  config: Config;
  store: Store;
  sessions: Sessions;
  pool: ImapPool;
  mail: MailService;
  compose: ComposeService;
  push: PushService;
  snooze: SnoozeService;
  /** VAPID public key, the browser's applicationServerKey. */
  vapidPublicKey: string;
  /** Replaces the DNS check of push service hosts (tests only). */
  pushHostCheck?: (host: string) => Promise<void>;
  /** Replaces the real remote image fetcher (tests only). */
  fetchImage?: (url: string) => Promise<RemoteImage>;
  /** Replaces the contact picture lookup (tests only). */
  avatars?: AvatarService;
  access: Access;
  /** A message action is about to run (the AI assistant's learning mode notes it; returns at once otherwise). */
  onAction?: (userId: string, accountId: string, folder: string, uids: number[], action: MessageAction) => Promise<void>;
  /** Replaces the GitHub release check (tests only). */
  updates?: Pick<UpdateChecker, 'get'>;
  blocklist?: Blocklist;
  onBlocklistChanged?: (userId: string) => void;
  scheduled?: ScheduledSends;
  addressBook?: AddressBook;
}

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps) {
  const { config, store, sessions, pool, mail, compose, push, snooze, vapidPublicKey, pushHostCheck, fetchImage, access } = deps;
  const avatars = deps.avatars ?? new AvatarService();

  app.decorateRequest('user', null);

  // Authentication + CSRF protection for the whole /api namespace.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const full = sessions.readWithExpiry(req);
    const user = full ? store.getUser(full.data.uid) : null;
    if (!full || !user) return reply.code(401).send({ error: 'Not logged in' });
    req.user = user;
    // DreyMail: the idle app lock and trusted devices (sliding sessions).
    let s = full.data;
    let changed = false;
    const now = Date.now();
    if (s.lockAfter && !s.locked && s.seen && now - s.seen > s.lockAfter * 60_000) {
      s = { ...s, locked: true };
      changed = true;
    }
    if (s.trusted && full.exp - now / 1000 < TRUSTED_TTL - 86_400) changed = true;
    if (changed) sessions.rewrite(reply, s, full.exp);
    if (s.locked && !req.url.startsWith('/api/session')) return reply.code(423).send({ error: 'DreyMail is locked', locked: true });
    // State-changing requests must carry a custom header. Browsers only allow that from our own
    // origin (it would require a CORS preflight, which we never grant).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-dreymail'] !== '1') {
      return reply.code(403).send({ error: 'Missing CSRF header' });
    }
  });

  const uid = (req: FastifyRequest) => req.user!.id;
  /** Values for {username}, {email} and {name} in the admin's default account settings. */
  const templateValues = (u: User): TemplateValues => ({
    // OIDC providers don't always send a preferred_username; the email's local part is the next best thing.
    username: u.username || (u.email.includes('@') ? u.email.slice(0, u.email.lastIndexOf('@')) : ''),
    email: u.email,
    name: u.name,
  });
  const ownsAccount = (userId: string, accountId: string) => store.listAccounts(userId).some((a) => a.id === accountId);
  const requireAccount = (userId: string, accountId: string) => {
    if (!ownsAccount(userId, accountId)) throw new NotFoundError('Account not found');
  };
  // Fetched remote images, shared across requests (per-user keys, short TTL, size-capped).
  const imageCache = new RemoteImageCache();
  /** When a message in a Snoozed folder comes back, as an ISO time (undefined if not snoozed). */
  const snoozedUntil = (userId: string) => {
    const cache = new Map<string, Map<number, number>>();
    return (m: MessageRef): string | undefined => {
      const k = `${m.accountId}\u0000${m.folder}\u0000${m.uidValidity}`;
      let byUid = cache.get(k);
      if (!byUid) cache.set(k, (byUid = store.snoozesIn(userId, m.accountId, m.folder, m.uidValidity)));
      const t = byUid.get(m.uid);
      return t === undefined ? undefined : new Date(t).toISOString();
    };
  };

  // ---- me / preferences -----------------------------------------------------

  app.get('/api/me', async (req): Promise<Me> => {
    const u = req.user!;
    return {
      id: u.id,
      name: u.displayName || u.name,
      displayName: u.displayName,
      email: u.email,
      preferences: u.preferences,
      hasPassword: u.hasPassword,
      accountDefaults: accountDefaultsFor(config.accountDefaults, templateValues(u)),
      role: access.superadminByEnv(u) ? { id: 'superadmin', name: 'Superadmin' } : { id: u.roleId, name: store.getRole(u.roleId)?.name ?? 'User' },
      permissions: access.permissions(u),
      avatar: pictureUrl(store, u),
      gravatar: u.gravatar,
      hasPicture: u.avatarVersion > 0,
    };
  });

  // ---- profile pictures (DreyMail) ----------------------------------------------------

  /** Anyone signed in may see a user's picture (for lists of users, shared calendars, ...). */
  app.get<{ Params: { id: string } }>('/api/users/:id/picture', async (req, reply) => {
    const user = store.getUser(req.params.id);
    if (!user) return reply.code(404).send({ error: 'No picture' });
    const own = store.getAvatar(user.id);
    let img: { contentType: string; body: Buffer } | null = own ? { contentType: own.type, body: own.body } : null;
    if (!img && user.gravatar) {
      const email = gravatarEmail(store, user);
      const found = email ? await avatars.lookup(user.id, email.toLowerCase()) : null;
      img = found ? { contentType: found.contentType, body: Buffer.from(found.body) } : null;
    }
    // Versioned URLs: an uploaded picture never changes under its URL.
    reply.header('cache-control', own ? 'private, max-age=31536000, immutable' : `private, max-age=${img ? 86400 : 600}`);
    if (!img) return reply.code(404).send({ error: 'No picture' });
    return reply.header('content-type', img.contentType).header('content-security-policy', "default-src 'none'; sandbox").send(img.body);
  });

  const pictureSchema = z.object({ image: z.string().max(500_000) });
  app.put('/api/me/picture', async (req, reply) => {
    if (!access.require(req, reply, 'profile.picture', 'users.pictures')) return reply;
    const body = pictureSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid picture' });
    try {
      store.setAvatar(uid(req), parsePicture(body.data.image));
    } catch (err) {
      if (err instanceof PictureError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return { avatar: pictureUrl(store, store.getUser(uid(req))!) };
  });
  app.delete('/api/me/picture', async (req, reply) => {
    if (!access.require(req, reply, 'profile.picture', 'users.pictures')) return reply;
    store.setAvatar(uid(req), null);
    return { avatar: pictureUrl(store, store.getUser(uid(req))!) };
  });
  app.put('/api/me/gravatar', async (req, reply) => {
    if (!access.require(req, reply, 'profile.picture', 'users.pictures')) return reply;
    const body = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    store.setGravatar(uid(req), body.data.on);
    return { avatar: pictureUrl(store, store.getUser(uid(req))!) };
  });

  // ---- version and changelog (DreyMail) ----------------------------------------------

  const version = serverVersion();
  const updates = deps.updates ?? new UpdateChecker(config.updateCheck);
  let changelog: string | null = null;
  app.get('/api/version', async (req): Promise<VersionInfo> => {
    const latest = access.can(req.user!, 'updates.view') ? await updates.get() : null;
    return { version, update: latest && isNewer(latest.version, version) ? latest : null };
  });
  app.get('/api/changelog', async () => ({ markdown: (changelog ??= readChangelog()) }));

  /** Settings → General → Your name. Lowercase input is capitalised ("sam schultz" → "Sam Schultz"). */
  app.put('/api/me/name', async (req, reply) => {
    const body = z.object({ name: z.string().max(100) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Name is too long' });
    const name = capitalizeName(body.data.name);
    store.setDisplayName(uid(req), name);
    return { name };
  });

  const passwordChangeSchema = z.object({ current: z.string().max(1000), next: passwordSchema });
  const passwordFailures = new FailureLimiter(10, 15 * 60 * 1000);

  app.put('/api/password', async (req, reply) => {
    const userId = uid(req);
    const stored = store.getPasswordHash(userId);
    if (!stored) return reply.code(400).send({ error: 'This account signs in with single sign-on' });
    const body = passwordChangeSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]!.message });
    if (passwordFailures.blocked(userId)) return reply.code(429).send({ error: 'Too many failed attempts. Try again in a few minutes.' });
    if (!(await verifyPassword(body.data.current, stored))) {
      passwordFailures.fail(userId);
      return reply.code(403).send({ error: 'Current password is wrong' });
    }
    passwordFailures.reset(userId);
    store.setPasswordHash(userId, await hashPassword(body.data.next));
    return { ok: true };
  });

  app.put('/api/preferences', async (req, reply) => {
    try {
      const prefs = prefsSchema.parse(req.body);
      store.setPreferences(uid(req), prefs);
      // The user's other devices (browser tabs, desktop and Android apps) pick the change up now.
      pool.onEvent(uid(req), { type: 'preferences' });
      return prefs;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Web Push (phone notifications) -------------------------------------------

  app.get('/api/push', async () => ({ publicKey: vapidPublicKey }));

  app.post('/api/push/subscriptions', async (req, reply) => {
    try {
      const sub = pushSubscriptionSchema.parse(req.body);
      await validateSubscription(sub, pushHostCheck);
      store.addPushSubscription(uid(req), sub);
      pool.setBackground(uid(req), true, true);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/push/subscriptions', async (req, reply) => {
    try {
      const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(req.body);
      store.removePushSubscription(uid(req), endpoint);
      if (store.listPushSubscriptions(uid(req)).length === 0) pool.setBackground(uid(req), false);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/push/test', async (req) => ({ delivered: await push.sendTest(uid(req)) }));

  // ---- sender domains allowed to show images ----------------------------------

  const domainBody = z.object({ domain: z.string().max(400) });
  const parseDomain = (raw: string) => {
    const domain = normaliseDomain(raw);
    if (!domain) throw new ComposeError('Not a valid domain name');
    return domain;
  };
  const listDomains = (userId: string) => store.listImageDomains(userId).map(displayDomain);

  app.get('/api/image-domains', async (req) => listDomains(uid(req)));

  app.post('/api/image-domains', async (req, reply) => {
    try {
      const domain = parseDomain(domainBody.parse(req.body).domain);
      if (!store.addImageDomain(uid(req), domain, MAX_ALLOWED_DOMAINS)) {
        throw new ComposeError(`You can allow at most ${MAX_ALLOWED_DOMAINS} domains`);
      }
      return listDomains(uid(req));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { domain: string } }>('/api/image-domains/:domain', async (req, reply) => {
    try {
      if (!store.removeImageDomain(uid(req), parseDomain(req.params.domain))) {
        return reply.code(404).send({ error: 'Domain not in the list' });
      }
      return listDomains(uid(req));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- accounts ---------------------------------------------------------------

  app.get('/api/accounts', async (req) => store.listAccounts(uid(req)));

  // ---- signatures (DreyMail) -------------------------------------------------------

  app.get('/api/signatures', async (req) => store.listSignatures(uid(req)));

  const saveSignature = (req: FastifyRequest, reply: FastifyReply, id: string | null) => {
    try {
      const input = signatureSchema.parse(req.body);
      const saved = store.saveSignature(uid(req), id, { ...input, html: sanitizeOutgoingHtml(input.html) });
      return saved ?? reply.code(404).send({ error: 'Signature not found' });
    } catch (err) {
      return sendError(reply, err);
    }
  };
  app.post('/api/signatures', async (req, reply) => saveSignature(req, reply, null));
  app.put<{ Params: { id: string } }>('/api/signatures/:id', async (req, reply) => saveSignature(req, reply, req.params.id));
  app.delete<{ Params: { id: string } }>('/api/signatures/:id', async (req, reply) =>
    store.deleteSignature(uid(req), req.params.id) ? { ok: true } : reply.code(404).send({ error: 'Signature not found' }),
  );

  // ---- saved searches (DreyMail) ---------------------------------------------------

  const savedSearchSchema = z.object({
    name: z.string().trim().min(1).max(80),
    q: z.string().trim().max(500).default(''),
    unread: z.boolean().default(false),
    filters: z.unknown(),
    accountId: z.string().max(64).nullable().default(null),
    folder: z.string().max(1000).default('INBOX'),
  });
  app.get('/api/searches', async (req) => store.listSavedSearches(uid(req)));
  app.post('/api/searches', async (req, reply) => {
    const body = savedSearchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Give the search a name' });
    if (store.listSavedSearches(uid(req)).length >= 50) return reply.code(400).send({ error: 'You can keep up to 50 saved searches' });
    return store.saveSearch(uid(req), { ...body.data, filters: normalizeFilters(body.data.filters) });
  });
  app.delete<{ Params: { id: string } }>('/api/searches/:id', async (req, reply) =>
    store.deleteSavedSearch(uid(req), req.params.id) ? store.listSavedSearches(uid(req)) : reply.code(404).send({ error: 'Saved search not found' }),
  );

  /** A known icon key, else none. */
  const iconOf = (icon: string | undefined, accountId?: string, userId?: string) =>
    isMailboxIcon(icon) ? icon : icon === 'image' && accountId && userId && store.getAccountIconImage(userId, accountId) ? 'image' : '';

  const verify = async (input: AccountInput, existing?: { imap: string; smtp: string }) => {
    const imapPw = input.imap.password || existing?.imap || '';
    const smtpPw = input.smtp.password || existing?.smtp || imapPw;
    await testConnection(
      { ...input.imap, password: imapPw },
      { ...input.smtp, password: smtpPw },
      config.blockPrivateMailHosts,
    );
  };

  /** Folders pinned in the sidebar (a view preference: no mailbox permission needed). */
  app.put<{ Params: { id: string } }>('/api/accounts/:id/pinned', async (req, reply) => {
    const body = z.object({ folders: z.array(z.string().max(1000)).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    if (!store.setPinnedFolders(uid(req), req.params.id, body.data.folders)) return reply.code(404).send({ error: 'Account not found' });
    return { ok: true };
  });

  /** A mail provider's own icon for the mailbox icon picker ("Use Gmail's icon"). */
  // The icon of the provider for an address, of one picked from the list (provider=key), or of any
  // website (site=domain).
  app.get<{ Querystring: { email?: string; provider?: string; site?: string } }>('/api/provider-icon', async (req, reply) => {
    const email = (req.query.email ?? '').slice(0, 320);
    const site = req.query.provider
      ? providerByKey(req.query.provider.slice(0, 40))
      : req.query.site
        ? providerSite(`x@${req.query.site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]!.slice(0, 253)}`)
        : providerSite(email);
    if ((req.query.provider || req.query.site) && !site) return reply.code(400).send({ error: req.query.site ? 'Type a website, like example.com' : 'Unknown provider' });
    const found = await providerIcon(email, {}, site);
    if (!found) return reply.code(404).send({ error: "Couldn't find this provider's icon. Upload a picture instead." });
    return reply.header('content-type', found.image.contentType).header('x-provider-name', encodeURIComponent(found.name)).header('cache-control', 'private, max-age=86400').send(found.image.body);
  });

  app.get<{ Querystring: { email?: string } }>('/api/provider-icon/name', async (req) => ({ name: providerSite(req.query.email ?? '')?.name ?? null }));
  app.get('/api/provider-icon/providers', async () => PROVIDER_CHOICES);

  // ---- mailbox groups (DreyMail) ----------------------------------------------------------

  const groupSchema = z.object({
    name: z.string().trim().min(1).max(60),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    icon: z.string().max(40).refine((v) => v === '' || v === 'image' || isMailboxIcon(v), 'Unknown icon'),
    notify: z.boolean(),
    follow: z.boolean(),
    accountIds: z.array(z.string().max(64)).max(200),
  });

  app.get('/api/groups', async (req) => store.listGroups(uid(req)));

  // A group's own picture as its icon, like a mailbox's.
  app.get<{ Params: { id: string } }>('/api/groups/:id/icon', async (req, reply) => {
    const img = store.getGroupIconImage(uid(req), req.params.id);
    if (!img) return reply.code(404).send({ error: 'No picture' });
    return reply
      .header('content-type', img.type)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(img.body);
  });
  app.put<{ Params: { id: string } }>('/api/groups/:id/icon', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    const body = z.object({ image: z.string().max(500_000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid picture' });
    try {
      if (!store.setGroupIconImage(uid(req), req.params.id, parsePicture(body.data.image))) return reply.code(404).send({ error: 'Group not found' });
    } catch (err) {
      if (err instanceof PictureError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return store.listGroups(uid(req));
  });
  app.delete<{ Params: { id: string } }>('/api/groups/:id/icon', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    if (!store.setGroupIconImage(uid(req), req.params.id, null)) return reply.code(404).send({ error: 'Group not found' });
    return store.listGroups(uid(req));
  });

  // The sidebar's order (groups, mailboxes and which group each is in), as dragged there.
  const orderSchema = z.object({
    groups: z.array(z.string().max(64)).max(200),
    accounts: z.array(z.object({ id: z.string().max(64), groupId: z.string().max(64).nullable() })).max(200),
  });
  app.put('/api/sidebar-order', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    const body = orderSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid order' });
    store.reorderSidebar(uid(req), body.data.groups, body.data.accounts);
    return { groups: store.listGroups(uid(req)), accounts: store.listAccounts(uid(req)) };
  });

  app.post('/api/groups', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    const body = groupSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Give the group a name' });
    store.saveGroup(uid(req), body.data);
    return store.listGroups(uid(req));
  });

  app.put<{ Params: { id: string } }>('/api/groups/:id', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    const body = groupSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Give the group a name' });
    if (!store.saveGroup(uid(req), body.data, req.params.id)) return reply.code(404).send({ error: 'Group not found' });
    return store.listGroups(uid(req));
  });

  app.delete<{ Params: { id: string } }>('/api/groups/:id', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    if (!store.deleteGroup(uid(req), req.params.id)) return reply.code(404).send({ error: 'Group not found' });
    return store.listGroups(uid(req));
  });

  app.post('/api/accounts/test', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    try {
      const body = z.object({ account: accountSchema, id: z.string().optional() }).parse(req.body);
      const existing = body.id ? store.getAccountSecret(uid(req), body.id) : null;
      if (existing && existing.auth !== 'password') {
        // Outlook: reading over IMAP (with Microsoft sign-in) is what can be tested; sending goes through Graph.
        const client = await connectImap(existing.imap, { blockPrivateHosts: false });
        await client.logout().catch(() => client.close());
      } else if (existing) await verify(body.account, { imap: existing.imap.password, smtp: existing.smtp.password });
      else await verify(withDefaultPassword(config.accountDefaults, templateValues(req.user!), body.account));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/accounts', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    try {
      const input = withDefaultPassword(config.accountDefaults, templateValues(req.user!), accountSchema.parse(req.body));
      if (!input.imap.password) throw new ComposeError('IMAP password is required');
      await verify(input);
      const created = store.createAccount(uid(req), input);
      store.setAccountIcon(uid(req), created.id, iconOf(input.icon));
      if (input.threaded === false) store.setAccountThreaded(uid(req), created.id, false);
      pool.accountAdded(uid(req), created.id);
      return store.listAccounts(uid(req)).find((a) => a.id === created.id) ?? created;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    try {
      const input = accountSchema.parse(req.body);
      const existing = store.getAccountSecret(uid(req), req.params.id);
      if (!existing) throw new NotFoundError('Account not found');
      // Outlook / Google-signed-in accounts: only the label, name and colour can change here.
      if (input.threaded !== undefined) store.setAccountThreaded(uid(req), req.params.id, input.threaded);
      if (existing.auth !== 'password') {
        store.setAccountIcon(uid(req), req.params.id, iconOf(input.icon, req.params.id, uid(req)));
        return store.updateAccountLabels(uid(req), req.params.id, { name: input.name, displayName: input.displayName, color: input.color });
      }
      await verify(input, { imap: existing.imap.password, smtp: existing.smtp.password });
      store.updateAccount(uid(req), req.params.id, input);
      store.setAccountIcon(uid(req), req.params.id, iconOf(input.icon, req.params.id, uid(req)));
      const account = store.listAccounts(uid(req)).find((a) => a.id === req.params.id) ?? null;
      // Another server or login can mean another mailbox: cached mail no longer applies.
      if (existing.imap.host !== input.imap.host || existing.imap.port !== input.imap.port || existing.imap.user !== input.imap.user) {
        mail.forgetAccount(uid(req), req.params.id);
        deps.addressBook?.forgetAccount(uid(req), req.params.id);
      }
      pool.invalidate(uid(req), req.params.id);
      mail.forgetFolders(uid(req), req.params.id);
      return account;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    if (!store.deleteAccount(uid(req), req.params.id)) return reply.code(404).send({ error: 'Account not found' });
    mail.forgetAccount(uid(req), req.params.id);
    pool.invalidate(uid(req), req.params.id);
      mail.forgetFolders(uid(req), req.params.id);
    return { ok: true };
  });

  // ---- mailbox pictures (DreyMail) -------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/accounts/:id/icon', async (req, reply) => {
    const img = store.getAccountIconImage(uid(req), req.params.id);
    if (!img) return reply.code(404).send({ error: 'No picture' });
    return reply
      .header('content-type', img.type)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(img.body);
  });
  app.put<{ Params: { id: string } }>('/api/accounts/:id/icon', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    const body = z.object({ image: z.string().max(500_000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid picture' });
    try {
      if (!store.setAccountIconImage(uid(req), req.params.id, parsePicture(body.data.image))) return reply.code(404).send({ error: 'Account not found' });
    } catch (err) {
      if (err instanceof PictureError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return store.listAccounts(uid(req)).find((a) => a.id === req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/accounts/:id/icon', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    if (!store.setAccountIconImage(uid(req), req.params.id, null)) return reply.code(404).send({ error: 'Account not found' });
    return store.listAccounts(uid(req)).find((a) => a.id === req.params.id);
  });

  // ---- folders ----------------------------------------------------------------

  // ?accountId=: one mailbox's folders (the app asks per mailbox, so a slow one holds up no other).
  app.get<{ Querystring: { accountId?: string } }>('/api/folders', async (req) => {
    const accounts = store.listAccounts(uid(req)).filter((a) => !req.query.accountId || a.id === req.query.accountId);
    return Promise.all(accounts.map((a) => mail.listFolders(uid(req), a.id)));
  });

  // ---- message list -----------------------------------------------------------

  app.get('/api/messages', async (req, reply) => {
    try {
      const q = z
        .object({
          accountId: z.string().optional(),
          folder: z.string().max(1000).optional(),
          cursor: z.string().max(10_000).optional(),
          q: z.string().trim().max(500).optional(),
          unread: z.enum(['0', '1']).optional(),
          // Filter builder choices, JSON (see shared/search.ts).
          filter: z.string().max(4000).optional(),
          // 1: the user asked to refresh, so the cache must check with the IMAP server first.
          fresh: z.enum(['0', '1']).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query);
      const userId = uid(req);
      const filters = decodeFilters(q.filter);
      const where = filters.where ?? 'folder';
      // Accounts to look in: the filter's choice (the user's own only), else all of them.
      const own = store.listAccounts(userId).map((a) => a.id);
      const picked = filters.accounts?.length ? own.filter((id) => filters.accounts!.includes(id)) : own;
      let sources: ListSource[];
      if (q.accountId && where === 'folder') {
        requireAccount(userId, q.accountId);
        sources = [{ accountId: q.accountId, folder: q.folder || 'INBOX' }];
      } else if (where === 'all') {
        // All mail: each account's folders (Gmail's All Mail alone, where there is one).
        const lists = await Promise.all(picked.map(async (accountId) => (await mail.allMailFolders(userId, accountId).catch(() => ['INBOX'])).map((folder) => ({ accountId, folder }))));
        sources = lists.flat();
      } else {
        // Unified view, or "All inboxes": every (picked) account's INBOX.
        sources = picked.map((accountId) => ({ accountId, folder: 'INBOX' }));
      }
      const limit = q.limit ?? req.user!.preferences.pageSize;
      const list = await mail.listMessages(userId, sources, q.cursor ?? null, limit, { text: q.q ?? '', unread: q.unread === '1', filters }, { fresh: q.fresh === '1' });
      const until = snoozedUntil(userId);
      for (const m of [...list.messages, ...list.related]) {
        const t = until(m);
        if (t) m.snoozedUntil = t;
      }
      return list;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- single message -----------------------------------------------------------

  /** Settings → Images: automatic loading beyond the "always load from" list. */
  const autoImagesFor = (userId: string) => {
    const prefs = store.getUser(userId)?.preferences;
    return {
      // Public mail domains (gmail.com, outlook.com…) are everyone's, not "your own".
      ownDomains:
        prefs?.imagesOwnDomains === false
          ? []
          : [...new Set(store.listAccounts(userId).map((a) => normaliseDomain(a.email)).filter((d): d is string => !!d && !isPublicMailDomain(d)))],
      contacts: prefs?.imagesContacts === false ? new Set<string>() : store.recipientAddresses(userId),
      senderHosted: prefs?.imagesSenderHosted === true,
    };
  };

  /** Gmail labels of a message (null for mailboxes without labels) (DreyMail). */
  app.get('/api/message/labels', async (req, reply) => {
    try {
      const q = refSchema.parse(req.query);
      requireAccount(uid(req), q.accountId);
      return { labels: await mail.labels(uid(req), q) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/api/message/labels', async (req, reply) => {
    try {
      const body = z.object({ ref: refSchema, add: z.array(z.string().min(1).max(1000)).max(50).default([]), remove: z.array(z.string().min(1).max(1000)).max(50).default([]) }).parse(req.body);
      requireAccount(uid(req), body.ref.accountId);
      await mail.setLabels(uid(req), body.ref, body.add, body.remove);
      return { labels: await mail.labels(uid(req), body.ref).catch(() => null) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/message', async (req, reply) => {
    try {
      // remote=1: the user asked to load images; remote=0: keep them blocked (e.g. for quoting);
      // absent: the server decides from the user's sender-domain allowlist.
      const q = refSchema.extend({ remote: z.enum(['0', '1']).optional() }).parse(req.query);
      requireAccount(uid(req), q.accountId);
      const timing: Record<string, number> = {};
      const started = performance.now();
      const detail = await mail.getMessage(uid(req), q, {
        timing,
        allowRemote: q.remote === undefined ? undefined : q.remote === '1',
        imageDomains: q.remote === undefined ? store.listImageDomains(uid(req)) : [],
        autoImages: q.remote === undefined ? autoImagesFor(uid(req)) : undefined,
        imageCache,
        fetchImage,
        maxBytes: config.maxMessageBytes,
      });
      const until = snoozedUntil(uid(req))(q);
      if (until) detail.snoozedUntil = until;
      // Where the time went (mail server, parsing, pictures): visible in the browser's developer
      // tools, and logged when a message took long.
      const total = Math.round(performance.now() - started);
      reply.header('server-timing', [...Object.entries(timing).map(([k, v]) => `${k};dur=${v}`), `total;dur=${total}`].join(', '));
      if (total > 3000) req.log.warn({ ...timing, total, folder: q.folder }, 'slow message');
      reply.header('cache-control', 'private, no-store');
      return detail;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/attachment', async (req, reply) => {
    try {
      const q = refSchema.extend({ index: z.coerce.number().int().min(0) }).parse(req.query);
      requireAccount(uid(req), q.accountId);
      const att = await mail.getAttachment(uid(req), q, q.index, config.maxMessageBytes);
      // Always a download, never rendered by the browser on our origin.
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', contentDisposition(att.filename))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .send(att.content);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // A sender's picture, fetched by the server so the browser never contacts Gravatar & co.
  app.get('/api/avatar', async (req, reply) => {
    const q = z.object({ email: z.string().max(320) }).safeParse(req.query);
    const email = q.success ? normaliseEmail(q.data.email) : null;
    if (!email) return reply.code(400).send({ error: 'Invalid address' });
    if (!req.user!.preferences.contactPhotos) {
      // Turned off: no lookup, and nothing the browser keeps for when it is turned back on.
      return reply.header('cache-control', 'no-store').code(404).send({ error: 'Contact pictures are off' });
    }
    const img = await avatars.lookup(uid(req), email);
    // Let the browser keep the answer, a miss included, so it doesn't ask again on every render.
    reply.header('cache-control', `private, max-age=${img ? 86400 : 3600}`);
    if (!img) return reply.code(404).send({ error: 'No picture' });
    return reply
      .header('content-type', img.contentType)
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(img.body);
  });

  // ---- unsubscribe and blocked senders (DreyMail) ---------------------------------------

  app.post('/api/unsubscribe', async (req, reply) => {
    const body = z.object({ oneClick: z.string().max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    try {
      await oneClickUnsubscribe(body.data.oneClick);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/api/blocked', async (req) => deps.blocklist?.list(uid(req)) ?? []);
  app.post('/api/blocked', async (req, reply) => {
    const body = z.object({ accountId: z.string().max(64), address: z.string().max(320) }).safeParse(req.body);
    const address = body.success ? normaliseBlock(body.data.address) : null;
    if (!body.success || !address) return reply.code(400).send({ error: 'Enter an email address, or @domain.com for a whole domain' });
    try {
      requireAccount(uid(req), body.data.accountId);
      const moved = (await deps.blocklist?.add(uid(req), body.data.accountId, address)) ?? 0;
      deps.onBlocklistChanged?.(uid(req));
      return { moved, blocked: deps.blocklist?.list(uid(req)) ?? [] };
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.delete('/api/blocked', async (req, reply) => {
    const body = z.object({ accountId: z.string().max(64), address: z.string().max(320) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    deps.blocklist?.remove(uid(req), body.data.accountId, body.data.address);
    deps.onBlocklistChanged?.(uid(req));
    return deps.blocklist?.list(uid(req)) ?? [];
  });

  app.post('/api/messages/actions', async (req, reply) => {
    try {
      const body = z.object({ messages: z.array(refSchema).min(1).max(1000), action: actionSchema }).parse(req.body);
      const userId = uid(req);
      // Group by (account, folder, uidValidity): one IMAP command per group.
      const groups = new Map<string, { ref: MessageRef; uids: number[] }>();
      for (const m of body.messages) {
        requireAccount(userId, m.accountId);
        const k = `${m.accountId}\u0000${m.folder}\u0000${m.uidValidity}`;
        const g = groups.get(k) ?? { ref: m, uids: [] };
        g.uids.push(m.uid);
        groups.set(k, g);
      }
      const result: ActionResult = { undo: [], permanent: false, createdFolders: [] };
      const action = body.action;
      for (const { ref, uids } of groups.values()) {
        // Before the action: a moved message can't be looked at in its old folder afterwards.
        await deps.onAction?.(userId, ref.accountId, ref.folder, uids, action).catch(() => undefined);
        let r;
        if (action.type === 'snooze') r = await snooze.snooze(userId, ref, uids, action.until);
        else if (action.type === 'unsnooze') r = await snooze.unsnooze(userId, ref, uids);
        else {
          r = await mail.applyAction(userId, ref.accountId, ref.folder, ref.uidValidity, uids, action);
          // Snoozed messages moved or deleted by hand no longer come back on their own.
          if (action.type === 'move' || action.type === 'archive' || action.type === 'delete' || action.type === 'notJunk' || action.type === 'junk') {
            store.deleteSnoozes(userId, ref.accountId, ref.folder, ref.uidValidity, uids);
          }
          // Not spam: senders blocked in DreyMail are unblocked, or their next mail goes straight back.
          if (action.type === 'notJunk' && r.senders?.length && deps.blocklist) {
            const removed = r.senders.flatMap((a) => deps.blocklist!.unblockSender(userId, ref.accountId, a));
            if (removed.length) {
              result.unblocked = [...new Set([...(result.unblocked ?? []), ...removed])];
              deps.onBlocklistChanged?.(userId);
            }
          }
        }
        // Read, moved or deleted from the inbox here: close its notifications on the user's devices
        // without waiting for the IDLE watcher, which not every IMAP server tells about it.
        if (ref.folder.toUpperCase() === 'INBOX' && action.type !== 'flagged') push.inboxChanged(userId, ref.accountId);
        if (r.undo) result.undo.push(r.undo);
        if (r.permanent) result.permanent = true;
        if (r.createdFolder) result.createdFolders.push(r.createdFolder);
      }
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- compose ----------------------------------------------------------------------

  const readCompose = async (req: FastifyRequest) => {
    let payload: unknown = null;
    let sendAt: number | null = null;
    const files: { filename: string; contentType: string; content: Buffer }[] = [];
    let total = 0;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const content = await part.toBuffer();
        total += content.length;
        if (total > config.maxUploadBytes) throw new ComposeError('Attachments are too large');
        files.push({ filename: part.filename || 'attachment', contentType: part.mimetype || 'application/octet-stream', content });
      } else if (part.fieldname === 'payload') {
        payload = JSON.parse(String(part.value));
      } else if (part.fieldname === 'sendAt') {
        const t = Date.parse(String(part.value));
        if (!Number.isNaN(t)) sendAt = t;
      }
    }
    const parsed = composeSchema.parse(payload) as ComposePayload;
    requireAccount(uid(req), parsed.accountId);
    if (parsed.forwardFrom) requireAccount(uid(req), parsed.forwardFrom.accountId);
    if (parsed.replaceDraft) requireAccount(uid(req), parsed.replaceDraft.accountId);
    if (parsed.answering) requireAccount(uid(req), parsed.answering.accountId);
    return { payload: parsed, files, sendAt };
  };

  app.post('/api/send', async (req, reply) => {
    try {
      const { payload, files, sendAt } = await readCompose(req);
      // Send later (or undo send's short wait): the server keeps it and sends it when due.
      if (sendAt && sendAt > Date.now() + 1000 && deps.scheduled) {
        if (sendAt > Date.now() + 366 * 86_400_000) throw new ComposeError('Choose a time within the next year');
        return { scheduled: deps.scheduled.schedule(uid(req), payload, files, sendAt) };
      }
      return await compose.send(uid(req), payload, files);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/scheduled', async (req) => deps.scheduled?.list(uid(req)) ?? []);
  app.delete<{ Params: { id: string } }>('/api/scheduled/:id', async (req, reply) =>
    deps.scheduled?.cancel(uid(req), req.params.id) ? deps.scheduled.list(uid(req)) : reply.code(404).send({ error: 'Already sent, or not found' }),
  );
  // Undo send (from the Sending list under Compose): cancelled, and the message comes back to edit.
  app.post<{ Params: { id: string } }>('/api/scheduled/:id/undo', async (req, reply) => {
    const back = deps.scheduled?.takeBack(uid(req), req.params.id);
    return back ?? reply.code(404).send({ error: 'Already sent, or not found' });
  });
  app.post<{ Params: { id: string } }>('/api/scheduled/:id/send', async (req, reply) =>
    deps.scheduled?.sendNow(uid(req), req.params.id) ? deps.scheduled.list(uid(req)) : reply.code(404).send({ error: 'Already sent, or not found' }),
  );

  app.post('/api/drafts', async (req, reply) => {
    try {
      const { payload, files } = await readCompose(req);
      return await compose.saveDraft(uid(req), payload, files);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Address suggestions while writing: people from sent and received mail of the mailboxes the
  // user's scope preference picks (see AddressBook), then those written to before (all mailboxes).
  app.get('/api/recipients', async (req) => {
    const q = z.object({ q: z.string().max(200).default(''), from: z.string().max(64).optional() }).parse(req.query);
    const userId = uid(req);
    const prefs = store.getUser(userId)?.preferences;
    const scope = prefs?.suggestScope ?? 'all';
    const book = deps.addressBook;
    const out = book ? book.search(userId, q.q, book.scope(userId, q.from ?? null, scope, prefs?.suggestAccounts ?? [])) : [];
    if (out.length < 8 && (scope === 'all' || !book)) {
      const seen = new Set(out.map((s) => s.address));
      for (const r of store.searchRecipients(userId, q.q)) if (!seen.has(r.address) && out.length < 8) out.push(r);
    }
    return out;
  });
}
