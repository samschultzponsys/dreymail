// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Who may do what: each user's role (shared/permissions.ts). Users named in DREYMAIL_ADMIN_USERS are
// always Superadmins, whatever role the database gives them, so an instance can't lock itself out.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ALL_PERMISSIONS, SUPERADMIN, type Permission } from '../../shared/permissions.js';
import type { Config } from './config.js';
import type { Store, User } from './db.js';

export class Access {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  /** Superadmin by the environment (DREYMAIL_ADMIN_USERS). */
  superadminByEnv(user: User): boolean {
    const names = [user.username, user.email].map((s) => s.toLowerCase()).filter(Boolean);
    return names.some((n) => this.config.adminUsers.includes(n));
  }

  superadmin(user: User): boolean {
    return user.roleId === SUPERADMIN || this.superadminByEnv(user);
  }

  permissions(user: User): Permission[] {
    if (this.superadmin(user)) return [...ALL_PERMISSIONS];
    return this.store.getRole(user.roleId)?.permissions ?? [];
  }

  can(user: User, permission: Permission): boolean {
    return this.permissions(user).includes(permission);
  }

  /** For routes: true when allowed, else answers 403 and returns false. */
  require(req: FastifyRequest, reply: FastifyReply, ...anyOf: Permission[]): boolean {
    const perms = this.permissions(req.user!);
    if (anyOf.some((p) => perms.includes(p))) return true;
    void reply.code(403).send({ error: "Your role doesn't allow this" });
    return false;
  }

  /** At least one Superadmin stays (one by the environment counts). */
  lastSuperadmin(user: User): boolean {
    return user.roleId === SUPERADMIN && this.store.countRole(SUPERADMIN) <= 1 && this.config.adminUsers.length === 0;
  }
}
