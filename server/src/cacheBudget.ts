// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Space for each user's cached mail (DreyMail 12.3): one allowance per user (Settings → Server,
// DREYMAIL_CACHE_USER_MB), split across their mailboxes evenly or by the shares they choose
// (Settings → Search and storage). Each mailbox's share holds its message summaries, its search
// index and stored message content (which gives way first).

import type { CacheSplit } from '../../shared/types.js';
import type { Store } from './db.js';
import { storedServerSettings } from './serverSettings.js';

export const DEFAULT_USER_MB = 4096;
const MB = 1024 * 1024;

/** Each mailbox's fraction of the allowance: even, or the chosen shares (mailboxes left out get none). */
export function cacheShares(accountIds: string[], split?: CacheSplit | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!accountIds.length) return out;
  const custom = split?.mode === 'custom' ? accountIds.map((id) => Math.max(0, Number(split.shares?.[id]) || 0)) : null;
  const sum = custom?.reduce((a, b) => a + b, 0) ?? 0;
  accountIds.forEach((id, i) => out.set(id, custom && sum > 0 ? custom[i]! / sum : 1 / accountIds.length));
  return out;
}

export class CacheBudget {
  constructor(private readonly store: Store) {}

  /** The allowance per user, in MB (the environment wins over the saved setting). */
  userMb(): number {
    const raw = process.env.DREYMAIL_CACHE_USER_MB ?? storedServerSettings(this.store).DREYMAIL_CACHE_USER_MB ?? '';
    const n = raw === '' ? DEFAULT_USER_MB : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 1024 * 1024) : DEFAULT_USER_MB;
  }

  /** Bytes the account's cached mail may take. */
  accountBytes(userId: string, accountId: string): number {
    const user = this.store.getUser(userId);
    const ids = this.store.listAccounts(userId).map((a) => a.id);
    return Math.floor(this.userMb() * MB * (cacheShares(ids, user?.preferences.cacheSplit).get(accountId) ?? 0));
  }
}
