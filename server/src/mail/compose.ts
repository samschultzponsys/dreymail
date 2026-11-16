// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-16: table layout attributes kept (signatures made for Outlook).
// Modified by samschultzponsys, 2026-11-16: pictures inside the HTML sent as inline (cid:) attachments.

import crypto from 'node:crypto';
import { convert } from 'html-to-text';
import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import sanitizeHtml from 'sanitize-html';
import type { Address } from '../../../shared/types.js';

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMessage {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string[];
  attachments: OutgoingAttachment[];
}

const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

/** Parse a comma separated recipient field ("A <a@example.com>, b@example.com"). */
export function parseAddressList(input: string): Address[] {
  if (!input.trim()) return [];
  const out: Address[] = [];
  const visit = (entries: ReturnType<typeof addressparser>) => {
    for (const e of entries) {
      if ('group' in e && e.group) visit(e.group);
      else if ('address' in e && e.address) out.push({ name: e.name ?? '', address: e.address });
    }
  };
  visit(addressparser(input));
  return out;
}

export function isValidAddress(a: string): boolean {
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(a);
}

/**
 * The editor produces HTML in the user's browser; it is still sanitized before it is sent so that
 * nothing unexpected (scripts, remote references to this server, ...) ends up in outgoing mail.
 */
export function sanitizeOutgoingHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'img', 'li',
      'ol', 'p', 'pre', 's', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th',
      'thead', 'tr', 'u', 'ul', 'font', 'center',
    ],
    allowedAttributes: {
      '*': ['style', 'dir', 'align'],
      a: ['href', 'title'],
      img: ['src', 'alt', 'width', 'height', 'border'],
      font: ['color', 'face', 'size'],
      // Table layout, as signatures made for Outlook use it.
      table: ['cellpadding', 'cellspacing', 'border', 'width', 'bgcolor', 'role'],
      tr: ['valign', 'bgcolor'],
      td: ['colspan', 'rowspan', 'width', 'height', 'valign', 'bgcolor'],
      th: ['colspan', 'rowspan', 'width', 'height', 'valign', 'bgcolor'],
      blockquote: ['type', 'cite'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['data', 'https', 'http'] },
    allowProtocolRelative: false,
    // Relative URLs (for example the app's own image proxy) must never leave the server.
    exclusiveFilter: (frame) => frame.tag === 'img' && !/^(data:image\/|https?:)/i.test(frame.attribs.src ?? ''),
  });
}

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: 76,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'blockquote', format: 'blockquote' },
    ],
  });
}

/**
 * Pictures kept inside the HTML (data: URLs: pasted or imported, e.g. a signature's animated logo)
 * become inline attachments the HTML points at (cid:), which is what mail apps show: Gmail and
 * Outlook on the web don't show data: pictures. The same picture used twice is attached once.
 */
export function inlineDataImages(html: string): { html: string; images: { cid: string; filename: string; contentType: string; content: Buffer }[] } {
  const images = new Map<string, { cid: string; filename: string; contentType: string; content: Buffer }>();
  const out = html.replace(/(<img\b[^>]*?\bsrc=")data:(image\/(?:png|gif|jpeg|jpg|webp|bmp));base64,([A-Za-z0-9+/=\s]+)"/gi, (whole, start: string, type: string, b64: string) => {
    const content = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    if (content.length === 0) return whole;
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 24);
    let img = images.get(hash);
    if (!img) {
      const ext = type.split('/')[1]!.replace('jpeg', 'jpg');
      img = { cid: `${hash}@dreymail`, filename: `image${images.size + 1}.${ext}`, contentType: type.toLowerCase(), content };
      images.set(hash, img);
    }
    return `${start}cid:${img.cid}"`;
  });
  return { html: out, images: [...images.values()] };
}

/**
 * Build the raw RFC 5322 message. The same bytes are sent over SMTP and appended to Sent, so the
 * stored copy is exactly what recipients received. Drafts keep the Bcc header.
 */
export async function buildRawMessage(
  msg: OutgoingMessage,
  opts: { keepBcc: boolean; inlineImages?: boolean },
): Promise<{ raw: Buffer; messageId: string; envelope: { from: string; to: string[] } }> {
  // Sent mail gets its pictures as inline attachments; drafts keep them in the HTML, so the draft
  // opens again with them in the editor.
  const inlined = opts.inlineImages ? inlineDataImages(sanitizeOutgoingHtml(msg.html)) : { html: sanitizeOutgoingHtml(msg.html), images: [] };
  const html = inlined.html;
  const references = msg.references.filter((r) => MESSAGE_ID.test(r)).slice(-30);
  const inReplyTo = msg.inReplyTo && MESSAGE_ID.test(msg.inReplyTo) ? msg.inReplyTo : undefined;
  if (inReplyTo && !references.includes(inReplyTo)) references.push(inReplyTo);

  const composer = new MailComposer({
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject,
    inReplyTo,
    references: references.length ? references : undefined,
    html,
    text: htmlToPlainText(html),
    attachments: [
      ...msg.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content,
      })),
      ...inlined.images.map((i) => ({ filename: i.filename, contentType: i.contentType, content: i.content, cid: i.cid, contentDisposition: 'inline' as const })),
    ],
    // Never let message content reference local files or fetch URLs on the server.
    disableFileAccess: true,
    disableUrlAccess: true,
    xMailer: 'DreyMail',
  });
  const node = composer.compile();
  if (opts.keepBcc) (node as unknown as { keepBcc: boolean }).keepBcc = true;
  const envelope = node.getEnvelope();
  const raw = await node.build();
  return {
    raw,
    messageId: node.messageId(),
    envelope: { from: envelope.from || msg.from.address, to: envelope.to },
  };
}
