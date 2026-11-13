// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FirebaseSettingsView } from '../../shared/types.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { fcmData, parseServiceAccount, type FetchLike } from '../src/push/fcm.js';

const secret = crypto.randomBytes(48).toString('base64');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  project_id: 'dreymail-test',
  client_email: 'push@dreymail-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
});

/** The phone's side of RFC 8291: its key pair, and decrypting what arrives. */
const phone = crypto.createECDH('prime256v1');
phone.generateKeys();
const phoneAuth = crypto.randomBytes(16);
const phoneKeys = { p256dh: phone.getPublicKey().toString('base64url'), auth: phoneAuth.toString('base64url') };
function phoneDecrypt(b64: string): Record<string, string> {
  const buf = Buffer.from(b64, 'base64');
  const salt = buf.subarray(0, 16);
  const idLen = buf[20]!;
  const asPublic = buf.subarray(21, 21 + idLen);
  const ct = buf.subarray(21 + idLen);
  const secret = phone.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, phoneAuth, Buffer.concat([Buffer.from('WebPush: info\0'), phone.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString()) as Record<string, string>;
}

/** Fake Google: hands out a token for a correctly signed JWT and records FCM sends. */
function fakeGoogle(unregistered = new Set<string>()) {
  const sent: { token: string; data: Record<string, string>; priority: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const jwt = new URLSearchParams(init.body).get('assertion')!;
      const [h, p, sig] = jwt.split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig!, 'base64url'));
      const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as { scope: string };
      const good = ok && claims.scope === 'https://www.googleapis.com/auth/firebase.messaging';
      return { status: good ? 200 : 400, ok: good, json: async () => ({ access_token: 'ya29.test', expires_in: 3600 }), text: async () => '' };
    }
    expect(url).toBe('https://fcm.googleapis.com/v1/projects/dreymail-test/messages:send');
    expect(init.headers.authorization).toBe('Bearer ya29.test');
    const msg = (JSON.parse(init.body) as { message: { token: string; data: Record<string, string>; android: { priority: string } } }).message;
    if (unregistered.has(msg.token)) return { status: 404, ok: false, json: async () => ({}), text: async () => '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' };
    // Google only ever sees ciphertext.
    expect(Object.keys(msg.data)).toEqual(['e']);
    sent.push({ token: msg.token, data: phoneDecrypt(msg.data.e!), priority: msg.android.priority });
    return { status: 200, ok: true, json: async () => ({}), text: async () => '' };
  };
  return { sent, fetchImpl };
}

let ctx: App | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

async function start(fetchImpl: FetchLike, env: Record<string, string> = {}) {
  const config = loadConfig({ DREYMAIL_SECRET_KEY: secret, ...env });
  ctx = await buildApp(config, { store: new Store(':memory:', new Keyring(secret).credentialKey), logger: false, fcmFetch: fetchImpl, cacheFile: null });
  const reg = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
  const cookie = `dm_session=${reg.cookies.find((c) => c.name === 'dm_session')!.value}`;
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const res = await ctx!.app.inject({ method, url, payload: payload as object, headers: { cookie, 'x-dreymail': '1' } });
    return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null };
  };
  return { call, store: ctx.store };
}

const firebaseInput = { serviceAccount, apiKey: 'AIzaTest', appId: '1:123:android:abc', senderId: '123' };

describe('Android app notifications (Firebase)', () => {
  it('an administrator sets Firebase up; the app then gets the client values, never the service account', async () => {
    const { call } = await start(fakeGoogle().fetchImpl);
    expect((await call('GET', '/api/push/android')).json).toEqual({ firebase: null });
    const saved = await call('PUT', '/api/admin/firebase', firebaseInput);
    expect(saved.status).toBe(200);
    expect(saved.json as unknown as FirebaseSettingsView).toMatchObject({ configured: true, projectId: 'dreymail-test', hasServiceAccount: true });
    expect(JSON.stringify(saved.json)).not.toContain('PRIVATE KEY');
    const client = (await call('GET', '/api/push/android')).json;
    expect(client).toEqual({ firebase: { projectId: 'dreymail-test', apiKey: 'AIzaTest', appId: '1:123:android:abc', senderId: '123' } });
    expect(JSON.stringify(client)).not.toContain('PRIVATE KEY');
    // Saving again without pasting the JSON keeps it.
    expect(((await call('PUT', '/api/admin/firebase', { ...firebaseInput, serviceAccount: '' })).json as unknown as FirebaseSettingsView).configured).toBe(true);
    expect((await call('PUT', '/api/admin/firebase', { ...firebaseInput, serviceAccount: '{"nope":1}' })).status).toBe(400);
  });

  it('notifications reach the phone as data messages with the account colour; dead tokens are dropped', async () => {
    const google = fakeGoogle(new Set(['dead-token-000000000000000000']));
    const { call, store } = await start(google.fetchImpl);
    await call('PUT', '/api/admin/firebase', firebaseInput);
    expect((await call('POST', '/api/push/android', { token: 'phone-token-00000000000000000000' })).status).toBe(400);
    expect((await call('POST', '/api/push/android', { token: 'phone-token-00000000000000000000', keys: phoneKeys })).status).toBe(200);
    await call('POST', '/api/push/android', { token: 'dead-token-000000000000000000', keys: phoneKeys });
    const user = store.listUsers()[0]!;
    expect(await ctx!.push.sendTest(user.id)).toBe(1);
    expect(google.sent).toEqual([{ token: 'phone-token-00000000000000000000', priority: 'HIGH', data: expect.objectContaining({ type: 'notify', title: 'DreyMail', tag: 'test' }) }]);
    expect(store.listFcmTokens(user.id).map((t) => t.token)).toEqual(['phone-token-00000000000000000000']);
  });

  it('builds per-account data and clear messages', () => {
    const acc = { id: 'a1', name: 'Gmail', color: '#ef4444' };
    expect(fcmData({ title: 'Ada', body: 'Hi', tag: 'a1:7', url: '/?open=a1.9.7' }, acc)).toMatchObject({ type: 'notify', accountId: 'a1', accountName: 'Gmail', color: '#ef4444' });
    expect(fcmData({ type: 'clear', tags: ['a1:7'], badge: 2 }, null)).toEqual({ type: 'clear', tags: '["a1:7"]', badge: '2' });
  });

  it('rejects a broken service account', () => {
    expect(() => parseServiceAccount('{"project_id":"x","client_email":"y","private_key":"not a key"}')).toThrow(/private_key/);
    expect(parseServiceAccount(serviceAccount).project_id).toBe('dreymail-test');
  });
});
