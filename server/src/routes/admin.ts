// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Administration: users (list, add, give a role, reset password, change picture, remove), roles
// with permission flags, sign-in settings (OIDC, password login, registration) and the Android app's
// Firebase setup. Each needs its own permission (shared/permissions.ts); /api's preHandler has
// already authenticated the user and checked the CSRF header.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { isPermission, SUPERADMIN, type Permission, type Role } from '../../../shared/permissions.js';
import type { AdminUser, FirebaseSettingsView, StorageReport, StorageUserUsage } from '../../../shared/types.js';
import type { Access } from '../access.js';
import { parsePicture, PictureError, pictureUrl } from '../profilePicture.js';
import { AssistantStore } from '../ai/store.js';
import { hashPassword, LOCAL_ISSUER, passwordSchema, usernameSchema } from '../auth/password.js';
import type { Sessions } from '../auth/session.js';
import type { Config } from '../config.js';
import type { Store, User } from '../db.js';
import type { MailService } from '../imap/mail.js';
import type { ImapPool } from '../imap/pool.js';
import { LoginSettingsError, type LoginSettings } from '../loginSettings.js';
import type { FirebaseConfig } from '../push/fcm.js';
import type { MailCache } from '../cache/store.js';
import { databaseUsage, emptyDatabaseUsage, sqliteFileBytes } from '../storage.js';

export interface AdminDeps {
  config: Config;
  store: Store;
  sessions: Sessions;
  access: Access;
  login: LoginSettings;
  pool: ImapPool;
  mail: MailService;
  firebase: FirebaseConfig;
  /** The mail cache (null when switched off) and the SQLite files, for Settings → Storage. */
  storage?: { cache: MailCache | null; files: { name: string; path: string | null }[] };
  /** A user's AI assistant switch changed (start or stop watching their inboxes). */
  onAiAccess?: (userId: string) => void;
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
  oidcAutoLogin: z.boolean().optional(),
  registration: registrationSchema,
});
const newUserSchema = z.object({ username: z.string().max(500), password: z.string().max(1000), roleId: z.string().max(64).optional() });
const patchUserSchema = z.object({ roleId: z.string().max(64).optional(), password: z.string().max(1000).optional(), aiAccess: z.enum(['', 'on', 'off']).optional() });
const roleSchema = z.object({ name: z.string().trim().min(1).max(60), permissions: z.array(z.string().max(60)).max(100) });
const testSchema = z.object({ issuerUrl: z.string().max(2000), clientId: z.string().max(500), clientSecret: z.string().max(2000) });

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps) {
  const { config, store, sessions, access, login, pool, mail, firebase } = deps;
  const ai = new AssistantStore(store);

  const view = (u: User & { accounts: number }): AdminUser => ({
    id: u.id,
    name: u.displayName || u.name,
    username: u.username,
    email: u.email,
    login: u.hasPassword ? 'password' : u.issuer === 'dev-login' ? 'dev' : 'oidc',
    sso: store.identitiesOf(u.id).length > 0,
    roleId: access.superadminByEnv(u) ? SUPERADMIN : u.roleId,
    adminByEnv: access.superadminByEnv(u),
    accounts: u.accounts,
    createdAt: new Date(u.createdAt).toISOString(),
    avatar: pictureUrl(store, u),
    hasPicture: u.avatarVersion > 0,
    aiAccess: ai.access(u.id),
  });
  const listUsers = () => store.listUsers().map(view);
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });
  const may = (req: FastifyRequest, reply: FastifyReply, ...p: Permission[]) => access.require(req, reply, ...p);

  /**
   * Nobody can hand out more than they have: giving a role (or building one) needs every flag in
   * it, and only a Superadmin can make Superadmins.
   */
  const canGrant = (me: User, role: Role) =>
    role.id === SUPERADMIN ? access.superadmin(me) : role.permissions.every((p) => access.can(me, p));

  // ---- users -----------------------------------------------------------------

  app.get('/api/admin/users', async (req, reply) => (may(req, reply, 'users.manage', 'roles.manage', 'users.pictures') ? listUsers() : reply));

  app.post('/api/admin/users', async (req, reply) => {
    if (!may(req, reply, 'users.manage')) return reply;
    const body = newUserSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Username and password are required');
    const username = usernameSchema.safeParse(body.data.username);
    if (!username.success) return bad(reply, username.error.issues[0]!.message);
    const password = passwordSchema.safeParse(body.data.password);
    if (!password.success) return bad(reply, password.error.issues[0]!.message);
    const role = body.data.roleId ? store.getRole(body.data.roleId) : null;
    if (body.data.roleId && (!role || !canGrant(req.user!, role))) return bad(reply, "You can't give that role");
    const user = store.createPasswordUser(LOCAL_ISSUER, username.data, await hashPassword(password.data));
    if (!user) return reply.code(409).send({ error: 'That username is taken' });
    if (role) store.setUserRole(user.id, role.id);
    return listUsers();
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    const me = req.user!;
    const body = patchUserSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    const target = store.getUser(req.params.id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (body.data.roleId !== undefined && body.data.roleId !== target.roleId) {
      if (!may(req, reply, 'roles.manage')) return reply;
      const role = store.getRole(body.data.roleId);
      if (!role) return bad(reply, 'That role no longer exists');
      if (!canGrant(me, role)) return bad(reply, "You can't give a role with more rights than your own");
      // Taking a role away is as strong as giving it: only a Superadmin can demote one.
      if (target.roleId === SUPERADMIN && !access.superadmin(me)) return bad(reply, 'Only a Superadmin can change a Superadmin');
      if (target.id === me.id) return bad(reply, "You can't change your own role");
      if (access.lastSuperadmin(target)) return bad(reply, 'Keep at least one Superadmin');
      store.setUserRole(target.id, role.id);
    }
    if (body.data.aiAccess !== undefined) {
      if (!may(req, reply, 'users.manage')) return reply;
      ai.setAccess(target.id, body.data.aiAccess);
      deps.onAiAccess?.(target.id);
    }
    if (body.data.password !== undefined) {
      if (!may(req, reply, 'users.manage')) return reply;
      if (!target.hasPassword) return bad(reply, 'This user signs in with OIDC and has no password');
      if (target.roleId === SUPERADMIN && !access.superadmin(me)) return bad(reply, "Only a Superadmin can reset a Superadmin's password");
      const password = passwordSchema.safeParse(body.data.password);
      if (!password.success) return bad(reply, password.error.issues[0]!.message);
      store.setPasswordHash(target.id, await hashPassword(password.data));
    }
    return listUsers();
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    if (!may(req, reply, 'users.manage')) return reply;
    const me = req.user!;
    const target = store.getUser(req.params.id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.id === me.id) return bad(reply, "You can't remove yourself");
    if (target.roleId === SUPERADMIN && !access.superadmin(me)) return bad(reply, 'Only a Superadmin can remove a Superadmin');
    if (access.lastSuperadmin(target)) return bad(reply, 'Keep at least one Superadmin');
    // Close their mail connections and forget their cached mail before the rows go.
    for (const a of store.listAccounts(target.id)) {
      mail.forgetAccount(target.id, a.id);
      pool.invalidate(target.id, a.id);
    }
    store.deleteUser(target.id);
    return listUsers();
  });

  // Someone else's profile picture.
  app.put<{ Params: { id: string } }>('/api/admin/users/:id/picture', async (req, reply) => {
    if (!may(req, reply, 'users.pictures')) return reply;
    if (!store.getUser(req.params.id)) return reply.code(404).send({ error: 'User not found' });
    const body = z.object({ image: z.string().max(500_000) }).safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid picture');
    try {
      store.setAvatar(req.params.id, parsePicture(body.data.image));
    } catch (err) {
      if (err instanceof PictureError) return bad(reply, err.message);
      throw err;
    }
    return listUsers();
  });
  app.delete<{ Params: { id: string } }>('/api/admin/users/:id/picture', async (req, reply) => {
    if (!may(req, reply, 'users.pictures')) return reply;
    store.setAvatar(req.params.id, null);
    return listUsers();
  });

  // ---- roles -------------------------------------------------------------------

  const rolesView = () => ({ roles: store.listRoles(), defaultRole: store.defaultRole() });
  // Space used per user: their data in the main database and their mailboxes' copies in the mail cache.
  app.get('/api/admin/storage', async (req, reply) => {
    if (!may(req, reply, 'users.manage')) return reply;
    const db = databaseUsage(store.db);
    const cache = deps.storage?.cache ?? null;
    let cached: ReturnType<MailCache['usage']> = [];
    try {
      cached = cache?.usage() ?? [];
    } catch {
      /* the cache is optional; an unreadable one counts as empty */
    }
    const users: StorageUserUsage[] = store.listUsers().map((u) => {
      const accounts = new Map(store.listAccounts(u.id).map((a) => [a.id, a]));
      const mailboxes = cached
        .filter((c) => c.userId === u.id)
        .map((c) => {
          const a = accounts.get(c.accountId);
          return { accountId: c.accountId, name: a ? a.name : null, email: a?.email ?? '', folders: c.folders, messages: c.messages, messageBytes: c.messageBytes, bodies: c.bodies, bodyBytes: c.bodyBytes };
        })
        .sort((a, b) => b.messageBytes + b.bodyBytes - (a.messageBytes + a.bodyBytes));
      const database = db.get(u.id) ?? emptyDatabaseUsage();
      const total = Object.values(database).reduce((s, n) => s + n, 0) + mailboxes.reduce((s, m) => s + m.messageBytes + m.bodyBytes, 0);
      return { id: u.id, name: u.displayName || u.name || u.username || u.email, avatar: pictureUrl(store, u), database, mailboxes, total };
    });
    users.sort((a, b) => b.total - a.total);
    const report: StorageReport = {
      files: (deps.storage?.files ?? []).filter((f) => f.path && f.path !== ':memory:').map((f) => ({ name: f.name, bytes: sqliteFileBytes(f.path) })),
      cacheEnabled: !!cache,
      users,
    };
    return report;
  });

  app.get('/api/admin/roles', async (req, reply) => (may(req, reply, 'roles.manage', 'users.manage') ? rolesView() : reply));

  const saveRole = (req: FastifyRequest, reply: FastifyReply, id: string | null) => {
    if (!may(req, reply, 'roles.manage')) return reply;
    const body = roleSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Give the role a name');
    const permissions = body.data.permissions.filter(isPermission);
    const missing = permissions.filter((p) => !access.can(req.user!, p));
    if (missing.length) return bad(reply, "A role can't have rights you don't have yourself");
    if (id === SUPERADMIN) return bad(reply, 'Superadmin always has every right and cannot be changed');
    if (id && store.getRole(id) && !canGrant(req.user!, store.getRole(id)!)) return bad(reply, "You can't change a role with more rights than your own");
    const role = store.saveRole(id, body.data.name, permissions);
    return role ? rolesView() : reply.code(404).send({ error: 'Role not found' });
  };
  app.post('/api/admin/roles', async (req, reply) => saveRole(req, reply, null));
  app.put<{ Params: { id: string } }>('/api/admin/roles/:id', async (req, reply) => saveRole(req, reply, req.params.id));
  app.delete<{ Params: { id: string } }>('/api/admin/roles/:id', async (req, reply) => {
    if (!may(req, reply, 'roles.manage')) return reply;
    const role = store.getRole(req.params.id);
    if (!role) return reply.code(404).send({ error: 'Role not found' });
    if (role.builtin) return bad(reply, 'Superadmin and User are built in and stay');
    if (!canGrant(req.user!, role)) return bad(reply, "You can't remove a role with more rights than your own");
    store.deleteRole(role.id);
    return rolesView();
  });
  app.put('/api/admin/roles-default', async (req, reply) => {
    if (!may(req, reply, 'roles.manage')) return reply;
    const body = z.object({ roleId: z.string().max(64) }).safeParse(req.body);
    const role = body.success ? store.getRole(body.data.roleId) : null;
    if (!role || role.id === SUPERADMIN) return bad(reply, 'New users can get any role except Superadmin');
    if (!canGrant(req.user!, role)) return bad(reply, "You can't give that role");
    store.setDefaultRole(role.id);
    return rolesView();
  });

  // ---- sign-in settings ------------------------------------------------------------

  app.get('/api/admin/login', async (req, reply) => (may(req, reply, 'signin.manage') ? login.view() : reply));

  app.put('/api/admin/login', async (req, reply) => {
    if (!may(req, reply, 'signin.manage')) return reply;
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

  // ---- Android app notifications (Firebase) --------------------------------------------

  const firebaseView = (): FirebaseSettingsView => {
    const c = firebase.current();
    const env = config.firebaseEnv;
    const sa = firebase.serviceAccount();
    return {
      configured: firebase.client() !== null,
      hasServiceAccount: !!sa,
      projectId: sa?.project_id ?? '',
      serviceAccountEmail: sa?.client_email ?? '',
      apiKey: c.apiKey,
      appId: c.appId,
      senderId: c.senderId,
      locked: {
        ...(env.serviceAccount ? { serviceAccount: 'DREYMAIL_FIREBASE_SERVICE_ACCOUNT' } : {}),
        ...(env.apiKey ? { apiKey: 'DREYMAIL_FIREBASE_API_KEY' } : {}),
        ...(env.appId ? { appId: 'DREYMAIL_FIREBASE_APP_ID' } : {}),
        ...(env.senderId ? { senderId: 'DREYMAIL_FIREBASE_SENDER_ID' } : {}),
      },
    };
  };
  const firebaseSchema = z.object({ serviceAccount: z.string().max(20_000), apiKey: z.string().max(200), appId: z.string().max(200), senderId: z.string().max(100) });

  app.get('/api/admin/firebase', async (req, reply) => (may(req, reply, 'android.manage') ? firebaseView() : reply));

  app.put('/api/admin/firebase', async (req, reply) => {
    if (!may(req, reply, 'android.manage')) return reply;
    const body = firebaseSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 'Invalid request');
    try {
      firebase.save(body.data);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
    return firebaseView();
  });

  /** Checks that the provider can be discovered with these values (before saving them). */
  app.post('/api/admin/login/test', async (req, reply) => {
    if (!may(req, reply, 'signin.manage')) return reply;
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
