// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// "Add Outlook account": sign in with Microsoft and come back with a connected account. Plus the
// administrator's Microsoft app registration (Settings → Outlook).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDays, setAdminReminder } from '../calendar/adminReminders.js';
import type { MicrosoftSettingsView } from '../../../shared/types.js';
import type { Sessions } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { MicrosoftError, type MicrosoftAuth, type MicrosoftConfig } from '../oauth/microsoft.js';
import type { Access } from '../access.js';

/** Instance setting: when the Microsoft client secret expires (YYYY-MM-DD). */
const SECRET_EXPIRES = 'microsoft.secretExpires';

export function registerMicrosoftRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    store: Store;
    sessions: Sessions;
    access: Access;
    microsoft: MicrosoftAuth;
    microsoftConfig: MicrosoftConfig;
    /** A mailbox signed in again (maybe allowing more): forget what was refused (DreyMail 12.5). */
    onSignedIn?: (userId: string, accountId: string) => void;
  },
) {
  const { config, store, sessions, access, microsoft, microsoftConfig } = deps;

  app.get('/api/oauth/microsoft', async () => ({ available: microsoftConfig.configured() }));

  app.post('/api/oauth/microsoft/start', async (req, reply) => {
    if (!access.require(req, reply, 'mail.accounts')) return reply;
    const body = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b82f6'), allow: z.array(z.enum(['mail', 'people', 'contacts', 'tasks', 'rooms', 'groups'])).max(6).default([]) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid color' });
    try {
      return { url: microsoft.start(req.user!.id, body.data.color, body.data.allow) };
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
      deps.onSignedIn?.(user.id, accountId);
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
      secretExpires: store.getSetting<string>(SECRET_EXPIRES) ?? null,
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
    const body = z
      .object({
        clientId: z.string().max(200),
        clientSecret: z.string().max(500),
        tenant: z.string().max(100),
        /** When the client secret expires (YYYY-MM-DD); a reminder goes in every Superadmin's calendar. */
        secretExpires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    try {
      microsoftConfig.save(body.data);
    } catch (err) {
      if (err instanceof MicrosoftError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    const expires = body.data.secretExpires;
    if (expires && expires !== store.getSetting<string>(SECRET_EXPIRES)) {
      store.setSetting(SECRET_EXPIRES, expires);
      const admins = store.listUsers().filter((u) => access.superadmin(u)).map((u) => u.id);
      // Two weeks ahead (or today, if that's already past).
      const today = new Date().toISOString().slice(0, 10);
      const day = addDays(expires, -14) < today ? today : addDays(expires, -14);
      setAdminReminder(store, admins, {
        key: 'microsoft-secret',
        title: "Renew DreyMail's Outlook client secret",
        notes: [
          `The Outlook (Microsoft) client secret DreyMail uses expires on ${expires}. After that, Outlook and Microsoft 365 mailboxes stop syncing until a new one is saved.`,
          '',
          'To renew: entra.microsoft.com → Applications → App registrations → DreyMail → Certificates & secrets → New client secret (24 months). Copy its Value into DreyMail → Settings → Outlook, set the new expiry date, and save. Then delete the old secret there.',
        ].join('\n'),
        day,
      });
    } else if (body.data.secretExpires === null) store.setSetting(SECRET_EXPIRES, null);
    return view();
  });
}
