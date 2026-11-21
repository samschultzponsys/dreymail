// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-16: longer notification previews.
// Modified by samschultzponsys, 2026-11-21: HTML sent as text/plain.

import fs from 'node:fs';
import path from 'node:path';
import type { MessageStructureObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { buildMessageDetail, flattenAddresses, parseRaw, parseReferences } from '../src/mail/parse.js';
import { buildRawMessage, parseAddressList, sanitizeOutgoingHtml } from '../src/mail/compose.js';
import { findTextPart, hasAttachments, looksLikeHtml, snippetFromPart } from '../src/imap/snippet.js';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'mime', name));
const meta = { accountId: 'a1', folder: 'INBOX', uid: 42, uidValidity: '7', flags: new Set(['\\Seen']), internalDate: null };
const opts = { allowRemote: false, resolveRemote: () => null };

describe('MIME parsing', () => {
  it('parses headers, encoded words and addresses', async () => {
    const d = buildMessageDetail(await parseRaw(fixture('rich.eml')), meta, opts);
    expect(d.subject).toBe('Re: Räksmörgås 💡');
    expect(d.from).toEqual([{ name: 'Jörg Example', address: 'sender@example.com' }]);
    expect(d.to).toEqual([
      { name: 'Test User', address: 'user@example.com' },
      { name: 'Other, Person', address: 'other@example.org' },
    ]);
    expect(d.cc).toEqual([]);
    expect(d.messageId).toBe('<msg-2@example.com>');
    expect(d.inReplyTo).toBe('<msg-1@example.com>');
    expect(d.references).toEqual(['<msg-0@example.com>', '<msg-1@example.com>']);
    expect(d.date).toBe('2026-09-01T08:15:00.000Z');
    expect(d.seen).toBe(true);
  });

  it('decodes quoted-printable text and sanitizes the HTML part', async () => {
    const d = buildMessageDetail(await parseRaw(fixture('rich.eml')), meta, opts);
    expect(d.text).toContain('Räksmörgås is ready. This line is long enough that it gets soft-wrapped');
    expect(d.html).toContain('<b>Räksmörgås</b>');
    expect(d.html).not.toContain('onclick');
    expect(d.html).not.toContain('tracker.example.com');
    expect(d.remoteContentBlocked).toBe(1);
  });

  it('inlines cid: images and lists only real attachments', async () => {
    const d = buildMessageDetail(await parseRaw(fixture('rich.eml')), meta, opts);
    expect(d.html).toMatch(/src="data:image\/png;base64,iVBOR/);
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0]).toMatchObject({ filename: 'report.pdf', mimeType: 'application/pdf', index: 1, inline: false });
    expect(d.attachments[0]!.size).toBeGreaterThan(10);
  });

  it('decodes legacy charsets', async () => {
    const d = buildMessageDetail(await parseRaw(fixture('latin1.eml')), meta, opts);
    expect(d.text?.trim()).toBe('Grüße aus Köln');
    expect(d.html).toBeNull();
  });

  it('flattens address groups and parses references', () => {
    expect(
      flattenAddresses([{ name: 'Team', group: [{ name: 'A', address: 'a@example.com' }, { name: '', address: 'b@example.com' }] }]),
    ).toEqual([
      { name: 'A', address: 'a@example.com' },
      { name: '', address: 'b@example.com' },
    ]);
    expect(parseReferences('<a@example.com>\r\n <b@example.com> junk')).toEqual(['<a@example.com>', '<b@example.com>']);
  });
});

describe('snippets from BODYSTRUCTURE', () => {
  const structure: MessageStructureObject = {
    type: 'multipart/mixed',
    childNodes: [
      {
        type: 'multipart/alternative',
        part: '1',
        childNodes: [
          { type: 'text/html', part: '1.2', encoding: 'base64', parameters: { charset: 'utf-8' } },
          { type: 'text/plain', part: '1.1', encoding: 'quoted-printable', parameters: { charset: 'iso-8859-1' } },
        ],
      },
      { type: 'application/pdf', part: '2', disposition: 'attachment', dispositionParameters: { filename: 'x.pdf' } },
    ],
  };

  it('prefers text/plain and detects attachments', () => {
    expect(findTextPart(structure)).toEqual({ part: '1.1', type: 'text/plain', encoding: 'quoted-printable', charset: 'iso-8859-1' });
    expect(hasAttachments(structure)).toBe(true);
    expect(hasAttachments({ type: 'text/plain' })).toBe(false);
    expect(findTextPart({ type: 'text/plain' })?.part).toBe('1');
  });

  it('decodes truncated base64 html and quoted-printable latin-1, dropping quotes', () => {
    const html = Buffer.from('<html><head><style>p{color:red}</style></head><body><p>Hello <b>there</b> friend</p><p>more</p></body></html>').toString('base64');
    expect(snippetFromPart(Buffer.from(html.slice(0, 101)), { part: '1', type: 'text/html', encoding: 'base64', charset: 'utf-8' })).toMatch(/^Hello there/);
    const qp = Buffer.from('K=F6ln is nice=\r\n today\r\n> quoted reply\r\nbye =');
    expect(snippetFromPart(qp, { part: '1', type: 'text/plain', encoding: 'quoted-printable', charset: 'iso-8859-1' })).toBe('Köln is nice today bye =');
  });

  it('makes longer previews with paragraphs for notifications, up to the signature or quote', () => {
    const plain = { part: '1', type: 'text/plain' as const, encoding: '7bit', charset: 'utf-8' };
    const body = 'Hi Sam,\r\n\r\n\r\nThe RMA for Myrtle Beach is approved.   Ship it Monday.\r\n\r\nThanks!\r\n-- \r\nDustin\r\nOn Mon, Nov 16, 2026 at 9:00 AM Sam wrote:\r\n> old';
    expect(snippetFromPart(Buffer.from(body), plain, false, { length: 1000, keepLines: true })).toBe('Hi Sam,\n\nThe RMA for Myrtle Beach is approved. Ship it Monday.\n\nThanks!');
    const reply = 'Sounds good.\r\n\r\nOn Mon, Nov 16, 2026 at 9:00 AM Sam Schultz <s@example.com> wrote:\r\n> Can you check?';
    expect(snippetFromPart(Buffer.from(reply), plain, false, { length: 1000, keepLines: true })).toBe('Sounds good.');
    expect(snippetFromPart(Buffer.from('x'.repeat(5000)), plain, false, { length: 1000, keepLines: true })).toHaveLength(1000);
    // Emoji written in two halves (Outlook for iOS) come out whole in the snippet too.
    expect(snippetFromPart(Buffer.from('<p>Thank you &#55357;&#56842;</p>'), { part: '1', type: 'text/html', encoding: '7bit', charset: 'utf-8' })).toBe('Thank you 😊');
    // The list's snippet is unchanged: one line, short.
    expect(snippetFromPart(Buffer.from(body), plain)).toMatch(/^Hi Sam, The RMA/);
  });
});

describe('composing', () => {
  it('keeps the table layout of signatures made for Outlook', () => {
    const sig = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr><td width="67" height="67" valign="top"><img src="data:image/gif;base64,R0lGOD" width="67" height="67" border="0" onerror="x()"></td></tr></table>';
    const out = sanitizeOutgoingHtml(sig);
    expect(out).toContain('cellpadding="0" cellspacing="0" border="0"');
    expect(out).toContain('<td width="67" height="67" valign="top">');
    expect(out).toContain('src="data:image/gif;base64,R0lGOD" width="67" height="67" border="0"');
    expect(out).not.toContain('onerror');
  });

  it('parses recipient lists', () => {
    expect(parseAddressList('"Doe, Jane" <jane@example.com>, bob@example.com')).toEqual([
      { name: 'Doe, Jane', address: 'jane@example.com' },
      { name: '', address: 'bob@example.com' },
    ]);
    expect(parseAddressList('  ')).toEqual([]);
  });

  it('strips scripts and relative (server-internal) image URLs from outgoing HTML', () => {
    const out = sanitizeOutgoingHtml('<p>hi<script>x()</script></p><img src="/api/proxy/image?u=x"><img src="https://img.example.com/a.png">');
    expect(out).toBe('<p>hi</p><img src="https://img.example.com/a.png" />');
  });

  it('builds a multipart message with a plain-text alternative that parses back', async () => {
    const { raw, messageId, envelope } = await buildRawMessage(
      {
        from: { name: 'Test User', address: 'user@example.com' },
        to: [{ name: 'Jane', address: 'jane@example.com' }],
        cc: [],
        bcc: [{ name: '', address: 'secret@example.com' }],
        subject: 'Grüße',
        html: '<p>Hello <b>Jane</b></p><blockquote>older</blockquote>',
        inReplyTo: '<orig@example.com>',
        references: ['<root@example.com>'],
        attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('attached') }],
      },
      { keepBcc: false },
    );
    expect(envelope.to).toEqual(['jane@example.com', 'secret@example.com']);
    const parsed = await parseRaw(raw);
    expect(parsed.subject).toBe('Grüße');
    expect(parsed.text).toContain('Hello Jane');
    expect(parsed.html).toContain('<b>Jane</b>');
    expect(parsed.inReplyTo).toBe('<orig@example.com>');
    expect(parsed.references).toContain('<root@example.com>');
    expect(parsed.references).toContain('<orig@example.com>');
    expect(parsed.messageId).toBe(messageId);
    expect(parsed.bcc ?? []).toEqual([]);
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['notes.txt']);
  });

  it('sends pictures inside the HTML (a signature logo) as inline attachments; drafts keep them inside', async () => {
    const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
    const msg = {
      from: { name: '', address: 'user@example.com' },
      to: [{ name: '', address: 'jane@example.com' }],
      cc: [],
      bcc: [],
      subject: 'sig',
      html: `<p>Hi</p><img src="data:image/gif;base64,${gif.toString('base64')}" width="67"><img src="data:image/gif;base64,${gif.toString('base64')}">`,
      inReplyTo: null,
      references: [],
      attachments: [],
    };
    const sent = await parseRaw((await buildRawMessage(msg, { keepBcc: false, inlineImages: true })).raw);
    expect(sent.html).not.toContain('data:');
    const cids = [...String(sent.html).matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]);
    expect(cids).toHaveLength(2);
    expect(new Set(cids).size).toBe(1); // the same picture is attached once
    const inline = sent.attachments.filter((a) => a.contentId);
    expect(inline).toHaveLength(1);
    expect(inline[0]!.mimeType).toBe('image/gif');
    expect(Buffer.compare(Buffer.from(inline[0]!.content as ArrayBuffer), gif)).toBe(0);
    const draft = await parseRaw((await buildRawMessage(msg, { keepBcc: true })).raw);
    expect(draft.html).toContain('data:image/gif;base64,');
  });

  it('keeps Bcc in drafts', async () => {
    const { raw } = await buildRawMessage(
      {
        from: { name: '', address: 'user@example.com' },
        to: [],
        cc: [],
        bcc: [{ name: '', address: 'secret@example.com' }],
        subject: 'draft',
        html: '<p>wip</p>',
        inReplyTo: null,
        references: [],
        attachments: [],
      },
      { keepBcc: true },
    );
    expect((await parseRaw(raw)).bcc).toEqual([{ name: '', address: 'secret@example.com' }]);
  });
});

describe('HTML sent as text/plain (11.7)', () => {
  const plain = { part: '1', type: 'text/plain' as const, encoding: '7bit', charset: 'utf-8' };
  it('is read as HTML in previews, not shown as markup', () => {
    const raw = Buffer.from(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><title></title><style>img { max-width: 568px; }</style></head><body contentEditable="false"><p>Your ticket has been updated.</p><p>Status: Open</p></body></html>',
    );
    const s = snippetFromPart(raw, plain, false, { length: 500, keepLines: true });
    expect(s).not.toContain('<');
    expect(s).not.toContain('max-width');
    expect(s).toContain('Your ticket has been updated.');
    expect(snippetFromPart(raw, plain)).toBe('Your ticket has been updated. Status: Open');
  });
  it('leaves plain text that mentions a tag alone', () => {
    expect(looksLikeHtml('Use the <br> tag for a line break.')).toBe(false);
    expect(snippetFromPart(Buffer.from('Use the <br> tag for a line break.'), plain)).toBe('Use the <br> tag for a line break.');
  });
});

describe('opening a message whose text/plain part is HTML (11.7)', () => {
  it('shows it as (sanitized) HTML, with a plain-text version for replies', async () => {
    const raw = Buffer.from(
      'From: Support <help@example.com>\r\nTo: sam@example.com\r\nSubject: Ticket updated\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>Your ticket has been updated.</p><script>alert(1)</script></body></html>\r\n',
    );
    const email = await parseRaw(raw);
    const d = buildMessageDetail(email, meta, opts);
    expect(d.html).toContain('Your ticket has been updated.');
    expect(d.html).not.toContain('<script');
    expect(d.text).toContain('Your ticket has been updated.');
    expect(d.text).not.toContain('<');
  });
});
