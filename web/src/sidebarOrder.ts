// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Rearranging the sidebar by dragging: groups among groups, mailboxes among mailboxes (also into
// a group, or out of one).

export interface SidebarOrder {
  groups: string[];
  /** Every mailbox in the order shown, with the group it is in (null: none). */
  accounts: { id: string; groupId: string | null }[];
}

export type DropTarget =
  | { type: 'account'; id: string; where: 'before' | 'after' }
  | { type: 'group'; id: string; where: 'before' | 'after' | 'into' }
  | { type: 'ungrouped' };

export interface Dragged {
  kind: 'account' | 'group';
  id: string;
}

/** The order as the sidebar shows it: each group's mailboxes in turn, then those in no group. */
export function currentOrder(groups: { id: string }[], accounts: { id: string; groupId?: string | null }[]): SidebarOrder {
  const known = new Set(groups.map((g) => g.id));
  const groupOf = (a: { groupId?: string | null }) => (a.groupId && known.has(a.groupId) ? a.groupId : null);
  return {
    groups: groups.map((g) => g.id),
    accounts: [
      ...groups.flatMap((g) => accounts.filter((a) => groupOf(a) === g.id).map((a) => ({ id: a.id, groupId: g.id }))),
      ...accounts.filter((a) => !groupOf(a)).map((a) => ({ id: a.id, groupId: null })),
    ],
  };
}

/** The order after dropping `dragged` on `target`, or null when nothing changes. */
export function applyDrop(order: SidebarOrder, dragged: Dragged, target: DropTarget): SidebarOrder | null {
  if (dragged.kind === 'group') {
    if (target.type !== 'group' || target.id === dragged.id || target.where === 'into') return null;
    const groups = order.groups.filter((g) => g !== dragged.id);
    const at = groups.indexOf(target.id);
    if (at < 0) return null;
    groups.splice(target.where === 'before' ? at : at + 1, 0, dragged.id);
    return groups.join() === order.groups.join() ? null : { ...order, groups };
  }
  const moving = order.accounts.find((a) => a.id === dragged.id);
  if (!moving) return null;
  if (target.type === 'account' && target.id === dragged.id) return null;
  const rest = order.accounts.filter((a) => a.id !== dragged.id);
  let groupId: string | null;
  let index: number;
  if (target.type === 'account') {
    const at = rest.findIndex((a) => a.id === target.id);
    if (at < 0) return null;
    groupId = rest[at]!.groupId;
    index = target.where === 'before' ? at : at + 1;
  } else if (target.type === 'group') {
    groupId = target.id;
    // At the end of that group's mailboxes.
    const last = rest.map((a) => a.groupId).lastIndexOf(target.id);
    index = last >= 0 ? last + 1 : rest.length;
  } else {
    groupId = null;
    index = rest.length;
  }
  rest.splice(index, 0, { id: dragged.id, groupId });
  const next = currentOrder(order.groups.map((id) => ({ id })), rest);
  const same = next.accounts.every((a, i) => a.id === order.accounts[i]?.id && a.groupId === order.accounts[i]?.groupId);
  return same ? null : next;
}
