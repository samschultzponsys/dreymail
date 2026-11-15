// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Gmail with "Sign in with Google" (OAuth 2.0 authorization code + PKCE) instead of an app password.
// IMAP and SMTP both log in with an OAuth access token (XOAUTH2); Gmail files sent mail itself. The
// refresh token is stored encrypted. App passwords keep working as the other way to add Gmail.

import crypto from 'node:crypto';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { FetchLike } from './microsoft.js';

export interface GoogleSettings {
  clientId: string;
  /** Sealed in the database. */
  clientSecret: string;
}

const SETTING = 'google';
/** Full Gmail access over IMAP/SMTP (Google calls it a restricted scope). */
export const GMAIL_SCOPE = 'https://mail.google.com/';

export class GoogleError extends Error {}

export class GoogleConfig {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  private stored(): GoogleSettings {
    const s = this.store.getSetting<GoogleSettings>(SETTING) ?? { clientId: '', clientSecret: '' };
    let clientSecret = '';
    try {
      clientSecret = s.clientSecret ? this.store.openSecret(SETTING, s.clientSecret) : '';
    } catch {
      /* unreadable: treat as not set */
    }
    return { ...s, clientSecret };
  }

  current(): GoogleSettings {
    const s = this.stored();
    const env = this.config.googleEnv;
    return { clientId: env.clientId ?? s.clientId, clientSecret: env.clientSecret ?? s.clientSecret };
  }

  configured(): boolean {
    const c = this.current();
    return !!(c.clientId && c.clientSecret);
  }

  save(input: { clientId: string; clientSecret: string }) {
    const old = this.stored();
    const clientSecret = input.clientSecret.trim() || old.clientSecret;
    this.store.setSetting(SETTING, { clientId: input.clientId.trim(), clientSecret: clientSecret ? this.store.sealSecret(SETTING, clientSecret) : '' });
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export class GoogleAuth {
  private readonly pending = new Map<string, { userId: string; verifier: string; color: string; expires: number }>();
  private readonly tokens = new Map<string, { value: string; expires: number }>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly settings: GoogleConfig,
    private readonly store: Store,
    private readonly baseUrl: URL,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  get redirectUri(): string {
    return new URL('/oauth/google/callback', this.baseUrl).toString();
  }

  start(userId: string, color: string): string {
    if (!this.settings.configured()) throw new GoogleError('Sign in with Google is not set up yet (Settings → Google)');
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expires < now) this.pending.delete(k);
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    this.pending.set(state, { userId, verifier, color, expires: now + 10 * 60 * 1000 });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: this.settings.current().clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: `openid email profile ${GMAIL_SCOPE}`,
      state,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      // A refresh token every time, so reconnecting always works.
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
    }).toString();
    return u.toString();
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const c = this.settings.current();
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || json.error) throw new GoogleError(json.error_description || json.error || `Google sign-in failed (${res.status})`);
    return json;
  }

  async finish(userId: string, state: string, code: string): Promise<string> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < Date.now() || p.userId !== userId) throw new GoogleError('This sign-in link expired. Please try again.');
    const t = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: this.redirectUri });
    if (!t.refresh_token || !t.id_token) throw new GoogleError('Google did not allow offline access. Please try again and allow access to Gmail.');
    const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1] ?? '', 'base64url').toString() || '{}') as { email?: string; name?: string };
    const email = (claims.email ?? '').trim();
    if (!email.includes('@')) throw new GoogleError('Google did not tell DreyMail the email address of this account');
    const domain = email.split('@')[1]!.toLowerCase();
    const account = this.store.saveGoogleAccount(userId, {
      email,
      name: domain === 'gmail.com' || domain === 'googlemail.com' ? 'Gmail' : domain.split('.')[0]!.replace(/^./, (c) => c.toUpperCase()),
      displayName: claims.name ?? '',
      color: p.color,
      refreshToken: t.refresh_token,
    });
    if (t.access_token) this.tokens.set(account.id, { value: t.access_token, expires: Date.now() + (t.expires_in ?? 3600) * 1000 });
    return account.id;
  }

  /** A current access token (IMAP and SMTP share it), refreshed when needed. */
  async accessToken(userId: string, accountId: string): Promise<string> {
    const cached = this.tokens.get(accountId);
    if (cached && cached.expires > Date.now() + 120_000) return cached.value;
    let job = this.refreshing.get(accountId);
    if (!job) {
      job = (async () => {
        const refreshToken = this.store.getOAuthToken(userId, accountId);
        if (!refreshToken) throw new GoogleError('This Gmail account needs to be signed in again (Accounts → Reconnect)');
        let t: TokenResponse;
        try {
          t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
        } catch (err) {
          throw new GoogleError(`Google sign-in expired: ${(err as Error).message}. Reconnect the account in Accounts.`);
        }
        if (t.refresh_token && t.refresh_token !== refreshToken) this.store.setOAuthToken(userId, accountId, t.refresh_token);
        this.tokens.set(accountId, { value: t.access_token!, expires: Date.now() + (t.expires_in ?? 3600) * 1000 });
        return t.access_token!;
      })().finally(() => this.refreshing.delete(accountId));
      this.refreshing.set(accountId, job);
    }
    return job;
  }
}
