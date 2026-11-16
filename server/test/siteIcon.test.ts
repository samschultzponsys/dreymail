// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { iconLinks, providerIcon, providerSite } from '../src/net/siteIcon.js';

describe("a mail provider's own icon", () => {
  it('knows the big providers, and uses the domain itself otherwise', () => {
    expect(providerSite('a@gmail.com')).toEqual({ name: 'Gmail', pages: ['https://www.google.com/gmail/about/'] });
    expect(providerSite('a@hotmail.com')?.name).toBe('Outlook');
    expect(providerSite('a@msn.com')?.name).toBe('Outlook');
    expect(providerSite('a@purelymail.com')).toEqual({ name: 'Purelymail', pages: ['https://purelymail.com/', 'https://www.purelymail.com/'] });
    expect(providerSite('not an address')).toBeNull();
    expect(providerSite('a@localhost')).toBeNull();
  });

  it('picks the biggest icon a page lists, never SVG or mask icons', () => {
    const html = `<html><head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">
      <link rel="icon" href="/icon-192.png" sizes="192x192">
    </head></html>`;
    expect(iconLinks(html, 'https://mail.example.com/inbox')).toEqual(['https://mail.example.com/icon-192.png', 'https://cdn.example.com/touch.png', 'https://mail.example.com/favicon-16.png']);
  });

  it('fetches the best one that works, falling back to the usual places', async () => {
    const tried: string[] = [];
    const found = await providerIcon('sam@purelymail.com', {
      getPage: async (url) => (url === 'https://purelymail.com/' ? { html: '<link rel="icon" href="/broken.png" sizes="64x64">', url } : null),
      fetchImage: async (url) => {
        tried.push(url);
        if (url.endsWith('/broken.png')) throw new Error('404');
        return { contentType: 'image/png', body: Buffer.from([1, 2, 3]) };
      },
    });
    expect(found?.name).toBe('Purelymail');
    expect(tried).toEqual(['https://purelymail.com/broken.png', 'https://purelymail.com/apple-touch-icon.png']);
    expect(await providerIcon('sam@nowhere.example', { getPage: async () => null, fetchImage: async () => Promise.reject(new Error('no')) })).toBeNull();
  });
});
