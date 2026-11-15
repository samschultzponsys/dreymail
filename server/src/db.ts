// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: unifiedInbox preference default.
// Modified by samschultzponsys, 2026-11-13: signatures tables and store methods.
// Modified by samschultzponsys, 2026-11-13: administrators, user management and instance settings.
// Modified by samschultzponsys, 2026-11-13: rekeyFrom for the one-time data upgrade.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-13: Android app notifications (Firebase).
// Modified by samschultzponsys, 2026-11-13: your name; interface size.
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.
// Modified by samschultzponsys, 2026-11-15: Microsoft (OAuth) accounts.
// Modified by samschultzponsys, 2026-11-15: Sign in with Google for Gmail.
// Modified by samschultzponsys, 2026-11-15: saved searches.
// Modified by samschultzponsys, 2026-11-15: roles with permission flags; profile pictures.
// Modified by samschultzponsys, 2026-11-15: mailbox icons.
// Modified by samschultzponsys, 2026-11-15: AI mailbox assistant (connections, rules, history, usage).
// Modified by samschultzponsys, 2026-11-15: choose what the bottom left shows (photo, name or both).
// Modified by samschultzponsys, 2026-11-15: your own picture as a mailbox icon.
// Modified by samschultzponsys, 2026-11-15: copy codes, unsubscribe, block sender, mailbox health.
// Modified by samschultzponsys, 2026-11-15: send later and undo send.
// Modified by samschultzponsys, 2026-11-15: passkey sign-in.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ALL_PERMISSIONS, isPermission, SUPERADMIN, USER_DEFAULTS, USER_ROLE, type Permission, type Role } from '../../shared/permissions.js';
import { normalizeFilters, type SavedSearch, type SearchFilters } from '../../shared/search.js';
import type { AccountInput, AccountView, Preferences, PushSubscriptionInput, Signature, SignatureInput, TlsMode } from '../../shared/types.js';
import { decrypt, encrypt } from './crypto.js';

// Snoozed messages: where each one waits (IMAP folder, UIDVALIDITY, UID) and when it returns to
// INBOX. IMAP has a "Snoozed" folder attribute but no wake-up time, so the time lives here.
const SNOOZES_SQL = `CREATE TABLE IF NOT EXISTS snoozes (
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     folder TEXT NOT NULL,
     uid_validity TEXT NOT NULL,
     uid INTEGER NOT NULL,
     until INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, folder, uid_validity, uid)
   );
   CREATE INDEX IF NOT EXISTS snoozes_until ON snoozes(until);`;

export const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     issuer TEXT NOT NULL,
     subject TEXT NOT NULL,
     email TEXT NOT NULL DEFAULT '',
     name TEXT NOT NULL DEFAULT '',
     preferences TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL,
     UNIQUE (issuer, subject)
   );
   CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     display_name TEXT NOT NULL,
     email TEXT NOT NULL,
     color TEXT NOT NULL,
     imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_tls TEXT NOT NULL,
     imap_user TEXT NOT NULL, imap_password TEXT NOT NULL,
     smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_tls TEXT NOT NULL,
     smtp_user TEXT NOT NULL, smtp_password TEXT NOT NULL,
     append_sent INTEGER NOT NULL DEFAULT 1,
     position INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX accounts_user ON accounts(user_id);
   CREATE TABLE recent_recipients (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     address TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     last_used INTEGER NOT NULL,
     uses INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (user_id, address)
   );`,
  `CREATE TABLE image_domains (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     domain TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, domain)
   );`,
  // Web Push: one row per browser/device. The endpoint is unique, so a device that is used by a
  // different user after a re-login moves to that user instead of receiving both users' mail.
  `CREATE TABLE push_subscriptions (
     endpoint TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
   CREATE TABLE inbox_state (
     account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     uid_validity TEXT NOT NULL,
     last_uid INTEGER NOT NULL
   );`,
  SNOOZES_SQL,
  // Username/password login: such users have issuer 'local' and the normalised username as subject.
  // Dev databases shared between branches may already be at this version with the password column
  // and without snoozes (both branches used the same migration number), so repair either way.
  (db) => {
    db.exec(SNOOZES_SQL);
    const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT;');
  },
  // The user's short name for {username} in default account settings: the login name of password
  // users, the provider's preferred_username for OIDC users (filled in at their next login).
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'username')) db.exec("ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT '';");
    db.exec("UPDATE users SET username = subject WHERE password_hash IS NOT NULL AND username = '';");
  },
  // DreyMail: signatures (IF NOT EXISTS: tests and shared dev databases re-run migrations). An account uses at most one signature (account_id is the key), so one
  // signature can be shared by several accounts or belong to just one.
  `CREATE TABLE IF NOT EXISTS signatures (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     html TEXT NOT NULL,
     on_replies INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS signatures_user ON signatures(user_id);
   CREATE TABLE IF NOT EXISTS signature_accounts (
     account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     signature_id TEXT NOT NULL REFERENCES signatures(id) ON DELETE CASCADE
   );`,
  // DreyMail: administrators and instance-wide settings (sign-in options set in the UI). The oldest
  // user of an existing instance becomes its administrator.
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;');
    db.exec(`UPDATE users SET is_admin = 1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)
               AND id = (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1);
             CREATE TABLE IF NOT EXISTS instance_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  },
  // DreyMail: the Android app's Firebase registration tokens, one row per phone, with the phone's
  // Web Push keys: payloads are end-to-end encrypted (RFC 8291), so Google relays only ciphertext.
  `CREATE TABLE IF NOT EXISTS fcm_tokens (
     token TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS fcm_tokens_user ON fcm_tokens(user_id);`,
  // DreyMail: accounts that sign in with Microsoft (Outlook, Microsoft 365) instead of a password.
  // oauth_token holds the encrypted refresh token.
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('accounts')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'auth')) db.exec("ALTER TABLE accounts ADD COLUMN auth TEXT NOT NULL DEFAULT 'password';");
    if (!cols.some((c) => c.name === 'oauth_token')) db.exec("ALTER TABLE accounts ADD COLUMN oauth_token TEXT NOT NULL DEFAULT '';");
  },
  // DreyMail: the name a user chose for themselves (Settings → General). Kept apart from `name`,
  // which an OIDC provider overwrites at every sign-in.
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'display_name')) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';");
  },
  // DreyMail: saved searches (the sidebar's smart folders). `query` is JSON: q, unread, filters.
  `CREATE TABLE IF NOT EXISTS saved_searches (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     query TEXT NOT NULL,
     account_id TEXT,
     folder TEXT NOT NULL DEFAULT 'INBOX',
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS saved_searches_user ON saved_searches(user_id);`,
  // DreyMail: roles with permission flags (they replace the admin yes/no), and profile pictures.
  // Administrators become Superadmins, everyone else gets the User role.
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS roles (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               permissions TEXT NOT NULL,
               created_at INTEGER NOT NULL
             );`);
    db.prepare('INSERT OR IGNORE INTO roles (id, name, permissions, created_at) VALUES (?, ?, ?, 0)').run(SUPERADMIN, 'Superadmin', '[]');
    db.prepare('INSERT OR IGNORE INTO roles (id, name, permissions, created_at) VALUES (?, ?, ?, 1)').run(USER_ROLE, 'User', JSON.stringify(USER_DEFAULTS));
    const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    const has = (c: string) => cols.some((x) => x.name === c);
    if (!has('role_id')) {
      db.exec(`ALTER TABLE users ADD COLUMN role_id TEXT NOT NULL DEFAULT '${USER_ROLE}';`);
      db.exec(`UPDATE users SET role_id = '${SUPERADMIN}' WHERE is_admin = 1;`);
    }
    if (!has('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar BLOB;');
    if (!has('avatar_type')) db.exec("ALTER TABLE users ADD COLUMN avatar_type TEXT NOT NULL DEFAULT '';");
    if (!has('avatar_version')) db.exec('ALTER TABLE users ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0;');
    if (!has('gravatar')) db.exec('ALTER TABLE users ADD COLUMN gravatar INTEGER NOT NULL DEFAULT 1;');
  },
  // DreyMail: an icon per mailbox (shared/mailboxIcons.ts), shown with its colour.
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('accounts')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'icon')) db.exec("ALTER TABLE accounts ADD COLUMN icon TEXT NOT NULL DEFAULT '';");
  },
  // DreyMail: a picture the user uploaded as a mailbox's icon (already cropped and scaled).
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('accounts')").all() as { name: string }[];
    const has = (c: string) => cols.some((x) => x.name === c);
    if (!has('icon_image')) db.exec('ALTER TABLE accounts ADD COLUMN icon_image BLOB;');
    if (!has('icon_image_type')) db.exec("ALTER TABLE accounts ADD COLUMN icon_image_type TEXT NOT NULL DEFAULT '';");
    if (!has('icon_image_version')) db.exec('ALTER TABLE accounts ADD COLUMN icon_image_version INTEGER NOT NULL DEFAULT 0;');
  },
  // DreyMail: the AI mailbox assistant. Connections hold an AI service and its sealed key (user_id
  // NULL = shared by an administrator); each mailbox picks one, has rules, and keeps a history.
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_connections (
               id TEXT PRIMARY KEY,
               user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
               name TEXT NOT NULL,
               preset TEXT NOT NULL,
               api TEXT NOT NULL,
               base_url TEXT NOT NULL,
               model TEXT NOT NULL,
               api_key TEXT NOT NULL DEFAULT '',
               daily_limit INTEGER NOT NULL DEFAULT 500,
               created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS ai_mailboxes (
               account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
               user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
               connection_id TEXT REFERENCES ai_connections(id) ON DELETE SET NULL,
               enabled INTEGER NOT NULL DEFAULT 0,
               accuracy INTEGER NOT NULL DEFAULT 4
             );
             CREATE TABLE IF NOT EXISTS ai_rules (
               id TEXT PRIMARY KEY,
               user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
               account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
               name TEXT NOT NULL,
               instructions TEXT NOT NULL,
               conditions TEXT NOT NULL,
               actions TEXT NOT NULL,
               enabled INTEGER NOT NULL DEFAULT 1,
               position INTEGER NOT NULL,
               created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS ai_rules_account ON ai_rules(account_id, position);
             CREATE TABLE IF NOT EXISTS ai_history (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
               account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
               at INTEGER NOT NULL,
               source TEXT NOT NULL,
               decision TEXT NOT NULL,
               undo TEXT NOT NULL DEFAULT '[]',
               undone INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS ai_history_account ON ai_history(account_id, at);
             CREATE TABLE IF NOT EXISTS ai_usage (
               connection_id TEXT NOT NULL,
               day TEXT NOT NULL,
               requests INTEGER NOT NULL DEFAULT 0,
               input_tokens INTEGER NOT NULL DEFAULT 0,
               output_tokens INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (connection_id, day)
             );`);
    const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'ai_access')) db.exec("ALTER TABLE users ADD COLUMN ai_access TEXT NOT NULL DEFAULT '';");
    if (!cols.some((c) => c.name === 'ai_terms_at')) db.exec('ALTER TABLE users ADD COLUMN ai_terms_at INTEGER NOT NULL DEFAULT 0;');
  },
  // DreyMail: the assistant's learning mode. Per mailbox: until when it learns, and whether its
  // suggestions were reviewed; observations are what arrived and what the user did with it.
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('ai_mailboxes')").all() as { name: string }[];
    const has = (c: string) => cols.some((x) => x.name === c);
    if (!has('learning_from')) db.exec('ALTER TABLE ai_mailboxes ADD COLUMN learning_from INTEGER NOT NULL DEFAULT 0;');
    if (!has('learning_until')) db.exec('ALTER TABLE ai_mailboxes ADD COLUMN learning_until INTEGER NOT NULL DEFAULT 0;');
    if (!has('review_after')) db.exec('ALTER TABLE ai_mailboxes ADD COLUMN review_after INTEGER NOT NULL DEFAULT 0;');
    db.exec(`CREATE TABLE IF NOT EXISTS ai_observations (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
               account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
               at INTEGER NOT NULL,
               kind TEXT NOT NULL,
               message_id TEXT NOT NULL DEFAULT '',
               sender TEXT NOT NULL,
               subject TEXT NOT NULL,
               detail TEXT NOT NULL DEFAULT '{}'
             );
             CREATE INDEX IF NOT EXISTS ai_observations_account ON ai_observations(account_id, at);`);
  },
  // DreyMail: blocked senders per mailbox (their mail goes to Junk).
  `CREATE TABLE IF NOT EXISTS blocked_senders (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     address TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, address)
   );`,
  // DreyMail: mail to send later (also how "undo send" waits a few seconds). The message with its
  // attachments is sealed like account passwords.
  `CREATE TABLE IF NOT EXISTS scheduled_sends (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     send_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     error TEXT NOT NULL DEFAULT '',
     subject TEXT NOT NULL DEFAULT '',
     recipients TEXT NOT NULL DEFAULT '',
     message TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS scheduled_sends_due ON scheduled_sends(status, send_at);`,
  // DreyMail: passkeys (fingerprint, face, security key) to sign in with.
  `CREATE TABLE IF NOT EXISTS passkeys (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     public_key BLOB NOT NULL,
     counter INTEGER NOT NULL DEFAULT 0,
     transports TEXT NOT NULL DEFAULT '[]',
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);`,
];

/** Most devices one user can have notifications on; the oldest subscription is dropped beyond that. */
export const MAX_PUSH_SUBSCRIPTIONS = 20;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  pageSize: 50,
  markReadOnOpen: true,
  swipeLeft: 'delete',
  swipeRight: 'archive',
  notificationContent: 'full',
  screenTransitions: 'fast',
  contactPhotos: true,
  unifiedInbox: true,
  showFullName: false,
  footerIdentity: 'both',
  undoSendSeconds: 10,
};

export interface User {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  name: string;
  /** Short user name, e.g. "alice" (may be empty for OIDC users whose provider sends none). */
  username: string;
  preferences: Preferences;
  /** Signs in with a username and password (as opposed to OIDC). */
  hasPassword: boolean;
  /** Role (DreyMail): what the user may do, see shared/permissions.ts. */
  roleId: string;
  /** Has uploaded a profile picture; changes when it does (for cache busting). */
  avatarVersion: number;
  /** Without an uploaded picture, show their Gravatar. */
  gravatar: boolean;
  /** The name the user chose (DreyMail); empty to use `name`. */
  displayName: string;
  createdAt: number;
}

/** A snoozed message: where it waits and when it returns to INBOX (ms since the epoch). */
export interface Snooze {
  userId: string;
  accountId: string;
  folder: string;
  uidValidity: string;
  uid: number;
  until: number;
}

/** Full account including decrypted credentials. Server-side only, never serialise to clients. */
export interface AccountSecret extends AccountView {
  userId: string;
  imap: AccountView['imap'] & { password: string; oauth?: OAuthRef };
  smtp: AccountView['smtp'] & { password: string; oauth?: OAuthRef };
}

/** Marks server settings that log in with an OAuth access token (fetched just before connecting). */
export interface OAuthRef {
  provider: 'microsoft' | 'google';
  userId: string;
  accountId: string;
}

interface AccountRow {
  id: string;
  user_id: string;
  name: string;
  display_name: string;
  email: string;
  color: string;
  imap_host: string;
  imap_port: number;
  imap_tls: string;
  imap_user: string;
  imap_password: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: string;
  smtp_user: string;
  smtp_password: string;
  append_sent: number;
  auth?: string;
  oauth_token?: string;
  icon?: string;
  icon_image_version?: number;
}

function credAad(userId: string, accountId: string, kind: 'imap' | 'smtp'): string {
  return `account-credential:${userId}:${accountId}:${kind}`;
}

function toView(r: AccountRow): AccountView {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    email: r.email,
    color: r.color,
    icon: r.icon === 'image' && !r.icon_image_version ? '' : (r.icon ?? ''),
    iconImage: r.icon_image_version ? `/api/accounts/${r.id}/icon?v=${r.icon_image_version}` : null,
    imap: { host: r.imap_host, port: r.imap_port, tls: r.imap_tls as TlsMode, user: r.imap_user },
    smtp: { host: r.smtp_host, port: r.smtp_port, tls: r.smtp_tls as TlsMode, user: r.smtp_user },
    appendSent: r.append_sent === 1,
    auth: r.auth === 'microsoft' || r.auth === 'google' ? r.auth : 'password',
  };
}

/**
 * Persistence for the only state DreyMail keeps: users, their (encrypted) account settings,
 * preferences, recently used recipients, sender domains allowed to show images, Web Push
 * subscriptions, the highest INBOX UID already notified about and when snoozed messages (by folder
 * and UID) return. No mail content is stored here; the disposable mail cache (cache/store.ts) is a
 * separate file.
 *
 * Every account query is scoped by user id; there is deliberately no "get account by id" without
 * an owner, which keeps per-user isolation enforced at the data layer.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(
    file: string,
    private readonly credentialKey: Buffer,
  ) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate() {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        const m = MIGRATIONS[v]!;
        if (typeof m === 'string') this.db.exec(m);
        else m(this.db);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close() {
    this.db.close();
  }

  // ---- users ---------------------------------------------------------------

  upsertUser(issuer: string, subject: string, email: string, name: string, username = ''): User {
    const existing = this.db
      .prepare('SELECT id FROM users WHERE issuer = ? AND subject = ?')
      .get(issuer, subject) as { id: string } | undefined;
    if (existing) {
      this.db.prepare('UPDATE users SET email = ?, name = ?, username = ? WHERE id = ?').run(email, name, username, existing.id);
      return this.getUser(existing.id)!;
    }
    const id = crypto.randomUUID();
    // The first user of an empty instance is its Superadmin.
    this.db
      .prepare('INSERT INTO users (id, issuer, subject, email, name, username, created_at, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, issuer, subject, email, name, username, Date.now(), this.newUserRole());
    return this.getUser(id)!;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | {
          id: string;
          issuer: string;
          subject: string;
          email: string;
          name: string;
          username: string;
          preferences: string;
          password_hash: string | null;
          role_id: string;
          avatar_version: number;
          gravatar: number;
          created_at: number;
          display_name: string;
        }
      | undefined;
    if (!row) return null;
    let prefs: Partial<Preferences> = {};
    try {
      prefs = JSON.parse(row.preferences) as Partial<Preferences>;
    } catch {
      /* fall back to defaults */
    }
    return {
      id: row.id,
      issuer: row.issuer,
      subject: row.subject,
      email: row.email,
      name: row.name,
      username: row.username,
      preferences: { ...DEFAULT_PREFERENCES, ...prefs },
      hasPassword: row.password_hash !== null,
      roleId: row.role_id,
      avatarVersion: row.avatar_version,
      gravatar: row.gravatar === 1,
      createdAt: row.created_at,
      displayName: row.display_name ?? '',
    };
  }

  setDisplayName(userId: string, name: string) {
    this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, userId);
  }

  // ---- administration (DreyMail) -------------------------------------------

  listUsers(): (User & { accounts: number })[] {
    const rows = this.db
      .prepare('SELECT u.id, (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id) AS n FROM users u ORDER BY u.created_at, u.rowid')
      .all() as { id: string; n: number }[];
    return rows.map((r) => ({ ...this.getUser(r.id)!, accounts: r.n }));
  }

  // ---- roles (DreyMail) ------------------------------------------------------

  /** The role a new user gets: Superadmin for the very first user, else the default role. */
  private newUserRole(): string {
    const any = this.db.prepare('SELECT 1 FROM users LIMIT 1').get();
    return any ? this.defaultRole() : SUPERADMIN;
  }

  defaultRole(): string {
    const id = this.getSetting<string>('defaultRole');
    return id && id !== SUPERADMIN && this.getRole(id) ? id : USER_ROLE;
  }

  setDefaultRole(id: string) {
    this.setSetting('defaultRole', id);
  }

  listRoles(): Role[] {
    const rows = this.db
      .prepare('SELECT r.id, r.name, r.permissions, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS n FROM roles r ORDER BY r.created_at, r.name')
      .all() as { id: string; name: string; permissions: string; n: number }[];
    return rows.map((r) => this.roleOf(r));
  }

  getRole(id: string): Role | null {
    const r = this.db
      .prepare('SELECT r.id, r.name, r.permissions, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS n FROM roles r WHERE r.id = ?')
      .get(id) as { id: string; name: string; permissions: string; n: number } | undefined;
    return r ? this.roleOf(r) : null;
  }

  private roleOf(r: { id: string; name: string; permissions: string; n: number }): Role {
    let perms: Permission[] = [];
    try {
      perms = (JSON.parse(r.permissions) as unknown[]).filter(isPermission);
    } catch {
      /* none */
    }
    // Superadmin has everything, including flags added after the role was stored.
    if (r.id === SUPERADMIN) perms = [...ALL_PERMISSIONS];
    return { id: r.id, name: r.name, permissions: perms, builtin: r.id === SUPERADMIN || r.id === USER_ROLE, users: r.n };
  }

  /** Creates (id null) or changes a role. Superadmin can't be changed; User keeps its name. */
  saveRole(id: string | null, name: string, permissions: Permission[]): Role | null {
    const perms = JSON.stringify([...new Set(permissions.filter(isPermission))]);
    if (id === null) {
      const newId = crypto.randomUUID();
      this.db.prepare('INSERT INTO roles (id, name, permissions, created_at) VALUES (?, ?, ?, ?)').run(newId, name, perms, Date.now());
      return this.getRole(newId);
    }
    if (id === SUPERADMIN || !this.getRole(id)) return null;
    this.db.prepare('UPDATE roles SET name = ?, permissions = ? WHERE id = ?').run(id === USER_ROLE ? 'User' : name, perms, id);
    return this.getRole(id);
  }

  /** Deletes a custom role; its users get the default role. */
  deleteRole(id: string): boolean {
    if (id === SUPERADMIN || id === USER_ROLE) return false;
    this.db.exec('BEGIN');
    try {
      if (this.defaultRole() === id) this.setDefaultRole(USER_ROLE);
      this.db.prepare('UPDATE users SET role_id = ? WHERE role_id = ?').run(this.defaultRole(), id);
      const n = this.db.prepare('DELETE FROM roles WHERE id = ?').run(id).changes;
      this.db.exec('COMMIT');
      return n > 0;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setUserRole(userId: string, roleId: string): boolean {
    if (!this.getRole(roleId)) return false;
    return this.db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(roleId, userId).changes > 0;
  }

  countRole(roleId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(roleId) as { n: number }).n;
  }

  // ---- profile pictures (DreyMail) ----------------------------------------------

  setAvatar(userId: string, picture: { type: string; body: Buffer } | null) {
    this.db
      .prepare('UPDATE users SET avatar = ?, avatar_type = ?, avatar_version = ? WHERE id = ?')
      .run(picture?.body ?? null, picture?.type ?? '', picture ? Date.now() : 0, userId);
  }

  getAvatar(userId: string): { type: string; body: Buffer } | null {
    const r = this.db.prepare('SELECT avatar, avatar_type FROM users WHERE id = ?').get(userId) as { avatar: Uint8Array | null; avatar_type: string } | undefined;
    return r?.avatar ? { type: r.avatar_type, body: Buffer.from(r.avatar) } : null;
  }

  setGravatar(userId: string, on: boolean) {
    this.db.prepare('UPDATE users SET gravatar = ? WHERE id = ?').run(on ? 1 : 0, userId);
  }

  /** Deletes a user with everything they own (accounts, signatures, push subscriptions, ...). */
  deleteUser(userId: string): boolean {
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes > 0;
  }

  /** An instance-wide setting (JSON), or null. */
  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  /**
   * Re-encrypts every stored secret (mail passwords, the OIDC client secret) from `oldKey` to this
   * store's key, in one transaction that also records `marker`. Values that don't open with the old
   * key (already unreadable) are left alone. Returns how many account credentials moved.
   */
  rekeyFrom(oldKey: Buffer, marker: { key: string; value: string }): number {
    let moved = 0;
    this.db.exec('BEGIN');
    try {
      const rows = this.db.prepare('SELECT id, user_id, imap_password, smtp_password FROM accounts').all() as {
        id: string;
        user_id: string;
        imap_password: string;
        smtp_password: string;
      }[];
      const update = this.db.prepare('UPDATE accounts SET imap_password = ?, smtp_password = ? WHERE id = ?');
      for (const r of rows) {
        try {
          const imap = decrypt(oldKey, r.imap_password, credAad(r.user_id, r.id, 'imap'));
          const smtp = decrypt(oldKey, r.smtp_password, credAad(r.user_id, r.id, 'smtp'));
          update.run(encrypt(this.credentialKey, imap, credAad(r.user_id, r.id, 'imap')), encrypt(this.credentialKey, smtp, credAad(r.user_id, r.id, 'smtp')), r.id);
          moved++;
        } catch {
          /* not readable with the old key either */
        }
      }
      const login = this.getSetting<{ clientSecret?: string }>('login');
      if (login?.clientSecret) {
        try {
          const plain = decrypt(oldKey, login.clientSecret, 'instance-setting:login');
          this.setSetting('login', { ...login, clientSecret: this.sealSecret('login', plain) });
        } catch {
          /* leave it */
        }
      }
      this.setSetting(marker.key, marker.value);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return moved;
  }

  /** Encrypts a secret setting value (e.g. the OIDC client secret) with the credential key. */
  sealSecret(key: string, plain: string): string {
    return encrypt(this.credentialKey, plain, `instance-setting:${key}`);
  }

  openSecret(key: string, sealed: string): string {
    return decrypt(this.credentialKey, sealed, `instance-setting:${key}`);
  }

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  /** A password user and their stored hash, by normalised username. */
  findPasswordUser(issuer: string, username: string): { user: User; passwordHash: string } | null {
    const row = this.db
      .prepare('SELECT id, password_hash FROM users WHERE issuer = ? AND subject = ? AND password_hash IS NOT NULL')
      .get(issuer, username) as { id: string; password_hash: string } | undefined;
    return row ? { user: this.getUser(row.id)!, passwordHash: row.password_hash } : null;
  }

  /** Creates a password user; null if the username is taken. */
  createPasswordUser(issuer: string, username: string, passwordHash: string): User | null {
    const id = crypto.randomUUID();
    const email = username.includes('@') ? username : '';
    const res = this.db
      .prepare(
        `INSERT INTO users (id, issuer, subject, email, name, username, password_hash, created_at, role_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (issuer, subject) DO NOTHING`,
      )
      .run(id, issuer, username, email, username, username, passwordHash, Date.now(), this.newUserRole());
    return res.changes > 0 ? this.getUser(id) : null;
  }

  setPasswordHash(userId: string, passwordHash: string) {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NOT NULL').run(passwordHash, userId);
  }

  getPasswordHash(userId: string): string | null {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string | null } | undefined;
    return row?.password_hash ?? null;
  }

  setPreferences(userId: string, prefs: Preferences) {
    this.db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(prefs), userId);
  }

  // ---- accounts ------------------------------------------------------------

  listAccounts(userId: string): AccountView[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY position, created_at')
      .all(userId) as unknown as AccountRow[];
    return rows.map(toView);
  }

  /** Every account as `${userId}\0${accountId}` (to forget cached mail of deleted accounts). */
  allAccountKeys(): Set<string> {
    const rows = this.db.prepare('SELECT user_id, id FROM accounts').all() as { user_id: string; id: string }[];
    return new Set(rows.map((r) => `${r.user_id}\u0000${r.id}`));
  }

  getAccountSecret(userId: string, accountId: string): AccountSecret | null {
    const r = this.db
      .prepare('SELECT * FROM accounts WHERE user_id = ? AND id = ?')
      .get(userId, accountId) as AccountRow | undefined;
    if (!r) return null;
    const view = toView(r);
    const oauth: OAuthRef | undefined = view.auth !== 'password' ? { provider: view.auth, userId, accountId: r.id } : undefined;
    return {
      ...view,
      userId: r.user_id,
      imap: { ...view.imap, password: decrypt(this.credentialKey, r.imap_password, credAad(userId, r.id, 'imap')), oauth },
      smtp: { ...view.smtp, password: decrypt(this.credentialKey, r.smtp_password, credAad(userId, r.id, 'smtp')), oauth },
    };
  }

  // ---- Microsoft (OAuth) accounts (DreyMail) ---------------------------------------

  /**
   * Adds an Outlook / Microsoft 365 account signed in with Microsoft, or refreshes the sign-in of
   * the user's existing account with that address. Mail is read over IMAP with OAuth and sent
   * through Microsoft Graph (which keeps its own copy in Sent).
   */
  saveMicrosoftAccount(userId: string, a: { email: string; name: string; displayName: string; color: string; refreshToken: string }): AccountView {
    return this.saveOAuthAccount(userId, 'microsoft', a, {
      imap: { host: 'outlook.office365.com', port: 993, tls: 'tls' },
      smtp: { host: 'graph.microsoft.com', port: 443, tls: 'tls' },
    });
  }

  /** Gmail signed in with Google: IMAP and SMTP with OAuth (Gmail files sent mail itself). */
  saveGoogleAccount(userId: string, a: { email: string; name: string; displayName: string; color: string; refreshToken: string }): AccountView {
    return this.saveOAuthAccount(userId, 'google', a, {
      imap: { host: 'imap.gmail.com', port: 993, tls: 'tls' },
      smtp: { host: 'smtp.gmail.com', port: 465, tls: 'tls' },
    });
  }

  private saveOAuthAccount(
    userId: string,
    provider: 'microsoft' | 'google',
    a: { email: string; name: string; displayName: string; color: string; refreshToken: string },
    servers: { imap: { host: string; port: number; tls: TlsMode }; smtp: { host: string; port: number; tls: TlsMode } },
  ): AccountView {
    const existing = this.db
      .prepare('SELECT id FROM accounts WHERE user_id = ? AND auth = ? AND lower(email) = lower(?)')
      .get(userId, provider, a.email) as { id: string } | undefined;
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      this.createAccount(
        userId,
        {
          name: a.name,
          displayName: a.displayName,
          email: a.email,
          color: a.color,
          imap: { ...servers.imap, user: a.email, password: '' },
          smtp: { ...servers.smtp, user: a.email, password: '' },
          appendSent: false,
        },
        id,
      );
      this.db.prepare('UPDATE accounts SET auth = ? WHERE id = ?').run(provider, id);
    }
    this.setOAuthToken(userId, id, a.refreshToken);
    return this.listAccounts(userId).find((x) => x.id === id)!;
  }

  /** Label, sender name and colour only (Outlook accounts, whose servers are fixed). */
  /** A mailbox's uploaded picture (null removes it; the icon falls back to none if it was in use). */
  setAccountIconImage(userId: string, accountId: string, picture: { type: string; body: Buffer } | null): boolean {
    const n = this.db
      .prepare('UPDATE accounts SET icon_image = ?, icon_image_type = ?, icon_image_version = ? WHERE user_id = ? AND id = ?')
      .run(picture?.body ?? null, picture?.type ?? '', picture ? Date.now() : 0, userId, accountId).changes;
    if (n) this.db.prepare(`UPDATE accounts SET icon = ? WHERE user_id = ? AND id = ? AND (icon = 'image' OR ?)`).run(picture ? 'image' : '', userId, accountId, picture ? 1 : 0);
    return n > 0;
  }

  getAccountIconImage(userId: string, accountId: string): { type: string; body: Buffer } | null {
    const r = this.db.prepare('SELECT icon_image, icon_image_type FROM accounts WHERE user_id = ? AND id = ?').get(userId, accountId) as
      | { icon_image: Uint8Array | null; icon_image_type: string }
      | undefined;
    return r?.icon_image ? { type: r.icon_image_type, body: Buffer.from(r.icon_image) } : null;
  }

  /** A mailbox's icon key (checked by the caller); '' for none. */
  setAccountIcon(userId: string, accountId: string, icon: string) {
    this.db.prepare('UPDATE accounts SET icon = ? WHERE user_id = ? AND id = ?').run(icon, userId, accountId);
  }

  updateAccountLabels(userId: string, accountId: string, l: { name: string; displayName: string; color: string }): AccountView | null {
    const changed = this.db
      .prepare('UPDATE accounts SET name = ?, display_name = ?, color = ? WHERE user_id = ? AND id = ?')
      .run(l.name, l.displayName, l.color, userId, accountId).changes;
    return changed ? (this.listAccounts(userId).find((a) => a.id === accountId) ?? null) : null;
  }

  getOAuthToken(userId: string, accountId: string): string | null {
    const r = this.db.prepare('SELECT oauth_token FROM accounts WHERE user_id = ? AND id = ?').get(userId, accountId) as { oauth_token: string } | undefined;
    if (!r?.oauth_token) return null;
    try {
      return decrypt(this.credentialKey, r.oauth_token, `account-oauth:${userId}:${accountId}`);
    } catch {
      return null;
    }
  }

  setOAuthToken(userId: string, accountId: string, refreshToken: string) {
    this.db
      .prepare('UPDATE accounts SET oauth_token = ? WHERE user_id = ? AND id = ?')
      .run(encrypt(this.credentialKey, refreshToken, `account-oauth:${userId}:${accountId}`), userId, accountId);
  }

  /** Creates an account. Passwords are required on create. */
  createAccount(userId: string, input: AccountInput, id: string = crypto.randomUUID()): AccountView {
    const imapPw = input.imap.password ?? '';
    const smtpPw = input.smtp.password ?? imapPw;
    const position =
      (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM accounts WHERE user_id = ?').get(userId) as {
        p: number;
      }).p;
    this.db
      .prepare(
        `INSERT INTO accounts (id, user_id, name, display_name, email, color,
           imap_host, imap_port, imap_tls, imap_user, imap_password,
           smtp_host, smtp_port, smtp_tls, smtp_user, smtp_password,
           append_sent, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        input.name,
        input.displayName,
        input.email,
        input.color,
        input.imap.host,
        input.imap.port,
        input.imap.tls,
        input.imap.user,
        encrypt(this.credentialKey, imapPw, credAad(userId, id, 'imap')),
        input.smtp.host,
        input.smtp.port,
        input.smtp.tls,
        input.smtp.user,
        encrypt(this.credentialKey, smtpPw, credAad(userId, id, 'smtp')),
        input.appendSent ? 1 : 0,
        position,
        Date.now(),
      );
    return this.listAccounts(userId).find((a) => a.id === id)!;
  }

  /** Updates an account. Omitted passwords keep their stored value. */
  updateAccount(userId: string, accountId: string, input: AccountInput): AccountView | null {
    const current = this.getAccountSecret(userId, accountId);
    if (!current) return null;
    const imapPw = input.imap.password || current.imap.password;
    const smtpPw = input.smtp.password || current.smtp.password;
    this.db
      .prepare(
        `UPDATE accounts SET name = ?, display_name = ?, email = ?, color = ?,
           imap_host = ?, imap_port = ?, imap_tls = ?, imap_user = ?, imap_password = ?,
           smtp_host = ?, smtp_port = ?, smtp_tls = ?, smtp_user = ?, smtp_password = ?,
           append_sent = ?
         WHERE user_id = ? AND id = ?`,
      )
      .run(
        input.name,
        input.displayName,
        input.email,
        input.color,
        input.imap.host,
        input.imap.port,
        input.imap.tls,
        input.imap.user,
        encrypt(this.credentialKey, imapPw, credAad(userId, accountId, 'imap')),
        input.smtp.host,
        input.smtp.port,
        input.smtp.tls,
        input.smtp.user,
        encrypt(this.credentialKey, smtpPw, credAad(userId, accountId, 'smtp')),
        input.appendSent ? 1 : 0,
        userId,
        accountId,
      );
    return this.listAccounts(userId).find((a) => a.id === accountId) ?? null;
  }

  deleteAccount(userId: string, accountId: string): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE user_id = ? AND id = ?').run(userId, accountId).changes > 0;
  }

  // ---- signatures (DreyMail) ------------------------------------------------

  listSignatures(userId: string): Signature[] {
    const rows = this.db
      .prepare('SELECT id, name, html, on_replies FROM signatures WHERE user_id = ? ORDER BY created_at, id')
      .all(userId) as { id: string; name: string; html: string; on_replies: number }[];
    const links = this.db
      .prepare('SELECT sa.signature_id, sa.account_id FROM signature_accounts sa JOIN signatures s ON s.id = sa.signature_id WHERE s.user_id = ?')
      .all(userId) as { signature_id: string; account_id: string }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      html: r.html,
      onReplies: r.on_replies === 1,
      accountIds: links.filter((l) => l.signature_id === r.id).map((l) => l.account_id),
    }));
  }

  /**
   * Creates (id null) or replaces a signature. Accounts that are not the user's are ignored; an
   * account moves here from any other signature it had. Null when the signature isn't the user's.
   */
  saveSignature(userId: string, id: string | null, input: SignatureInput): Signature | null {
    const own = new Set(this.listAccounts(userId).map((a) => a.id));
    const accountIds = [...new Set(input.accountIds)].filter((a) => own.has(a));
    this.db.exec('BEGIN');
    try {
      if (id === null) {
        id = crypto.randomUUID();
        this.db
          .prepare('INSERT INTO signatures (id, user_id, name, html, on_replies, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, userId, input.name, input.html, input.onReplies ? 1 : 0, Date.now());
      } else {
        const changed = this.db
          .prepare('UPDATE signatures SET name = ?, html = ?, on_replies = ? WHERE id = ? AND user_id = ?')
          .run(input.name, input.html, input.onReplies ? 1 : 0, id, userId).changes;
        if (!changed) {
          this.db.exec('ROLLBACK');
          return null;
        }
        this.db.prepare('DELETE FROM signature_accounts WHERE signature_id = ?').run(id);
      }
      const link = this.db.prepare('INSERT OR REPLACE INTO signature_accounts (account_id, signature_id) VALUES (?, ?)');
      for (const a of accountIds) link.run(a, id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.listSignatures(userId).find((s) => s.id === id) ?? null;
  }

  deleteSignature(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM signatures WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  // ---- saved searches (DreyMail) ----------------------------------------------

  listSavedSearches(userId: string): SavedSearch[] {
    const rows = this.db
      .prepare('SELECT id, name, query, account_id, folder FROM saved_searches WHERE user_id = ? ORDER BY created_at, rowid')
      .all(userId) as { id: string; name: string; query: string; account_id: string | null; folder: string }[];
    return rows.map((r) => {
      let q: { q?: unknown; unread?: unknown; filters?: unknown } = {};
      try {
        q = JSON.parse(r.query) as typeof q;
      } catch {
        /* keep the name, drop the broken query */
      }
      return {
        id: r.id,
        name: r.name,
        q: typeof q.q === 'string' ? q.q.slice(0, 500) : '',
        unread: q.unread === true,
        filters: normalizeFilters(q.filters),
        accountId: r.account_id,
        folder: r.folder,
      };
    });
  }

  saveSearch(userId: string, input: { name: string; q: string; unread: boolean; filters: SearchFilters; accountId: string | null; folder: string }): SavedSearch[] {
    // A search scoped to a folder must be in one of the user's own accounts.
    const accountId = input.accountId && this.listAccounts(userId).some((a) => a.id === input.accountId) ? input.accountId : null;
    const query = JSON.stringify({ q: input.q, unread: input.unread, filters: normalizeFilters(input.filters) });
    this.db
      .prepare('INSERT INTO saved_searches (id, user_id, name, query, account_id, folder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), userId, input.name, query, accountId, accountId ? input.folder : 'INBOX', Date.now());
    return this.listSavedSearches(userId);
  }

  deleteSavedSearch(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM saved_searches WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  // ---- recent recipients (address autocomplete) ----------------------------

  rememberRecipients(userId: string, recipients: { name: string; address: string }[]) {
    const stmt = this.db.prepare(
      `INSERT INTO recent_recipients (user_id, address, name, last_used) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, address) DO UPDATE SET
         name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END,
         last_used = excluded.last_used, uses = uses + 1`,
    );
    const now = Date.now();
    for (const r of recipients) stmt.run(userId, r.address.toLowerCase(), r.name, now);
    // Keep the table small: only the 500 most recent per user.
    this.db
      .prepare(
        `DELETE FROM recent_recipients WHERE user_id = ? AND address NOT IN (
           SELECT address FROM recent_recipients WHERE user_id = ? ORDER BY last_used DESC LIMIT 500)`,
      )
      .run(userId, userId);
  }

  searchRecipients(userId: string, query: string, limit = 8): { name: string; address: string }[] {
    const like = `%${query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(
        `SELECT name, address FROM recent_recipients
         WHERE user_id = ? AND (address LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')
         ORDER BY uses DESC, last_used DESC LIMIT ?`,
      )
      .all(userId, like, like, limit) as { name: string; address: string }[];
  }

  // ---- sender domains whose remote images load automatically -----------------
  // Domains are stored normalised (lowercase ASCII/punycode); callers validate them first.

  listImageDomains(userId: string): string[] {
    return (
      this.db.prepare('SELECT domain FROM image_domains WHERE user_id = ? ORDER BY domain').all(userId) as { domain: string }[]
    ).map((r) => r.domain);
  }

  /** Returns false if the user already has `max` domains (re-adding an existing one is fine). */
  addImageDomain(userId: string, domain: string, max: number): boolean {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM image_domains WHERE user_id = ?').get(userId) as { n: number }).n;
    const exists = !!this.db.prepare('SELECT 1 FROM image_domains WHERE user_id = ? AND domain = ?').get(userId, domain);
    if (exists) return true;
    if (count >= max) return false;
    this.db.prepare('INSERT INTO image_domains (user_id, domain, created_at) VALUES (?, ?, ?)').run(userId, domain, Date.now());
    return true;
  }

  removeImageDomain(userId: string, domain: string): boolean {
    return this.db.prepare('DELETE FROM image_domains WHERE user_id = ? AND domain = ?').run(userId, domain).changes > 0;
  }

  // ---- Web Push subscriptions ------------------------------------------------

  addPushSubscription(userId: string, sub: PushSubscriptionInput) {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
           auth = excluded.auth, created_at = excluded.created_at`,
      )
      .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, Date.now());
    this.db
      .prepare(
        `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`,
      )
      .run(userId, userId, MAX_PUSH_SUBSCRIPTIONS);
  }

  listPushSubscriptions(userId: string): PushSubscriptionInput[] {
    const rows = this.db
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY created_at')
      .all(userId) as { endpoint: string; p256dh: string; auth: string }[];
    return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  }

  removePushSubscription(userId: string, endpoint: string): boolean {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint).changes > 0;
  }

  /** Users with notifications enabled on at least one device. */
  pushUserIds(): string[] {
    return (
      this.db.prepare('SELECT user_id FROM push_subscriptions UNION SELECT user_id FROM fcm_tokens').all() as { user_id: string }[]
    ).map((r) => r.user_id);
  }

  // ---- Android app (Firebase) tokens (DreyMail) ------------------------------------

  /** Stores a phone's token; a token used by another user before moves to this one. */
  addFcmToken(userId: string, token: string, keys: { p256dh: string; auth: string }) {
    this.db
      .prepare(
        `INSERT INTO fcm_tokens (token, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(token, userId, keys.p256dh, keys.auth, Date.now());
    // Same cap as push subscriptions: the oldest phones go first.
    this.db
      .prepare(`DELETE FROM fcm_tokens WHERE user_id = ? AND token NOT IN (SELECT token FROM fcm_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_PUSH_SUBSCRIPTIONS})`)
      .run(userId, userId);
  }

  listFcmTokens(userId: string): { token: string; p256dh: string; auth: string }[] {
    return this.db.prepare('SELECT token, p256dh, auth FROM fcm_tokens WHERE user_id = ? ORDER BY created_at').all(userId) as {
      token: string;
      p256dh: string;
      auth: string;
    }[];
  }

  removeFcmToken(userId: string, token: string): boolean {
    return this.db.prepare('DELETE FROM fcm_tokens WHERE user_id = ? AND token = ?').run(userId, token).changes > 0;
  }

  // ---- highest INBOX UID already notified about (per account) ---------------------

  getInboxState(userId: string, accountId: string): { uidValidity: string; lastUid: number } | null {
    const row = this.db
      .prepare(
        `SELECT s.uid_validity, s.last_uid FROM inbox_state s JOIN accounts a ON a.id = s.account_id
         WHERE a.user_id = ? AND a.id = ?`,
      )
      .get(userId, accountId) as { uid_validity: string; last_uid: number } | undefined;
    return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null;
  }

  /** Forget every mark of a user, so new-mail tracking starts over from "now". */
  clearInboxState(userId: string) {
    this.db.prepare('DELETE FROM inbox_state WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)').run(userId);
  }

  setInboxState(userId: string, accountId: string, uidValidity: string, lastUid: number) {
    this.db
      .prepare(
        `INSERT INTO inbox_state (account_id, uid_validity, last_uid)
         SELECT id, ?, ? FROM accounts WHERE user_id = ? AND id = ?
         ON CONFLICT (account_id) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid`,
      )
      .run(uidValidity, lastUid, userId, accountId);
  }

  // ---- snoozed messages ------------------------------------------------------------

  /** Snooze (or re-snooze) messages of one folder until `until`. */
  setSnoozes(userId: string, accountId: string, folder: string, uidValidity: string, uids: number[], until: number) {
    const stmt = this.db.prepare(
      `INSERT INTO snoozes (account_id, folder, uid_validity, uid, until, created_at)
       SELECT id, ?, ?, ?, ?, ? FROM accounts WHERE user_id = ? AND id = ?
       ON CONFLICT (account_id, folder, uid_validity, uid) DO UPDATE SET until = excluded.until`,
    );
    const now = Date.now();
    for (const uid of uids) stmt.run(folder, uidValidity, uid, until, now, userId, accountId);
  }

  /** Wake-up times of the snoozed messages in one folder, by UID. */
  snoozesIn(userId: string, accountId: string, folder: string, uidValidity: string): Map<number, number> {
    const rows = this.db
      .prepare(
        `SELECT s.uid, s.until FROM snoozes s JOIN accounts a ON a.id = s.account_id
         WHERE a.user_id = ? AND a.id = ? AND s.folder = ? AND s.uid_validity = ?`,
      )
      .all(userId, accountId, folder, uidValidity) as { uid: number; until: number }[];
    return new Map(rows.map((r) => [r.uid, r.until]));
  }

  /** Forget snoozes (the messages were woken, moved elsewhere or deleted). */
  deleteSnoozes(userId: string, accountId: string, folder: string, uidValidity: string, uids: number[]) {
    const stmt = this.db.prepare(
      `DELETE FROM snoozes WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ? AND id = ?)
         AND folder = ? AND uid_validity = ? AND uid = ?`,
    );
    for (const uid of uids) stmt.run(userId, accountId, folder, uidValidity, uid);
  }

  /** Snoozes whose time has come, oldest first, across all users. */
  dueSnoozes(now: number, limit = 500): Snooze[] {
    const rows = this.db
      .prepare(
        `SELECT a.user_id, s.account_id, s.folder, s.uid_validity, s.uid, s.until
         FROM snoozes s JOIN accounts a ON a.id = s.account_id
         WHERE s.until <= ? ORDER BY s.until LIMIT ?`,
      )
      .all(now, limit) as { user_id: string; account_id: string; folder: string; uid_validity: string; uid: number; until: number }[];
    return rows.map((r) => ({ userId: r.user_id, accountId: r.account_id, folder: r.folder, uidValidity: r.uid_validity, uid: r.uid, until: r.until }));
  }

  /** When the next snoozed message is due, or null if nothing is snoozed. */
  nextSnoozeDue(): number | null {
    return (this.db.prepare('SELECT MIN(until) AS t FROM snoozes').get() as { t: number | null }).t;
  }
}
