// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// "Add Gmail with Sign in with Google", and the administrator's Google OAuth client (Settings → Google).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GoogleSettingsView } from '../../../shared/types.js';
import type { Sessions } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { GoogleError, type GoogleAuth, type GoogleConfig } from '../oauth/google.js';
import type { Access } from '../access.js';

export function registerGoogleRoutes(app: FastifyInstance, deps: { config: Config; store: Store; sessions: Sessions; access: Access; google: GoogleAuth; googleConfig: GoogleConfig }) {
  const { config, store, sessions, access, google, googleConfig } = deps;

  app.get('/api/oauth/google', async () => ({ available: googleConfig.configured() }));

  app.post('/api/oauth/google/start', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    const body = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ef4444') }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid colour' });
    try {
      return { url: google.start(req.user!.id, body.data.color) };
    } catch (err) {
      if (err instanceof GoogleError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/oauth/google/callback', async (req, reply) => {
    const back = (params: Record<string, string>) => reply.redirect(`/?${new URLSearchParams({ provider: 'google', ...params }).toString()}`);
    const session = sessions.read(req);
    const user = session ? store.getUser(session.uid) : null;
    if (!user) return back({ outlook: 'error', message: 'Sign in to DreyMail first, then add the Gmail account again.' });
    const { code, state, error, error_description } = req.query;
    if (error) return back({ outlook: 'error', message: (error === 'access_denied' ? 'Access to Gmail was not allowed.' : (error_description ?? error)).slice(0, 300) });
    if (!code || !state) return back({ outlook: 'error', message: 'Google sent an incomplete answer. Please try again.' });
    try {
      return back({ outlook: 'added', account: await google.finish(user.id, state, code) });
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'Google sign-in failed');
      return back({ outlook: 'error', message: (err as Error).message.slice(0, 300) });
    }
  });

  const view = (): GoogleSettingsView => {
    const c = googleConfig.current();
    const env = config.googleEnv;
    return {
      configured: googleConfig.configured(),
      clientId: c.clientId,
      hasClientSecret: !!c.clientSecret,
      redirectUri: google.redirectUri,
      locked: {
        ...(env.clientId ? { clientId: 'DREYMAIL_GOOGLE_CLIENT_ID' } : {}),
        ...(env.clientSecret ? { clientSecret: 'DREYMAIL_GOOGLE_CLIENT_SECRET' } : {}),
      },
    };
  };

  app.get('/api/admin/google', async (req, reply) => (access.require(req, reply, 'providers.manage') ? view() : reply));

  app.put('/api/admin/google', async (req, reply) => {
    if (!access.require(req, reply, 'providers.manage')) return reply;
    const body = z.object({ clientId: z.string().max(300), clientSecret: z.string().max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    googleConfig.save(body.data);
    return view();
  });
}
