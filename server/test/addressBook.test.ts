// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../shared/types.js';
import { AddressBook } from '../src/addressBook.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const imap = { host: 'h', port: 993, tls: 'tls', user: 'u', password: 'p' };
const smtp = { host: 'h', port: 465, tls: 'tls', user: 'u', password: 'p' };

function setup() {
  const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
  const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
  const mk = (email: string) => store.createAccount(user.id, { name: email.split('@')[0], email, displayName: 'Sam', color: '#22d3ee', imap, smtp, appendSent: true } as never);
  const work = mk('sam@work.example');
  const home = mk('sam@home.example');
  const side = mk('sam@side.example');
  const gid = store.saveGroup(user.id, { name: 'Jobs', color: '#22d3ee', icon: '', notify: true, follow: false, accountIds: [work.id, side.id] } as never)!;
  return { store, book: new AddressBook(store), userId: user.id, work, home, side, gid };
}

const msg = (over: Partial<MessageSummary>): Pick<MessageSummary, 'from' | 'to' | 'date' | 'category'> => ({
  from: [],
  to: [],
  date: '2026-11-01T10:00:00Z',
  category: 'personal',
  ...over,
});
const who = (address: string, name = '') => ({ address, name });

describe('address suggestions', () => {
  it('collects people from sent and received mail, but not newsletters, no-reply senders, Junk or yourself', () => {
    const { book, userId, work } = setup();
    book.harvest(userId, work.id, 'sent', [msg({ to: [who('Alice@Example.com', 'Alice Adams'), who('sam@home.example')] })]);
    book.harvest(userId, work.id, 'inbox', [
      msg({ from: [who('bob@example.com', 'Bob Brown')] }),
      msg({ from: [who('news@shop.example')], category: 'newsletters' }),
      msg({ from: [who('no-reply@service.example')] }),
      msg({ from: [who('notifications@github.example')] }),
    ]);
    book.harvest(userId, work.id, 'junk', [msg({ from: [who('spam@bad.example')] })]);
    book.harvest(userId, work.id, null, [msg({ from: [who('carol@example.com', 'Carol')] })]);
    const all = book.search(userId, 'e', null, 20).map((s) => s.address);
    expect(all.sort()).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
  });

  it('matches the start of addresses and names first, and people you write to before those who write to you', () => {
    const { book, userId, work } = setup();
    book.harvest(userId, work.id, 'inbox', [msg({ from: [who('dan@example.com', 'Dan Fox')] }), msg({ from: [who('dan@example.com', 'Dan Fox')] })]);
    book.sent(userId, work.id, [who('danielle@example.com', 'Danielle Ray')]);
    book.harvest(userId, work.id, 'inbox', [msg({ from: [who('jordan@example.com', 'Jordan')] })]);
    expect(book.search(userId, 'dan', null).map((s) => s.address)).toEqual(['danielle@example.com', 'dan@example.com', 'jordan@example.com']);
    expect(book.search(userId, 'fox', null)).toEqual([{ name: 'Dan Fox', address: 'dan@example.com' }]);
    expect(book.search(userId, 'ray', null)[0]!.address).toBe('danielle@example.com');
  });

  it('limits suggestions to the mailbox written from, its group, or chosen mailboxes', () => {
    const { book, userId, work, home, side, gid } = setup();
    book.sent(userId, work.id, [who('wendy@example.com')]);
    book.sent(userId, home.id, [who('hank@example.com')]);
    book.sent(userId, side.id, [who('sid@example.com')]);
    const find = (from: string, scope: 'all' | 'mailbox' | 'group' | 'chosen', chosen: string[] = []) =>
      book.search(userId, 'example', book.scope(userId, from, scope, chosen)).map((s) => s.address).sort();
    expect(find(work.id, 'all')).toEqual(['hank@example.com', 'sid@example.com', 'wendy@example.com']);
    expect(find(work.id, 'mailbox')).toEqual(['wendy@example.com']);
    expect(find(work.id, 'group')).toEqual(['sid@example.com', 'wendy@example.com']);
    expect(find(home.id, 'group')).toEqual(['hank@example.com']); // not in a group: just itself
    expect(find(work.id, 'chosen', [home.id])).toEqual(['hank@example.com']);
    expect(find(work.id, 'chosen', [])).toHaveLength(3); // nothing chosen: everyone
    expect(gid).toBeTruthy();
  });

  it('counts each folder once, and forgets a mailbox', () => {
    const { book, userId, work } = setup();
    expect(book.filled(work.id, 'INBOX')).toBe(false);
    book.markFilled(work.id, 'INBOX');
    expect(book.filled(work.id, 'INBOX')).toBe(true);
    book.sent(userId, work.id, [who('x@example.com')]);
    book.forgetAccount(userId, work.id);
    expect(book.filled(work.id, 'INBOX')).toBe(false);
    expect(book.search(userId, 'x@', null)).toEqual([]);
  });

  it("goes when the mailbox does", () => {
    const { store, book, userId, work } = setup();
    book.sent(userId, work.id, [who('gone@example.com')]);
    store.deleteAccount(userId, work.id);
    expect(book.search(userId, 'gone', null)).toEqual([]);
  });
});
