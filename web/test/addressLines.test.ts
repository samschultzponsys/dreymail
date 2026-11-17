// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { DEFAULT_ADDRESS_LINES, resolveAddressLine, setAddressLine } from '../../shared/addressLines';

const work = { id: 'w', groupId: 'g' };
const home = { id: 'h', groupId: null };

describe('Cc and Bcc lines', () => {
  it('shows Cc and hides Bcc by default', () => {
    expect(resolveAddressLine(undefined, work, 'cc')).toEqual({ show: true, level: 'all' });
    expect(resolveAddressLine(DEFAULT_ADDRESS_LINES, home, 'bcc')).toEqual({ show: false, level: 'all' });
  });

  it('lets a mailbox override its group, and a group override all', () => {
    let l = setAddressLine(undefined, work, 'group', 'bcc', true);
    expect(resolveAddressLine(l, work, 'bcc')).toEqual({ show: true, level: 'group' });
    expect(resolveAddressLine(l, home, 'bcc')).toEqual({ show: false, level: 'all' });
    l = setAddressLine(l, work, 'mailbox', 'bcc', false);
    expect(resolveAddressLine(l, work, 'bcc')).toEqual({ show: false, level: 'mailbox' });
    // Each line on its own: Cc still follows all.
    expect(resolveAddressLine(l, work, 'cc')).toEqual({ show: true, level: 'all' });
    // Back to the group's choice.
    l = setAddressLine(l, work, 'mailbox', 'bcc', undefined);
    expect(l.accounts).toEqual({});
    expect(resolveAddressLine(l, work, 'bcc').level).toBe('group');
  });

  it('changes the setting for all mailboxes', () => {
    const l = setAddressLine(undefined, home, 'all', 'cc', false);
    expect(resolveAddressLine(l, work, 'cc')).toEqual({ show: false, level: 'all' });
    expect(DEFAULT_ADDRESS_LINES.all.cc).toBe(true); // the defaults are never changed in place
  });
});
