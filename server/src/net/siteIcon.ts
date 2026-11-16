// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// A mail provider's own icon, for "Use Gmail's icon" in the mailbox icon picker. Nothing is bundled
// (providers' logos are their trademarks): the server reads the icons the provider's own web page
// lists (rel="icon" / "apple-touch-icon"), largest first, then the usual /apple-touch-icon.png and
// /favicon.ico. Like remote images, only public addresses are fetched, with size limits.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { parseDocument } from 'htmlparser2';
import { isPublicAddress, publicOnlyLookup } from './ssrf.js';
import { fetchRemoteImage, type RemoteImage } from './remoteImages.js';

const MAX_PAGE = 512 * 1024;
const MAX_ICON = 512 * 1024;

/** Where each provider's own icon is: the page whose icons show its mail product. */
const PROVIDER_PAGES: { domains: string[]; name: string; page: string }[] = [
  { domains: ['gmail.com', 'googlemail.com'], name: 'Gmail', page: 'https://www.google.com/gmail/about/' },
  { domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.de', 'hotmail.co.uk', 'live.co.uk'], name: 'Outlook', page: 'https://outlook.live.com/' },
  { domains: ['yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.de', 'yahoo.fr'], name: 'Yahoo Mail', page: 'https://mail.yahoo.com/' },
  { domains: ['aol.com'], name: 'AOL', page: 'https://mail.aol.com/' },
  { domains: ['icloud.com', 'me.com', 'mac.com'], name: 'iCloud', page: 'https://www.icloud.com/mail' },
  { domains: ['proton.me', 'protonmail.com', 'pm.me'], name: 'Proton Mail', page: 'https://proton.me/mail' },
  { domains: ['fastmail.com', 'fastmail.fm'], name: 'Fastmail', page: 'https://www.fastmail.com/' },
  { domains: ['zoho.com', 'zohomail.com', 'zohomail.eu'], name: 'Zoho Mail', page: 'https://www.zoho.com/mail/' },
  { domains: ['gmx.com', 'gmx.us', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'], name: 'GMX', page: 'https://www.gmx.com/' },
  { domains: ['yandex.com', 'yandex.ru', 'ya.ru'], name: 'Yandex Mail', page: 'https://mail.yandex.com/' },
];

/** The provider for an address: a known one, or the domain's own website. */
export function providerSite(email: string): { name: string; pages: string[] } | null {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  const known = PROVIDER_PAGES.find((p) => p.domains.includes(domain));
  if (known) return { name: known.name, pages: [known.page] };
  const name = domain.split('.').slice(-2, -1)[0] ?? domain;
  return { name: name.charAt(0).toUpperCase() + name.slice(1), pages: [`https://${domain}/`, `https://www.${domain}/`] };
}

type GetPage = (url: string) => Promise<{ html: string; url: string } | null>;

/** The HTML of a public page (following a few redirects), or null. */
const getPage: GetPage = (raw) =>
  new Promise((resolve) => {
    const go = (url: URL, hops: number) => {
      if (hops > 4 || !/^https?:$/.test(url.protocol) || !['', '80', '443'].includes(url.port)) return resolve(null);
      if (net.isIP(url.hostname) && !isPublicAddress(url.hostname)) return resolve(null);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.get(url, { lookup: publicOnlyLookup as never, timeout: 8000, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; DreyMail)' } }, (res) => {
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          return go(new URL(loc, url), hops + 1);
        }
        if (res.statusCode !== 200 || !/text\/html/i.test(String(res.headers['content-type'] ?? ''))) {
          res.resume();
          return resolve(null);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_PAGE) req.destroy();
          else chunks.push(c);
        });
        res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url: url.toString() }));
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    };
    try {
      go(new URL(raw), 0);
    } catch {
      resolve(null);
    }
  });

interface XNode {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: XNode[];
}

/** Icon links a page lists, best first: the biggest, apple-touch-icon over plain icons, no SVG. */
export function iconLinks(html: string, base: string): string[] {
  const doc = parseDocument(html.slice(0, MAX_PAGE)) as unknown as XNode;
  const found: { url: string; score: number }[] = [];
  const walk = (n: XNode) => {
    for (const c of n.children ?? []) {
      if (c.type === 'tag' && c.name === 'link' && c.attribs?.href) {
        const rel = (c.attribs.rel ?? '').toLowerCase().split(/\s+/);
        const type = (c.attribs.type ?? '').toLowerCase();
        if ((rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) && !rel.includes('mask-icon') && !type.includes('svg') && !/\.svg(\?|$)/i.test(c.attribs.href)) {
          const sizes = (c.attribs.sizes ?? '').match(/(\d+)x(\d+)/g)?.map((s) => Number(s.split('x')[0])) ?? [];
          const size = sizes.length ? Math.max(...sizes) : rel.some((r) => r.startsWith('apple-touch-icon')) ? 180 : 32;
          try {
            found.push({ url: new URL(c.attribs.href, base).toString(), score: Math.min(size, 512) + (rel.some((r) => r.startsWith('apple-touch-icon')) ? 1 : 0) });
          } catch {
            /* bad href */
          }
        }
      }
      walk(c);
    }
  };
  walk(doc);
  return [...new Set(found.sort((a, b) => b.score - a.score).map((f) => f.url))];
}

/** The provider's icon for this address, or null if none could be fetched. */
export async function providerIcon(email: string, deps: { getPage?: GetPage; fetchImage?: (url: string) => Promise<RemoteImage> } = {}): Promise<{ name: string; image: RemoteImage } | null> {
  const site = providerSite(email);
  if (!site) return null;
  const page = deps.getPage ?? getPage;
  const fetchImage = deps.fetchImage ?? ((url: string) => fetchRemoteImage(url, { maxBytes: MAX_ICON }));
  const candidates: string[] = [];
  for (const p of site.pages) {
    const got = await page(p);
    if (got) candidates.push(...iconLinks(got.html, got.url));
    const origin = new URL(got?.url ?? p).origin;
    candidates.push(`${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`);
    if (candidates.length > 2) break;
  }
  for (const url of [...new Set(candidates)].slice(0, 8)) {
    try {
      const image = await fetchImage(url);
      if (image.body.length > 0) return { name: site.name, image };
    } catch {
      /* next one */
    }
  }
  return null;
}
