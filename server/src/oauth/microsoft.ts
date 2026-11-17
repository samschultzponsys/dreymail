// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Outlook.com / Hotmail / Live and Microsoft 365 accounts. Microsoft no longer accepts passwords
// from mail apps, so these accounts sign in with Microsoft (OAuth 2.0 authorization code + PKCE).
// Mail is read over IMAP with an OAuth access token (XOAUTH2); mail is sent through Microsoft Graph,
// which works even where a Microsoft 365 tenant has SMTP sending switched off, and files the copy
// in Sent itself. The refresh token is stored encrypted and rotated as Microsoft hands out new ones.

import crypto from 'node:crypto';
import type { Config } from '../config.js';
import type { Store } from '../db.js';

/** Microsoft app registration (instance setting 'microsoft'); environment variables override it. */
export interface MicrosoftSettings {
  clientId: string;
  /** Sealed in the database. */
  clientSecret: string;
  /** 'common' (work/school and personal accounts), 'consumers', 'organizations' or a tenant ID. */
  tenant: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const SETTING = 'microsoft';
export const SCOPES = {
  imap: 'https://outlook.office.com/IMAP.AccessAsUser.All',
  graph: 'https://graph.microsoft.com/Mail.Send',
  calendar: 'https://graph.microsoft.com/Calendars.ReadWrite',
  /** Changing mail (Outlook categories), asked for only when the user allows it (DreyMail 9.8). */
  mail: 'https://graph.microsoft.com/Mail.ReadWrite',
} as const;
/** Asked for at sign-in: both resources (consented at once), a refresh token, and who the user is. */
const SIGN_IN_SCOPES = `offline_access openid email profile ${SCOPES.imap} ${SCOPES.graph} ${SCOPES.calendar}`;

export class MicrosoftError extends Error {}

export class MicrosoftConfig {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  private stored(): MicrosoftSettings {
    const s = this.store.getSetting<MicrosoftSettings>(SETTING) ?? { clientId: '', clientSecret: '', tenant: '' };
    let clientSecret = '';
    try {
      clientSecret = s.clientSecret ? this.store.openSecret(SETTING, s.clientSecret) : '';
    } catch {
      /* unreadable: treat as not set */
    }
    return { ...s, clientSecret };
  }

  current(): MicrosoftSettings {
    const s = this.stored();
    const env = this.config.microsoftEnv;
    return {
      clientId: env.clientId ?? s.clientId,
      clientSecret: env.clientSecret ?? s.clientSecret,
      tenant: env.tenant ?? (s.tenant || 'common'),
    };
  }

  configured(): boolean {
    const c = this.current();
    return !!(c.clientId && c.clientSecret);
  }

  save(input: { clientId: string; clientSecret: string; tenant: string }) {
    const old = this.stored();
    const clientSecret = input.clientSecret.trim() || old.clientSecret;
    const tenant = input.tenant.trim() || 'common';
    if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant)) throw new MicrosoftError('Tenant must be common, consumers, organizations or a tenant ID');
    this.store.setSetting(SETTING, { clientId: input.clientId.trim(), clientSecret: clientSecret ? this.store.sealSecret(SETTING, clientSecret) : '', tenant });
  }
}

interface Pending {
  userId: string;
  verifier: string;
  color: string;
  expires: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Signing in, and access tokens for connected accounts. */
export class MicrosoftAuth {
  private readonly pending = new Map<string, Pending>();
  private readonly tokens = new Map<string, { value: string; expires: number }>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly settings: MicrosoftConfig,
    private readonly store: Store,
    private readonly baseUrl: URL,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  get redirectUri(): string {
    return new URL('/oauth/microsoft/callback', this.baseUrl).toString();
  }

  private endpoint(path: 'authorize' | 'token'): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.settings.current().tenant)}/oauth2/v2.0/${path}`;
  }

  /** Where to send the browser to sign in. */
  start(userId: string, color: string, extra: 'mail'[] = []): string {
    const c = this.settings.current();
    if (!this.settings.configured()) throw new MicrosoftError('Outlook sign-in is not set up yet (Settings → Outlook)');
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expires < now) this.pending.delete(k);
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    this.pending.set(state, { userId, verifier, color, expires: now + 10 * 60 * 1000 });
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const u = new URL(this.endpoint('authorize'));
    u.search = new URLSearchParams({
      client_id: c.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: [SIGN_IN_SCOPES, ...extra.map((x) => SCOPES[x])].join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return u.toString();
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const c = this.settings.current();
    const res = await this.fetchImpl(this.endpoint('token'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: this.redirectUri, ...params }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || json.error) {
      throw new MicrosoftError(json.error_description?.split('\r\n')[0] || json.error || `Microsoft sign-in failed (${res.status})`);
    }
    return json;
  }

  /**
   * The browser came back from Microsoft. Checks state (and that it's the same DreyMail user),
   * exchanges the code and stores the account. Returns the account id.
   */
  async finish(userId: string, state: string, code: string): Promise<string> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < Date.now() || p.userId !== userId) throw new MicrosoftError('This sign-in link expired. Please try again.');
    const t = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: p.verifier, scope: SCOPES.imap + ' offline_access openid email profile' });
    if (!t.refresh_token || !t.id_token) throw new MicrosoftError('Microsoft did not allow offline access. Please try again and accept the permissions.');
    const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1] ?? '', 'base64url').toString() || '{}') as {
      email?: string;
      preferred_username?: string;
      name?: string;
    };
    const email = (claims.email || claims.preferred_username || '').trim();
    if (!email.includes('@')) throw new MicrosoftError('Microsoft did not tell DreyMail the email address of this account');
    const domain = email.split('@')[1]!.toLowerCase();
    const label = /^(outlook|hotmail|live|msn)\./.test(domain) ? 'Outlook' : domain.split('.')[0]!.replace(/^./, (c) => c.toUpperCase());
    const account = this.store.saveMicrosoftAccount(userId, {
      email,
      name: label,
      displayName: claims.name ?? '',
      color: p.color,
      refreshToken: t.refresh_token,
    });
    if (t.access_token) this.tokens.set(`${account.id}:imap`, { value: t.access_token, expires: Date.now() + (t.expires_in ?? 3600) * 1000 });
    return account.id;
  }

  /** A current access token for this account and resource, refreshed (and the refresh token rotated) when needed. */
  async accessToken(userId: string, accountId: string, resource: keyof typeof SCOPES): Promise<string> {
    const key = `${accountId}:${resource}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expires > Date.now() + 120_000) return cached.value;
    let job = this.refreshing.get(key);
    if (!job) {
      job = (async () => {
        const refreshToken = this.store.getOAuthToken(userId, accountId);
        if (!refreshToken) throw new MicrosoftError('This Outlook account needs to be signed in again (Accounts → Reconnect)');
        let t: TokenResponse;
        try {
          t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: `${SCOPES[resource]} offline_access` });
        } catch (err) {
          throw new MicrosoftError(`Outlook sign-in expired: ${(err as Error).message}. Reconnect the account in Accounts.`);
        }
        if (t.refresh_token && t.refresh_token !== refreshToken) this.store.setOAuthToken(userId, accountId, t.refresh_token);
        this.tokens.set(key, { value: t.access_token!, expires: Date.now() + (t.expires_in ?? 3600) * 1000 });
        return t.access_token!;
      })().finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, job);
    }
    return job;
  }

  /**
   * Puts an Outlook category on the message with this Message-ID (DreyMail 9.8). Needs the
   * Mail.ReadWrite permission, which the user allows by reconnecting with it.
   */
  async addCategory(userId: string, accountId: string, messageId: string, name: string): Promise<void> {
    let token: string;
    try {
      token = await this.accessToken(userId, accountId, 'mail');
    } catch {
      throw new MicrosoftError('Outlook categories need permission to change mail: in the assistant, click "Allow Outlook categories" for this mailbox.');
    }
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const filter = encodeURIComponent(`internetMessageId eq '${messageId.replace(/'/g, "''")}'`);
    const found = await this.fetchImpl(`https://graph.microsoft.com/v1.0/me/messages?$filter=${filter}&$select=id,categories&$top=5`, { method: 'GET', headers });
    if (!found.ok) throw new MicrosoftError(`Outlook didn't find the message (${found.status})`);
    const list = ((await found.json()) as { value?: { id: string; categories?: string[] }[] }).value ?? [];
    for (const m of list) {
      if (m.categories?.includes(name)) continue;
      const res = await this.fetchImpl(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(m.id)}`, { method: 'PATCH', headers, body: JSON.stringify({ categories: [...(m.categories ?? []), name] }) });
      if (!res.ok) throw new MicrosoftError(`Outlook didn't add the category (${res.status})`);
    }
  }

  /** Sends a complete MIME message through Microsoft Graph; Microsoft keeps the copy in Sent. */
  async sendRaw(userId: string, accountId: string, raw: Buffer): Promise<void> {
    const token = await this.accessToken(userId, accountId, 'graph');
    const res = await this.fetchImpl('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: raw.toString('base64'),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const msg = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      throw new MicrosoftError(`Outlook didn't send the message${msg ? `: ${msg}` : ` (${res.status})`}`);
    }
  }
}
