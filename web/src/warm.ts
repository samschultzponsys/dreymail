// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/**
 * Messages likely opened next (DreyMail 14.0): the server fetches their content into its cache
 * ahead, so opening them doesn't wait for the mail server. Asked in small batches, each message
 * at most once every few minutes.
 */
import type { ConversationRow } from '../../shared/threads';
import type { MessageRef } from '../../shared/types';
import { api } from './api';
import { refKey, toRef } from './util';

const AGAIN_MS = 5 * 60_000;
const asked = new Map<string, number>();
let queue: MessageRef[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function warm(refs: MessageRef[]) {
  const now = Date.now();
  for (const r of refs) {
    const k = refKey(r);
    if ((asked.get(k) ?? 0) > now - AGAIN_MS) continue;
    asked.set(k, now);
    queue.push(r);
  }
  if (asked.size > 2000) for (const [k, at] of asked) if (at < now - AGAIN_MS) asked.delete(k);
  if (!queue.length || timer) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = queue.splice(0, 10);
    queue = [];
    void api.warmMessages(batch).catch(() => undefined);
  }, 60);
}

/** What opening a row shows: its newest message and the unread ones (at most four). */
export function rowRefs(row: ConversationRow): MessageRef[] {
  const newest = row.thread.at(-1) ?? row;
  const unread = row.thread.filter((m) => !m.seen && m !== newest).slice(-3);
  return [newest, ...unread].map(toRef);
}
