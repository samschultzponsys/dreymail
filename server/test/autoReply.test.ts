// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AutoReplyInput } from '../../shared/types.js';
import { AutoReplies, fill, parseHeaders, skipReason } from '../src/autoReply.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import type { ImapPool } from '../src/imap/pool.js';

const own = 'me@example.com';
const h = (raw: string) => parseHeaders(raw);

describe('skipReason', () => {
  it('answers a normal message', () => {
    expect(skipReason(h('From: a@b.com\r\nSubject: hi\r\n'), 'a@b.com', own)).toBeNull();
    expect(skipReason(h('Auto-Submitted: no\r\n'), 'a@b.com', own)).toBeNull();
  });
  it('never answers automatic, list, bulk, spam or no-reply mail', () => {
    expect(skipReason(h('Auto-Submitted: auto-replied\r\n'), 'a@b.com', own)).toBe('automatic');
    expect(skipReason(h('Precedence: bulk\r\n'), 'a@b.com', own)).toBe('bulk');
    expect(skipReason(h('List-Id: <x.lists.example>\r\n'), 'a@b.com', own)).toBe('list');
    expect(skipReason(h('List-Unsubscribe:\r\n <mailto:u@x>\r\n'), 'a@b.com', own)).toBe('list');
    expect(skipReason(h('X-Auto-Response-Suppress: OOF, AutoReply\r\n'), 'a@b.com', own)).toBe('suppressed');
    expect(skipReason(h('X-Spam-Flag: YES\r\n'), 'a@b.com', own)).toBe('spam');
    expect(skipReason(h('Return-Path: <>\r\n'), 'a@b.com', own)).toBe('bounce');
    expect(skipReason(h(''), 'noreply@shop.com', own)).toBe('no-reply');
    expect(skipReason(h(''), 'MAILER-DAEMON@mx.example', own)).toBe('no-reply');
    expect(skipReason(h(''), 'Me@Example.com', own)).toBe('own');
  });
  it('fills in the subject', () => {
    expect(fill('Out of office: {subject}', { subject: 'Lunch?' })).toBe('Out of office: Lunch?');
  });
});

function setup() {
  const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
  const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
  const imap = { host: 'h', port: 993, tls: 'tls', user: 'u', password: 'p' };
  const smtp = { host: 'h', port: 465, tls: 'tls', user: 'u', password: 'p' };
  const mk = (email: string) => store.createAccount(user.id, { name: email, email, displayName: 'Sam', color: '#22d3ee', imap, smtp, appendSent: true } as never);
  const a1 = mk('work@example.com');
  const a2 = mk('home@example.com');
  let headers: Record<number, string> = {};
  const pool = {
    withMailbox: async (_u: string, _a: string, _p: string, fn: (c: unknown) => Promise<unknown>) =>
      fn({
        async *fetch(range: string) {
          for (const uid of range.split(',').map(Number)) yield { uid, headers: Buffer.from(headers[uid] ?? '') };
        },
      }),
  } as unknown as ImapPool;
  const sent: { accountId: string; to: string; subject: string; text: string }[] = [];
  let now = Date.parse('2026-11-17T12:00:00Z');
  const replies = new AutoReplies({ store, pool, send: async (_u, accountId, r) => void sent.push({ accountId, ...r }), now: () => now });
  return { store, user, a1, a2, replies, sent, setHeaders: (v: typeof headers) => (headers = v), advance: (ms: number) => (now += ms) };
}

const base: AutoReplyInput = {
  name: 'Out of office',
  subject: 'Out of office: {subject}',
  body: 'I am away.',
  enabled: true,
  startsAt: null,
  endsAt: null,
  allMailboxes: true,
  accountIds: [],
  groupIds: [],
  intervalDays: 4,
};
const flush = () => new Promise((r) => setTimeout(r, 10));

describe('AutoReplies', () => {
  it('picks the most specific auto-reply for a mailbox, within its dates', () => {
    const { user, a1, a2, replies } = setup();
    replies.save(user.id, base);
    replies.save(user.id, { ...base, name: 'Sick', allMailboxes: false, accountIds: [a1.id] });
    replies.save(user.id, { ...base, name: 'Later', allMailboxes: false, accountIds: [a2.id], startsAt: '2026-12-01T00:00:00Z' });
    expect(replies.activeFor(user.id, a1.id)?.name).toBe('Sick');
    expect(replies.activeFor(user.id, a2.id)?.name).toBe('Out of office');
    expect(replies.users()).toEqual([user.id]);
  });

  it('answers each sender once per interval, and skips list mail', async () => {
    const { user, a1, replies, sent, setHeaders, advance } = setup();
    replies.save(user.id, base);
    setHeaders({ 1: 'Subject: Lunch?\r\n', 2: 'List-Id: <news.example>\r\n', 3: 'Subject: again\r\n' });
    await replies.handleNew(user.id, a1.id, [
      { uid: 1, from: { address: 'friend@example.org' }, subject: 'Lunch?', messageId: '<m1@example.org>' },
      { uid: 2, from: { address: 'news@example.org' }, subject: 'News', messageId: null },
      { uid: 3, from: { address: 'Friend@example.org' }, subject: 'again', messageId: null },
    ]);
    await flush();
    expect(sent).toEqual([{ accountId: a1.id, to: 'friend@example.org', subject: 'Out of office: Lunch?', text: 'I am away.', inReplyTo: '<m1@example.org>' }]);
    await replies.handleNew(user.id, a1.id, [{ uid: 3, from: { address: 'friend@example.org' }, subject: 'again', messageId: null }]);
    await flush();
    expect(sent).toHaveLength(1);
    advance(5 * 86_400_000);
    await replies.handleNew(user.id, a1.id, [{ uid: 3, from: { address: 'friend@example.org' }, subject: 'again', messageId: null }]);
    await flush();
    expect(sent).toHaveLength(2);
  });

  it('sends nothing when off or over', async () => {
    const { user, a1, replies, sent, setHeaders } = setup();
    const r = replies.save(user.id, { ...base, endsAt: '2026-11-17T11:00:00Z' })!;
    setHeaders({ 1: '' });
    await replies.handleNew(user.id, a1.id, [{ uid: 1, from: { address: 'x@example.org' }, subject: '', messageId: null }]);
    replies.save(user.id, { ...base, enabled: false }, r.id);
    await replies.handleNew(user.id, a1.id, [{ uid: 1, from: { address: 'x@example.org' }, subject: '', messageId: null }]);
    await flush();
    expect(sent).toHaveLength(0);
    expect(replies.users()).toEqual([]);
  });
});
