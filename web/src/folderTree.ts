// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import type { FolderView, SpecialUse } from '../../shared/types';

/** The folder bar's order for built-in mailboxes; other folders follow alphabetically. */
export const SPECIAL_ORDER: SpecialUse[] = ['inbox', 'snoozed', 'drafts', 'sent', 'archive', 'junk', 'trash'];

export interface FolderRow {
  folder: FolderView;
  /** Indentation level in the bar (0 = top). */
  depth: number;
  /** It has subfolders shown in the bar, so it gets a fold arrow. */
  hasChildren: boolean;
  /** Its subfolders are folded away. */
  folded: boolean;
  /** Unread mail in the subfolders folded away under it. */
  hiddenUnread: number;
}

const rank = (f: FolderView) => {
  const i = f.specialUse ? SPECIAL_ORDER.indexOf(f.specialUse) : -1;
  return i === -1 ? 100 : i;
};
const bySidebarOrder = (a: FolderView, b: FolderView) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path);

/**
 * The folder bar as a tree: every folder right under its parent, Inbox, Sent and the other built-in
 * mailboxes foldable like any folder. Built-in mailboxes kept in a container that can't hold mail
 * (Gmail's "[Gmail]") move to the top level, so folding that container never hides Sent or Drafts;
 * a container left empty is not shown. With `only` (pinned folders), just those are shown, each under
 * its nearest shown ancestor.
 */
export function folderRows(
  folders: FolderView[],
  opts: { folded?: Iterable<string>; only?: string[] | null; count?: (f: FolderView) => number } = {},
): FolderRow[] {
  const count = opts.count ?? (() => 0);
  const folded = new Set(opts.folded ?? []);
  const byPath = new Map(folders.map((f) => [f.path, f]));
  const realParent = (f: FolderView): string | null => {
    const p = f.parentPath && f.parentPath !== f.path && byPath.has(f.parentPath) ? f.parentPath : null;
    if (p && f.specialUse && !byPath.get(p)!.selectable) return null;
    return p;
  };
  // Containers that can't hold mail and end up with nothing in them are left out.
  const kids = new Map<string | null, FolderView[]>();
  for (const f of folders) {
    const p = realParent(f);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(f);
  }
  const keep = new Set<string>();
  const anyKept = (f: FolderView, seen: Set<string>): boolean => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    let any = f.selectable;
    for (const c of kids.get(f.path) ?? []) if (anyKept(c, seen)) any = true;
    if (any) keep.add(f.path);
    return any;
  };
  for (const f of kids.get(null) ?? []) anyKept(f, new Set());

  const only = opts.only ? new Set(opts.only) : null;
  const shown = (f: FolderView) => keep.has(f.path) && (!only || only.has(f.path));
  // The parent in the bar: the nearest shown ancestor.
  const barParent = (f: FolderView): string | null => {
    const seen = new Set<string>([f.path]);
    for (let p = realParent(f); p; p = realParent(byPath.get(p)!)) {
      if (seen.has(p)) return null;
      seen.add(p);
      if (shown(byPath.get(p)!)) return p;
    }
    return null;
  };
  const children = new Map<string | null, FolderView[]>();
  for (const f of folders)
    if (shown(f)) {
      const p = barParent(f);
      if (!children.has(p)) children.set(p, []);
      children.get(p)!.push(f);
    }
  for (const list of children.values()) list.sort(bySidebarOrder);

  const unreadBelow = (path: string, seen = new Set<string>()): number => {
    if (seen.has(path)) return 0;
    seen.add(path);
    return (children.get(path) ?? []).reduce((n, c) => n + count(c) + unreadBelow(c.path, seen), 0);
  };
  const rows: FolderRow[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const f of children.get(parent) ?? []) {
      if (visited.has(f.path)) continue;
      visited.add(f.path);
      const hasChildren = (children.get(f.path) ?? []).length > 0;
      const isFolded = hasChildren && folded.has(f.path);
      rows.push({ folder: f, depth, hasChildren, folded: isFolded, hiddenUnread: isFolded ? unreadBelow(f.path) : 0 });
      if (!isFolded) walk(f.path, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
