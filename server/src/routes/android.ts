// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The Android app's notification registration: it asks for the Firebase client values, registers
// with Firebase, and hands its token to the server. /api's preHandler has authenticated the user.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { ImapPool } from '../imap/pool.js';
import type { FirebaseConfig } from '../push/fcm.js';

const tokenSchema = z.object({ token: z.string().min(20).max(4096) });
const registerSchema = tokenSchema.extend({
  // The phone's Web Push keys (base64url): P-256 public key and 16-byte auth secret.
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

function validKeys(keys: { p256dh: string; auth: string }): boolean {
  const pub = Buffer.from(keys.p256dh, 'base64url');
  return pub.length === 65 && pub[0] === 4 && Buffer.from(keys.auth, 'base64url').length === 16;
}

export function registerAndroidPushRoutes(app: FastifyInstance, deps: { store: Store; pool: ImapPool; firebase: FirebaseConfig }) {
  const { store, pool, firebase } = deps;

  /** Firebase client values (public by design), or null while the administrator hasn't set it up. */
  app.get('/api/push/android', async () => ({ firebase: firebase.client() }));

  app.post('/api/push/android', async (req, reply) => {
    const body = registerSchema.safeParse(req.body);
    if (!body.success || !validKeys(body.data.keys)) return reply.code(400).send({ error: 'Invalid token or keys' });
    store.addFcmToken(req.user!.id, body.data.token, body.data.keys);
    // Watch this user's inboxes in the background from now on, so the phone hears about new mail.
    pool.setBackground(req.user!.id, true, true);
    return { ok: true };
  });

  app.delete('/api/push/android', async (req, reply) => {
    const body = tokenSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid token' });
    store.removeFcmToken(req.user!.id, body.data.token);
    if (!store.pushUserIds().includes(req.user!.id)) pool.setBackground(req.user!.id, false);
    return { ok: true };
  });
}
