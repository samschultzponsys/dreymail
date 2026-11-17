// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { FolderView, SpecialUse } from '../../shared/types';
import { folderRows } from '../src/folderTree';

const f = (path: string, opts: { special?: SpecialUse; selectable?: boolean; unread?: number; d?: string } = {}): FolderView => {
  const d = opts.d ?? '/';
  const i = path.lastIndexOf(d);
  return {
    path,
    name: i === -1 ? path : path.slice(i + 1),
    delimiter: d,
    parentPath: i === -1 ? '' : path.slice(0, i),
    specialUse: opts.special ?? null,
    selectable: opts.selectable ?? true,
    unread: opts.unread ?? 0,
    total: 0,
  } as FolderView;
};
const outline = (rows: ReturnType<typeof folderRows>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.folder.path}`);

describe('folderRows', () => {
  const outlook = [
    f('Archive', { special: 'archive' }),
    f('Inbox/Projects/Alpha'),
    f('Inbox', { special: 'inbox' }),
    f('Sent Items', { special: 'sent' }),
    f('Inbox/Projects'),
    f('Sent Items/2025'),
    f('Clients'),
    f('Inbox/Bills'),
  ];

  it('puts subfolders of Inbox and Sent right under them', () => {
    expect(outline(folderRows(outlook))).toEqual(['Inbox', '  Inbox/Bills', '  Inbox/Projects', '    Inbox/Projects/Alpha', 'Sent Items', '  Sent Items/2025', 'Archive', 'Clients']);
  });

  it('folds Inbox like any folder, counting the hidden unread mail on it', () => {
    const folders = outlook.map((x) => (x.path === 'Inbox/Bills' ? { ...x, unread: 3 } : x.path === 'Inbox/Projects/Alpha' ? { ...x, unread: 2 } : x));
    const rows = folderRows(folders, { folded: ['Inbox'], count: (x) => x.unread ?? 0 });
    expect(outline(rows)).toEqual(['Inbox', 'Sent Items', '  Sent Items/2025', 'Archive', 'Clients']);
    expect(rows[0]).toMatchObject({ hasChildren: true, folded: true, hiddenUnread: 5 });
    expect(rows.find((r) => r.folder.path === 'Sent Items')).toMatchObject({ hasChildren: true, folded: false });
  });

  it("lifts Gmail's built-in mailboxes out of [Gmail], so folding it never hides Sent", () => {
    const gmail = [
      f('INBOX', { special: 'inbox' }),
      f('[Gmail]', { selectable: false }),
      f('[Gmail]/Sent Mail', { special: 'sent' }),
      f('[Gmail]/Drafts', { special: 'drafts' }),
      f('[Gmail]/Trash', { special: 'trash' }),
      f('Receipts'),
    ];
    expect(outline(folderRows(gmail))).toEqual(['INBOX', '[Gmail]/Drafts', '[Gmail]/Sent Mail', '[Gmail]/Trash', 'Receipts']);
  });

  it('keeps a container that still has ordinary folders in it', () => {
    const rows = folderRows([f('[Gmail]', { selectable: false }), f('[Gmail]/Sent Mail', { special: 'sent' }), f('[Gmail]/Important')]);
    expect(outline(rows)).toEqual(['[Gmail]/Sent Mail', '[Gmail]', '  [Gmail]/Important']);
  });

  it('with pinned folders, nests them under their nearest pinned ancestor and folds there too', () => {
    const only = ['Inbox', 'Inbox/Projects/Alpha', 'Clients'];
    expect(outline(folderRows(outlook, { only }))).toEqual(['Inbox', '  Inbox/Projects/Alpha', 'Clients']);
    expect(outline(folderRows(outlook, { only, folded: ['Inbox'] }))).toEqual(['Inbox', 'Clients']);
  });

  it('ignores a fold on a folder without subfolders and survives odd parent paths', () => {
    const rows = folderRows([f('A'), { ...f('B'), parentPath: 'B' }, { ...f('C'), parentPath: 'missing' }], { folded: ['A'] });
    expect(outline(rows)).toEqual(['A', 'B', 'C']);
    expect(rows[0]!.folded).toBe(false);
  });
});
