// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: user-visible name changed from "Ratatoskr" to "DreyMail".
// Modified by samschultzponsys, 2026-11-13: day/night DreyMail logo instead of the favicon.
// Modified by samschultzponsys, 2026-11-13: hides "All inboxes" when turned off in Settings.
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.
// Modified by samschultzponsys, 2026-11-15: saved searches as smart folders.
// Modified by samschultzponsys, 2026-11-15: roles and permissions, profile pictures, grouped settings, empty mailbox screen.
// Modified by samschultzponsys, 2026-11-15: choose what the bottom left shows (photo, name or both).

import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { SavedSearch } from '../../../shared/search';
import type { AccountFolders, AccountView, FolderView, SpecialUse } from '../../../shared/types';
import { api, type MailboxSel } from '../api';
import { ChangelogDialog } from './ChangelogDialog';
import { UserAvatar } from './UserPicture';

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
}

export function Sidebar({ accounts, showUnified, userFullName, userAvatar, footerIdentity = 'both', folders, sel, onSelect, onCompose, onAccounts, onSettings, onLogout, userLabel, onCloseNav, searches, activeSearch, onSearch, onDeleteSearch }: Props) {
  // Server version (bottom left) and, for administrators, whether a newer image is out.
  const version = useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 3600_000, refetchInterval: 3600_000 });
  const [showLog, setShowLog] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [rail, setRail] = useState(() => localStorage.getItem('navRail') === '1');
  useEffect(() => localStorage.setItem('navRail', rail ? '1' : '0'), [rail]);
  const totalUnread = (folders ?? []).reduce((sum, a) => sum + (a.folders.find((f) => f.specialUse === 'inbox')?.unread ?? 0), 0);

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
        {accounts.map((acc) => {
          const af = folders?.find((f) => f.accountId === acc.id);
          const isCollapsed = !rail && collapsed[acc.id];
          return (
            <div className="nav-section" key={acc.id}>
              <button
                className="nav-heading"
                onClick={() => setCollapsed((c) => ({ ...c, [acc.id]: !c[acc.id] }))}
                title={acc.name}
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="dot" style={{ background: acc.color }} />
                <span className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.name}</span>
              </button>
              {!isCollapsed && (
                <>
                  {!af && (
                    <div className="nav-loading" role="status" aria-label="Loading folders" title="Loading folders">
                      <div className="spinner" />
                    </div>
                  )}
                  {af?.error && <div className="nav-error">{af.error}</div>}
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
        })}
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
