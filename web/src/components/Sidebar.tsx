// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: user-visible name changed from "Ratatoskr" to "DreyMail".
// Modified by samschultzponsys, 2026-11-13: day/night DreyMail logo instead of the favicon.
// Modified by samschultzponsys, 2026-11-13: hides "All inboxes" when turned off in Settings.
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.
// Modified by samschultzponsys, 2026-11-15: saved searches as smart folders.
// Modified by samschultzponsys, 2026-11-15: roles and permissions, profile pictures, grouped settings, empty mailbox screen.
// Modified by samschultzponsys, 2026-11-15: choose what the bottom left shows (photo, name or both).
// Modified by samschultzponsys, 2026-11-15: mailbox icons.
// Modified by samschultzponsys, 2026-11-15: your own picture as a mailbox icon.
// Modified by samschultzponsys, 2026-11-15: AI mailbox assistant.
// Modified by samschultzponsys, 2026-11-15: copy codes, unsubscribe, block sender, mailbox health.
// Modified by samschultzponsys, 2026-11-15: send later and undo send.
// Modified by samschultzponsys, 2026-11-15: calendar.
// Modified by samschultzponsys, 2026-11-16: mailbox groups as sections that expand and collapse.
// Modified by samschultzponsys, 2026-11-16: pinned folders, the rest behind "show all".
// Modified by samschultzponsys, 2026-11-16: the folder bar can be dragged wider or narrower.
// Modified by samschultzponsys, 2026-11-16: groups and mailboxes rearranged by dragging.
// Modified by samschultzponsys, 2026-11-16: right-click a group's name; group pictures.
// Modified by samschultzponsys, 2026-11-16: right-click a mailbox's name for its menu.
// Modified by samschultzponsys, 2026-11-16: right-click the folder bar's empty space for New group….
// Modified by samschultzponsys, 2026-11-17: Install the app button (in a browser).
// Modified by samschultzponsys, 2026-11-17: room under Compose for the Sending list.
// Modified by samschultzponsys, 2026-11-17: subfolders fold away (collapse kept in preferences, on every device).
// Modified by samschultzponsys, 2026-11-17: folders as a real tree (Inbox, Sent… fold like any folder; folding works with pins); collapsed mailboxes and groups remembered per device.
// Modified by samschultzponsys, 2026-11-17: Calendar as a prominent button under Compose, marked while open.
// Modified by samschultzponsys, 2026-11-17: server and app versions at the bottom, with a warning when they differ.
// Modified by samschultzponsys, 2026-11-18: the version as one short label (a red ! when the app is out of step).

import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  ChevronUp,
  Pin,
  PinOff,
  BellOff,
  CalendarDays,
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  File,
  Folder,
  Inbox,
  LogOut,
  PenSquare,
  Send,
  Settings,
  ShieldAlert,
  Star,
  Trash2,
  UserCog,
  Layers,
  Search,
  Sparkles,
  Pencil,
  FolderPlus,
  TriangleAlert,
  X,
  Download,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { SavedSearch } from '../../../shared/search';
import { PaneResizer } from './PaneResizer';
import { ContextMenu, type MenuItem } from './MailboxMenu';
import { applyDrop, currentOrder, type DropTarget, type Dragged, type SidebarOrder } from '../sidebarOrder';
import { folderRows } from '../folderTree';
import type { AccountFolders, AccountView, FolderView, MailboxGroupView, SpecialUse } from '../../../shared/types';
import { api, type MailboxSel } from '../api';
import { ChangelogDialog } from './ChangelogDialog';
import { InstallDialog } from './InstallDialog';
import { runningAsApp } from '../install';
import { UserAvatar } from './UserPicture';
import { checkVersions } from '../../../shared/versions';
import { WEB_VERSION } from '../buildInfo';
import { desktopBridge } from '../desktop';
import { androidBridge, androidInfo } from '../android';
import { MailboxIcon } from './MailboxIcon';

const SPECIAL_ICON: Record<SpecialUse, ReactNode> = {
  inbox: <Inbox size={16} />,
  sent: <Send size={16} />,
  drafts: <File size={16} />,
  trash: <Trash2 size={16} />,
  archive: <Archive size={16} />,
  junk: <ShieldAlert size={16} />,
  all: <Layers size={16} />,
  flagged: <Star size={16} />,
  snoozed: <AlarmClock size={16} />,
};
interface Props {
  /** PCs: dragging the right edge sets the folder bar's width (null: back to the default). */
  onResize?: (width: number | null, done: boolean) => void;
  /** Pin or unpin folders of a mailbox (the new list of pinned paths). */
  onPin?: (accountId: string, folders: string[]) => void;
  /** Mailbox groups: sidebar sections that expand and collapse. */
  groups?: MailboxGroupView[];
  /** Show the "All inboxes" entry (Settings → All inboxes). */
  showUnified: boolean;
  /** Full name, for the tooltip when only the first name is shown. */
  userFullName: string;
  /** Profile picture URL, or null for initials. */
  userAvatar: string | null;
  /** What the bottom left shows: photo and name, name only, or photo only. */
  footerIdentity?: 'both' | 'name' | 'photo';
  accounts: AccountView[];
  folders: AccountFolders[] | undefined;
  sel: MailboxSel;
  onSelect: (sel: MailboxSel) => void;
  onCompose: () => void;
  /** Shown right under Compose (the Sending list) (DreyMail). */
  belowCompose?: ReactNode;
  /** Folders whose subfolders are folded away, per mailbox (a preference, so every device shows the same) (DreyMail). */
  collapsedFolders?: Record<string, string[]>;
  onToggleFolder?: (accountId: string, path: string) => void;
  /** The calendar page is showing (DreyMail). */
  calendarActive?: boolean;
  onAccounts: () => void;
  onSettings: () => void;
  onLogout: () => void;
  userLabel: string;
  onCloseNav: () => void;
  /** Saved searches, listed as smart folders. */
  searches: SavedSearch[];
  activeSearch: string | null;
  onSearch: (s: SavedSearch) => void;
  onDeleteSearch: (s: SavedSearch) => void;
  /** Messages waiting to be sent later, and opening their list. */
  scheduledCount?: number;
  onScheduled?: () => void;
  /** Open the calendar. */
  onCalendar?: () => void;
  /** Open the AI assistant for a mailbox (only when the user may use it). */
  onAssistant?: (accountId: string) => void;
  /** Open a mailbox's settings (right-click its name); absent when the user may not edit mailboxes. */
  onEditAccount?: (accountId: string) => void;
  /** Groups and mailboxes rearranged by dragging; absent when the user may not change mailboxes. */
  onReorder?: (order: SidebarOrder) => void;
  /** Open a group's settings (right-click its name); absent when the user may not change mailboxes. */
  onEditGroup?: (groupId: string) => void;
  /** Opens the new-group form (right-click on the folder bar's empty space). */
  onNewGroup?: () => void;
}

export function Sidebar({ onResize, onPin, groups = [], accounts, showUnified, userFullName, userAvatar, footerIdentity = 'both', folders, sel, onSelect, onCompose, onAccounts, onSettings, onLogout, userLabel, onCloseNav, searches, activeSearch, onSearch, onDeleteSearch, onAssistant, onEditAccount, onReorder, onEditGroup, onNewGroup, scheduledCount = 0, onScheduled, onCalendar, belowCompose, collapsedFolders = {}, onToggleFolder, calendarActive = false }: Props) {
  // Server version (bottom left) and, for administrators, whether a newer image is out.
  const version = useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 3600_000, refetchInterval: 3600_000 });
  const [showLog, setShowLog] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  // In a browser only: the desktop and Android apps and installed web apps don't need it.
  const [offerInstall, setOfferInstall] = useState(() => {
    if (runningAsApp()) return false;
    try {
      return localStorage.getItem('dm-install-hidden') !== '1';
    } catch {
      return true;
    }
  });
  // Collapsed mailboxes, groups and saved searches, remembered on this device (DreyMail).
  const [collapsed, setCollapsedState] = useState<Record<string, boolean>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem('navCollapsed') ?? '{}') as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const setCollapsed = (f: (c: Record<string, boolean>) => Record<string, boolean>) =>
    setCollapsedState((c) => {
      const next = Object.fromEntries(Object.entries(f(c)).filter(([, v]) => v));
      try {
        localStorage.setItem('navCollapsed', JSON.stringify(next));
      } catch {
        /* private mode: kept until reload */
      }
      return next;
    });
  /** Mailboxes whose unpinned folders are shown too (the ⌄ under the pinned ones). */
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [rail, setRail] = useState(() => localStorage.getItem('navRail') === '1');
  // Dragging groups and mailboxes into another order (not in the narrow icon-only bar).
  const [drag, setDrag] = useState<Dragged | null>(null);
  const [over, setOver] = useState<{ key: string; where: 'before' | 'after' | 'into' } | null>(null);
  const canDrag = !!onReorder && !rail;
  const half = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY - r.top < r.height / 2 ? ('before' as const) : ('after' as const);
  };
  const dragProps = (item: Dragged) =>
    canDrag
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.id);
            setDrag(item);
          },
          onDragEnd: () => {
            setDrag(null);
            setOver(null);
          },
        }
      : {};
  /** `target` says what a drop here means (null: not here, for what is being dragged). */
  const dropProps = (key: string, target: (e: React.DragEvent) => DropTarget | null) =>
    canDrag
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!drag) return;
            const t = target(e);
            if (!t) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const where = t.type === 'ungrouped' ? 'into' : t.where;
            if (over?.key !== key || over.where !== where) setOver({ key, where });
          },
          onDrop: (e: React.DragEvent) => {
            const t = drag && target(e);
            e.preventDefault();
            const next = drag && t ? applyDrop(currentOrder(groups, accounts), drag, t) : null;
            setDrag(null);
            setOver(null);
            if (next) onReorder?.(next);
          },
        }
      : {};
  const dropClass = (key: string) => (over?.key === key ? `drop-${over.where}` : '');

  /** The right-click menu on a mailbox's name. */
  const [menu, setMenu] = useState<{ acc: AccountView; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  /** The right-click menu on a group's name. */
  const [groupMenu, setGroupMenu] = useState<{ group: MailboxGroupView; x: number; y: number } | null>(null);
  const closeGroupMenu = useCallback(() => setGroupMenu(null), []);
  /** The right-click menu on the folder bar's empty space. */
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null);
  const closeBlankMenu = useCallback(() => setBlankMenu(null), []);
  const blankMenuItems: MenuItem[] = [
    ...(onNewGroup ? [{ label: 'New group…', icon: <FolderPlus size={15} />, onClick: onNewGroup }] : []),
    { label: 'Mail accounts…', icon: <UserCog size={15} />, onClick: onAccounts },
  ];
  const groupMenuItems = (g: MailboxGroupView): MenuItem[] => {
    const key = `g:${g.id}`;
    const items: MenuItem[] = [];
    if (onEditGroup) items.push({ label: 'Edit group…', icon: <Pencil size={15} />, onClick: () => onEditGroup(g.id) });
    if (!rail) items.push({ label: collapsed[key] ? 'Expand' : 'Collapse', icon: collapsed[key] ? <ChevronDown size={15} /> : <ChevronUp size={15} />, onClick: () => setCollapsed((c) => ({ ...c, [key]: !c[key] })) });
    return items;
  };
  const menuItems = (acc: AccountView): MenuItem[] => {
    const isCollapsed = !!collapsed[acc.id];
    const items: MenuItem[] = [];
    if (onEditAccount) items.push({ label: 'Edit mailbox…', icon: <Pencil size={15} />, onClick: () => onEditAccount(acc.id) });
    if (!rail) items.push({ label: isCollapsed ? 'Expand' : 'Collapse', icon: isCollapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />, onClick: () => setCollapsed((c) => ({ ...c, [acc.id]: !c[acc.id] })) });
    if (!rail && (acc.pinnedFolders ?? []).length > 0)
      items.push({
        label: showAll[acc.id] ? 'Show pinned folders only' : 'Show all folders',
        icon: <Folder size={15} />,
        onClick: () => {
          setCollapsed((c) => ({ ...c, [acc.id]: false }));
          setShowAll((s) => ({ ...s, [acc.id]: !s[acc.id] }));
        },
      });
    if (onAssistant) items.push({ label: 'AI assistant', icon: <Sparkles size={15} />, onClick: () => onAssistant(acc.id) });
    return items;
  };
  useEffect(() => localStorage.setItem('navRail', rail ? '1' : '0'), [rail]);
  const totalUnread = (folders ?? []).reduce((sum, a) => sum + (a.folders.find((f) => f.specialUse === 'inbox')?.unread ?? 0), 0);

  const renderAccount = (acc: AccountView) => {
          const af = folders?.find((f) => f.accountId === acc.id);
          const isCollapsed = !rail && collapsed[acc.id];
          return (
            <div className={`nav-section ${drag?.kind === 'account' && drag.id === acc.id ? 'dragging' : ''}`} key={acc.id}>
              <div
                className={`nav-heading-row ${dropClass(`a:${acc.id}`)}`}
                {...dragProps({ kind: 'account', id: acc.id })}
                {...dropProps(`a:${acc.id}`, (e) => (drag?.kind === 'account' ? { type: 'account', id: acc.id, where: half(e) } : null))}
              >
                <button
                  className="nav-heading"
                  onClick={() => setCollapsed((c) => ({ ...c, [acc.id]: !c[acc.id] }))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ acc, x: e.clientX, y: e.clientY });
                  }}
                  title={onEditAccount ? `${acc.name} (right-click for options)` : acc.name}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <MailboxIcon icon={acc.icon} image={acc.iconImage} color={acc.color} size={14} />
                  <span className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.name}</span>
                  {af?.error && (
                    <span className="health-alert" title={`This mailbox has a problem: ${af.error}`} aria-label="Mailbox problem">
                      <TriangleAlert size={13} />
                    </span>
                  )}
                </button>
                {onAssistant && (
                  <button className="nav-assistant name" title={`AI assistant for ${acc.name}`} aria-label={`AI assistant for ${acc.name}`} onClick={() => onAssistant(acc.id)}>
                    <Sparkles size={13} />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <>
                  {!af && (
                    <div className="nav-loading" role="status" aria-label="Loading folders" title="Loading folders">
                      <div className="spinner" />
                    </div>
                  )}
                  {af?.error && (
                    <div className="nav-error">
                      {af.error}{' '}
                      <button className="link-btn" onClick={onAccounts}>
                        Fix in Accounts
                      </button>
                    </div>
                  )}
                  {af &&
                    (() => {
                      const pinned = acc.pinnedFolders ?? [];
                      // With folders pinned, only those show until "show all" is opened.
                      const limited = pinned.length > 0 && !showAll[acc.id];
                      const countOf = (f: FolderView) => (f.unread && f.specialUse !== 'sent' && f.specialUse !== 'drafts' && f.specialUse !== 'trash' && f.specialUse !== 'snoozed' ? f.unread : 0);
                      // The folders as a tree (DreyMail): each under its parent, Inbox and Sent foldable
                      // like any folder; folded subfolders hidden, their unread mail counted on the folder.
                      const rows = folderRows(af.folders, { folded: rail ? [] : (collapsedFolders[acc.id] ?? []), only: limited ? pinned : null, count: countOf });
                      const foldable = !rail && !!onToggleFolder;
                      // Room for the fold arrows, in a column, when any folder has subfolders.
                      const foldRoom = foldable && rows.some((r) => r.hasChildren) ? 16 : 0;
                      const hiddenUnread = limited ? af.folders.filter((f) => !pinned.includes(f.path)).reduce((n, f) => n + countOf(f), 0) : 0;
                      return (
                        <>
                          {rows.map(({ folder: f, depth, hasChildren, folded: isFolded, hiddenUnread: underneath }) => {
                            const active = !activeSearch && sel.accountId === acc.id && sel.folder === f.path;
                            const showCount = countOf(f) + underneath;
                            const isPinned = pinned.includes(f.path);
                            const canFold = foldable && hasChildren;
                            return (
                              <div key={f.path} className={`nav-folder ${isPinned ? 'pinned' : ''} ${canFold ? 'foldable' : ''}`}>
                                {canFold && (
                                  <button
                                    className="fold-btn"
                                    style={{ left: depth * 14 + 4 }}
                                    title={isFolded ? `Show the folders in ${f.name}` : `Fold away the folders in ${f.name}`}
                                    aria-label={isFolded ? `Expand ${f.name}` : `Collapse ${f.name}`}
                                    aria-expanded={!isFolded}
                                    onClick={() => onToggleFolder(acc.id, f.path)}
                                  >
                                    {isFolded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                                  </button>
                                )}
                                <button
                                  className={`nav-item ${active ? 'active' : ''} ${showCount ? 'unread' : ''}`}
                                  disabled={!f.selectable}
                                  style={{ paddingLeft: rail ? undefined : 8 + foldRoom + depth * 14, opacity: f.selectable ? 1 : 0.6 }}
                                  onClick={() => onSelect({ accountId: acc.id, folder: f.path })}
                                  title={f.path}
                                >
                                  {f.specialUse ? SPECIAL_ICON[f.specialUse] : <Folder size={16} />}
                                  <span className="name">{f.specialUse === 'inbox' ? 'Inbox' : f.name}</span>
                                  {showCount ? <span className="count">{showCount}</span> : null}
                                </button>
                                {!rail && onPin && (
                                  <button
                                    className="pin-btn name"
                                    title={isPinned ? `Unpin ${f.name}` : `Pin ${f.name}: always shown`}
                                    aria-label={isPinned ? `Unpin ${f.name}` : `Pin ${f.name}`}
                                    aria-pressed={isPinned}
                                    onClick={() => onPin(acc.id, isPinned ? pinned.filter((p) => p !== f.path) : [...pinned, f.path])}
                                  >
                                    {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                          {pinned.length > 0 && !rail && (
                            <button
                              className="nav-more"
                              onClick={() => setShowAll((m) => ({ ...m, [acc.id]: !m[acc.id] }))}
                              title={limited ? `Show all folders of ${acc.name}` : 'Show pinned folders only'}
                              aria-expanded={!limited}
                            >
                              <span className="nav-more-line" />
                              {limited ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                              {hiddenUnread > 0 && <span className="count">{hiddenUnread}</span>}
                              <span className="nav-more-line" />
                            </button>
                          )}
                        </>
                      );
                    })()}
                </>
              )}
            </div>
          );
  };

  return (
    <aside className={`pane sidebar ${rail ? 'rail' : ''}`}>
      {onResize && !rail && <PaneResizer label="Resize the folder bar" min={180} max={(room) => Math.min(440, room - 600)} onResize={onResize} />}
      <div className="brand">
        <img className="brand-mark day" src="/brand-day.svg" alt="" />
        <img className="brand-mark night" src="/brand-night.svg" alt="" />
        <span className="name" style={{ flex: 1 }}>DreyMail</span>
        <button
          className="icon-btn rail-toggle desktop-only"
          title={rail ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setRail((r) => !r)}
        >
          {rail ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
        </button>
        <button className="icon-btn mobile-only" title="Close" onClick={onCloseNav}>
          <X size={18} />
        </button>
      </div>
      <button className="btn primary compose-btn" onClick={onCompose} disabled={accounts.length === 0} title="Compose">
        <PenSquare size={16} /> <span className="name">Compose</span>
      </button>
      {!rail && belowCompose}
      {onCalendar && (
        <button className={`btn calendar-btn ${calendarActive ? 'active' : ''}`} onClick={onCalendar} title="Calendar" aria-current={calendarActive ? 'page' : undefined}>
          <CalendarDays size={17} />
          <span className="name">Calendar</span>
        </button>
      )}
      <nav
        className="nav"
        onContextMenu={(e) => {
          // Only the empty space (below the last mailbox, between sections): names have their own menus.
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setBlankMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {showUnified && accounts.length > 1 && (
          <button
            className={`nav-item ${sel.accountId === null && !activeSearch ? 'active' : ''} ${totalUnread ? 'unread' : ''}`}
            onClick={() => onSelect({ accountId: null, folder: 'INBOX' })}
            title="All inboxes"
          >
            <Layers size={16} />
            <span className="name">All inboxes</span>
            {totalUnread > 0 && <span className="count">{totalUnread}</span>}
          </button>
        )}

        {scheduledCount > 0 && onScheduled && (
          <button className="nav-item" onClick={onScheduled} title="Scheduled">
            <Clock size={16} />
            <span className="name">Scheduled</span>
            <span className="count">{scheduledCount}</span>
          </button>
        )}
        {searches.length > 0 && (
          <div className="nav-section">
            <button className="nav-heading" onClick={() => setCollapsed((c) => ({ ...c, '/searches': !c['/searches'] }))} title="Saved searches">
              {!rail && collapsed['/searches'] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              <span className="name">Saved searches</span>
            </button>
            {(rail || !collapsed['/searches']) &&
              searches.map((s) => (
                <div key={s.id} className={`nav-item saved-search ${activeSearch === s.id ? 'active' : ''}`}>
                  <button className="saved-open" onClick={() => onSearch(s)} title={s.name}>
                    <Search size={16} />
                    <span className="name">{s.name}</span>
                  </button>
                  <button className="saved-remove name" title={`Remove “${s.name}”`} aria-label={`Remove saved search ${s.name}`} onClick={() => onDeleteSearch(s)}>
                    <X size={13} />
                  </button>
                </div>
              ))}
          </div>
        )}
        {groups.map((g) => {
          const members = accounts.filter((a) => a.groupId === g.id);
          // An empty group shows only while a mailbox is being dragged, to drop it in.
          if (!members.length && drag?.kind !== 'account') return null;
          const key = `g:${g.id}`;
          const open = rail || !collapsed[key];
          const unread = members.reduce((n, a) => n + (folders?.find((f) => f.accountId === a.id)?.folders.find((f) => f.specialUse === 'inbox')?.unread ?? 0), 0);
          return (
            <div className={`nav-group ${drag?.kind === 'group' && drag.id === g.id ? 'dragging' : ''}`} key={g.id} style={{ ['--group' as string]: g.color }}>
              <button
                className={`nav-group-head ${unread ? 'unread' : ''} ${dropClass(`g:${g.id}`)}`}
                onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setGroupMenu({ group: g, x: e.clientX, y: e.clientY });
                }}
                title={canDrag ? `${g.name} (drag to move, right-click for options)` : onEditGroup ? `${g.name} (right-click for options)` : g.name}
                aria-expanded={open}
                {...dragProps({ kind: 'group', id: g.id })}
                {...dropProps(`g:${g.id}`, (e) => (drag?.kind === 'account' ? { type: 'group', id: g.id, where: 'into' } : drag?.kind === 'group' ? { type: 'group', id: g.id, where: half(e) } : null))}
              >
                {!rail && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
                <MailboxIcon icon={g.icon} image={g.iconImage} color={g.color} size={15} />
                <span className="name">{g.name}</span>
                {!g.notify && <BellOff size={12} className="name muted" aria-label="Notifications off" />}
                {unread > 0 && <span className="count">{unread}</span>}
              </button>
              {open && <div className="nav-group-body">{members.map(renderAccount)}</div>}
            </div>
          );
        })}
        {accounts.filter((a) => !a.groupId || !groups.some((g) => g.id === a.groupId)).map(renderAccount)}
        {drag?.kind === 'account' && groups.length > 0 && (
          <div className={`nav-drop-ungrouped ${dropClass('ungrouped')}`} {...dropProps('ungrouped', () => ({ type: 'ungrouped' }))}>
            Not in a group
          </div>
        )}
      </nav>
      <div className="sidebar-footer">
        <div className="footer-id">
          <button className={`footer-me shows-${footerIdentity}`} title={`${userFullName}: profile and settings`} onClick={onSettings}>
            <UserAvatar src={userAvatar} name={userFullName} size={20} />
            {footerIdentity !== 'photo' && <span className="who name">{userLabel}</span>}
          </button>
          {version.data && <VersionStack server={version.data.version} update={version.data.update?.version ?? null} onLog={() => setShowLog(true)} />}
        </div>
        {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.acc.name} items={menuItems(menu.acc)} onClose={closeMenu} />}
        {blankMenu && <ContextMenu x={blankMenu.x} y={blankMenu.y} items={blankMenuItems} onClose={closeBlankMenu} />}
        {groupMenu && <ContextMenu x={groupMenu.x} y={groupMenu.y} title={groupMenu.group.name} items={groupMenuItems(groupMenu.group)} onClose={closeGroupMenu} />}
        {showLog && version.data && <ChangelogDialog version={version.data} onClose={() => setShowLog(false)} />}
        {showInstall && version.data && <InstallDialog version={version.data.version} onClose={() => setShowInstall(false)} />}
        {offerInstall && version.data && (
          <button
            className="icon-btn"
            title="Install the app (right-click to hide this button; it stays in Settings → This device)"
            onClick={() => setShowInstall(true)}
            onContextMenu={(e) => {
              e.preventDefault();
              try {
                localStorage.setItem('dm-install-hidden', '1');
              } catch {
                /* only for this visit */
              }
              setOfferInstall(false);
            }}
          >
            <Download size={17} />
          </button>
        )}
        <button className="icon-btn" title="Accounts" onClick={onAccounts}>
          <UserCog size={17} />
        </button>
        <button className="icon-btn" title="Settings" onClick={onSettings}>
          <Settings size={17} />
        </button>
        <button className="icon-btn" title="Sign out" onClick={onLogout}>
          <LogOut size={17} />
        </button>
      </div>
    </aside>
  );
}

/**
 * Bottom of the sidebar (DreyMail): the server's version, and under it the version of what you
 * run: the web app in a browser, or the desktop / Android app. When they differ the second line
 * warns and says which side to update; a click does what it can (reload the page, or the app's
 * own update check).
 */
function VersionStack({ server, update, onLog }: { server: string; update: string | null; onLog: () => void }) {
  const desktop = desktopBridge();
  const android = androidBridge() ? androidInfo() : null;
  const client = desktop
    ? { kind: 'desktop' as const, version: desktop.version, label: 'App' }
    : android
      ? { kind: 'android' as const, version: android.version, label: 'App' }
      : { kind: 'web' as const, version: WEB_VERSION ?? server, label: 'Web' };
  const check = checkVersions(server, client, WEB_VERSION);
  const fix = () => {
    if (check.fix === 'reload') window.location.reload();
    else if (check.fix === 'update-app') (desktop ?? androidBridge())?.checkForUpdates();
    else onLog();
  };
  const shown = check.fix === 'reload' ? (WEB_VERSION ?? client.version) : client.version;
  // One short label (DreyMail 10.0): the server's version. A newer DreyMail adds an accent dot; a
  // client out of step with the server turns it red with a "!", and the tooltip and click say and
  // do what to update.
  const title = !check.ok
    ? `${check.message} Click to ${check.fix === 'reload' ? 'reload' : check.fix === 'update-app' ? 'check for an update' : "see what's new"}.`
    : update
      ? `Server ${server}${client.kind === 'web' ? '' : `, ${client.label.toLowerCase()} ${shown}`}. DreyMail ${update} is available: click for what's new.`
      : `${check.message}. Click for what's new.`;
  return (
    <button className={`version-btn name ${update ? 'has-update' : ''} ${check.ok ? '' : 'warn'}`} onClick={check.ok ? onLog : fix} title={title} aria-label={title}>
      {server}
      {!check.ok ? <span className="version-alert" aria-hidden="true">!</span> : update ? <span className="update-dot" aria-hidden="true" /> : null}
    </button>
  );
}
