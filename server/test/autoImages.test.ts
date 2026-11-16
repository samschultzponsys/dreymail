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
