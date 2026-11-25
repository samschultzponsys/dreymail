// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { decideRemoteImages, type AutoImages } from '../src/mail/imageAllowlist.js';
import { parseRaw } from '../src/mail/parse.js';

const mail = (from: string, extra = '') => parseRaw(Buffer.from(`${extra}From: ${from}\r\nTo: sam@spazcat.test\r\nSubject: Hi\r\nContent-Type: text/html\r\n\r\n<p>Hi</p>\r\n`));
const auto = (over: Partial<AutoImages> = {}): AutoImages => ({ ownDomains: [], contacts: new Set(), senderHosted: false, imageUrls: [], ...over });

describe('loading images by themselves', () => {
  it('for your own domains and people you have written to', async () => {
    expect(decideRemoteImages(await mail('Me <me@spazcat.test>'), undefined, [], auto({ ownDomains: ['spazcat.test'] }))).toMatchObject({ load: true, reason: 'own' });
    // Exactly your domain: a subdomain (e.g. a newsletter's) doesn't count.
    expect(decideRemoteImages(await mail('News <n@news.spazcat.test>'), undefined, [], auto({ ownDomains: ['spazcat.test'] })).load).toBe(false);
    expect(decideRemoteImages(await mail('Ada <Ada@Example.org>'), undefined, [], auto({ contacts: new Set(['ada@example.org']) }))).toMatchObject({ load: true, reason: 'contact' });
    expect(decideRemoteImages(await mail('Stranger <x@example.net>'), undefined, [], auto({ ownDomains: ['spazcat.test'], contacts: new Set(['ada@example.org']) }))).toMatchObject({ load: false });
  });

  it("when every image is on the sender's own domain, if switched on", async () => {
    const shop = await mail('Shop <news@mail.shop.example>');
    const own = auto({ senderHosted: true, imageUrls: ['https://img.shop.example/a.png', 'https://shop.example/b.png'] });
    expect(decideRemoteImages(shop, undefined, [], own)).toMatchObject({ load: true, reason: 'sender', allowedBy: 'shop.example' });
    const mixed = auto({ senderHosted: true, imageUrls: ['https://img.shop.example/a.png', 'https://tracker.example.com/pixel.gif'] });
    expect(decideRemoteImages(shop, undefined, [], mixed).load).toBe(false);
    expect(decideRemoteImages(shop, undefined, [], { ...own, senderHosted: false }).load).toBe(false);
  });

  it('never for a forged sender, and the user can still decide', async () => {
    const forged = await mail('Me <me@spazcat.test>', 'Authentication-Results: mx.spazcat.test; dmarc=fail header.from=spazcat.test\r\n');
    expect(decideRemoteImages(forged, undefined, [], auto({ ownDomains: ['spazcat.test'] }))).toMatchObject({ load: false, skipped: 'dmarc-fail' });
    expect(decideRemoteImages(forged, true, [], auto()).load).toBe(true);
    // The "always load from" list still comes first.
    expect(decideRemoteImages(await mail('N <n@news.example>'), undefined, ['news.example'], auto())).toMatchObject({ load: true, reason: 'list' });
  });
});

describe('12.1: images from everyone you know, or from all mail', () => {
  it('in all mail when switched on, but never for a forged sender', async () => {
    expect(decideRemoteImages(await mail('Stranger <x@example.net>'), undefined, [], auto({ everyone: true }))).toMatchObject({ load: true, reason: 'everyone' });
    const forged = await mail('Bank <a@bank.example>', 'Authentication-Results: mx.spazcat.test; dmarc=fail header.from=bank.example\r\n');
    expect(decideRemoteImages(forged, undefined, [], auto({ everyone: true })).load).toBe(false);
  });

  it('knows people you wrote to, people who wrote to you, and your contacts', async () => {
    const crypto = await import('node:crypto');
    const { Keyring } = await import('../src/crypto.js');
    const { Store } = await import('../src/db.js');
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const u = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
    const acc = store.createAccount(u.id, { name: 'W', displayName: 'S', email: 'sam@x.test', color: '#000000', imap: { host: 'i', port: 993, tls: 'tls', user: 'a', password: 'p' }, smtp: { host: 's', port: 465, tls: 'tls', user: 'a', password: 'p' }, appendSent: true } as never);
    store.rememberRecipients(u.id, [{ name: 'Wrote', address: 'Wrote@Example.org' }]);
    store.db.prepare("INSERT INTO address_book (user_id, account_id, address, name, sent, received, last_seen) VALUES (?, ?, 'heard@example.org', 'Heard', 0, 3, 1)").run(u.id, acc.id);
    store.db.prepare("INSERT INTO contacts (id, user_id, name, emails, phones, company, title, notes, updated_at) VALUES ('c', ?, 'C', '[\"Card@Example.org\"]', '[]', '', '', '', 1)").run(u.id);
    for (const known of ['wrote@example.org', 'HEARD@example.org', ' card@example.org ']) expect(store.isKnownAddress(u.id, known)).toBe(true);
    for (const stranger of ['', 'ard@example.org', 'card@example', 'c_rd@example.org', '%@example.org']) expect(store.isKnownAddress(u.id, stranger)).toBe(false);
  });
});
