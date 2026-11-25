// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-15: automatic inbox tabs (category of each message).
// Modified by samschultzponsys, 2026-11-16: longer snippets with paragraphs, for notification previews.
// Modified by samschultzponsys, 2026-11-18: importance (high / low) in message lists; Gmail labels.
// Modified by samschultzponsys, 2026-11-25: searchOrThrow (a refused search is an error, never an empty answer).

import { importanceOf } from '../../../shared/importance.js';
import { categoryFromHeaders } from '../../../shared/categories.js';
import type { FetchMessageObject, FetchQueryObject, ImapFlow, MessageAddressObject, SearchObject } from 'imapflow';
import type { Address, MessageSummary } from '../../../shared/types.js';
import { firstMessageId, type ThreadHeaders } from '../../../shared/threads.js';
import { parseReferences } from '../mail/parse.js';
import { findTextPart, hasAttachments, SNIPPET_FETCH_BYTES, snippetFromPart, type TextPart } from './snippet.js';

// Turning fetched IMAP messages into list entries, shared by live listings and the mail cache.

/** What a message list needs of each message. */
export const LIST_FETCH: FetchQueryObject = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true, headers: ['references', 'in-reply-to', 'list-id', 'list-unsubscribe', 'precedence', 'auto-submitted', 'importance', 'priority', 'x-priority'] };

/** References kept per message: the root and the most recent ancestors are what threading needs. */
const MAX_REFERENCES = 30;

/** LIST_FETCH, with Gmail's labels on Gmail (X-GM-EXT-1) (DreyMail 10.9). */
/**
 * A SEARCH's results, or an error when the mail server refused it (imapflow answers `false`, e.g.
 * when Microsoft 365 throttles). Never an empty list in its place (DreyMail 14.6): an empty answer
 * read as "no messages" made a sync drop the whole cached inbox.
 */
export async function searchOrThrow(client: Pick<ImapFlow, 'search'>, query: SearchObject, opts: { uid: boolean }): Promise<number[]> {
  const res = await client.search(query, opts);
  if (!Array.isArray(res)) throw new Error('The mail server did not answer a search of the folder (busy or limiting); trying again later');
  return res;
}

export function listFetch(client: { capabilities?: Map<string, unknown> | Set<string> }): FetchQueryObject {
  return client.capabilities?.has('X-GM-EXT-1') ? { ...LIST_FETCH, labels: true } : LIST_FETCH;
}

/** Gmail labels worth showing in a list: user labels (and Inbox), not the folder being looked at. */
export function shownLabels(labels: Set<string> | undefined, folder: string): string[] | undefined {
  if (!labels?.size) return undefined;
  const out = [...labels].filter((l) => !l.startsWith('\\') || l === '\\Inbox').map((l) => (l === '\\Inbox' ? 'INBOX' : l)).filter((l) => l !== folder);
  return out.length ? out.slice(0, 6) : undefined;
}

/** Message-ID, In-Reply-To and References of a message fetched with LIST_FETCH. */
export function threadHeaders(msg: Pick<FetchMessageObject, 'envelope' | 'headers'>): ThreadHeaders {
  // Read from the headers: not every server puts In-Reply-To in the ENVELOPE.
  const raw = msg.headers?.toString('latin1').replace(/\r?\n[ \t]+/g, ' ') ?? '';
  let references = parseReferences(raw.match(/^references:(.*)$/im)?.[1]);
  if (references.length > MAX_REFERENCES) references = [references[0]!, ...references.slice(-(MAX_REFERENCES - 1))];
  return {
    messageId: firstMessageId(msg.envelope?.messageId) ?? msg.envelope?.messageId ?? null,
    inReplyTo: firstMessageId(raw.match(/^in-reply-to:(.*)$/im)?.[1]) ?? firstMessageId(msg.envelope?.inReplyTo),
    references,
  };
}

export function toDate(d: Date | string | undefined): Date | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addresses(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? []).filter((a) => a.address).map((a) => ({ name: a.name ?? '', address: a.address! }));
}

/** Where a message sorts in a merged listing: its arrival time. */
export function sortTime(msg: Pick<FetchMessageObject, 'internalDate' | 'envelope'>): number {
  return (toDate(msg.internalDate) ?? toDate(msg.envelope?.date) ?? new Date(0)).getTime();
}

export function summaryOf(source: { accountId: string; folder: string }, uidValidity: string, msg: FetchMessageObject, snippet: string): MessageSummary {
  const env = msg.envelope ?? {};
  const importance = importanceOf(msg.headers?.toString('latin1') ?? '');
  const flags = msg.flags ?? new Set<string>();
  const date = toDate(env.date) ?? toDate(msg.internalDate) ?? new Date(0);
  return {
    accountId: source.accountId,
    folder: source.folder,
    uid: msg.uid,
    uidValidity,
    ...threadHeaders(msg),
    subject: env.subject ?? '',
    from: addresses(env.from),
    to: addresses(env.to),
    date: date.toISOString(),
    snippet,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    draft: flags.has('\\Draft'),
    hasAttachments: hasAttachments(msg.bodyStructure),
    size: msg.size ?? 0,
    category: categoryFromHeaders(msg.headers?.toString('latin1') ?? '', env.from?.[0]?.address ?? ''),
    ...(importance ? { importance } : {}),
    ...(shownLabels(msg.labels, source.folder) ? { labels: shownLabels(msg.labels, source.folder) } : {}),
  };
}

/**
 * Preview snippets for messages of the currently selected mailbox, fetched with LIST_FETCH: the
 * first bytes of each one's text part, one FETCH per kind of part. Keyed by UID.
 */
export async function fetchSnippets(
  client: ImapFlow,
  msgs: FetchMessageObject[],
  opts: { bytes?: number; length?: number; keepLines?: boolean } = {},
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const byPart = new Map<string, { part: TextPart; uids: number[] }>();
  for (const m of msgs) {
    const part = findTextPart(m.bodyStructure);
    if (!part) continue;
    const k = `${part.part}|${part.type}|${part.encoding}|${part.charset}`;
    const e = byPart.get(k) ?? { part, uids: [] };
    e.uids.push(m.uid);
    byPart.set(k, e);
  }
  for (const { part, uids } of byPart.values()) {
    const fetched = await client.fetchAll(
      uids.join(','),
      { uid: true, bodyParts: [{ key: part.part, start: 0, maxLength: opts.bytes ?? SNIPPET_FETCH_BYTES }] },
      { uid: true },
    );
    for (const f of fetched) {
      const buf = f.bodyParts ? [...f.bodyParts.values()][0] : undefined;
      if (buf) out.set(f.uid, snippetFromPart(buf, part, (f.binaryParts?.size ?? 0) > 0, opts));
    }
  }
  return out;
}
