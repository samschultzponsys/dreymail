// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Administration: users (list, add, make admin, reset password, remove) and sign-in settings
// (OIDC, password login, registration). Only administrators may call these; /api's preHandler has
// already authenticated the user and checked the CSRF header.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { AdminUser } from '../../../shared/types.js';
import { hashPassword, LOCAL_ISSUER, passwordSchema, usernameSchema } from '../auth/password.js';
import type { Sessions } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Store, User } from '../db.js';
import type { MailService } from '../imap/mail.js';
import type { ImapPool } from '../imap/pool.js';
import { LoginSettingsError, type LoginSettings } from '../loginSettings.js';

export interface AdminDeps {
  config: Config;
  store: Store;
  sessions: Sessions;
  login: LoginSettings;
  pool: ImapPool;
  mail: MailService;
}

/** Administrator: flagged in the database, or named in DREYMAIL_ADMIN_USERS. */
export function isAdmin(config: Config, user: User): boolean {
  return user.admin || adminByEnv(config, user);
}

function adminByEnv(config: Config, user: User): boolean {
  const names = [user.username, user.email].map((s) => s.toLowerCase()).filter(Boolean);
  return names.some((n) => config.adminUsers.includes(n));
}

const registrationSchema = z.enum(['open', 'first', 'closed']);
const loginSchema = z.object({
  oidcEnabled: z.boolean(),
  issuerUrl: z.string().max(2000),
  clientId: z.string().max(500),
  clientSecret: z.string().max(2000),
  clearClientSecret: z.boolean().default(false),
  scopes: z.string().max(500),
  label: z.string().max(100),
  passwordLogin: z.boolean(),
  registration: registrationSchema,
});
const newUserSchema = z.object({ username: z.string().max(500), password: z.string().max(1000), admin: z.boolean().default(false) });
const patchUserSchema = z.object({ admin: z.boolean().optional(), password: z.string().max(1000).optional() });
const testSchema = z.object({ issuerUrl: z.string().max(2000), clientId: z.string().max(500), clientSecret: z.string().max(2000) });

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps) {
  const { config, store, sessions, login, pool, mail } = deps;

  const admin = (req: FastifyRequest, reply: FastifyReply): User | null => {
    const user = req.user!;
    if (!isAdmin(config, user)) {
      void reply.code(403).send({ error: 'Administrators only' });
      return null;
    }
    return user;
  };

  const view = (u: User & { accounts: number }): AdminUser => ({
    id: u.id,
    name: u.name,
    username: u.username,
    email: u.email,
    login: u.hasPassword ? 'password' : u.issuer === 'dev-login' ? 'dev' : 'oidc',
    admin: isAdmin(config, u),
    adminByEnv: adminByEnv(config, u),
    accounts: u.accounts,
    createdAt: new Date(u.createdAt).toISOString(),
  });
  const listUsers = () => store.listUsers().map(view);
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

  // ---- users -----------------------------------------------------------------

  app.get('/api/admin/users', async (req, reply) => (admin(req, reply) ? listUsers() : reply));

  app.post('/api/admin/users', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const body = newUserSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Username and password are required');
    const username = usernameSchema.safeParse(body.data.username);
    if (!username.success) return bad(reply, username.error.issues[0]!.message);
    const password = passwordSchema.safeParse(body.data.password);
    if (!password.success) return bad(reply, password.error.issues[0]!.message);
    const user = store.createPasswordUser(LOCAL_ISSUER, username.data, await hashPassword(password.data));
    if (!user) return reply.code(409).send({ error: 'That username is taken' });
    if (body.data.admin) store.setAdmin(user.id, true);
    return listUsers();
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    const me = admin(req, reply);
    if (!me) return reply;
    const body = patchUserSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    const target = store.getUser(req.params.id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (body.data.admin !== undefined && body.data.admin !== target.admin) {
      if (!body.data.admin && target.id === me.id) return bad(reply, "You can't remove your own administrator rights");
      if (!body.data.admin && target.admin && store.countAdmins() <= 1 && config.adminUsers.length === 0) {
        return bad(reply, 'Keep at least one administrator');
      }
      store.setAdmin(target.id, body.data.admin);
    }
    if (body.data.password !== undefined) {
      if (!target.hasPassword) return bad(reply, 'This user signs in with OIDC and has no password');
      const password = passwordSchema.safeParse(body.data.password);
      if (!password.success) return bad(reply, password.error.issues[0]!.message);
      store.setPasswordHash(target.id, await hashPassword(password.data));
    }
    return listUsers();
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    const me = admin(req, reply);
    if (!me) return reply;
    const target = store.getUser(req.params.id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.id === me.id) return bad(reply, "You can't remove yourself");
    // Close their mail connections and forget their cached mail before the rows go.
    for (const a of store.listAccounts(target.id)) {
      mail.forgetAccount(target.id, a.id);
      pool.invalidate(target.id, a.id);
    }
    store.deleteUser(target.id);
    return listUsers();
  });

  // ---- sign-in settings ------------------------------------------------------------

  app.get('/api/admin/login', async (req, reply) => (admin(req, reply) ? login.view() : reply));

  app.put('/api/admin/login', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    try {
      const { effective } = login.preview(body.data);
      // Don't let an administrator lock themselves out.
      const via = sessions.read(req)?.via;
      if (via === 'password' && !effective.passwordLogin) {
        return bad(reply, 'You signed in with a password. Sign in with OIDC first before turning password login off.');
      }
      if ((via ?? 'oidc') === 'oidc' && !effective.oidc && !effective.passwordLogin) {
        return bad(reply, 'Keep at least one way to sign in');
      }
      login.save(body.data);
      return login.view();
    } catch (err) {
      if (err instanceof LoginSettingsError) return bad(reply, err.message);
      throw err;
    }
  });

  /** Checks that the provider can be discovered with these values (before saving them). */
  app.post('/api/admin/login/test', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const body = testSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    const current = login.current().oidc;
    const env = config.loginEnv;
    const issuer = env.issuerUrl ?? body.data.issuerUrl.trim();
    const clientId = env.clientId ?? body.data.clientId.trim();
    // A blank secret means "keep the stored one".
    const secret = env.clientSecret ?? (body.data.clientSecret || current?.clientSecret || '');
    let url: URL;
    try {
      url = new URL(issuer);
    } catch {
      return bad(reply, 'Issuer URL is not a valid URL');
    }
    try {
      const cfg = await oidc.discovery(url, clientId, secret || undefined, undefined, {
        execute: !config.production && url.protocol === 'http:' ? [oidc.allowInsecureRequests] : [],
      });
      return { ok: true, issuer: cfg.serverMetadata().issuer };
    } catch (err) {
      return reply.code(502).send({ error: `Could not reach the provider: ${(err as Error).message}` });
    }
  });
}
