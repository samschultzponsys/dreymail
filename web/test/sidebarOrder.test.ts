// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { applyDrop, currentOrder } from '../src/sidebarOrder';

const groups = [{ id: 'work' }, { id: 'home' }];
const accounts = [
  { id: 'gmail', groupId: 'home' },
  { id: 'ponsys', groupId: 'work' },
  { id: 'outlook', groupId: 'work' },
  { id: 'purely', groupId: null },
];
const order = currentOrder(groups, accounts);
const ids = (o: ReturnType<typeof currentOrder> | null) => o!.accounts.map((a) => `${a.id}:${a.groupId ?? '-'}`);

describe('rearranging the sidebar by dragging', () => {
  it('starts from what is shown: each group in turn, then mailboxes in no group', () => {
    expect(ids(order)).toEqual(['ponsys:work', 'outlook:work', 'gmail:home', 'purely:-']);
  });

  it('moves a mailbox before or after another, into that one’s group', () => {
    expect(ids(applyDrop(order, { kind: 'account', id: 'outlook' }, { type: 'account', id: 'ponsys', where: 'before' }))).toEqual(['outlook:work', 'ponsys:work', 'gmail:home', 'purely:-']);
    expect(ids(applyDrop(order, { kind: 'account', id: 'purely' }, { type: 'account', id: 'gmail', where: 'after' }))).toEqual(['ponsys:work', 'outlook:work', 'gmail:home', 'purely:home']);
  });

  it('drops a mailbox into a group (at its end) or out of every group', () => {
    expect(ids(applyDrop(order, { kind: 'account', id: 'purely' }, { type: 'group', id: 'work', where: 'into' }))).toEqual(['ponsys:work', 'outlook:work', 'purely:work', 'gmail:home']);
    expect(ids(applyDrop(order, { kind: 'account', id: 'ponsys' }, { type: 'ungrouped' }))).toEqual(['outlook:work', 'gmail:home', 'purely:-', 'ponsys:-']);
  });

  it('moves groups among groups', () => {
    expect(applyDrop(order, { kind: 'group', id: 'home' }, { type: 'group', id: 'work', where: 'before' })!.groups).toEqual(['home', 'work']);
  });

  it('changes nothing when dropped where it already is', () => {
    expect(applyDrop(order, { kind: 'account', id: 'ponsys' }, { type: 'account', id: 'outlook', where: 'before' })).toBeNull();
    expect(applyDrop(order, { kind: 'group', id: 'work' }, { type: 'group', id: 'home', where: 'before' })).toBeNull();
    expect(applyDrop(order, { kind: 'account', id: 'ponsys' }, { type: 'account', id: 'ponsys', where: 'after' })).toBeNull();
  });
});
