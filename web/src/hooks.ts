// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: useSignatures.
// Modified by samschultzponsys, 2026-11-13: desktop app: native notifications, update check.
// Modified by samschultzponsys, 2026-11-13: useAccounts can wait for sign-in.
// Modified by samschultzponsys, 2026-11-15: search filters and saved searches.
// Modified by samschultzponsys, 2026-11-15: send later and undo send.
// Modified by samschultzponsys, 2026-11-16: folders asked for per mailbox.
// Modified by samschultzponsys, 2026-11-17: preferences changed on another device are fetched again.
// Modified by samschultzponsys, 2026-11-17: event reminders over the WebSocket.
// Modified by samschultzponsys, 2026-11-23: quick searches from the search index while the full one runs.
// Modified by samschultzponsys, 2026-11-24: reconnecting checks the server's version again.
// Modified by samschultzponsys, 2026-11-25: unused useMessageCache removed.
// Modified by samschultzponsys, 2026-11-25: the list kept on this device shown at once (when switched on).

import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountFolders, ClientEvent, MessageAction, MessageRef, Preferences, ServerEvent } from '../../shared/types';
import { api, type MailboxSel } from './api';
import { desktopBridge } from './desktop';
import { actionsPending, fetchMessageList, runMessageAction, type ActionOutcome } from './messageActions';
import { closeNotifications } from './push';
import { applyThemeColor } from './themeColor';
import { saveSnapshot, snapshotFor } from './listSnapshot';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: Infinity });
export const useAccounts = (enabled = true) => useQuery({ queryKey: ['accounts'], queryFn: api.accounts, staleTime: 60_000, enabled });
export const useSignatures = (enabled = true) => useQuery({ queryKey: ['signatures'], queryFn: api.signatures, staleTime: 60_000, enabled });
/**
 * Every mailbox's folders, each asked for on its own, so one slow mailbox doesn't hold up the others'
 * folders in the sidebar. `data` holds the mailboxes loaded so far (in mailbox order).
 */
export function useFolders(accountIds: string[], enabled: boolean): { data: AccountFolders[] | undefined } {
  const results = useQueries({
    queries: accountIds.map((id) => ({
      queryKey: ['folders', id],
      queryFn: async () => (await api.folders(id))[0] ?? null,
      enabled,
      staleTime: 30_000,
      // The server answered with the last known list while it fetches a fresh one: ask again soon.
      refetchInterval: (q: { state: { data?: AccountFolders | null } }) => (q.state.data?.refreshing ? 3000 : 120_000),
    })),
  });
  const loaded = results.map((r) => r.data).filter((d): d is AccountFolders => !!d);
  const key = results.map((r) => `${r.dataUpdatedAt}`).join('|');
  // Same array while nothing changed, so effects that depend on it don't rerun every render.
  const data = useMemo(() => (accountIds.length && results.some((r) => r.data) ? loaded : undefined), [key, accountIds.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data };
}

/** Saved searches (the sidebar's smart folders). */
export function useSavedSearches(enabled: boolean) {
  return useQuery({ queryKey: ['searches'], queryFn: api.savedSearches, enabled, staleTime: 60_000 });
}

export function useMessages(sel: MailboxSel, q: string, unread: boolean, enabled: boolean, filter = '') {
  const qc = useQueryClient();
  const queryKey = ['messages', sel.accountId, sel.accountId ? sel.folder : '', q, unread, filter] as const;
  return useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchMessageList(qc, () => api.messages(sel, pageParam, q, unread, filter, false, q || filter ? signal : undefined));
      // Settings → This device: kept to show at once next time (DreyMail 14.5; off unless chosen).
      if (pageParam === null && !q && !filter) saveSnapshot(queryKey, page);
      return page;
    },
    // Until the server answers: the list kept from last time, if there is one for this view.
    placeholderData: () => {
      const page = q || filter ? undefined : snapshotFor(queryKey);
      return page ? { pages: [page], pageParams: [null] } : undefined;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    enabled,
    staleTime: 20_000,
    // INBOX changes arrive via IDLE; this also catches changes in other folders.
    refetchInterval: 120_000,
  });
}

/**
 * A word search answered at once from DreyMail's search index (DreyMail 12.8), shown while the full
 * search (which asks the mail servers) runs.
 */
export function useQuickSearch(sel: MailboxSel, q: string, unread: boolean, enabled: boolean, filter = '') {
  return useQuery({
    queryKey: ['messages-quick', sel.accountId, sel.accountId ? sel.folder : '', q, unread, filter],
    queryFn: () => api.messages(sel, null, q, unread, filter, true),
    enabled: enabled && !!q.trim(),
    staleTime: 20_000,
  });
}

/**
 * Run a message action with an optimistic cache update and a refetch afterwards. Resolves with a
 * plan to undo it (null if it failed or can't be undone). See messageActions.ts.
 */
export function useMessageAction(onError: (msg: string) => void) {
  const qc = useQueryClient();
  return useCallback(
    (refs: MessageRef[], action: MessageAction): Promise<ActionOutcome> => {
      void closeNotifications(refs, action);
      return runMessageAction(qc, refs, action, { send: api.action, onError });
    },
    [qc, onError],
  );
}

/** In front of the user right now: phone notifications are held back while this is true. */
const isActive = () => document.visibilityState === 'visible' && document.hasFocus();

export type SnoozeEndedEvent = Extract<ServerEvent, { type: 'snoozeEnded' }>;

/** One WebSocket per browser session; reconnects with backoff. Reports presence to the server. */
export type NotifyEvent = Extract<ServerEvent, { type: 'notify' }>;

export type ReminderEvent = Extract<ServerEvent, { type: 'reminder' }>;

export function useLiveUpdates(enabled: boolean, onSnoozeEnded?: (ev: SnoozeEndedEvent) => void, onNotify?: (ev: NotifyEvent) => void, onReminder?: (ev: ReminderEvent) => void) {
  const qc = useQueryClient();
  const reminder = useRef(onReminder);
  reminder.current = onReminder;
  const timer = useRef<number | null>(null);
  const snoozeEnded = useRef(onSnoozeEnded);
  snoozeEnded.current = onSnoozeEnded;
  const notify = useRef(onNotify);
  notify.current = onNotify;
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let backoff = 1000;
    let retry: number | null = null;
    const refresh = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        // While actions are under way the last one to finish refetches; a list fetched now could
        // still show what they are removing.
        if (!actionsPending(qc)) void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['folders'] });
      }, 400);
    };
    const sendPresence = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'presence', active: isActive(), ...(desktopBridge() ? { notifications: true } : {}) } satisfies ClientEvent));
      }
    };
    const presenceEvents = ['visibilitychange', 'focus', 'blur'] as const;
    for (const ev of presenceEvents) window.addEventListener(ev, sendPresence);
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      ws.onopen = () => {
        backoff = 1000;
        sendPresence();
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(String(e.data)) as ServerEvent;
        // Reconnected (the server may have been updated): check its version again (DreyMail 13.8).
        if (ev.type === 'hello') void qc.invalidateQueries({ queryKey: ['version'] });
        else if (ev.type === 'reset') void qc.resetQueries({ queryKey: ['messages'] });
        else if (ev.type === 'mailbox') refresh();
        else if (ev.type === 'snoozeEnded') snoozeEnded.current?.(ev);
        else if (ev.type === 'preferences') void qc.invalidateQueries({ queryKey: ['me'] });
        else if (ev.type === 'notify') notify.current?.(ev);
        else if (ev.type === 'reminders') void qc.invalidateQueries({ queryKey: ['reminders'] });
        else if (ev.type === 'reminder') {
          void qc.invalidateQueries({ queryKey: ['reminders'] });
          reminder.current?.(ev);
        }
      };
      ws.onclose = (e) => {
        if (stopped || e.code === 4401) return;
        retry = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60_000);
      };
    };
    connect();
    return () => {
      stopped = true;
      for (const ev of presenceEvents) window.removeEventListener(ev, sendPresence);
      if (retry) window.clearTimeout(retry);
      ws?.close();
    };
  }, [enabled, qc]);
}

export type ResolvedTheme = 'light' | 'dark';

export function useTheme(pref: Preferences['theme'] | undefined): ResolvedTheme {
  const [system, setSystem] = useState<ResolvedTheme>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const theme = !pref || pref === 'system' ? system : pref;
  // Applied during render (idempotent) so children that read CSS variables, such as the message
  // iframe palette, already see the new theme in the same render.
  if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  useEffect(() => applyThemeColor(document, theme), [theme]);
  return theme;
}

export interface Toast {
  id: number;
  text: string;
  error: boolean;
  action?: { label: string; run: () => void };
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (text: string, error = false, action?: Toast['action'], ms?: number) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, text, error, action }]);
      window.setTimeout(() => dismiss(id), Math.max(ms ?? 0, action ? 7000 : error ? 6000 : 3500));
    },
    [dismiss],
  );
  return { toasts, push, dismiss };
}
