// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// "Add Outlook account": sign in with Microsoft and come back with a connected account. Plus the
// administrator's Microsoft app registration (Settings → Outlook).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MicrosoftSettingsView } from '../../../shared/types.js';
import type { Sessions } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { MicrosoftError, type MicrosoftAuth, type MicrosoftConfig } from '../oauth/microsoft.js';
import type { Access } from '../access.js';

export function registerMicrosoftRoutes(
  app: FastifyInstance,
  deps: { config: Config; store: Store; sessions: Sessions; access: Access; microsoft: MicrosoftAuth; microsoftConfig: MicrosoftConfig },
) {
  const { config, store, sessions, access, microsoft, microsoftConfig } = deps;

  app.get('/api/oauth/microsoft', async () => ({ available: microsoftConfig.configured() }));

  app.post('/api/oauth/microsoft/start', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    const body = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b82f6') }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid color' });
    try {
      return { url: microsoft.start(req.user!.id, body.data.color) };
    } catch (err) {
      if (err instanceof MicrosoftError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Microsoft sends the browser back here (outside /api: it's a plain navigation, without our CSRF
  // header). The state ties it to the sign-in this DreyMail user started.
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/oauth/microsoft/callback', async (req, reply) => {
    const back = (params: Record<string, string>) => reply.redirect(`/?${new URLSearchParams(params).toString()}`);
    const session = sessions.read(req);
    const user = session ? store.getUser(session.uid) : null;
    if (!user) return back({ outlook: 'error', message: 'Sign in to DreyMail first, then add the Outlook account again.' });
    const { code, state, error, error_description } = req.query;
    if (error) return back({ outlook: 'error', message: (error_description ?? error).split('\r\n')[0]!.slice(0, 300) });
    if (!code || !state) return back({ outlook: 'error', message: 'Microsoft sent an incomplete answer. Please try again.' });
    try {
      const accountId = await microsoft.finish(user.id, state, code);
      return back({ outlook: 'added', account: accountId });
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'Microsoft sign-in failed');
      return back({ outlook: 'error', message: (err as Error).message.slice(0, 300) });
    }
  });

  // ---- administrator: the Microsoft app registration --------------------------------

  const view = (): MicrosoftSettingsView => {
    const c = microsoftConfig.current();
    const env = config.microsoftEnv;
    return {
      configured: microsoftConfig.configured(),
      clientId: c.clientId,
      hasClientSecret: !!c.clientSecret,
      tenant: c.tenant,
      redirectUri: microsoft.redirectUri,
      locked: {
        ...(env.clientId ? { clientId: 'DREYMAIL_MICROSOFT_CLIENT_ID' } : {}),
        ...(env.clientSecret ? { clientSecret: 'DREYMAIL_MICROSOFT_CLIENT_SECRET' } : {}),
        ...(env.tenant ? { tenant: 'DREYMAIL_MICROSOFT_TENANT' } : {}),
      },
    };
  };

  app.get('/api/admin/microsoft', async (req, reply) => (access.require(req, reply, 'providers.manage') ? view() : reply));

  app.put('/api/admin/microsoft', async (req, reply) => {
    if (!access.require(req, reply, 'providers.manage')) return reply;
    const body = z.object({ clientId: z.string().max(200), clientSecret: z.string().max(500), tenant: z.string().max(100) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    try {
      microsoftConfig.save(body.data);
    } catch (err) {
      if (err instanceof MicrosoftError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return view();
  });
}
