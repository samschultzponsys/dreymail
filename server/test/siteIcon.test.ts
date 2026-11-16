// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { iconLinks, PROVIDER_CHOICES, providerByKey, providerIcon, providerSite } from '../src/net/siteIcon.js';

describe("a mail provider's own icon", () => {
  it('knows the big providers, and uses the domain itself otherwise', () => {
    expect(providerSite('a@gmail.com')).toEqual({ name: 'Gmail', pages: ['https://www.google.com/gmail/about/'] });
    expect(providerSite('a@hotmail.com')?.name).toBe('Outlook / Hotmail');
    expect(providerSite('a@msn.com')?.name).toBe('MSN');
    expect(providerSite('a@purelymail.com')).toEqual({ name: 'Purelymail', pages: ['https://purelymail.com/', 'https://www.purelymail.com/'] });
    expect(providerSite('not an address')).toBeNull();
    expect(providerSite('a@localhost')).toBeNull();
  });

  it('offers a list of providers to pick from, whatever the address', () => {
    expect(PROVIDER_CHOICES.map((p) => p.name)).toEqual(expect.arrayContaining(['Gmail', 'Outlook / Hotmail', 'MSN', 'Yahoo Mail', 'AOL', 'Purelymail', 'Microsoft 365']));
    expect(new Set(PROVIDER_CHOICES.map((p) => p.key)).size).toBe(PROVIDER_CHOICES.length);
    expect(providerByKey('purelymail')).toEqual({ name: 'Purelymail', pages: ['https://purelymail.com/'] });
    expect(providerByKey('nope')).toBeNull();
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

  it('asks the public favicon services when the site turns servers away', async () => {
    const tried: string[] = [];
    const found = await providerIcon('x@ponsys.com', {
      getPage: async () => null, // blocked
      fetchImage: async (url) => {
        tried.push(url);
        if (!url.startsWith('https://www.google.com/s2/favicons')) throw new Error('403');
        return { contentType: 'image/png', body: Buffer.from([1, 2, 3]) };
      },
    });
    expect(found).not.toBeNull();
    expect(tried.at(-1)).toBe('https://www.google.com/s2/favicons?domain=ponsys.com&sz=128');
    expect(tried).toContain('https://ponsys.com/favicon.ico');
    // A provider from the list: its own site's domain.
    const ms = await providerIcon('', { getPage: async () => null, fetchImage: async (url) => { if (!url.includes('s2/favicons')) throw new Error('no'); return { contentType: 'image/png', body: Buffer.from([1]) }; } }, providerByKey('microsoft-365'));
    expect(ms?.name).toBe('Microsoft 365');
  });
});
