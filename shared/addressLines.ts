// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Whether the composer shows the Cc and Bcc lines by itself: set for all mailboxes, for a group or
// for one mailbox. The most specific setting wins, for each line on its own.

export type AddressLine = 'cc' | 'bcc';
export type AddressLineLevel = 'mailbox' | 'group' | 'all';

/** A group's or mailbox's own choice; a line left out follows the next level up. */
export type AddressLineSetting = Partial<Record<AddressLine, boolean>>;

export interface AddressLines {
  all: Record<AddressLine, boolean>;
  groups: Record<string, AddressLineSetting>;
  accounts: Record<string, AddressLineSetting>;
}

/** By default Cc is always there and Bcc is a click away. */
export const DEFAULT_ADDRESS_LINES: AddressLines = { all: { cc: true, bcc: false }, groups: {}, accounts: {} };

/** Whether `line` shows when writing from this mailbox, and which level decided it. */
export function resolveAddressLine(
  lines: AddressLines | undefined,
  account: { id: string; groupId?: string | null } | undefined,
  line: AddressLine,
): { show: boolean; level: AddressLineLevel } {
  const l = lines ?? DEFAULT_ADDRESS_LINES;
  const own = account ? l.accounts[account.id]?.[line] : undefined;
  if (own !== undefined) return { show: own, level: 'mailbox' };
  const group = account?.groupId ? l.groups[account.groupId]?.[line] : undefined;
  if (group !== undefined) return { show: group, level: 'group' };
  return { show: l.all[line] ?? DEFAULT_ADDRESS_LINES.all[line], level: 'all' };
}

/** The settings with `line` set to `show` at `level` (for this mailbox, its group, or all). */
export function setAddressLine(
  lines: AddressLines | undefined,
  account: { id: string; groupId?: string | null } | undefined,
  level: AddressLineLevel,
  line: AddressLine,
  show: boolean | undefined,
): AddressLines {
  const l = lines ?? DEFAULT_ADDRESS_LINES;
  const put = (map: Record<string, AddressLineSetting>, id: string) => {
    const next = { ...(map[id] ?? {}) };
    if (show === undefined) delete next[line];
    else next[line] = show;
    const out = { ...map };
    if (Object.keys(next).length) out[id] = next;
    else delete out[id];
    return out;
  };
  if (level === 'mailbox' && account) return { ...l, accounts: put(l.accounts, account.id) };
  if (level === 'group' && account?.groupId) return { ...l, groups: put(l.groups, account.groupId) };
  return { ...l, all: { ...l.all, [line]: show ?? DEFAULT_ADDRESS_LINES.all[line] } };
}
