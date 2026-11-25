// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Which Settings tabs a user has (from SettingsDialog, DreyMail 14.4: so the app's start doesn't
// need the whole Settings window).

import type { Permission } from '../../shared/permissions';
import type { Me } from '../../shared/types';

/** The Settings tabs this user has (DreyMail 12.1: the search at the top only offers these). */
export function settingTabsFor(me: Me): string[] {
  const can = (p: Permission) => me.permissions.includes(p);
  return [
    'device',
    'profile',
    'general',
    'signatures',
    'autoreplies',
    'privacy',
    'backup',
    'cache',
    ...(me.hasPassword ? ['password'] : []),
    ...(can('ai.assistant') ? ['ai'] : []),
    ...(can('users.manage') || can('users.pictures') || can('roles.manage') ? ['users'] : []),
    ...(can('users.manage') ? ['storage'] : []),
    ...(can('roles.manage') ? ['roles'] : []),
    ...(can('signin.manage') ? ['signin'] : []),
    ...(can('server.manage') ? ['server'] : []),
    ...(can('providers.manage') ? ['outlook', 'google'] : []),
    ...(can('android.manage') ? ['android'] : []),
  ];
}
