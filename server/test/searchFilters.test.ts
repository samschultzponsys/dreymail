// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dateRange, decodeFilters, encodeFilters, filterChips, normalizeFilters, withoutFilter } from '../../shared/search.js';
import type { AccountInput } from '../../shared/types.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { isFiltered, needsSearch, searchAttempts } from '../src/imap/mail.js';

const NOW = new Date(2026, 10, 15, 14, 30);

describe('search filters (shared)', () => {
  it('keeps only valid values', () => {
    expect(
      normalizeFilters({
        where: 'all',
        accounts: ['a1', 'bad id!', 'a1'],
        from: '  bob@example.com ',
        to: '',
        flagged: true,
        answered: 'yes',
        date: 'custom',
        since: '2026-01-01',
        until: 'tomorrow',
        largerMb: 3,
        evil: 1,
      }),
    ).toEqual({ where: 'all', accounts: ['a1'], from: 'bob@example.com', flagged: true, date: 'custom', since: '2026-01-01' });
    expect(normalizeFilters({ where: 'folder', date: 'custom' })).toEqual({});
    expect(normalizeFilters('nope')).toEqual({});
  });

  it('round-trips through the URL and ignores garbage', () => {
    const f = { where: 'inboxes' as const, subject: 'invoice', attachment: true, largerMb: 5 };
    expect(decodeFilters(encodeFilters(f))).toEqual(f);
    expect(encodeFilters({})).toBe('');
    expect(decodeFilters('{not json')).toEqual({});
  });

  it('turns date presets into whole-day IMAP ranges', () => {
    expect(dateRange({ date: 'today' }, NOW)).toEqual({ since: new Date('2026-11-15T00:00:00Z') });
    expect(dateRange({ date: 'week' }, NOW)).toEqual({ since: new Date('2026-11-08T00:00:00Z') });
    // "until" is inclusive, IMAP BEFORE is not.
    expect(dateRange({ date: 'custom', since: '2026-03-01', until: '2026-03-31' }, NOW)).toEqual({
      since: new Date('2026-03-01T00:00:00Z'),
      before: new Date('2026-04-01T00:00:00Z'),
    });
    expect(dateRange({}, NOW)).toEqual({});
  });

  it('shows one chip per filter and removes them one by one', () => {
    const f = normalizeFilters({ accounts: ['g'], from: 'bob', date: 'custom', since: '2026-01-01', flagged: true });
    expect(filterChips(f, (id) => (id === 'g' ? 'Gmail' : '?')).map((c) => c.label)).toEqual(['Gmail', 'From: bob', 'Starred', 'Since 2026-01-01']);
    expect(withoutFilter(f, 'date')).toEqual({ accounts: ['g'], from: 'bob', flagged: true });
  });
});

describe('searchAttempts with filters', () => {
  it('maps every filter to IMAP SEARCH keys', () => {
    const attempts = searchAttempts(
      { text: '', unread: true, filters: { from: 'bob', to: 'sam', subject: 'march', body: 'total', flagged: true, answered: true, date: 'month', largerMb: 5 } },
      { beforeUid: 10 },
      NOW,
    );
    expect(attempts).toEqual([
      {
        uid: '1:9',
        seen: false,
        from: 'bob',
        to: 'sam',
        subject: 'march',
        body: 'total',
        flagged: true,
        answered: true,
        since: new Date('2026-10-16T00:00:00Z'),
        larger: 5 * 1024 * 1024,
      },
    ]);
  });

  it('asks Gmail for attachments first, then multipart/mixed, each with the text fallbacks', () => {
    const attempts = searchAttempts({ text: 'x', unread: false, filters: { attachment: true } }, undefined, NOW);
    expect(attempts).toHaveLength(6);
    expect(attempts[0]).toEqual({ gmraw: 'has:attachment', or: [{ subject: 'x' }, { from: 'x' }, { to: 'x' }, { body: 'x' }] });
    expect(attempts[3]).toEqual({ header: { 'content-type': 'multipart/mixed' }, or: [{ subject: 'x' }, { from: 'x' }, { to: 'x' }, { body: 'x' }] });
  });

  it('where and accounts alone do not need a server search', () => {
    expect(needsSearch({ text: '', unread: false, filters: { where: 'all', accounts: ['a'] } })).toBe(false);
    expect(isFiltered({ text: '', unread: false, filters: { flagged: true } })).toBe(true);
  });
});

describe('saved searches in the store', () => {
  const account: AccountInput = {
    name: 'Gmail',
    displayName: 'Sam',
    email: 'sam@example.com',
    color: '#22d3ee',
    imap: { host: 'h', port: 993, tls: 'tls', user: 'u', password: 'p' },
    smtp: { host: 'h', port: 465, tls: 'tls', user: 'u', password: 'p' },
    appendSent: true,
  };

  it('saves, lists and deletes per user, scoped to own accounts', () => {
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const sam = store.upsertUser('local', 'sam', '', 'Sam');
    const eve = store.upsertUser('local', 'eve', '', 'Eve');
    const mine = store.createAccount(sam.id, account);
    const eves = store.createAccount(eve.id, account);
    const list = store.saveSearch(sam.id, { name: 'Receipts', q: 'receipt', unread: false, filters: { attachment: true, bogus: 1 } as never, accountId: mine.id, folder: 'Archive' });
    expect(list).toEqual([{ id: list[0]!.id, name: 'Receipts', q: 'receipt', unread: false, filters: { attachment: true }, accountId: mine.id, folder: 'Archive' }]);
    // Someone else's account is not accepted as the scope.
    const second = store.saveSearch(sam.id, { name: 'X', q: '', unread: true, filters: {}, accountId: eves.id, folder: 'INBOX' });
    expect(second[1]).toMatchObject({ accountId: null, folder: 'INBOX', unread: true });
    expect(store.listSavedSearches(eve.id)).toEqual([]);
    expect(store.deleteSavedSearch(eve.id, list[0]!.id)).toBe(false);
    expect(store.deleteSavedSearch(sam.id, list[0]!.id)).toBe(true);
    expect(store.listSavedSearches(sam.id)).toHaveLength(1);
  });
});
