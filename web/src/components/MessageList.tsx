// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: spacing and layout fixes (account tag, phone Compose button).
// Modified by samschultzponsys, 2026-11-15: search filter builder, filter chips, save search.
// Modified by samschultzponsys, 2026-11-15: roles and permissions, profile pictures, grouped settings, empty mailbox screen.
// Modified by samschultzponsys, 2026-11-15: copy codes, unsubscribe, block sender, mailbox health.

import { AlarmClock, Archive, Bookmark, Check, Copy, Inbox, Plus, Flag, FolderInput, Mail, MailCheck, MailOpen, Menu, Paperclip, PenSquare, RefreshCw, Search, SlidersHorizontal, Star, Trash2, X, Reply } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { findCode } from '../../../shared/codes';
import { filterChips, filterCount, hasFilters, withoutFilter, type SearchFilters } from '../../../shared/search';
import { participants, type ConversationRow } from '../../../shared/threads';
import type { AccountFolders, AccountView, MessageAction, MessageSummary, SwipeAction } from '../../../shared/types';
import type { Direction } from '../swipe';
import { SwipeRow } from './SwipeRow';
import { displayName, formatListDate, refKey } from '../util';
import { MoveMenu } from './MoveMenu';
import { SnoozeMenu } from './SnoozeMenu';
import { formatSnoozeTime } from '../snooze';
import { SearchPanel } from './SearchPanel';

interface Props {
  title: string;
  unified: boolean;
  isSentLike: boolean;
  accounts: Map<string, AccountView>;
  folders: AccountFolders[] | undefined;
  /** One row per conversation. */
  messages: ConversationRow[];
  loading: boolean;
  fetchingMore: boolean;
  hasMore: boolean;
  errors: { accountId: string; error: string }[];
  listError: string | null;
  openKey: string | null;
  checked: Set<string>;
  query: string;
  onQuery: (q: string) => void;
  /** Filter builder choices (see shared/search.ts). */
  filters: SearchFilters;
  /** New filters, and the search box text when it changed with them. */
  onFilters: (f: SearchFilters, q?: string) => void;
  /** Save the current search under a name (sidebar smart folder). */
  onSaveSearch: (name: string) => Promise<boolean>;
  /** The open view is one account's folder. */
  inFolder: boolean;
  /** Set when the user has no mailboxes yet: the list shows how to add one instead. */
  noMailboxes?: { canAdd: boolean; onAdd: () => void };
  onOpen: (m: MessageSummary) => void;
  onCheck: (m: MessageSummary, on: boolean) => void;
  onCheckAll: (on: boolean) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onBulk: (action: MessageAction) => void;
  onNav: () => void;
  onCompose: () => void;
  lastOpenKey: string | null;
  /** Server-side "unread only" filter for this view. */
  unreadOnly: boolean;
  onUnreadOnly: (on: boolean) => void;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  swipeRemoves: (m: MessageSummary, dir: Direction) => boolean;
  confirmSwipe: (m: MessageSummary, dir: Direction) => boolean;
  onSwipe: (m: MessageSummary, dir: Direction) => void;
}

/** A one-time code in a row (subject or preview), copyable without opening the message. */
function CodeChip({ subject, snippet }: { subject: string; snippet: string }) {
  const code = findCode(subject, snippet);
  const [copied, setCopied] = useState(false);
  if (!code) return null;
  return (
    <button
      className="chip code-chip"
      title="Copy code"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(code).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />} {code}
    </button>
  );
}

export function MessageList(p: Props) {
  const [q, setQ] = useState(p.query);
  const [panel, setPanel] = useState(false);
  const [saveName, setSaveName] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, fetchingMore, onLoadMore } = p;

  useEffect(() => setQ(p.query), [p.query]);
  const accountList = [...p.accounts.values()];
  const chips = filterChips(p.filters, (id) => p.accounts.get(id)?.name ?? 'Account');
  const searching = !!p.query || hasFilters(p.filters);
  const nFilters = filterCount(p.filters) + (p.filters.where ? 1 : 0);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && hasMore && !fetchingMore) onLoadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, fetchingMore, onLoadMore]);

  const checkedMsgs = p.messages.filter((m) => p.checked.has(refKey(m)));
  const sameAccount = checkedMsgs.length > 0 && checkedMsgs.every((m) => m.accountId === checkedMsgs[0]!.accountId);
  const anyUnread = checkedMsgs.some((m) => !m.seen);
  const anyUnflagged = checkedMsgs.some((m) => !m.flagged);

  return (
    <section className="pane list">
      <div className="list-header">
        <div className="list-title">
          <button className="icon-btn mobile-only" onClick={p.onNav} title="Folders">
            <Menu size={18} />
          </button>
          <h1>{p.title}</h1>
          <button className="icon-btn" onClick={p.onRefresh} title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
        {!p.noMailboxes && (
          <>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            p.onQuery(q.trim());
          }}
        >
          <Search size={15} />
          <input
            className="input"
            placeholder={p.filters.where === 'all' ? 'Search all mail' : p.filters.where === 'inboxes' || p.unified ? 'Search all inboxes' : 'Search this folder'}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (!e.target.value) p.onQuery('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQ('');
                p.onQuery('');
              }
            }}
          />
          <button
            type="button"
            className={`icon-btn filter-btn ${panel || nFilters ? 'on' : ''}`}
            title="Filters"
            aria-label="Filters"
            aria-expanded={panel}
            onClick={() => setPanel((v) => !v)}
          >
            <SlidersHorizontal size={15} />
            {nFilters > 0 && <span className="filter-count">{nFilters}</span>}
          </button>
        </form>
        {panel && (
          <SearchPanel
            filters={p.filters}
            inFolder={p.inFolder}
            accounts={accountList}
            onApply={(f) => {
              p.onFilters(f, q.trim());
              setPanel(false);
            }}
            onClose={() => setPanel(false)}
          />
        )}
        {(chips.length > 0 || searching) && !panel && (
          <div className="filter-chips">
            {chips.map((c) => (
              <button key={c.key} className="chip filter-chip" title="Remove this filter" onClick={() => p.onFilters(withoutFilter(p.filters, c.key))}>
                {c.label} <X size={12} />
              </button>
            ))}
            {saveName === null ? (
              <button className="chip save-search" onClick={() => setSaveName(p.query || chips[0]?.label || 'Search')} title="Keep this search in the sidebar">
                <Bookmark size={12} /> Save search
              </button>
            ) : (
              <form
                className="save-search-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (saveName.trim()) void p.onSaveSearch(saveName.trim()).then((ok) => ok && setSaveName(null));
                }}
              >
                <input className="input" autoFocus value={saveName} maxLength={80} onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSaveName(null)} aria-label="Name for this search" />
                <button className="btn primary" type="submit">
                  Save
                </button>
                <button className="btn" type="button" onClick={() => setSaveName(null)}>
                  Cancel
                </button>
              </form>
            )}
          </div>
        )}
        <label className="check unread-toggle">
          <input type="checkbox" checked={p.unreadOnly} onChange={(e) => p.onUnreadOnly(e.target.checked)} />
          Unread only
        </label>
          </>
        )}
      </div>

      {checkedMsgs.length > 0 && (
        <div className="bulk-bar">
          <input
            type="checkbox"
            checked={checkedMsgs.length === p.messages.length}
            onChange={(e) => p.onCheckAll(e.target.checked)}
            title="Select all"
            style={{ accentColor: 'var(--accent)' }}
          />
          <span className="count">{checkedMsgs.length} selected</span>
          <button className="icon-btn" title={anyUnread ? 'Mark read' : 'Mark unread'} onClick={() => p.onBulk({ type: 'seen', value: anyUnread })}>
            {anyUnread ? <MailOpen size={16} /> : <Mail size={16} />}
          </button>
          <button className="icon-btn" title={anyUnflagged ? 'Flag' : 'Unflag'} onClick={() => p.onBulk({ type: 'flagged', value: anyUnflagged })}>
            <Flag size={16} />
          </button>
          <button className="icon-btn" title="Archive" onClick={() => p.onBulk({ type: 'archive' })}>
            <Archive size={16} />
          </button>
          <SnoozeMenu iconSize={16} onSnooze={(until) => p.onBulk({ type: 'snooze', until: until.toISOString() })} />
          <MoveMenu
            disabled={!sameAccount}
            account={sameAccount ? p.folders?.find((f) => f.accountId === checkedMsgs[0]!.accountId) : undefined}
            exclude={checkedMsgs[0]?.folder}
            onMove={(destination) => p.onBulk({ type: 'move', destination })}
            icon={<FolderInput size={16} />}
          />
          <button className="icon-btn" title="Delete" onClick={() => p.onBulk({ type: 'delete' })}>
            <Trash2 size={16} />
          </button>
          <button className="icon-btn" title="Clear selection" onClick={() => p.onCheckAll(false)}>
            <X size={16} />
          </button>
        </div>
      )}

      <div className="rows">
        {p.listError && <div className="banner error">{p.listError}</div>}
        {p.errors.map((e) => (
          <div className="banner error" key={e.accountId}>
            {p.accounts.get(e.accountId)?.name ?? 'Account'}: {e.error}
          </div>
        ))}
        {p.loading && (
          <div className="center" style={{ height: 120 }}>
            <div className="spinner" />
          </div>
        )}
        {p.noMailboxes && (
          <div className="empty-mailboxes">
            <Inbox size={36} />
            <h2>Add a mailbox to get started</h2>
            {p.noMailboxes.canAdd ? (
              <>
                <p className="muted">Connect Gmail, Outlook, Purelymail or any other email account. Your mail stays on its server.</p>
                <button className="btn primary" onClick={p.noMailboxes.onAdd}>
                  <Plus size={15} /> Add mailbox
                </button>
              </>
            ) : (
              <p className="muted">Your role doesn't allow adding mailboxes. Ask an administrator to add one for you.</p>
            )}
          </div>
        )}
        {!p.noMailboxes && !p.loading && p.messages.length === 0 && !p.listError && (
          <div className="center muted" style={{ height: 160 }}>
            {p.unreadOnly ? (
              <div>
                <MailCheck size={28} style={{ opacity: 0.5 }} />
                <div style={{ marginTop: 6 }}>
                  {searching ? 'No unread messages match your search.' : "You're all caught up. No unread messages here."}
                </div>
              </div>
            ) : searching ? (
              'No messages match your search.'
            ) : (
              'No messages here.'
            )}
          </div>
        )}
        {p.messages.map((m) => {
          const key = refKey(m);
          const acc = p.accounts.get(m.accountId);
          const me = acc?.email.toLowerCase();
          const who = p.isSentLike
            ? `To: ${m.to.map(displayName).join(', ') || '(no recipients)'}`
            : participants(m.thread, (a) => a.toLowerCase() === me) || displayName(m.from[0]) || '(unknown sender)';
          // The open message may be any message of the conversation, not just the one on the row.
          const has = (k: string | null) => k !== null && (k === key || m.thread.some((x) => refKey(x) === k));
          const isOpen = has(p.openKey);
          return (
            <SwipeRow
              key={key}
              left={p.swipeLeft}
              right={p.swipeRight}
              seen={m.seen}
              flagged={m.flagged}
              removes={(d) => p.swipeRemoves(m, d)}
              confirm={(d) => p.confirmSwipe(m, d)}
              onSwipe={(d) => p.onSwipe(m, d)}
              className={`row ${m.seen ? '' : 'unread'} ${isOpen ? 'selected' : ''} ${has(p.lastOpenKey) && !isOpen ? 'recent' : ''} ${p.checked.has(key) ? 'checked' : ''} ${p.unreadOnly && m.seen ? 'read-in-filter' : ''}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) p.onCheck(m, !p.checked.has(key));
                else p.onOpen(m);
              }}
            >
              {p.unified && acc && <span className="acct-bar" style={{ background: acc.color }} title={acc.name} />}
              <div className="row-check" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={p.checked.has(key)} onChange={(e) => p.onCheck(m, e.target.checked)} aria-label="Select" />
              </div>
              <div className="row-main">
                <div className="row-top">
                  <span className="row-from">
                    {m.draft && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Draft </span>}
                    {who}
                    {m.thread.length > 1 && <span className="row-count">{m.thread.length}</span>}
                  </span>
                  {m.answered && <Reply size={13} className="ind" />}
                  {m.hasAttachments && <Paperclip size={13} className="ind" />}
                  {m.flagged && <Star size={13} className="flag" fill="currentColor" />}
                  {m.snoozedUntil ? (
                    <span className="row-date snoozed" title={`Snoozed until ${new Date(m.snoozedUntil).toLocaleString()}`}>
                      <AlarmClock size={12} /> {formatSnoozeTime(m.snoozedUntil)}
                    </span>
                  ) : (
                    <span className="row-date">{formatListDate(m.date)}</span>
                  )}
                </div>
                <div className="row-subject">
                  <span>{m.subject || '(no subject)'}</span>
                </div>
                {m.snippet && <div className="row-snippet">{m.snippet}</div>}
                <CodeChip subject={m.subject} snippet={m.snippet} />
              </div>
            </SwipeRow>
          );
        })}
        <div ref={sentinel} className="list-footer">
          {p.fetchingMore && <div className="spinner" />}
          {!p.fetchingMore && p.hasMore && (
            <button className="btn ghost" onClick={p.onLoadMore}>
              Load more
            </button>
          )}
        </div>
      </div>
      {/* Phones: Compose sits on the list itself, not only in the folder drawer. */}
      {!p.noMailboxes && <button className="fab mobile-only" onClick={p.onCompose} title="Compose" aria-label="Compose">
        <PenSquare size={22} />
      </button>}
    </section>
  );
}
