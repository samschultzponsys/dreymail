// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// What the assistant's rules can send or write (DreyMail 9.8): forwarding a message, a reply
// draft (saved in Drafts, never sent by itself), and an Outlook category.

import type { ComposePayload, MessageRef } from '../../../shared/types.js';
import type { Store } from '../db.js';
import type { MailService } from '../imap/mail.js';
import type { ComposeService } from '../mail/send.js';
import type { MicrosoftAuth } from '../oauth/microsoft.js';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${escape(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
const who = (a: { name?: string; address?: string } | undefined) => (a ? (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')) : '');

export function assistantOutgoing(deps: { store: Store; mail: MailService; compose: () => ComposeService; microsoft: MicrosoftAuth; maxMessageBytes: number }) {
  const parsed = (userId: string, ref: MessageRef) => deps.mail.getParsed(userId, ref, deps.maxMessageBytes);
  const base = (accountId: string): Omit<ComposePayload, 'to' | 'subject' | 'html'> => ({ accountId, cc: '', bcc: '', inReplyTo: null, references: [], forwardFrom: null, replaceDraft: null, answering: null });

  return {
    /** Forwards the message with its attachments, as other mail clients do. */
    async forward(userId: string, ref: MessageRef, to: string) {
      const e = await parsed(userId, ref);
      const head = ['---------- Forwarded message ----------', `From: ${who(e.from)}`, `Date: ${e.date ?? ''}`, `Subject: ${e.subject ?? ''}`, `To: ${(e.to ?? []).map(who).join(', ')}`]
        .map(escape)
        .join('<br>');
      const body = e.html ?? paragraphs(e.text ?? '');
      await deps.compose().send(
        userId,
        {
          ...base(ref.accountId),
          to,
          subject: /^fwd?:/i.test(e.subject ?? '') ? (e.subject ?? '') : `Fwd: ${e.subject ?? ''}`,
          html: `<p>${head}</p><br>${body}`,
          forwardFrom: { ...ref, indices: e.attachments.map((_, i) => i) },
        },
        [],
      );
    },

    /** A reply to the sender (or Reply-To) with `text`, and the original quoted, saved in Drafts. */
    async draftReply(userId: string, ref: MessageRef, text: string) {
      const e = await parsed(userId, ref);
      const to = who(e.replyTo?.[0] ?? e.from);
      if (!to) return;
      const subject = e.subject ?? '';
      const refs = (e.references ?? '').split(/\s+/).filter((x) => /^<[^>]+>$/.test(x));
      const quote = `<p>On ${escape(e.date ?? '')}, ${escape(who(e.from))} wrote:</p><blockquote>${paragraphs((e.text ?? '').slice(0, 20_000))}</blockquote>`;
      await deps.compose().saveDraft(
        userId,
        {
          ...base(ref.accountId),
          to,
          subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
          html: `${paragraphs(text)}<br>${quote}`,
          inReplyTo: e.messageId ?? null,
          references: e.messageId ? [...refs, e.messageId].slice(-20) : refs,
        },
        [],
      );
    },

    /** Outlook / Microsoft 365 mailboxes: an Outlook category. False for other mailboxes. */
    async category(userId: string, accountId: string, messageId: string, name: string) {
      const account = deps.store.listAccounts(userId).find((a) => a.id === accountId);
      if (account?.auth !== 'microsoft') return false;
      await deps.microsoft.addCategory(userId, accountId, messageId, name);
      return true;
    },
  };
}
