// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Firebase Cloud Messaging (HTTP v1) for the DreyMail Android app. The server watches the inboxes
// with IMAP IDLE (instant) and wakes the phone through FCM, the same way Spark and Gmail do.
// Messages are data-only: the app builds the notification itself, so each account gets its own
// Android notification channel (sound, vibration), a tinted small icon and a coloured large icon.
// No SDK: a service-account JWT is exchanged for an access token, then one POST per device.

import crypto from 'node:crypto';
import type { Store } from '../db.js';
import type { Config } from '../config.js';
import type { ClearPayload, NotificationPayload } from './notify.js';
import { encryptPayload } from './webpush.js';

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Firebase settings for the Android app (instance setting 'firebase'). */
export interface FirebaseSettings {
  /** The service account JSON (sealed in the database). */
  serviceAccount: string;
  /** Public client values the app needs to register for messages. */
  apiKey: string;
  appId: string;
  senderId: string;
}

export interface FirebaseClientConfig {
  projectId: string;
  apiKey: string;
  appId: string;
  senderId: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

const SETTING = 'firebase';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export function parseServiceAccount(json: string): ServiceAccount {
  let v: Partial<ServiceAccount>;
  try {
    v = JSON.parse(json) as Partial<ServiceAccount>;
  } catch {
    throw new Error('The service account is not valid JSON');
  }
  if (!v.project_id || !v.client_email || !v.private_key) throw new Error('The service account JSON needs project_id, client_email and private_key');
  try {
    crypto.createPrivateKey(v.private_key);
  } catch {
    throw new Error("The service account's private_key can't be read");
  }
  return v as ServiceAccount;
}

/** Firebase settings: environment variables override what an administrator saved in the UI. */
export class FirebaseConfig {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  private stored(): FirebaseSettings {
    const s = this.store.getSetting<FirebaseSettings>(SETTING) ?? { serviceAccount: '', apiKey: '', appId: '', senderId: '' };
    let serviceAccount = '';
    try {
      serviceAccount = s.serviceAccount ? this.store.openSecret(SETTING, s.serviceAccount) : '';
    } catch {
      /* unreadable: treat as not set */
    }
    return { ...s, serviceAccount };
  }

  /** Effective values. */
  current(): FirebaseSettings {
    const s = this.stored();
    const env = this.config.firebaseEnv;
    return {
      serviceAccount: env.serviceAccount ?? s.serviceAccount,
      apiKey: env.apiKey ?? s.apiKey,
      appId: env.appId ?? s.appId,
      senderId: env.senderId ?? s.senderId,
    };
  }

  serviceAccount(): ServiceAccount | null {
    const json = this.current().serviceAccount;
    if (!json) return null;
    try {
      return parseServiceAccount(json);
    } catch {
      return null;
    }
  }

  /** What the app needs to register, or null while Firebase isn't set up. */
  client(): FirebaseClientConfig | null {
    const c = this.current();
    const sa = this.serviceAccount();
    if (!sa || !c.apiKey || !c.appId || !c.senderId) return null;
    return { projectId: sa.project_id, apiKey: c.apiKey, appId: c.appId, senderId: c.senderId };
  }

  save(input: { serviceAccount: string; apiKey: string; appId: string; senderId: string }) {
    const old = this.stored();
    const serviceAccount = input.serviceAccount.trim() || old.serviceAccount;
    if (serviceAccount) parseServiceAccount(serviceAccount);
    this.store.setSetting(SETTING, {
      serviceAccount: serviceAccount ? this.store.sealSecret(SETTING, serviceAccount) : '',
      apiKey: input.apiKey.trim(),
      appId: input.appId.trim(),
      senderId: input.senderId.trim(),
    });
  }
}

/** Turns a Web Push payload into an FCM data message for the app. */
export function fcmData(payload: NotificationPayload | ClearPayload, account: { id: string; name: string; color: string } | null): Record<string, string> {
  if ('tags' in payload) {
    return { type: 'clear', tags: JSON.stringify(payload.tags), ...(typeof payload.badge === 'number' ? { badge: String(payload.badge) } : {}) };
  }
  return {
    type: 'notify',
    title: payload.title,
    body: payload.body,
    tag: payload.tag,
    url: payload.url,
    accountId: account?.id ?? '',
    accountName: account?.name ?? '',
    color: account?.color ?? '#22d3ee',
    ...(typeof payload.badge === 'number' ? { badge: String(payload.badge) } : {}),
  };
}

/** FCM data is limited to 4 KB; keep the encrypted, base64'd message well inside it. */
const MAX_PLAIN_BYTES = 2600;

function fitData(data: Record<string, string>): Record<string, string> {
  let d = data;
  while (Buffer.byteLength(JSON.stringify(d)) > MAX_PLAIN_BYTES) {
    if (d.body && d.body.length > 40) d = { ...d, body: `${d.body.slice(0, Math.floor(d.body.length * 0.7))}…` };
    else if (d.tags) d = { ...d, tags: JSON.stringify((JSON.parse(d.tags) as string[]).slice(0, -10)) };
    else break;
  }
  return d;
}

export class FcmSender {
  private token: { value: string; expires: number; project: string } | null = null;

  constructor(
    private readonly firebase: FirebaseConfig,
    private readonly store: Store,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly log?: (msg: string, extra?: Record<string, unknown>) => void,
  ) {}

  private async accessToken(sa: ServiceAccount): Promise<string> {
    if (this.token && this.token.project === sa.project_id && this.token.expires > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const res = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    });
    if (!res.ok) throw new Error(`Google refused the service account (${res.status})`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('Google sent no access token');
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000, project: sa.project_id };
    return json.access_token;
  }

  /** Sends to every phone of the user. Returns how many accepted it; drops tokens Google no longer knows. */
  async send(userId: string, payload: NotificationPayload | ClearPayload, opts: { ttl: number; high: boolean }): Promise<number> {
    const tokens = this.store.listFcmTokens(userId);
    const sa = this.firebase.serviceAccount();
    if (tokens.length === 0 || !sa) return 0;
    const accountId = 'tag' in payload ? payload.tag.split(':')[0] : '';
    const account = this.store.listAccounts(userId).find((a) => a.id === accountId) ?? null;
    const data = fcmData(payload, account);
    let access: string;
    try {
      access = await this.accessToken(sa);
    } catch (err) {
      this.log?.('FCM authentication failed', { error: (err as Error).message });
      return 0;
    }
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
    const plain = Buffer.from(JSON.stringify(fitData(data)));
    const results = await Promise.all(
      tokens.map(async ({ token, p256dh, auth }) => {
        try {
          // End to end: only the phone can read this (Web Push encryption, RFC 8291).
          const sealed = { e: encryptPayload({ p256dh, auth }, plain).toString('base64') };
          const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
            body: JSON.stringify({ message: { token, data: sealed, android: { priority: opts.high ? 'HIGH' : 'NORMAL', ttl: `${opts.ttl}s` } } }),
          });
          if (res.ok) return 1;
          const text = await res.text();
          if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text)) this.store.removeFcmToken(userId, token);
          else this.log?.('FCM delivery failed', { status: res.status });
          return 0;
        } catch {
          return 0;
        }
      }),
    );
    return results.reduce<number>((a, b) => a + b, 0);
  }
}
