// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-15: passkey sign-in.
// Modified by samschultzponsys, 2026-11-15: connecting single sign-on to an existing account.
// Modified by samschultzponsys, 2026-11-17: trusted devices (sliding sessions) and the idle app lock.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { openJson, openJsonWithExpiry, sealJson } from '../crypto.js';

export const SESSION_COOKIE = 'dm_session';
export const LOGIN_COOKIE = 'dm_login';
const SESSION_TTL = 14 * 24 * 3600;
const LOGIN_TTL = 10 * 60;
/** Trusted devices stay signed in while used at least this often… */
export const TRUSTED_TTL = 30 * 24 * 3600;
/** …but sign in again after this long, whatever happens. */
export const TRUSTED_MAX = 365 * 24 * 3600;

export interface SessionData {
  uid: string;
  /** How the user signed in. Missing in sessions from before password login existed (those are OIDC). */
  via?: 'oidc' | 'password' | 'dev' | 'passkey';
  /** id_token for RP-initiated logout, if the provider supports it. */
  idt?: string;
  /** When the user signed in (ms) (DreyMail). */
  since?: number;
  /** A trusted device: the session slides (see TRUSTED_TTL) (DreyMail). */
  trusted?: boolean;
  /** Lock the app after this many idle minutes; unlocking needs a passkey (DreyMail). */
  lockAfter?: number;
  /** Last time the user did something on this device (ms) (DreyMail). */
  seen?: number;
  /** Locked until unlocked with a passkey (DreyMail). */
  locked?: boolean;
}

export interface LoginTransaction {
  state: string;
  nonce: string;
  verifier: string;
  /** Connecting single sign-on to this signed-in account (user id) instead of signing in. */
  link?: string;
}

/**
 * Sessions are stateless, AES-GCM encrypted cookies (no server-side session store needed, which
 * keeps the "one container, one SQLite file" promise). HttpOnly + SameSite=Lax, Secure on https.
 */
export class Sessions {
  constructor(
    private readonly key: Buffer,
    private readonly secure: boolean,
  ) {}

  private cookieOpts(path: string, maxAge: number) {
    return { path, httpOnly: true, sameSite: 'lax' as const, secure: this.secure, maxAge };
  }

  read(req: FastifyRequest): SessionData | null {
    return openJson<SessionData>(this.key, req.cookies[SESSION_COOKIE], 'session');
  }

  /** The session and when its cookie expires (Unix seconds). */
  readWithExpiry(req: FastifyRequest): { data: SessionData; exp: number } | null {
    const r = openJsonWithExpiry<SessionData>(this.key, req.cookies[SESSION_COOKIE], 'session');
    return r ? { data: r.value, exp: r.exp } : null;
  }

  /** A new session (sign-in): 14 days. */
  write(reply: FastifyReply, data: SessionData) {
    this.store(reply, { since: Date.now(), seen: Date.now(), ...data }, SESSION_TTL);
  }

  /**
   * The same session with changes. Trusted devices get a fresh TRUSTED_TTL (until TRUSTED_MAX after
   * signing in); others keep their expiry.
   */
  rewrite(reply: FastifyReply, data: SessionData, exp: number) {
    const now = Math.floor(Date.now() / 1000);
    const since = Math.floor((data.since ?? Date.now()) / 1000);
    const ttl = data.trusted ? Math.min(TRUSTED_TTL, since + TRUSTED_MAX - now) : exp - now;
    if (ttl <= 0) return this.clear(reply);
    this.store(reply, { ...data, since: data.since ?? Date.now() }, ttl);
  }

  private store(reply: FastifyReply, data: SessionData, ttl: number) {
    reply.setCookie(SESSION_COOKIE, sealJson(this.key, data, ttl, 'session'), this.cookieOpts('/', ttl));
  }

  clear(reply: FastifyReply) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  writeLogin(reply: FastifyReply, tx: LoginTransaction) {
    reply.setCookie(LOGIN_COOKIE, sealJson(this.key, tx, LOGIN_TTL, 'login'), this.cookieOpts('/auth', LOGIN_TTL));
  }

  takeLogin(req: FastifyRequest, reply: FastifyReply): LoginTransaction | null {
    reply.clearCookie(LOGIN_COOKIE, { path: '/auth' });
    return openJson<LoginTransaction>(this.key, req.cookies[LOGIN_COOKIE], 'login');
  }
}
