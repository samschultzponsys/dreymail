// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: sign-in values from the environment are recorded as UI overrides; DREYMAIL_ADMIN_USERS.
// Modified by samschultzponsys, 2026-11-13: DREYMAIL_* environment variables; old names are rejected.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-13: Android app notifications (Firebase).
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.

import path from 'node:path';
import { parseHostSuffix } from '../../shared/devHosts.js';
import type { TlsMode } from '../../shared/types.js';
import { oldEnvErrors } from './upgrade.js';
import { TEMPLATE_TOKENS, unknownTokens, type AccountDefaultsConfig } from './accountDefaults.js';

export interface Config {
  production: boolean;
  host: string;
  port: number;
  baseUrl: URL;
  secretKey: string;
  dataDir: string;
  trustProxy: boolean;
  logLevel: string;
  oidc: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    /** Button text on the login page, e.g. "Authentik". */
    label: string;
  } | null;
  /** Username/password login. */
  passwordLogin: boolean;
  /**
   * Who may create a password account: anyone (`open`), only the very first user of an empty
   * instance (`first`), or nobody (`closed`).
   */
  registration: Registration;
  /** Development-only login bypass. Never honoured when NODE_ENV=production. */
  devLogin: boolean;
  /**
   * Development-only: extra hostnames (ending in this suffix) the app may be served from, e.g. via
   * several reverse-proxied dev ports. Always null when NODE_ENV=production.
   */
  devAllowedHostSuffix: string | null;
  /** Refuse IMAP/SMTP hosts that resolve to private/internal addresses. */
  blockPrivateMailHosts: boolean;
  /** Close pooled IMAP connections after this many ms without use. */
  imapIdleTimeoutMs: number;
  /** Largest message (bytes) the server will download for display. */
  maxMessageBytes: number;
  /** Largest total upload size (bytes) for compose attachments. */
  maxUploadBytes: number;
  /** Local copies of INBOX and Sent (see cache/store.ts); null = off, every request goes to IMAP. */
  cache: CacheConfig | null;
  webDir: string;
  /** Contact for push services (VAPID `sub`): a mailto: or https: URL. */
  vapidSubject: string;
  /** What new mail accounts start with (templates with {username} etc.). */
  accountDefaults: AccountDefaultsConfig;
  /**
   * Sign-in values given as environment variables (DreyMail). These override what an administrator
   * sets in the UI, which then shows them as locked. Unset fields are absent.
   */
  loginEnv: LoginEnv;
  /** Usernames or emails that are always administrators (DREYMAIL_ADMIN_USERS), lower case. */
  adminUsers: string[];
  /** Check GitHub for a newer DreyMail release (DREYMAIL_UPDATE_CHECK, default on). */
  updateCheck: boolean;
  /** Firebase (Android app notifications) set in the environment; overrides the UI. */
  firebaseEnv: { serviceAccount?: string; apiKey?: string; appId?: string; senderId?: string };
}

export interface LoginEnv {
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  label?: string;
  passwordLogin?: boolean;
  registration?: Registration;
}

/** Environment variable behind each sign-in field (shown in the UI next to locked fields). */
export const LOGIN_ENV_NAMES: Record<keyof LoginEnv, string> = {
  issuerUrl: 'OIDC_ISSUER_URL',
  clientId: 'OIDC_CLIENT_ID',
  clientSecret: 'OIDC_CLIENT_SECRET',
  scopes: 'OIDC_SCOPES',
  label: 'OIDC_LABEL',
  passwordLogin: 'DREYMAIL_PASSWORD_LOGIN',
  registration: 'DREYMAIL_REGISTRATION',
};

export interface CacheConfig {
  /** Newest messages kept per cached folder. */
  messagesPerFolder: number;
  /** Largest message (bytes) whose content is kept. */
  maxBodyBytes: number;
  /** Total message content (bytes) kept per account; the least recently read goes first. */
  bodyBytesPerAccount: number;
}

export type Registration = 'open' | 'first' | 'closed';

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number): number {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const port = int(env.PORT, 8080);
  const errors: string[] = oldEnvErrors(env);

  const secretKey = env.DREYMAIL_SECRET_KEY ?? '';
  if (secretKey.length < 32) errors.push('DREYMAIL_SECRET_KEY must be set to at least 32 characters');

  let baseUrl: URL;
  try {
    baseUrl = new URL(env.DREYMAIL_BASE_URL || `http://localhost:${port}`);
  } catch {
    errors.push('DREYMAIL_BASE_URL is not a valid URL');
    baseUrl = new URL(`http://localhost:${port}`);
  }

  const oidc = env.OIDC_ISSUER_URL
    ? {
        issuerUrl: env.OIDC_ISSUER_URL,
        clientId: env.OIDC_CLIENT_ID ?? '',
        clientSecret: env.OIDC_CLIENT_SECRET ?? '',
        scopes: env.OIDC_SCOPES || 'openid email profile',
        label: env.OIDC_LABEL?.trim() || 'Single sign-on',
      }
    : null;
  if (oidc && !oidc.clientId) errors.push('OIDC_CLIENT_ID is required when OIDC_ISSUER_URL is set');

  // Without OIDC, password login is the default; with OIDC it has to be switched on explicitly, so
  // existing single sign-on setups don't suddenly accept passwords.
  const passwordLogin = bool(env.DREYMAIL_PASSWORD_LOGIN, !oidc);
  const registration = (env.DREYMAIL_REGISTRATION || 'first').toLowerCase() as Registration;
  if (!['open', 'first', 'closed'].includes(registration)) {
    errors.push('DREYMAIL_REGISTRATION must be open, first or closed');
  }

  const devLogin = !production && bool(env.DREYMAIL_DEV_LOGIN, false);
  if (!oidc && !passwordLogin && !devLogin) {
    errors.push('Enable a login method: OIDC_ISSUER_URL, DREYMAIL_PASSWORD_LOGIN=true (or DREYMAIL_DEV_LOGIN=true outside production)');
  }

  let devAllowedHostSuffix: string | null = null;
  if (!production) {
    try {
      devAllowedHostSuffix = parseHostSuffix(env.DREYMAIL_DEV_ALLOWED_HOST_SUFFIX);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  const vapidSubject =
    env.DREYMAIL_VAPID_SUBJECT ||
    (baseUrl.protocol === 'https:' ? baseUrl.origin : `mailto:postmaster@${baseUrl.hostname}`);
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(vapidSubject)) {
    errors.push('DREYMAIL_VAPID_SUBJECT must be a mailto: or https: URL');
  }

  const accountDefaults = loadAccountDefaults(env, errors);

  // Server-wide limits, never per user: one user must not be able to fill the disk.
  const cache: CacheConfig | null = bool(env.DREYMAIL_CACHE, true)
    ? {
        messagesPerFolder: int(env.DREYMAIL_CACHE_MESSAGES, 2000),
        maxBodyBytes: Math.round(Number(env.DREYMAIL_CACHE_MAX_BODY_MB || 1) * 1024 * 1024),
        bodyBytesPerAccount: int(env.DREYMAIL_CACHE_ACCOUNT_MB, 200) * 1024 * 1024,
      }
    : null;
  if (cache && !(cache.messagesPerFolder >= 50 && cache.messagesPerFolder <= 100_000)) {
    errors.push('DREYMAIL_CACHE_MESSAGES must be between 50 and 100000');
  }
  if (cache && !(cache.maxBodyBytes >= 0 && cache.bodyBytesPerAccount >= 0)) {
    errors.push('DREYMAIL_CACHE_MAX_BODY_MB and DREYMAIL_CACHE_ACCOUNT_MB must not be negative');
  }

  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);

  return {
    production,
    host: env.HOST || '0.0.0.0',
    port,
    baseUrl,
    secretKey,
    dataDir: path.resolve(env.DREYMAIL_DATA_DIR || './data'),
    trustProxy: bool(env.DREYMAIL_TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL || 'info',
    oidc,
    passwordLogin,
    registration,
    devLogin,
    devAllowedHostSuffix,
    blockPrivateMailHosts: bool(env.DREYMAIL_BLOCK_PRIVATE_MAIL_HOSTS, false),
    imapIdleTimeoutMs: int(env.DREYMAIL_IMAP_IDLE_TIMEOUT, 300) * 1000,
    maxMessageBytes: int(env.DREYMAIL_MAX_MESSAGE_MB, 50) * 1024 * 1024,
    maxUploadBytes: int(env.DREYMAIL_MAX_UPLOAD_MB, 25) * 1024 * 1024,
    cache,
    webDir: path.resolve(env.DREYMAIL_WEB_DIR || './dist/web'),
    vapidSubject,
    accountDefaults,
    loginEnv: loginEnvFrom(env, passwordLogin, registration),
    updateCheck: bool(env.DREYMAIL_UPDATE_CHECK, true),
    firebaseEnv: {
      ...(env.DREYMAIL_FIREBASE_SERVICE_ACCOUNT ? { serviceAccount: env.DREYMAIL_FIREBASE_SERVICE_ACCOUNT } : {}),
      ...(env.DREYMAIL_FIREBASE_API_KEY ? { apiKey: env.DREYMAIL_FIREBASE_API_KEY } : {}),
      ...(env.DREYMAIL_FIREBASE_APP_ID ? { appId: env.DREYMAIL_FIREBASE_APP_ID } : {}),
      ...(env.DREYMAIL_FIREBASE_SENDER_ID ? { senderId: env.DREYMAIL_FIREBASE_SENDER_ID } : {}),
    },
    adminUsers: (env.DREYMAIL_ADMIN_USERS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

function loginEnvFrom(env: NodeJS.ProcessEnv, passwordLogin: boolean, registration: Registration): LoginEnv {
  const set = (name: string) => (env[name] ?? '') !== '';
  const out: LoginEnv = {};
  if (set('OIDC_ISSUER_URL')) out.issuerUrl = env.OIDC_ISSUER_URL!;
  if (set('OIDC_CLIENT_ID')) out.clientId = env.OIDC_CLIENT_ID!;
  if (set('OIDC_CLIENT_SECRET')) out.clientSecret = env.OIDC_CLIENT_SECRET!;
  if (set('OIDC_SCOPES')) out.scopes = env.OIDC_SCOPES!;
  if (set('OIDC_LABEL')) out.label = env.OIDC_LABEL!.trim();
  if (set('DREYMAIL_PASSWORD_LOGIN')) out.passwordLogin = passwordLogin;
  if (set('DREYMAIL_REGISTRATION')) out.registration = registration;
  return out;
}

function loadAccountDefaults(env: NodeJS.ProcessEnv, errors: string[]): AccountDefaultsConfig {
  const template = (name: string) => {
    const v = env[name]?.trim() ?? '';
    const unknown = unknownTokens(v);
    if (unknown.length) {
      errors.push(`${name} uses unknown token(s) ${unknown.map((t) => `{${t}}`).join(', ')}; use ${TEMPLATE_TOKENS.map((t) => `{${t}}`).join(', ')}`);
    }
    return v;
  };
  const server = (kind: 'IMAP' | 'SMTP') => {
    const portName = `DREYMAIL_DEFAULT_${kind}_PORT`;
    const tlsName = `DREYMAIL_DEFAULT_${kind}_SECURITY`;
    const rawPort = env[portName]?.trim();
    const port = rawPort ? Number(rawPort) : null;
    if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) errors.push(`${portName} must be a port number`);
    const rawTls = env[tlsName]?.trim().toLowerCase();
    const tls = rawTls ? (rawTls as TlsMode) : null;
    if (tls && !['tls', 'starttls', 'none'].includes(tls)) errors.push(`${tlsName} must be tls, starttls or none`);
    return { host: template(`DREYMAIL_DEFAULT_${kind}_HOST`), port, tls };
  };
  return {
    name: template('DREYMAIL_DEFAULT_ACCOUNT_LABEL'),
    displayName: template('DREYMAIL_DEFAULT_DISPLAY_NAME'),
    email: template('DREYMAIL_DEFAULT_EMAIL'),
    imap: server('IMAP'),
    smtp: server('SMTP'),
    user: template('DREYMAIL_DEFAULT_MAIL_USERNAME'),
    // Taken literally (no tokens, not trimmed): braces and spaces can be part of a password.
    password: env.DREYMAIL_DEFAULT_MAIL_PASSWORD ?? '',
  };
}
