// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Passkeys (WebAuthn): sign in with a fingerprint, face, device PIN or security key instead of a
// password. Signatures and attestation are checked by SimpleWebAuthn. Passkeys are "discoverable",
// so signing in needs no username. They are bound to DREYMAIL_BASE_URL's host and need https (or
// localhost).

import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { FailureLimiter } from './password.js';
import type { Sessions } from './session.js';

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsed: string | null;
}

const CHALLENGE_TTL = 5 * 60_000;

export function registerPasskeyRoutes(app: FastifyInstance, deps: { config: Config; store: Store; sessions: Sessions }) {
  const { config, store, sessions } = deps;
  const db = store.db;
  const rpID = config.baseUrl.hostname;
  const origin = config.baseUrl.origin;
  /** Pending challenges: per user (adding a passkey) or per sign-in attempt. */
  const challenges = new Map<string, { challenge: string; expires: number }>();
  const failures = new FailureLimiter(30, 15 * 60_000);

  const take = (key: string): string | null => {
    const c = challenges.get(key);
    challenges.delete(key);
    return c && c.expires > Date.now() ? c.challenge : null;
  };
  const put = (key: string, challenge: string) => {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
    challenges.set(key, { challenge, expires: now + CHALLENGE_TTL });
  };
  const list = (userId: string): PasskeyView[] =>
    (db.prepare('SELECT id, name, created_at, last_used FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId) as { id: string; name: string; created_at: number; last_used: number }[]).map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
      lastUsed: r.last_used ? new Date(r.last_used).toISOString() : null,
    }));
  const csrf = (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers['x-dreymail'] === '1') return true;
    void reply.code(403).send({ error: 'Missing CSRF header' });
    return false;
  };

  // ---- managing your passkeys (signed in; /api checks the session and CSRF header) ----------

  app.get('/api/passkeys', async (req) => list(req.user!.id));

  app.post('/api/passkeys/options', async (req) => {
    const user = req.user!;
    const options = await generateRegistrationOptions({
      rpName: 'DreyMail',
      rpID,
      userName: user.username || user.email || user.id,
      userDisplayName: user.displayName || user.name || user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: list(user.id).map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    put(`reg:${user.id}`, options.challenge);
    return options;
  });

  app.post('/api/passkeys', async (req, reply) => {
    const user = req.user!;
    const body = z.object({ response: z.unknown(), name: z.string().trim().max(60).default('') }).safeParse(req.body);
    const challenge = take(`reg:${user.id}`);
    if (!body.success || !challenge) return reply.code(400).send({ error: 'That took too long. Try again.' });
    try {
      const v = await verifyRegistrationResponse({ response: body.data.response as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID });
      if (!v.verified) return reply.code(400).send({ error: 'The passkey could not be verified' });
      const c = v.registrationInfo.credential;
      db.prepare('INSERT OR REPLACE INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        c.id,
        user.id,
        Buffer.from(c.publicKey),
        c.counter,
        JSON.stringify(c.transports ?? []),
        body.data.name || `Passkey ${list(user.id).length + 1}`,
        Date.now(),
      );
      return list(user.id);
    } catch (err) {
      return reply.code(400).send({ error: `The passkey could not be added: ${(err as Error).message}` });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/passkeys/:id', async (req, reply) => {
    const n = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.id).changes;
    return n ? list(req.user!.id) : reply.code(404).send({ error: 'Passkey not found' });
  });

  // ---- signing in with a passkey (no session yet) ------------------------------------------------

  app.post('/auth/passkey/options', async (req, reply) => {
    if (!csrf(req, reply)) return reply;
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    const attempt = crypto.randomBytes(18).toString('base64url');
    put(`auth:${attempt}`, options.challenge);
    return { attempt, options };
  });

  app.post('/auth/passkey/verify', async (req, reply) => {
    if (!csrf(req, reply)) return reply;
    if (failures.blocked(req.ip)) return reply.code(429).send({ error: 'Too many failed attempts. Try again in a few minutes.' });
    const body = z.object({ attempt: z.string().max(100), response: z.object({ id: z.string().max(1000) }).passthrough() }).safeParse(req.body);
    const challenge = body.success ? take(`auth:${body.data.attempt}`) : null;
    if (!body.success || !challenge) return reply.code(400).send({ error: 'That took too long. Try again.' });
    const row = db.prepare('SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?').get(body.data.response.id) as
      | { id: string; user_id: string; public_key: Uint8Array; counter: number; transports: string }
      | undefined;
    if (!row || !store.getUser(row.user_id)) {
      failures.fail(req.ip);
      return reply.code(401).send({ error: 'This passkey is not registered with DreyMail' });
    }
    try {
      const v = await verifyAuthenticationResponse({
        response: body.data.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) as never },
      });
      if (!v.verified) throw new Error('not verified');
      db.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?').run(v.authenticationInfo.newCounter, Date.now(), row.id);
      sessions.write(reply, { uid: row.user_id, via: 'passkey' });
      return { ok: true };
    } catch {
      failures.fail(req.ip);
      return reply.code(401).send({ error: 'The passkey could not be verified' });
    }
  });
}
