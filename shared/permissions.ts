// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/**
 * Roles and permission flags. Every user has one role. Two roles are built in:
 *  - Superadmin: has every permission, including ones added in later versions. Can't be edited.
 *  - User: what new users get unless the default role is changed. Its flags can be edited.
 * Administrators can add their own roles with any mix of flags.
 */

export const PERMISSIONS = [
  { key: 'mail.accounts', group: 'Using DreyMail', label: 'Add, edit and remove their own mailboxes' },
  { key: 'profile.picture', group: 'Using DreyMail', label: 'Change their own profile picture' },
  { key: 'ai.assistant', group: 'Using DreyMail', label: 'Use the AI mailbox assistant (with their own or a shared AI connection)' },
  { key: 'users.manage', group: 'Administration', label: 'Add and remove users, reset passwords' },
  { key: 'users.pictures', group: 'Administration', label: "Change anyone's profile picture" },
  { key: 'roles.manage', group: 'Administration', label: 'Create roles and give users a role' },
  { key: 'signin.manage', group: 'Administration', label: 'Sign-in settings (OIDC, passwords, registration)' },
  { key: 'server.manage', group: 'Administration', label: 'Server settings (new mailbox defaults, mail cache, limits, push)' },
  { key: 'providers.manage', group: 'Administration', label: 'Set up Sign in with Microsoft and Google' },
  { key: 'android.manage', group: 'Administration', label: 'Set up Android app notifications (Firebase)' },
  { key: 'ai.manage', group: 'Administration', label: 'Set up shared AI connections, and AI connections to servers on the local network' },
  { key: 'updates.view', group: 'Administration', label: 'See when a new DreyMail version is out' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.key);
export const SUPERADMIN = 'superadmin';
export const USER_ROLE = 'user';
/** What the built-in User role starts with: everything for using the app, nothing administrative. */
export const USER_DEFAULTS: Permission[] = ['mail.accounts', 'profile.picture'];

export interface Role {
  id: string;
  name: string;
  permissions: Permission[];
  /** Superadmin and User: can't be deleted (and Superadmin can't be changed). */
  builtin: boolean;
  /** How many users have this role. */
  users: number;
}

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (ALL_PERMISSIONS as string[]).includes(v);
}

/** Any administrative flag: opens the administration tabs. */
export const ADMIN_PERMISSIONS: Permission[] = PERMISSIONS.filter((p) => p.group === 'Administration').map((p) => p.key);
