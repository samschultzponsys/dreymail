// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-15: Gmail with an app password, Google's servers filled in (from the provider list).

import type { AccountDefaults, AccountInput } from '../../shared/types';
import { ACCOUNT_COLORS } from './util';
import { MAIL_PROVIDERS } from '../../shared/mailProviders';

/** A new account's form, starting from the admin's defaults (already filled in for this user). */
export function newAccountInput(n: number, defaults: AccountDefaults): AccountInput {
  return {
    name: defaults.name,
    displayName: defaults.displayName,
    email: defaults.email,
    color: ACCOUNT_COLORS[n % ACCOUNT_COLORS.length]!,
    imap: { ...defaults.imap, password: '' },
    smtp: { ...defaults.smtp, password: '' },
    appendSent: true,
  };
}

/** Gmail with an app password: Google's servers filled in (Gmail files sent mail itself). */
export function gmailAppPasswordInput(n: number, defaults: AccountDefaults): AccountInput {
  const gmail = MAIL_PROVIDERS.find((p) => p.id === 'gmail')!;
  const base = newAccountInput(n, defaults);
  return {
    ...base,
    name: 'Gmail',
    color: '#ef4444',
    imap: { ...gmail.imap, user: '', password: '' },
    smtp: { ...gmail.smtp, user: '', password: '' },
    appendSent: gmail.appendSent,
  };
}

/**
 * Will a blank password on a new account be replaced by the admin's default password? Mirrors the
 * server: only while the server is still the default one.
 */
export function usesDefaultPassword(defaults: AccountDefaults, kind: 'imap' | 'smtp', host: string): boolean {
  const def = defaults[kind].host;
  return defaults.password && def !== '' && def.trim().toLowerCase() === host.trim().toLowerCase();
}
