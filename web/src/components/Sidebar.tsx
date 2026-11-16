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

import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
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
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { SavedSearch } from '../../../shared/search';
import type { AccountFolders, AccountView, FolderView, MailboxGroupView, SpecialUse } from '../../../shared/types';
import { api, type MailboxSel } from '../api';
import { ChangelogDialog } from './ChangelogDialog';
import { UserAvatar } from './UserPicture';
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
const SPECIAL_ORDER: SpecialUse[] = ['inbox', 'snoozed', 'drafts', 'sent', 'archive', 'junk', 'trash'];

function sortFolders(folders: FolderView[]): FolderView[] {
  const rank = (f: FolderView) => {
    const i = f.specialUse ? SPECIAL_ORDER.indexOf(f.specialUse) : -1;
    return i === -1 ? 100 : i;
  };
  return [...folders].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

function depth(f: FolderView): number {
  if (!f.parentPath || !f.delimiter) return 0;
  return f.parentPath.split(f.delimiter).length;
}

interface Props {
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
}

export function Sidebar({ groups = [], accounts, showUnified, userFullName, userAvatar, footerIdentity = 'both', folders, sel, onSelect, onCompose, onAccounts, onSettings, onLogout, userLabel, onCloseNav, searches, activeSearch, onSearch, onDeleteSearch, onAssistant, scheduledCount = 0, onScheduled, onCalendar }: Props) {
  // Server version (bottom left) and, for administrators, whether a newer image is out.
  const version = useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 3600_000, refetchInterval: 3600_000 });
  const [showLog, setShowLog] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [rail, setRail] = useState(() => localStorage.getItem('navRail') === '1');
  useEffect(() => localStorage.setItem('navRail', rail ? '1' : '0'), [rail]);
  const totalUnread = (folders ?? []).reduce((sum, a) => sum + (a.folders.find((f) => f.specialUse === 'inbox')?.unread ?? 0), 0);

  const renderAccount = (acc: AccountView) => {
          const af = folders?.find((f) => f.accountId === acc.id);
          const isCollapsed = !rail && collapsed[acc.id];
          return (
            <div className="nav-section" key={acc.id}>
              <div className="nav-heading-row">
                <button
                  className="nav-heading"
                  onClick={() => setCollapsed((c) => ({ ...c, [acc.id]: !c[acc.id] }))}
                  title={acc.name}
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
                    sortFolders(af.folders).map((f) => {
                      const active = !activeSearch && sel.accountId === acc.id && sel.folder === f.path;
                      const showCount = f.unread && f.specialUse !== 'sent' && f.specialUse !== 'drafts' && f.specialUse !== 'trash' && f.specialUse !== 'snoozed';
                      return (
                        <button
                          key={f.path}
                          className={`nav-item ${active ? 'active' : ''} ${showCount ? 'unread' : ''}`}
                          disabled={!f.selectable}
                          style={{ paddingLeft: rail ? undefined : 8 + depth(f) * 14, opacity: f.selectable ? 1 : 0.6 }}
                          onClick={() => onSelect({ accountId: acc.id, folder: f.path })}
                          title={f.path}
                        >
                          {f.specialUse ? SPECIAL_ICON[f.specialUse] : <Folder size={16} />}
                          <span className="name">{f.specialUse === 'inbox' ? 'Inbox' : f.name}</span>
                          {showCount ? <span className="count">{f.unread}</span> : null}
                        </button>
                      );
                    })}
                </>
              )}
            </div>
          );
  };

  return (
    <aside className={`pane sidebar ${rail ? 'rail' : ''}`}>
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
      <nav className="nav">
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
        {onCalendar && (
          <button className="nav-item" onClick={onCalendar} title="Calendar">
            <CalendarDays size={16} />
            <span className="name">Calendar</span>
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
          if (!members.length) return null;
          const key = `g:${g.id}`;
          const open = rail || !collapsed[key];
          const unread = members.reduce((n, a) => n + (folders?.find((f) => f.accountId === a.id)?.folders.find((f) => f.specialUse === 'inbox')?.unread ?? 0), 0);
          return (
            <div className="nav-group" key={g.id} style={{ ['--group' as string]: g.color }}>
              <button className={`nav-group-head ${unread ? 'unread' : ''}`} onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))} title={g.name} aria-expanded={open}>
                {!rail && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
                <MailboxIcon icon={g.icon} color={g.color} size={15} />
                <span className="name">{g.name}</span>
                {!g.notify && <BellOff size={12} className="name muted" aria-label="Notifications off" />}
                {unread > 0 && <span className="count">{unread}</span>}
              </button>
              {open && <div className="nav-group-body">{members.map(renderAccount)}</div>}
            </div>
          );
        })}
        {accounts.filter((a) => !a.groupId || !groups.some((g) => g.id === a.groupId)).map(renderAccount)}
      </nav>
      <div className="sidebar-footer">
        <button className={`footer-me shows-${footerIdentity}`} title={`${userFullName}: profile and settings`} onClick={onSettings}>
          <UserAvatar src={userAvatar} name={userFullName} size={20} />
          {footerIdentity !== 'photo' && <span className="who name">{userLabel}</span>}
        </button>
        {version.data && (
          <button
            className={`version-btn name ${version.data.update ? 'has-update' : ''}`}
            onClick={() => setShowLog(true)}
            title={version.data.update ? `DreyMail ${version.data.update.version} is available. Click for what's new.` : "What's new"}
          >
            v{version.data.version}
            {version.data.update && <span className="update-dot" aria-label="Update available" />}
          </button>
        )}
        {showLog && version.data && <ChangelogDialog version={version.data} onClose={() => setShowLog(false)} />}
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
