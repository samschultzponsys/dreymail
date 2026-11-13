// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: unifiedInbox preference (All inboxes on/off).
// Modified by samschultzponsys, 2026-11-13: Signature types.
// Modified by samschultzponsys, 2026-11-13: notify event for the desktop app.
// Modified by samschultzponsys, 2026-11-13: Android app notifications (Firebase).
// Modified by samschultzponsys, 2026-11-13: your name; interface size.
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.

// Types shared between the server API and the web client.

export type TlsMode = 'tls' | 'starttls' | 'none';

export interface AccountInput {
  name: string;
  displayName: string;
  email: string;
  color: string;
  imap: { host: string; port: number; tls: TlsMode; user: string; password?: string };
  smtp: { host: string; port: number; tls: TlsMode; user: string; password?: string };
  appendSent: boolean;
}

/** Account as returned to the browser. Never contains passwords. */
export interface AccountView {
  id: string;
  name: string;
  displayName: string;
  email: string;
  color: string;
  imap: { host: string; port: number; tls: TlsMode; user: string };
  smtp: { host: string; port: number; tls: TlsMode; user: string };
  appendSent: boolean;
}

/**
 * What the "Add account" form starts with for this user: the admin's defaults with tokens such as
 * {username} already filled in. Fields without a default are empty.
 */
export interface AccountDefaults {
  name: string;
  displayName: string;
  email: string;
  imap: { host: string; port: number; tls: TlsMode; user: string };
  smtp: { host: string; port: number; tls: TlsMode; user: string };
  /**
   * The admin set a default password. It never reaches the browser: a blank password on a new
   * account is replaced by it on the server, but only while the server is the default one.
   */
  password: boolean;
}

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk' | 'all' | 'flagged' | 'snoozed';

export interface FolderView {
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  specialUse: SpecialUse | null;
  selectable: boolean;
  unread: number | null;
  total: number | null;
}

export interface AccountFolders {
  accountId: string;
  folders: FolderView[];
  error?: string;
}

export interface Address {
  name: string;
  address: string;
}

export interface MessageSummary {
  accountId: string;
  folder: string;
  uid: number;
  uidValidity: string;
  messageId: string | null;
  /** Parent's Message-ID; with `references`, what ties the message to its conversation. */
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: Address[];
  to: Address[];
  date: string;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  size: number;
  /** ISO time the message returns to the inbox, while it waits in the Snoozed folder. */
  snoozedUntil?: string;
}

/** Per-account position in a mailbox stream. */
export interface AccountCursor {
  uidValidity: string;
  /** Messages with UID strictly below this value have not been returned yet. */
  beforeUid: number;
  done: boolean;
}

export interface ListResponse {
  messages: MessageSummary[];
  /**
   * More messages of the listed messages' conversations that are not in `messages`: your replies
   * in the Sent folder, and older ones from the listed folder.
   */
  related: MessageSummary[];
  /** Opaque cursor for the next page, or null when every source is exhausted. */
  cursor: string | null;
  /** Accounts that could not be queried, with a human-readable reason. */
  errors: { accountId: string; error: string }[];
  /** True if the server noticed a UIDVALIDITY change and the client should reload. */
  reset: boolean;
}

export interface AttachmentView {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  contentId: string | null;
}

export type HtmlStyle = 'simple' | 'designed';

export interface MessageDetail {
  accountId: string;
  folder: string;
  uid: number;
  uidValidity: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  /** Only present on drafts and sent copies that kept the header. */
  bcc: Address[];
  replyTo: Address[];
  date: string;
  seen: boolean;
  flagged: boolean;
  text: string | null;
  /** Sanitized HTML document body, safe to put in a sandboxed iframe srcdoc. */
  html: string | null;
  /** Sanitized stylesheet from the message's own <style> elements. */
  css: string;
  htmlStyle: HtmlStyle | null;
  remoteContentBlocked: number;
  remoteContentLoaded: boolean;
  /** Domain of the From address, if it has a valid one. */
  senderDomain: DomainName | null;
  /** Allowlisted domain that made remote images load automatically. */
  imagesAllowedBy: DomainName | null;
  /** The sender is allowlisted, but the message failed DMARC so images were not loaded automatically. */
  allowlistSkipped: 'dmarc-fail' | null;
  attachments: AttachmentView[];
  /** ISO time the message returns to the inbox, while it waits in the Snoozed folder. */
  snoozedUntil?: string;
}

/** A domain in its stored ASCII (punycode) form and its human-readable form. */
export interface DomainName {
  domain: string;
  display: string;
}

export type MessageAction =
  | { type: 'seen'; value: boolean }
  | { type: 'flagged'; value: boolean }
  | { type: 'move'; destination: string }
  | { type: 'archive' }
  | { type: 'delete' }
  /** Move to the Snoozed folder until `until` (ISO time), then back to the inbox. Again on a snoozed message: change the time. */
  | { type: 'snooze'; until: string }
  /** Back to the inbox right away. */
  | { type: 'unsnooze' };

/** Where moved messages ended up, so the move can be undone by moving them back. */
export interface UndoInfo {
  accountId: string;
  folder: string;
  uidValidity: string;
  uids: number[];
  restoreTo: string;
}

export interface ActionResult {
  undo: UndoInfo[];
  /** True if messages were permanently deleted (expunged from Trash). */
  permanent: boolean;
  /** Folders that had to be created (e.g. a missing Archive). */
  createdFolders: string[];
}

export type SwipeAction = 'none' | 'delete' | 'archive' | 'toggleRead' | 'toggleFlag';

export interface MessageRef {
  accountId: string;
  folder: string;
  uid: number;
  uidValidity: string;
}

export interface ComposePayload {
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string[];
  /** Attachments carried over from an existing message (forward / draft edit). */
  forwardFrom: (MessageRef & { indices: number[] }) | null;
  /** Existing draft to replace when saving or sending. */
  replaceDraft: MessageRef | null;
  /** Message being replied to; flagged as answered after sending. */
  answering: MessageRef | null;
}

export interface SendResult {
  messageId: string;
  savedToSent: boolean;
  warning: string | null;
}

export interface DraftResult {
  draft: MessageRef | null;
}

/** full: sender and subject in phone notifications; minimal: only "New message" and the account. */
export type NotificationContent = 'full' | 'minimal';

/** Phone screen transitions (the running squirrel): off, or how quickly it runs. */
export type TransitionSpeed = 'off' | 'fast' | 'medium' | 'slow';

export interface Preferences {
  theme: 'system' | 'light' | 'dark';
  pageSize: number;
  markReadOnOpen: boolean;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  notificationContent: NotificationContent;
  /** On phones, the squirrel runs across the screen when switching views. */
  screenTransitions: TransitionSpeed;
  /** Show senders' pictures (Gravatar, Libravatar, their domain's icon) instead of initials. */
  contactPhotos: boolean;
  /** Show the unified "All inboxes" view. Off: every account stays separate and the app opens on the first account. */
  unifiedInbox: boolean;
  /** Bottom left shows the full name; off (default) shows only the first name. */
  showFullName: boolean;
}

/**
 * An email signature (DreyMail). One signature can serve several accounts (shared) or just one
 * (per inbox); each account has at most one.
 */
export interface Signature {
  id: string;
  name: string;
  /** Sanitized HTML. */
  html: string;
  accountIds: string[];
  /** Also added when replying and forwarding, not only to new messages. */
  onReplies: boolean;
}

export type SignatureInput = Omit<Signature, 'id'>;

/** A browser's Web Push subscription, as produced by PushSubscription.toJSON(). */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Me {
  id: string;
  /** What to call the user: their chosen name, else the provider's name (DreyMail). */
  name: string;
  /** The name they set in Settings → General ('' if none). */
  displayName: string;
  email: string;
  preferences: Preferences;
  /** Signs in with a username and password, so can change it in Settings. */
  hasPassword: boolean;
  /** Starting values for a new mail account. */
  accountDefaults: AccountDefaults;
  /** Administrator: sees Settings → Users and Sign-in. */
  admin: boolean;
}

export type Registration = 'open' | 'first' | 'closed';

/** Settings → Sign-in, as an administrator sees it (DreyMail). The client secret is never sent. */
export interface LoginSettingsView {
  oidcEnabled: boolean;
  issuerUrl: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  label: string;
  passwordLogin: boolean;
  registration: Registration;
  /** Fields set by environment variables (compose file): field -> variable name. They override the UI. */
  locked: Partial<Record<'oidcEnabled' | 'issuerUrl' | 'clientId' | 'clientSecret' | 'scopes' | 'label' | 'passwordLogin' | 'registration', string>>;
  /** Redirect URI to register at the provider. */
  callbackUrl: string;
}

export interface LoginSettingsInput {
  oidcEnabled: boolean;
  issuerUrl: string;
  clientId: string;
  /** New client secret; empty keeps the stored one. */
  clientSecret: string;
  clearClientSecret: boolean;
  scopes: string;
  label: string;
  passwordLogin: boolean;
  registration: Registration;
}

/** GET /api/version (DreyMail). */
export interface VersionInfo {
  /** This server's version, e.g. "2.0". */
  version: string;
  /** A newer release exists (administrators only; null for others or when unknown). */
  update: { version: string; url: string } | null;
}

/** Settings → Android (administrators): Firebase for the Android app's notifications. */
export interface FirebaseSettingsView {
  /** Everything the app and the server need is set. */
  configured: boolean;
  hasServiceAccount: boolean;
  projectId: string;
  serviceAccountEmail: string;
  apiKey: string;
  appId: string;
  senderId: string;
  locked: Partial<Record<'serviceAccount' | 'apiKey' | 'appId' | 'senderId', string>>;
}

/** A user in Settings → Users (DreyMail). */
export interface AdminUser {
  id: string;
  name: string;
  username: string;
  email: string;
  login: 'password' | 'oidc' | 'dev';
  admin: boolean;
  /** Administrator because of DREYMAIL_ADMIN_USERS (can't be changed in the UI). */
  adminByEnv: boolean;
  accounts: number;
  createdAt: string;
}

/** Login options shown on the sign-in page (GET /auth/methods). */
export interface AuthMethods {
  password: boolean;
  /** A new password account can be created right now. */
  registration: boolean;
  oidc: { label: string } | null;
  dev: boolean;
}

export type ServerEvent =
  | { type: 'mailbox'; accountId: string; folder: string }
  | { type: 'reset'; accountId: string; folder: string }
  /** A snoozed message is back in the inbox (uid is null if the server couldn't tell). */
  | { type: 'snoozeEnded'; accountId: string; uidValidity: string; uid: number | null; from: string; subject: string }
  /**
   * A notification about new (or woken) mail, for the DreyMail desktop app, which shows it as a
   * native notification in the account's colour. Browsers use Web Push instead and ignore this.
   */
  | { type: 'notify'; accountId: string; title: string; body: string; tag: string; url: string }
  | { type: 'hello' };

/**
 * Sent by the browser over the WebSocket: whether the app is in front of the user right now
 * (visible and focused). Phone notifications are skipped while any session is active.
 */
export type ClientEvent = {
  type: 'presence';
  active: boolean;
  /** DreyMail desktop app: this session shows its own notifications for new mail. */
  notifications?: boolean;
};
