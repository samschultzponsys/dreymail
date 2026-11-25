// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-16: emoji written as two halves (Outlook for iOS) show as one.
// Modified by samschultzponsys, 2026-11-25: remote image URLs found in one light pass instead of a whole sanitizing.

import { Parser } from 'htmlparser2';
import sanitizeHtml from 'sanitize-html';
import type { HtmlStyle } from '../../../shared/types.js';
import { fetchableImageUrl } from '../net/remoteImages.js';
import { countRules, sanitizeInlineStyle, sanitizeStylesheet } from './css.js';

/**
 * Email HTML sanitizer. Every message is treated as hostile.
 *
 * Defence in depth, outermost first:
 *  1. The browser renders the result in an <iframe sandbox> with neither allow-scripts nor
 *     allow-same-origin, plus a CSP that forbids scripts, forms, frames and every network
 *     request (images may only be data: URIs).
 *  2. This module removes everything that isn't plain formatting: scripts, event handlers, forms,
 *     frames, objects, SVG/MathML, meta/link/base, comments, javascript:/data: links, CSS
 *     expressions, @import, and any remote URL (img src, background, CSS url()).
 *  3. Remote images are only re-inserted on request, fetched by the server (SSRF-guarded) and
 *     inlined as data: URIs, so the sender never sees the reader's IP address or cookies.
 */

const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section',
  'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
];

const GLOBAL_ATTRS = ['style', 'class', 'dir', 'lang', 'title', 'align', 'valign', 'width', 'height', 'bgcolor'];

const ALLOWED_ATTRS: Record<string, string[]> = {
  '*': GLOBAL_ATTRS,
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'border', 'hspace', 'vspace'],
  font: ['color', 'face', 'size'],
  table: ['border', 'cellpadding', 'cellspacing', 'background', 'frame', 'rules', 'summary'],
  td: ['colspan', 'rowspan', 'background', 'nowrap', 'abbr', 'headers', 'scope'],
  th: ['colspan', 'rowspan', 'background', 'nowrap', 'abbr', 'headers', 'scope'],
  tr: ['background'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'type', 'reversed'],
  ul: ['type'],
  li: ['value', 'type'],
  blockquote: ['cite'],
  q: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  time: ['datetime'],
  hr: ['size', 'noshade', 'color'],
  div: ['background'],
  details: ['open'],
};

/** Elements whose text content must be dropped together with the element. */
const NON_TEXT_TAGS = [
  'script', 'style', 'textarea', 'option', 'noscript', 'title', 'template', 'xmp', 'noembed',
  'noframes', 'iframe', 'object', 'svg', 'math', 'head', 'select', 'button',
];

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
/** What the server-side image fetcher may produce (raster types only, never SVG). */
const SAFE_INLINED_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/;

export interface SanitizeOptions {
  /** Show remote images (inlined by the server) or strip them (false, default). */
  allowRemote: boolean;
  /**
   * Turn a remote http(s) URL into an inline data: URI fetched by the server, or null to drop it.
   * The result never contains a network URL, so the rendered message makes no requests at all.
   */
  resolveRemote: (url: string) => string | null;
  /** Resolve a cid: reference (without the "cid:" prefix) to a data: URL, or null. */
  resolveCid: (cid: string) => string | null;
}

export interface SanitizedHtml {
  /** Sanitized body markup. */
  html: string;
  /** Sanitized stylesheet collected from the message's <style> elements. */
  css: string;
  /** Number of remote resources not shown (blocked, or failed to load when allowed). */
  remoteBlocked: number;
  style: HtmlStyle;
}

/** Collect the raw contents of every <style> element, exactly as an HTML parser sees them. */
function extractStylesheets(html: string): string[] {
  const sheets: string[] = [];
  let depth = 0;
  let buf = '';
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === 'style') {
          depth++;
          buf = '';
        }
      },
      ontext(text) {
        if (depth > 0) buf += text;
      },
      onclosetag(name) {
        if (name === 'style' && depth > 0) {
          depth--;
          sheets.push(buf);
        }
      },
    },
    { decodeEntities: false, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  return sheets;
}

/**
 * Emoji written as two character references, one per UTF-16 half (`&#55357;&#56842;`, as Outlook
 * for iOS does): each half alone is shown as "�", so the pair becomes the one character it means.
 */
export function joinSurrogateReferences(html: string): string {
  const ref = '&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));';
  return html.replace(new RegExp(`${ref}${ref}`, 'g'), (whole, h1?: string, d1?: string, h2?: string, d2?: string) => {
    const hi = h1 ? Number.parseInt(h1, 16) : Number(d1);
    const lo = h2 ? Number.parseInt(h2, 16) : Number(d2);
    if (hi < 0xd800 || hi > 0xdbff || lo < 0xdc00 || lo > 0xdfff) return whole;
    return `&#${0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)};`;
  });
}

export function sanitizeEmailHtml(rawInput: string, opts: SanitizeOptions): SanitizedHtml {
  const input = joinSurrogateReferences(rawInput);
  let remoteBlocked = 0;
  let designSignals = 0;
  let images = 0;
  let tables = 0;

  const rewriteResourceUrl = (raw: string): string | null => {
    let src = raw.trim();
    if (src.startsWith('//')) src = `https:${src}`;
    if (/^cid:/i.test(src)) return opts.resolveCid(src.slice(4));
    if (SAFE_DATA_IMAGE.test(src)) return src.replace(/\s+/g, '');
    if (/^https?:\/\//i.test(src)) {
      const inlined = opts.allowRemote && fetchableImageUrl(src) ? opts.resolveRemote(src) : null;
      if (inlined && SAFE_INLINED_IMAGE.test(inlined)) return inlined;
      remoteBlocked++;
      return null;
    }
    return null;
  };

  const css = extractStylesheets(input)
    .map((sheet) => sanitizeStylesheet(sheet, rewriteResourceUrl))
    .filter(Boolean)
    .join('\n');
  if (countRules(css) >= 5) designSignals += 2;

  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    // URL attributes are validated in transformTags below; this is a second line of defence:
    // image sources and backgrounds can only ever be inline data: URIs, never network URLs.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['data'], table: ['data'], td: ['data'], th: ['data'], tr: ['data'], div: ['data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'background'],
    allowProtocolRelative: false,
    allowedStyles: undefined,
    parseStyleAttributes: false,
    nonTextTags: NON_TEXT_TAGS,
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: false,
    transformTags: {
      '*': (tagName, attribs) => {
        const out: Record<string, string> = { ...attribs };
        if (out.style !== undefined) {
          const style = sanitizeInlineStyle(out.style, rewriteResourceUrl);
          if (style) out.style = style;
          else delete out.style;
          if (/background/i.test(out.style ?? '')) designSignals++;
        }
        if (out.bgcolor !== undefined) designSignals++;
        if (out.background !== undefined) {
          const bg = rewriteResourceUrl(out.background);
          if (bg) out.background = bg;
          else delete out.background;
          designSignals++;
        }
        if (tagName === 'a') {
          const href = (out.href ?? '').trim();
          if (SAFE_LINK.test(href)) {
            out.href = href;
            out.target = '_blank';
            out.rel = 'noopener noreferrer nofollow';
          } else {
            delete out.href;
            delete out.target;
            delete out.rel;
          }
        }
        if (tagName === 'img') {
          images++;
          const src = out.src !== undefined ? rewriteResourceUrl(out.src) : null;
          if (src) out.src = src;
          else delete out.src;
        }
        if (tagName === 'table') {
          tables++;
          const w = Number.parseInt(out.width ?? '', 10);
          if (w >= 400 || (out.width ?? '').endsWith('%')) designSignals++;
        }
        return { tagName, attribs: out };
      },
    },
  });

  if (images >= 3) designSignals++;
  if (tables >= 2) designSignals++;
  const style: HtmlStyle = designSignals >= 3 ? 'designed' : 'simple';

  return { html, css, remoteBlocked, style };
}

/**
 * The remote image URLs a message would load if remote content were allowed (in img src,
 * background attributes and CSS url()), normalised exactly as the sanitizer will look them up.
 *
 * DreyMail 14.2: one light pass over the HTML instead of a whole sanitizing (which this used to
 * run, and throw away, before sanitizing again to show the message): every opening tag is seen
 * as the sanitizer sees it (same parser, same options), and only what can hold a URL is read.
 * `sanitizeRemoteUrlsReference` below is the old way, kept for the tests that prove both agree.
 */
export function collectRemoteImageUrls(rawHtml: string): string[] {
  const html = joinSurrogateReferences(rawHtml);
  const urls: string[] = [];
  const record = (raw: string): null => {
    let src = raw.trim();
    if (src.startsWith('//')) src = `https:${src}`;
    if (/^https?:\/\//i.test(src) && fetchableImageUrl(src)) urls.push(src);
    return null;
  };
  // CSS can only load something through url(), which escapes (a backslash) can hide.
  const mayHoldUrl = (css: string) => /url|\\/i.test(css);
  for (const sheet of extractStylesheets(html)) if (mayHoldUrl(sheet)) sanitizeStylesheet(sheet, record);
  // The sanitizer stops looking at tags inside a disallowed element whose text it drops (a
  // <noscript>, <svg>, <button>…) until that element ends; this follows the same rules
  // (sanitize-html 2.18's onopentag / onclosetag) so exactly the same tags are seen.
  const stack: string[] = [];
  let skipText = false;
  let skipTextDepth = 0;
  let skipRawText = false;
  let rawTextEnd: number | null = null;
  const updateRawTextRegion = () => {
    if (rawTextEnd !== null && parser.startIndex >= rawTextEnd) {
      rawTextEnd = null;
      skipRawText = false;
    }
  };
  const parser: Parser = new Parser(
    {
      onopentag(name, attribs) {
        updateRawTextRegion();
        if (skipRawText) return;
        if (skipText) {
          skipTextDepth++;
          return;
        }
        stack.push(name);
        if (attribs.style !== undefined && mayHoldUrl(attribs.style)) sanitizeInlineStyle(attribs.style, record);
        if (attribs.background !== undefined) record(attribs.background);
        if (name === 'img' && attribs.src !== undefined) record(attribs.src);
        if (!ALLOWED_TAGS.includes(name) && NON_TEXT_TAGS.includes(name)) {
          skipText = true;
          skipTextDepth = 1;
          if (name === 'noscript') {
            const end = /<\/noscript[\t\n\f\r />]/gi;
            end.lastIndex = parser.endIndex + 1;
            rawTextEnd = end.exec(html)?.index ?? Infinity;
          }
        }
      },
      onclosetag(name) {
        updateRawTextRegion();
        if (skipRawText) {
          if (stack.at(-1) !== name) return;
        } else if (skipText) {
          skipTextDepth--;
          if (skipTextDepth) return;
          skipText = false;
          if (rawTextEnd !== null) skipRawText = true;
        }
        const top = stack.pop();
        if (top === undefined) return;
        if (top !== name) {
          stack.push(top);
          return;
        }
        skipText = false;
      },
    },
    // What sanitize-html parses with.
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return [...new Set(urls)];
}

/** The remote image URLs found by sanitizing the whole message (before 14.2); tests compare against it. */
export function sanitizeRemoteUrlsReference(html: string): string[] {
  const urls: string[] = [];
  sanitizeEmailHtml(html, {
    allowRemote: true,
    resolveCid: () => null,
    resolveRemote: (u) => {
      urls.push(u);
      return null;
    },
  });
  return [...new Set(urls)];
}
