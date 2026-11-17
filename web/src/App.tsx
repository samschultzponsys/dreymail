// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: All inboxes can be turned off; then the first account opens instead.
// Modified by samschultzponsys, 2026-11-13: the whole UI takes on the open account's colour.
// Modified by samschultzponsys, 2026-11-13: passes admin to Settings.
// Modified by samschultzponsys, 2026-11-13: phone Compose button.
// Modified by samschultzponsys, 2026-11-13: desktop app: native notifications, update check.
// Modified by samschultzponsys, 2026-11-13: Android app: notifications and Firebase settings.
// Modified by samschultzponsys, 2026-11-13: tablet/foldable two-pane layout; interface size.
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.
// Modified by samschultzponsys, 2026-11-15: Outlook accounts; This device settings.
// Modified by samschultzponsys, 2026-11-15: Sign in with Google for Gmail.
// Modified by samschultzponsys, 2026-11-15: search filters, saved searches.
// Modified by samschultzponsys, 2026-11-15: roles and permissions, profile pictures, grouped settings, empty mailbox screen.
// Modified by samschultzponsys, 2026-11-15: choose what the bottom left shows (photo, name or both).
// Modified by samschultzponsys, 2026-11-15: mailbox icons.
// Modified by samschultzponsys, 2026-11-15: your own picture as a mailbox icon.
// Modified by samschultzponsys, 2026-11-15: AI mailbox assistant.
// Modified by samschultzponsys, 2026-11-15: AI assistant learning mode.
// Modified by samschultzponsys, 2026-11-15: send later and undo send.
// Modified by samschultzponsys, 2026-11-15: automatic inbox tabs.
// Modified by samschultzponsys, 2026-11-15: calendar.
// Modified by samschultzponsys, 2026-11-15: automatic single sign-on waits after signing out; /login.
// Modified by samschultzponsys, 2026-11-15: message after connecting single sign-on.
// Modified by samschultzponsys, 2026-11-16: right-click a mailbox's name to edit it.
// Modified by samschultzponsys, 2026-11-16: buttons pinned to each message.
// Modified by samschultzponsys, 2026-11-16: desktop notifications for every mailbox, always, with the mailbox's name.
// Modified by samschultzponsys, 2026-11-16: sidebar rearranged by dragging.
// Modified by samschultzponsys, 2026-11-16: group pictures; right-click a group to edit it.
// Modified by samschultzponsys, 2026-11-16: right-click the folder bar's empty space for New group….
// Modified by samschultzponsys, 2026-11-17: Not spam action.
// Modified by samschultzponsys, 2026-11-17: Sending list under Compose (undo send after leaving the message).
// Modified by samschultzponsys, 2026-11-17: folding subfolders (kept in preferences).
// Modified by samschultzponsys, 2026-11-17: the calendar as a page of its own (/calendar), not a dialog.

import { encodeFilters, type SavedSearch } from '../../shared/search';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AccountView, AttachmentView, MailboxGroupView, MessageAction, MessageDetail, MessageRef, MessageSummary } from '../../shared/types';
import { composerFromPayload, filesFrom, isSending } from './sending';
import { SendingBox } from './components/SendingBox';
import { groupConversations, rowOf } from '../../shared/threads';
import { inboxUnread } from '../../shared/unread';
import { api, ApiError, type MailboxSel } from './api';
import { accountPalette, ACCOUNT_PALETTE_VARS, BRAND_CYAN } from './accountTheme';
import { desktopBridge, loadMailboxPicture, mailboxNotificationIcon } from './desktop';
import { androidBridge, registerAndroidPush, syncAndroidAccounts } from './android';
import { applyThemeColor } from './themeColor';
import { AccountsDialog } from './components/AccountsDialog';
import { Composer, type ComposerInit } from './components/Composer';
import { Login, SIGNED_OUT_KEY } from './components/Login';
import { useListWidth, useSideWidth } from './listWidth';
import { MessageList } from './components/MessageList';
import { quotableDetail, Reader, replyTarget, type ReplyKind } from './components/Reader';
import { SettingsDialog } from './components/SettingsDialog';
import { AssistantDialog } from './components/AssistantDialog';
import { ScheduledDialog, useScheduled } from './components/ScheduledDialog';
import { CalendarDialog } from './components/CalendarDialog';
import { Sidebar } from './components/Sidebar';
import { SquirrelRun, type Run } from './components/SquirrelRun';
import { useAccounts, useFolders, useLiveUpdates, useMe, useMessageAction, useMessages, useSavedSearches, useTheme, useToasts, type NotifyEvent, type SnoozeEndedEvent } from './hooks';
import { PENDING_MAILTO_KEY, parseMailto } from './mailto';
import { blankComposer, composerFor, composerForMailto } from './replies';
import { useRouter, type Location } from './router';
import { disablePush, notificationTarget, registerServiceWorker, setAppBadge, syncPush } from './push';
import { HOME, listRoute, openMessageFolder, parseLocation, viewKey, type OpenMessage, type Route } from './routing';
import { updateSticky, withSticky } from './sticky';
import { removesFromList, swipeToAction, type Direction, type UndoStep } from './swipe';
import { formatSnoozeTime } from './snooze';
import { planRun, runFor, runSpeed, type PaneView } from './squirrel';
import { refKey, toRef } from './util';

/** Bottom-left name: the user's chosen name, else their login name with a capital first letter. */
export function userLabel(me: { name: string; displayName: string; email: string }, full = false): string {
  let n = me.displayName || me.name || me.email.split('@')[0] || '';
  if (!full) n = n.split(/\s+/)[0] ?? n;
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : '';
}

export function App() {
  const qc = useQueryClient();
  const me = useMe();
  // /login is the sign-in page's own address; once signed in, it's just the app.
  useEffect(() => {
    if (me.data && window.location.pathname.replace(/\/+$/, '') === '/login') window.history.replaceState(window.history.state, '', '/');
  }, [me.data]);
  const loggedIn = !!me.data;
  const theme = useTheme(me.data?.preferences.theme);
  // Only once signed in: asked earlier it fails with 401 and wouldn't be asked again after login.
  const accountsQ = useAccounts(loggedIn);
  const groupsQ = useQuery({ queryKey: ['groups'], queryFn: api.groups, enabled: loggedIn });
  const [listWidth, setListWidth] = useListWidth();
  const [sideWidth, setSideWidth] = useSideWidth();
  const accounts = useMemo(() => (loggedIn ? (accountsQ.data ?? []) : []), [accountsQ.data, loggedIn]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const folders = useFolders(useMemo(() => accounts.map((a) => a.id), [accounts]), loggedIn && accounts.length > 0);
  const { toasts, push, dismiss } = useToasts();

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<ComposerInit | null>(null);
  /** Bumped for every new composer, so it starts fresh even if the previous one looked alike. */
  const [composeId, setComposeId] = useState(0);
  const [lastOpenKey, setLastOpenKey] = useState<string | null>(null);
  const [snoozeSignal, setSnoozeSignal] = useState(0);
  const composerDirty = useRef(false);
  /** Entries pushed while the (non-modal) composer stayed open on top of them. */
  const composeNavs = useRef(0);

  // Browser Back/Forward: close the composer when leaving its entry; ignore stale overlay entries.
  const onPop = useCallback((prev: Location, next: Location) => {
    if (prev.state?.overlay === 'compose' && next.state?.overlay !== 'compose' && composerRef.current) {
      if (composerDirty.current && !window.confirm('Discard this message?')) {
        // Stay: put the compose entry back.
        router.current.reopen('compose');
        return;
      }
      setComposer(null);
    }
    composeNavs.current = Math.max(0, composeNavs.current - 1);
    if (next.state?.overlay === 'compose' && !composerRef.current) router.current.clear();
  }, []);
  const { loc, navigate, openOverlay, closeOverlay, clearOverlay, back } = useRouter(onPop);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const router = useRef({ reopen: openOverlay, clear: clearOverlay });
  router.current = { reopen: (o) => openOverlay(o), clear: clearOverlay };

  const route = loc.route;
  const overlay = loc.state?.overlay;
  const sel: MailboxSel = useMemo(() => ({ accountId: route.accountId, folder: route.folder }), [route.accountId, route.folder]);
  const query = route.q;
  const open: MessageRef | null = useMemo(
    () => (route.open ? { accountId: route.open.accountId, folder: openMessageFolder(route), uid: route.open.uid, uidValidity: route.open.uidValidity } : null),
    [route],
  );
  const dialog = overlay === 'settings' || overlay === 'accounts' ? overlay : null;
  const view: PaneView = overlay === 'nav' ? 'nav' : open ? 'reader' : 'list';

  useEffect(() => {
    if (open) setLastOpenKey(refKey(open));
  }, [open]);

  // Phone view changes: the squirrel runs across and drags the new view in. Set before paint so
  // the new pane never flashes in unclipped.
  const appRef = useRef<HTMLDivElement>(null);
  const shownView = useRef(view);
  const runId = useRef(0);
  const [run, setRun] = useState<(Run & { from: PaneView }) | null>(null);
  const transitionPref = me.data?.preferences.screenTransitions;
  useLayoutEffect(() => {
    const from = shownView.current;
    shownView.current = view;
    const kind = runFor(from, view);
    if (!kind) return;
    const speed = runSpeed(transitionPref, matchMedia('(max-width: 640px)').matches, matchMedia('(prefers-reduced-motion: reduce)').matches);
    setRun(speed ? { id: ++runId.current, plan: planRun(kind, window.innerWidth, window.innerHeight, speed), from, to: view } : null);
  }, [view, transitionPref]);
  // While running back to the folder, the message stays up underneath rather than the empty reader.
  const lastOpen = useRef(open);
  if (open) lastOpen.current = open;
  const readerRef = open ?? (run?.from === 'reader' ? lastOpen.current : null);

  /** Navigate, keeping a non-modal composer open on top of the new entry. */
  const go = useCallback(
    (r: Route, replace = false) => {
      if (composerRef.current) composeNavs.current++;
      navigate(r, { replace, keepOverlay: !!composerRef.current });
    },
    [navigate],
  );

  // With a single account, or with "All inboxes" turned off in Settings, the unified view is the
  // first account's inbox.
  const unifiedInbox = me.data?.preferences.unifiedInbox !== false;
  const effectiveSel = useMemo<MailboxSel>(
    () =>
      sel.accountId === null && accounts.length > 0 && (accounts.length === 1 || !unifiedInbox)
        ? { accountId: accounts[0]!.id, folder: 'INBOX' }
        : sel,
    [sel, accounts, unifiedInbox],
  );
  const filterParam = encodeFilters(route.filters);
  const messagesQ = useMessages(effectiveSel, query, route.unread, loggedIn && accounts.length > 0, filterParam);
  const savedSearches = useSavedSearches(loggedIn);
  const assistantStatus = useQuery({ queryKey: ['ai', 'status'], queryFn: api.assistantStatus, enabled: loggedIn, staleTime: 60_000 });
  const scheduledQ = useScheduled(loggedIn);
  const [showScheduled, setShowScheduled] = useState(false);
  const [assistantFor, setAssistantFor] = useState<{ id: string; tab?: 'learning' } | null>(null);
  /** Mailbox to open straight into when Accounts opens (right-click on its name). */
  const [editAccountId, setEditAccountId] = useState<string | null>(null);
  /** Group to open straight into when Accounts opens (right-click on its name). */
  const [editGroupId, setEditGroupId] = useState<string | null>(null);
  // A learning period ended: the first time DreyMail opens afterwards, show its review.
  const reviews = useQuery({ queryKey: ['ai', 'reviews'], queryFn: api.assistantReviewsDue, enabled: loggedIn && !!assistantStatus.data?.allowed, staleTime: 300_000 });
  const reviewShown = useRef(false);
  useEffect(() => {
    const id = reviews.data?.[0];
    if (!id || reviewShown.current || !accounts.some((a) => a.id === id)) return;
    reviewShown.current = true;
    setAssistantFor({ id, tab: 'learning' });
  }, [reviews.data, accounts]);
  const serverMessages = useMemo(() => messagesQ.data?.pages.flatMap((p) => p.messages) ?? [], [messagesQ.data]);

  // "Unread only": messages read in this view stay listed (dimmed) until the view changes or is
  // refreshed. Both the sticky keys and the last shown list are tied to the current view.
  const currentView = viewKey(route);
  const [sticky, setSticky] = useState<{ view: string; keys: Set<string> }>({ view: '', keys: new Set() });
  const lastShown = useRef<{ view: string; list: MessageSummary[] }>({ view: '', list: [] });
  const messages = useMemo(() => {
    if (!route.unread) return serverMessages;
    const keys = sticky.view === currentView ? sticky.keys : new Set<string>();
    const prev = lastShown.current.view === currentView ? lastShown.current.list : [];
    return withSticky(prev, serverMessages, keys, refKey);
  }, [serverMessages, sticky, currentView, route.unread]);
  useEffect(() => {
    lastShown.current = { view: currentView, list: messages };
  }, [currentView, messages]);
  const listErrors = messagesQ.data?.pages.at(-1)?.errors ?? [];

  const currentFolders = effectiveSel.accountId ? folders.data?.find((f) => f.accountId === effectiveSel.accountId) : undefined;
  const folderInfo = currentFolders?.folders.find((f) => f.path === effectiveSel.folder);
  const isSentLike = folderInfo?.specialUse === 'sent' || folderInfo?.specialUse === 'drafts';
  const inSnoozed = folderInfo?.specialUse === 'snoozed';
  const inDrafts = folderInfo?.specialUse === 'drafts';

  // One row per conversation, Gmail-style, including your replies found in Sent.
  const related = useMemo(() => messagesQ.data?.pages.flatMap((p) => p.related ?? []) ?? [], [messagesQ.data]);
  const singleView = useMemo(() => new Set(accounts.filter((a) => a.threaded === false).map((a) => a.id)), [accounts]);
  const rows = useMemo(
    () => groupConversations(messages, related, { group: !inDrafts, threaded: (id) => !singleView.has(id) }),
    [messages, related, inDrafts, singleView],
  );
  /** Actions on a conversation apply to all of its messages in the listed folder. */
  const expand = useCallback(
    (refs: MessageRef[]) => {
      const out = new Map<string, MessageRef>();
      for (const r of refs) {
        const row = rowOf(rows, r);
        const list = row && row.members.some((m) => refKey(m) === refKey(r)) ? row.members.map(toRef) : [r];
        for (const m of list) out.set(refKey(m), m);
      }
      return [...out.values()];
    },
    [rows],
  );

  // A snoozed message is back: say so while the app is open (phones get a notification instead).
  const onSnoozeEnded = useCallback(
    (ev: SnoozeEndedEvent) => {
      const text = `Back from snooze: ${ev.subject || '(no subject)'}${ev.from ? ` (${ev.from})` : ''}`;
      const target = ev.uid && ev.uidValidity ? { accountId: ev.accountId, uidValidity: ev.uidValidity, uid: ev.uid } : null;
      push(text, false, target ? { label: 'Open', run: () => go({ ...HOME, open: target }) } : undefined);
    },
    [push, go],
  );
  // Desktop app: new mail as a native notification in the mailbox's colour and icon, with its name
  // in the title, for every mailbox, always (also while the window is in front: the mail may well
  // be for another mailbox than the one open). Browsers get Web Push instead.
  const onNotify = useCallback(
    (ev: NotifyEvent) => {
      const bridge = desktopBridge();
      if (!bridge) return;
      const account = accountMap.get(ev.accountId);
      const title = account && !ev.title.includes(account.name) ? `${ev.title} · ${account.name}` : ev.title;
      bridge.notify({ title, body: ev.body, tag: ev.tag, url: ev.url, icon: mailboxNotificationIcon(account, BRAND_CYAN) });
    },
    [accountMap],
  );
  useLiveUpdates(loggedIn && accounts.length > 0, onSnoozeEnded, onNotify);
  // Desktop app: have uploaded mailbox pictures ready for notifications.
  useEffect(() => {
    if (!desktopBridge()) return;
    for (const a of accounts) if (a.icon === 'image' && a.iconImage) void loadMailboxPicture(a.iconImage);
  }, [accounts]);
  // Android app: a notification channel per account, and this phone registered for notifications.
  useEffect(() => {
    if (!androidBridge() || !accountsQ.data) return;
    void syncAndroidAccounts(accountsQ.data);
    void registerAndroidPush().catch(() => {});
  }, [accountsQ.data]);
  useEffect(() => {
    desktopBridge()?.onOpen((url) => {
      const target = notificationTarget(url, window.location.origin);
      if (!target) return;
      const u = new URL(target, window.location.origin);
      go(parseLocation(u.pathname, u.search));
    });
  }, [go]);

  // Notifications: register the service worker, keep this device's subscription current, and
  // follow taps on a notification while the app is already open.
  useEffect(() => {
    if (!loggedIn) return;
    registerServiceWorker();
    void syncPush().catch(() => {});
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: unknown } | null;
      const target = data?.type === 'open' ? notificationTarget(data.url, window.location.origin) : null;
      if (!target) return;
      const u = new URL(target, window.location.origin);
      go(parseLocation(u.pathname, u.search));
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [loggedIn, go]);

  // One account open: the whole app takes on its colour (see accountTheme.ts). "All inboxes" keeps
  // the DreyMail cyan. Runs after useTheme's effect, so the browser bar colour ends up tinted too.
  const openAccountColor = effectiveSel.accountId ? accountMap.get(effectiveSel.accountId)?.color : undefined;
  useEffect(() => {
    const root = document.documentElement;
    for (const name of ACCOUNT_PALETTE_VARS) root.style.removeProperty(name);
    if (!openAccountColor) {
      delete root.dataset.account;
      applyThemeColor(document, theme);
      return;
    }
    const palette = accountPalette(openAccountColor, theme);
    for (const [name, value] of Object.entries(palette)) root.style.setProperty(name, value);
    root.dataset.account = openAccountColor;
    applyThemeColor(document, theme, palette['--bg']);
  }, [openAccountColor, theme]);

  // Unread count across all inboxes on the app icon (installed app).
  useEffect(() => {
    if (folders.data) setAppBadge(inboxUnread(folders.data));
  }, [folders.data]);

  // Deep link to an account that doesn't exist (any more): back to the unified inbox, quietly.
  useEffect(() => {
    if (accountsQ.isSuccess && route.accountId && !accountMap.has(route.accountId)) {
      navigate(HOME, { replace: true });
      push('That account no longer exists.');
    }
  }, [accountsQ.isSuccess, route.accountId, accountMap, navigate, push]);

  // UIDVALIDITY changed under an open cursor: start the list over.
  useEffect(() => {
    if (messagesQ.data?.pages.some((p) => p.reset)) void qc.resetQueries({ queryKey: ['messages'] });
  }, [messagesQ.data, qc]);

  // First run: open the account dialog.
  useEffect(() => {
    if (loggedIn && accountsQ.isSuccess && accounts.length === 0 && me.data?.permissions.includes('mail.accounts')) openOverlay('accounts');
  }, [loggedIn, accountsQ.isSuccess, accounts.length, openOverlay, me.data]);

  // Back from adding an Outlook account (see main.tsx).
  useEffect(() => {
    if (!loggedIn) return;
    const raw = sessionStorage.getItem('dreymail.outlook');
    if (!raw) return;
    sessionStorage.removeItem('dreymail.outlook');
    const r = JSON.parse(raw) as { ok: boolean; message: string; account: string; provider?: string };
    const what = r.provider === 'google' ? 'Gmail' : 'Outlook';
    void qc.invalidateQueries({ queryKey: ['accounts'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
    push(r.ok ? `${what} account connected.` : `${what} sign-in didn’t work: ${r.message}`);
    if (r.ok && r.account) navigate({ ...HOME, accountId: r.account, folder: 'INBOX' }, { replace: true });
  }, [loggedIn, qc, push, navigate]);

  // Back from connecting single sign-on (see main.tsx).
  useEffect(() => {
    if (!loggedIn) return;
    const raw = sessionStorage.getItem('dreymail.sso');
    if (!raw) return;
    sessionStorage.removeItem('dreymail.sso');
    const r = JSON.parse(raw) as { ok: boolean; message: string };
    void qc.invalidateQueries({ queryKey: ['sso'] });
    push(r.ok ? 'Single sign-on connected: signing in with it now opens this account.' : r.message || 'Connecting single sign-on didn’t work.');
  }, [loggedIn, qc, push]);

  // The saved search this view is, if any (highlighted in the sidebar).
  const activeSearch = useMemo(() => {
    const key = viewKey(route);
    return (savedSearches.data ?? []).find((s: SavedSearch) => viewKey({ ...HOME, accountId: s.accountId, folder: s.folder, q: s.q, unread: s.unread, filters: s.filters }) === key)?.id ?? null;
  }, [savedSearches.data, route]);

  const runAction = useMessageAction(useCallback((m: string) => push(m, true), [push]));

  const title = accountsQ.isSuccess && accounts.length === 0
    ? 'No mailboxes yet'
    : route.filters.where === 'all'
    ? 'All mail'
    : route.filters.where === 'inboxes'
      ? 'All inboxes'
      : effectiveSel.accountId
    ? `${folderInfo?.specialUse === 'inbox' ? 'Inbox' : (folderInfo?.name ?? effectiveSel.folder)}${accounts.length > 1 ? ` · ${accountMap.get(effectiveSel.accountId)?.name ?? ''}` : ''}`
    : 'All inboxes';

  /** The route's open message; search results from another folder carry that folder. */
  const openOf = (r: MessageRef): OpenMessage => {
    const listFolder = route.accountId ? route.folder : 'INBOX';
    return { accountId: r.accountId, uidValidity: r.uidValidity, uid: r.uid, ...(r.folder !== listFolder || r.accountId !== (route.accountId ?? r.accountId) ? { folder: r.folder } : {}) };
  };

  /** Opening a message pushes an entry; switching to another one while open replaces it. */
  const openMessage = (m: MessageSummary) => go({ ...route, open: openOf(m) }, !!route.open);
  const setOpenRef = (r: MessageRef | null) => go({ ...route, open: r ? openOf(r) : null }, true);

  /** Move the selection to the neighbour of `ref`'s row (after archive/delete or j/k). */
  const rowIndex = useCallback(
    (ref: MessageRef) => {
      const row = rowOf(rows, ref);
      return row ? rows.indexOf(row) : -1;
    },
    [rows],
  );
  const neighbour = useCallback(
    (ref: MessageRef, dir: 1 | -1) => {
      const i = rowIndex(ref);
      return i === -1 ? null : (rows[i + dir] ?? rows[i - dir] ?? null);
    },
    [rows, rowIndex],
  );

  const runUndo = useCallback(
    async (steps: UndoStep[]) => {
      for (const step of steps) await runAction(step.refs, step.action);
      push('Undone');
    },
    [runAction, push],
  );

  const act = useCallback(
    async (picked: MessageRef[], action: MessageAction) => {
      const refs = expand(picked);
      // Snoozing again from the Snoozed folder only changes the time; the message stays.
      const removes = removesFromList(action) && !(action.type === 'snooze' && inSnoozed);
      if (removes && open && refs.some((r) => refKey(r) === refKey(open))) {
        const next = neighbour(open, 1);
        if (next && !refs.some((r) => refKey(r) === refKey(next))) setOpenRef(toRef(next));
        else back(listRoute(route));
      }
      if (removes) setChecked(new Set());
      if (route.unread) {
        const view = viewKey(route);
        setSticky((s) => ({ view, keys: updateSticky(s.view === view ? s.keys : new Set(), refs.map(refKey), action) }));
      }
      const res = await runAction(refs, action);
      if (!res.ok) return;
      const n = picked.length;
      const conversations = refs.length > picked.length;
      const what = n === 1 ? (conversations ? 'Conversation' : 'Message') : `${n} ${conversations ? 'conversations' : 'messages'}`;
      const label =
        action.type === 'archive' ? `${what} archived` : action.type === 'delete' ? (res.result?.permanent ? `${what} deleted permanently` : `${what} moved to Trash`)
          : action.type === 'move' ? `${what} moved to ${action.destination}`
          : action.type === 'snooze' ? `${what} snoozed until ${formatSnoozeTime(action.until)}`
          : action.type === 'unsnooze' ? `${what} back in the inbox`
          : action.type === 'junk' ? `${what} moved to Junk`
          : action.type === 'notJunk'
            ? `${what} moved to the inbox as not spam${res.result?.unblocked?.length ? `; unblocked ${res.result.unblocked.join(', ')}` : ''}`
          : null;
      for (const f of res.result?.createdFolders ?? []) push(`Created folder "${f}" for ${action.type === 'snooze' ? 'snoozed' : action.type === 'junk' ? 'spam' : 'archived'} mail.`);
      const undo = res.undo;
      if (label) push(label, false, undo ? { label: 'Undo', run: () => void runUndo(undo) } : undefined);
      else if (undo && picked.length > 1) push(`${what} updated`, false, { label: 'Undo', run: () => void runUndo(undo) });
      return undo;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, neighbour, expand, runAction, runUndo, route, back, push, inSnoozed],
  );

  /** Swipe actions: same as toolbar actions, with an undo toast for read/flag toggles too. */
  const prefs = me.data?.preferences;
  const swipeFor = (dir: Direction) => (dir === 'left' ? prefs?.swipeLeft : prefs?.swipeRight) ?? 'none';
  const isTrash = (m: MessageSummary) =>
    folders.data?.find((f) => f.accountId === m.accountId)?.folders.find((f) => f.path === m.folder)?.specialUse === 'trash';
  const onSwipe = async (m: MessageSummary, dir: Direction) => {
    const action = swipeToAction(swipeFor(dir), m);
    if (!action) return;
    const undo = await act([toRef(m)], action);
    if (!removesFromList(action) && undo) {
      const text =
        action.type === 'seen' ? (action.value ? 'Marked as read' : 'Marked as unread') : action.type === 'flagged' ? (action.value ? 'Flagged' : 'Unflagged') : 'Done';
      push(text, false, { label: 'Undo', run: () => void runUndo(undo) });
    }
  };


  const startCompose = useCallback(
    (init: ComposerInit) => {
      setComposer(init);
      setComposeId((n) => n + 1);
      composerDirty.current = false;
      composeNavs.current = 0;
      openOverlay('compose');
    },
    [openOverlay],
  );
  const compose = () => {
    const account = (effectiveSel.accountId && accountMap.get(effectiveSel.accountId)) || accounts[0];
    if (account) startCompose(blankComposer(account));
  };
  /** Compose from a mailto: link, from the current account (or the first one). */
  const composeMailto = useCallback(
    (mailto: string) => {
      const fields = parseMailto(mailto);
      const account = (effectiveSel.accountId && accountMap.get(effectiveSel.accountId)) || accounts[0];
      if (!fields || !account) return;
      if (composerRef.current && composerDirty.current && !window.confirm('Discard the message you are writing?')) return;
      startCompose(composerForMailto(fields, account));
    },
    [effectiveSel.accountId, accountMap, accounts, startCompose],
  );
  // Sending (under Compose): mail in its undo-send wait can be taken back until it goes out.
  const sending = (scheduledQ.data ?? []).filter(isSending);
  const [sendingBusy, setSendingBusy] = useState<string | null>(null);
  const undoSending = async (id: string) => {
    if (composerRef.current && composerDirty.current && !window.confirm('Discard the message you are writing?')) return;
    setSendingBusy(id);
    try {
      const back = await api.undoScheduled(id);
      let forwarded: AttachmentView[] = [];
      const from = back.payload.forwardFrom;
      if (from) {
        try {
          const d = await api.message({ accountId: from.accountId, folder: from.folder, uid: from.uid, uidValidity: from.uidValidity }, 'block');
          forwarded = d.attachments.filter((a) => from.indices.includes(a.index));
        } catch {
          push('The forwarded attachments could not be added back; attach them again if needed.', true);
        }
      }
      startCompose(composerFromPayload(back.payload, filesFrom(back.files), forwarded));
      push('Not sent: the message is open again.');
    } catch (err) {
      push((err as Error).message, true);
    } finally {
      setSendingBusy(null);
      void qc.invalidateQueries({ queryKey: ['scheduled'] });
    }
  };
  const sendNowSending = async (id: string) => {
    setSendingBusy(id);
    try {
      qc.setQueryData(['scheduled'], await api.sendScheduledNow(id));
    } catch (err) {
      push((err as Error).message, true);
    } finally {
      setSendingBusy(null);
    }
  };
  // Opened for a mailto: link (see main.tsx): compose once signed in and there is an account.
  useEffect(() => {
    if (!loggedIn || !accountsQ.isSuccess || accounts.length === 0) return;
    const pending = sessionStorage.getItem(PENDING_MAILTO_KEY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_MAILTO_KEY);
    composeMailto(pending);
  }, [loggedIn, accountsQ.isSuccess, accounts.length, composeMailto]);
  const reply = useCallback(
    (kind: ReplyKind, d: MessageDetail) => {
      const account = accountMap.get(d.accountId);
      if (account) startCompose(composerFor(kind, d, account));
    },
    [accountMap, startCompose],
  );

  /** Close the composer from its own UI without leaving a dead history entry. */
  const closeComposer = () => {
    setComposer(null);
    if (overlay === 'compose') {
      if (composeNavs.current === 0) closeOverlay('compose');
      else clearOverlay();
    }
  };

  // The open message is gone (deleted elsewhere) or its folder's UIDVALIDITY changed: fall back to
  // the list with a quiet notice.
  const onGone = useCallback(
    (stale: boolean) => {
      navigate(listRoute(route), { replace: true, keepOverlay: true });
      push(stale ? 'This folder changed on the server; the list was reloaded.' : 'That message is no longer available.');
      if (stale) void qc.resetQueries({ queryKey: ['messages'] });
    },
    [navigate, route, push, qc],
  );

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (composer || dialog || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const cur = open ? rowOf(rows, open) : undefined;
      switch (e.key) {
        case 'j':
        case 'k': {
          const next = open ? neighbour(open, e.key === 'j' ? 1 : -1) : rows[0];
          if (next && (!open || next !== cur)) {
            const idx = rows.indexOf(next);
            const curIdx = open ? rowIndex(open) : -1;
            if (!open || (e.key === 'j' ? idx > curIdx : idx < curIdx)) {
              if (open) setOpenRef(toRef(next));
              else openMessage(next);
            }
          }
          break;
        }
        case 'c':
          compose();
          break;
        case 'e':
          if (open) void act([open], { type: 'archive' });
          break;
        case 'b':
          if (open) setSnoozeSignal((n) => n + 1);
          break;
        case '#':
        case 'Delete':
          if (open) void act([open], { type: 'delete' });
          break;
        case 's':
          if (open && cur) void act([open], { type: 'flagged', value: !cur.flagged });
          break;
        case 'u':
          if (open) void act([open], { type: 'seen', value: false });
          break;
        case 'r':
        case 'a':
        case 'f': {
          if (!open) break;
          const d = qc.getQueryData<MessageDetail>(['message', refKey(replyTarget(cur, open)), 'auto']);
          const kind = e.key === 'r' ? 'reply' : e.key === 'a' ? 'replyAll' : 'forward';
          if (d) void quotableDetail(qc, d).then((quoted) => reply(kind, quoted), (err: Error) => push(err.message, true));
          break;
        }
        case 'Escape':
          setChecked(new Set());
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (me.isLoading) {
    return (
      <div className="center">
        <div className="spinner" />
      </div>
    );
  }
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
    return <div className="center error-text">Could not reach the server: {(me.error as Error).message}</div>;
  }

  const logout = async () => {
    // Stop this device's notifications along with the session.
    await disablePush().catch(() => {});
    setAppBadge(0);
    const { redirect } = await api.logout();
    qc.clear();
    // With automatic single sign-on, the sign-in page waits instead of signing straight back in.
    try {
      sessionStorage.setItem(SIGNED_OUT_KEY, '1');
    } catch {
      /* private mode */
    }
    window.location.href = redirect;
  };

  return (
    <div
      className={`app ${listWidth ? 'list-sized' : ''}`}
      data-mode={route.calendar ? 'calendar' : 'mail'}
      style={{ ...(listWidth ? { ['--list-w' as string]: `${listWidth}px` } : {}), ...(sideWidth ? { ['--side-w' as string]: `${sideWidth}px` } : {}) } as React.CSSProperties} data-view={view} ref={appRef} data-run={run?.plan.kind} data-leaving={run?.from}>
      {/* Tablets and foldables: tapping beside the folder drawer closes it. */}
      <div className="drawer-backdrop" onClick={() => closeOverlay('nav')} aria-hidden="true" />
      <Sidebar
        onResize={(w, done) => setSideWidth(w, done)}
        onReorder={
          me.data?.permissions.includes('mail.accounts')
            ? (order) => {
                // Shown in the new order right away; saved in the background.
                const pos = new Map(order.accounts.map((a, i) => [a.id, i]));
                qc.setQueryData<AccountView[]>(['accounts'], (list) =>
                  list
                    ?.map((a) => ({ ...a, groupId: order.accounts.find((x) => x.id === a.id)?.groupId ?? null }))
                    .sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0)),
                );
                qc.setQueryData<MailboxGroupView[]>(['groups'], (list) => list && order.groups.map((id) => list.find((g) => g.id === id)!).filter(Boolean));
                void api.sidebarOrder(order).then(
                  (saved) => {
                    qc.setQueryData(['groups'], saved.groups);
                    qc.setQueryData(['accounts'], saved.accounts);
                  },
                  (e: Error) => {
                    push(`Couldn't save the new order: ${e.message}`, true);
                    void qc.invalidateQueries({ queryKey: ['accounts'] });
                    void qc.invalidateQueries({ queryKey: ['groups'] });
                  },
                );
              }
            : undefined
        }
        collapsedFolders={me.data?.preferences.collapsedFolders}
        onToggleFolder={(accountId, path) => {
          const prefs = me.data?.preferences;
          if (!prefs) return;
          const mine = prefs.collapsedFolders?.[accountId] ?? [];
          const list = mine.includes(path) ? mine.filter((p) => p !== path) : [...mine, path];
          const collapsedFolders = { ...(prefs.collapsedFolders ?? {}) };
          if (list.length) collapsedFolders[accountId] = list;
          else delete collapsedFolders[accountId];
          const next = { ...prefs, collapsedFolders };
          qc.setQueryData(['me'], { ...me.data, preferences: next });
          void api.savePreferences(next).catch((err: Error) => {
            push(err.message, true);
            void qc.invalidateQueries({ queryKey: ['me'] });
          });
        }}
        onPin={(accountId, folders) => {
          // Shown right away; saved in the background.
          qc.setQueryData<AccountView[]>(['accounts'], (list) => list?.map((a) => (a.id === accountId ? { ...a, pinnedFolders: folders } : a)));
          void api.setPinnedFolders(accountId, folders).catch((e: Error) => {
            push(`Couldn't save pinned folders: ${e.message}`);
            void qc.invalidateQueries({ queryKey: ['accounts'] });
          });
        }}
        groups={groupsQ.data}
        accounts={accounts}
        showUnified={unifiedInbox}
        folders={folders.data}
        sel={route.calendar ? { accountId: '', folder: '' } : effectiveSel}
        onSelect={(s) => {
          setChecked(new Set());
          // From the phone drawer, the folder replaces the drawer entry: Back then returns to the
          // previous folder rather than reopening the drawer.
          const r: Route = { ...HOME, accountId: s.accountId, folder: s.folder };
          if (overlay === 'nav') navigate(r, { replace: true });
          else go(r);
        }}
        onCompose={compose}
        belowCompose={<SendingBox items={sending} busy={sendingBusy} onUndo={(id) => void undoSending(id)} onSendNow={(id) => void sendNowSending(id)} />}
        onAccounts={() => {
          setEditAccountId(null);
          setEditGroupId(null);
          openOverlay('accounts');
        }}
        onEditGroup={
          me.data?.permissions.includes('mail.accounts')
            ? (id) => {
                setEditAccountId(null);
                setEditGroupId(id);
                openOverlay('accounts');
              }
            : undefined
        }
        onNewGroup={
          me.data?.permissions.includes('mail.accounts')
            ? () => {
                setEditAccountId(null);
                setEditGroupId('new');
                openOverlay('accounts');
              }
            : undefined
        }
        onEditAccount={
          me.data?.permissions.includes('mail.accounts')
            ? (id) => {
                setEditGroupId(null);
                setEditAccountId(id);
                openOverlay('accounts');
              }
            : undefined
        }
        onSettings={() => openOverlay('settings')}
        onLogout={() => void logout()}
        userLabel={userLabel(me.data!, me.data!.preferences.showFullName)}
        userFullName={userLabel(me.data!, true)}
        userAvatar={me.data!.avatar}
        footerIdentity={me.data!.preferences.footerIdentity}
        onCloseNav={() => closeOverlay('nav')}
        searches={me.data?.preferences.sidebarSearches === false ? [] : (savedSearches.data ?? [])}
        activeSearch={activeSearch}
        onSearch={(s) => {
          setChecked(new Set());
          const r: Route = { ...HOME, accountId: s.accountId, folder: s.folder, q: s.q, unread: s.unread, filters: s.filters };
          if (overlay === 'nav') navigate(r, { replace: true });
          else go(r);
        }}
        scheduledCount={me.data?.preferences.sidebarScheduled === false ? 0 : scheduledQ.data?.filter((m) => (Date.parse(m.sendAt) > Date.now() + 60_000 && !isSending(m)) || m.status === 'failed').length ?? 0}
        onScheduled={() => setShowScheduled(true)}
        onCalendar={me.data?.preferences.sidebarCalendar === false ? undefined : () => {
          // Like a folder: from the phone drawer it replaces the drawer entry.
          const r: Route = { ...HOME, calendar: true };
          if (overlay === 'nav') navigate(r, { replace: true });
          else go(r);
        }}
        calendarActive={!!route.calendar}
        onAssistant={assistantStatus.data?.allowed ? (id) => setAssistantFor({ id }) : undefined}
        onDeleteSearch={(s) => {
          if (!confirm(`Remove the saved search “${s.name}”?`)) return;
          api.deleteSearch(s.id).then((list) => qc.setQueryData(['searches'], list), (e: Error) => push(e.message, true));
        }}
      />
      <MessageList
        onResize={(w, done) => setListWidth(w, done)}
        title={title}
        unified={effectiveSel.accountId === null}
        isSentLike={isSentLike}
        inboxTabs={(me.data?.preferences.inboxTabs ?? true) && !route.q && !Object.keys(route.filters).length && (effectiveSel.accountId === null || folderInfo?.specialUse === 'inbox')}
        accounts={accountMap}
        folders={folders.data}
        messages={rows}
        loading={messagesQ.isLoading && accounts.length > 0}
        fetchingMore={messagesQ.isFetchingNextPage}
        hasMore={!!messagesQ.hasNextPage}
        errors={listErrors}
        listError={messagesQ.error ? (messagesQ.error as Error).message : null}
        openKey={open ? refKey(open) : null}
        checked={checked}
        query={query}
        onQuery={(q) => {
          if (q === route.q) return;
          setChecked(new Set());
          go({ ...route, q, open: null });
        }}
        filters={route.filters}
        onFilters={(filters, q) => {
          setChecked(new Set());
          go({ ...route, filters, q: q ?? route.q, open: null });
        }}
        inFolder={sel.accountId !== null}
        noMailboxes={accountsQ.isSuccess && accounts.length === 0 ? { canAdd: !!me.data?.permissions.includes('mail.accounts'), onAdd: () => openOverlay('accounts') } : undefined}
        onSaveSearch={(name) =>
          api.saveSearch({ name, q: route.q, unread: route.unread, filters: route.filters, accountId: sel.accountId, folder: sel.folder }).then(
            (list) => {
              qc.setQueryData(['searches'], list);
              push(`Saved “${name}” in the sidebar.`);
              return true;
            },
            (e: Error) => {
              push(e.message, true);
              return false;
            },
          )
        }
        onOpen={openMessage}
        onCheck={(m, on) =>
          setChecked((c) => {
            const n = new Set(c);
            if (on) n.add(refKey(m));
            else n.delete(refKey(m));
            return n;
          })
        }
        onCheckAll={(on) => setChecked(on ? new Set(rows.map(refKey)) : new Set())}
        onLoadMore={() => void messagesQ.fetchNextPage()}
        unreadOnly={route.unread}
        onUnreadOnly={(on) => {
          setChecked(new Set());
          go({ ...route, unread: on, open: null });
        }}
        onRefresh={() => {
          // An explicit refresh also lets read messages leave the unread-only list.
          setSticky({ view: '', keys: new Set() });
          api.requestFresh();
          void qc.invalidateQueries({ queryKey: ['messages'] });
          void qc.invalidateQueries({ queryKey: ['folders'] });
        }}
        onBulk={(action) => void act(rows.filter((m) => checked.has(refKey(m))).map(toRef), action)}
        onNav={() => openOverlay('nav')}
        onCompose={compose}
        lastOpenKey={lastOpenKey}
        swipeLeft={prefs?.swipeLeft ?? 'none'}
        swipeRight={prefs?.swipeRight ?? 'none'}
        swipeRemoves={(m, d) => {
          const a = swipeToAction(swipeFor(d), m);
          return !!a && removesFromList(a);
        }}
        confirmSwipe={(m, d) => swipeFor(d) !== 'delete' || !isTrash(m) || window.confirm('Delete this message permanently?')}
        onSwipe={(m, d) => void onSwipe(m, d)}
      />
      {route.calendar && <CalendarDialog accounts={accounts} onNav={() => openOverlay('nav')} />}
      <Reader
        openRef={readerRef}
        conversation={readerRef ? rowOf(rows, readerRef) : undefined}
        account={readerRef ? accountMap.get(readerRef.accountId) : undefined}
        multipleAccounts={accounts.length > 1}
        folders={readerRef ? folders.data?.find((f) => f.accountId === readerRef.accountId) : undefined}
        isDrafts={
          !!readerRef &&
          folders.data?.find((f) => f.accountId === readerRef.accountId)?.folders.find((f) => f.path === readerRef.folder)?.specialUse === 'drafts'
        }
        theme={theme}
        markReadOnOpen={me.data!.preferences.markReadOnOpen}
        contactPhotos={me.data!.preferences.contactPhotos}
        messageButtons={me.data!.preferences.messageButtons}
        onAction={(refs, a) => void act(refs, a)}
        snoozeSignal={snoozeSignal}
        onReply={reply}
        onMailto={composeMailto}
        onBack={() => back(listRoute(route))}
        onGone={open ? onGone : () => {}}
      />
      {composer && (
        <Composer
          key={composeId}
          init={composer}
          accounts={accounts}
          onClose={closeComposer}
          dirtyRef={composerDirty}
          onToast={push}
          undoSeconds={me.data?.preferences.undoSendSeconds ?? 10}
          onReopen={(init) => startCompose(init)}
          onScheduled={() => void qc.invalidateQueries({ queryKey: ['scheduled'] })}
          onSent={() => {
            void qc.invalidateQueries({ queryKey: ['messages'] });
            void qc.invalidateQueries({ queryKey: ['folders'] });
          }}
        />
      )}
      {dialog === 'accounts' && <AccountsDialog accounts={accounts} defaults={me.data!.accountDefaults} startWithNew={accounts.length === 0} canEdit={me.data!.permissions.includes('mail.accounts')} editAccountId={editAccountId} editGroupId={editGroupId} onClose={() => closeOverlay('accounts')} />}
      {showScheduled && <ScheduledDialog accounts={accountMap} onClose={() => setShowScheduled(false)} />}
      {assistantFor && accountMap.get(assistantFor.id) && (
        <AssistantDialog
          account={accountMap.get(assistantFor.id)!}
          folders={folders.data?.find((f) => f.accountId === assistantFor.id)}
          initialTab={assistantFor.tab}
          onClose={() => setAssistantFor(null)}
        />
      )}
      {dialog === 'settings' && <SettingsDialog me={me.data!} onClose={() => closeOverlay('settings')} />}
      {run && <SquirrelRun key={run.id} run={run} appRef={appRef} onDone={() => setRun(null)} />}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
