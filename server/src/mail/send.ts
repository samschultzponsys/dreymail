// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-15: Outlook / Microsoft 365 accounts (Microsoft sign-in, Graph sending).
// Modified by samschultzponsys, 2026-11-15: Sign in with Google for Gmail.
// Modified by samschultzponsys, 2026-11-15: answers to calendar invitations (iTIP REPLY).
// Modified by samschultzponsys, 2026-11-16: sent mail carries its pictures as inline attachments.
// Modified by samschultzponsys, 2026-11-17: tells who a message was sent to (address suggestions).
// Modified by samschultzponsys, 2026-11-17: auto-replies.

import type { ComposePayload, DraftResult, SendResult } from '../../../shared/types.js';
import type { Store } from '../db.js';
import { createSmtpTransport, describeError, MailServerError } from '../imap/connect.js';
import type { MailService } from '../imap/mail.js';
import MailComposer from 'nodemailer/lib/mail-composer';
import { assertPublicHost } from '../net/ssrf.js';
import { attachmentBytes } from './parse.js';
import { buildRawMessage, isValidAddress, parseAddressList, type OutgoingAttachment } from './compose.js';

export class ComposeError extends Error {}

export class ComposeService {
  constructor(
    private readonly store: Store,
    private readonly mail: MailService,
    private readonly opts: {
      maxMessageBytes: number;
      blockPrivateHosts: boolean;
      /** Sends a complete MIME message through Microsoft Graph (Outlook / Microsoft 365 accounts). */
      graphSend?: (userId: string, accountId: string, raw: Buffer) => Promise<void>;
      /** OAuth access token for SMTP (Gmail signed in with Google). */
      smtpToken?: (userId: string, accountId: string) => Promise<string>;
      /** A message was sent from this mailbox to these people (address suggestions) (DreyMail). */
      onSent?: (userId: string, accountId: string, recipients: { name: string; address: string }[]) => void;
    },
  ) {}

  private async prepare(userId: string, p: ComposePayload, uploads: OutgoingAttachment[], requireRecipients: boolean) {
    const account = this.store.getAccountSecret(userId, p.accountId);
    if (!account) throw new ComposeError('Unknown sender account');
    const to = parseAddressList(p.to);
    const cc = parseAddressList(p.cc);
    const bcc = parseAddressList(p.bcc);
    const all = [...to, ...cc, ...bcc];
    const invalid = all.filter((a) => !isValidAddress(a.address));
    if (invalid.length) throw new ComposeError(`Invalid address: ${invalid.map((a) => a.address).join(', ')}`);
    if (requireRecipients && all.length === 0) throw new ComposeError('Add at least one recipient');

    const attachments = [...uploads];
    if (p.forwardFrom && p.forwardFrom.indices.length) {
      const original = await this.mail.getParsed(userId, p.forwardFrom, this.opts.maxMessageBytes);
      for (const i of p.forwardFrom.indices) {
        const a = original.attachments[i];
        if (!a) continue;
        attachments.push({
          filename: a.filename || `attachment-${i + 1}`,
          contentType: a.mimeType || 'application/octet-stream',
          content: attachmentBytes(a),
        });
      }
    }
    return {
      account,
      recipients: all,
      message: {
        from: { name: account.displayName, address: account.email },
        to,
        cc,
        bcc,
        subject: p.subject,
        html: p.html,
        inReplyTo: p.inReplyTo,
        references: p.references,
        attachments,
      },
    };
  }

  async send(userId: string, p: ComposePayload, uploads: OutgoingAttachment[]): Promise<SendResult> {
    const { account, recipients, message } = await this.prepare(userId, p, uploads, true);
    // Graph takes the recipients from the headers, so Outlook messages keep Bcc (Exchange strips it
    // from what recipients get); SMTP gets them in the envelope instead.
    const viaGraph = account.auth === 'microsoft';
    const { raw, messageId, envelope } = await buildRawMessage(message, { keepBcc: viaGraph, inlineImages: true });
    await this.deliver(userId, account, raw, envelope);

    // From here on the message is sent; failures are reported as warnings, not errors.
    const warnings: string[] = [];
    // Microsoft files Graph-sent mail in Sent itself.
    let savedToSent = viaGraph;
    if (account.appendSent) {
      try {
        const sent = await this.mail.specialFolder(userId, account.id, 'sent');
        if (sent) {
          await this.mail.append(userId, account.id, sent, raw, ['\\Seen']);
          savedToSent = true;
        } else warnings.push('No Sent folder found; the message was not saved.');
      } catch (err) {
        warnings.push(`Could not save to Sent: ${(err as Error).message}`);
      }
    }
    if (p.replaceDraft) await this.mail.deleteDraft(userId, p.replaceDraft).catch(() => undefined);
    if (p.answering) await this.mail.markAnswered(userId, p.answering);
    this.store.rememberRecipients(userId, recipients);
    try {
      this.opts.onSent?.(userId, account.id, recipients);
    } catch {
      /* suggestions are optional */
    }
    return { messageId, savedToSent, warning: warnings.join(' ') || null };
  }

  /** Hands a finished message to Microsoft Graph or the account's SMTP server. */
  private async deliver(userId: string, account: NonNullable<ReturnType<Store['getAccountSecret']>>, raw: Buffer, envelope: { from: string; to: string[] }) {
    if (account.auth === 'microsoft') {
      if (!this.opts.graphSend) throw new ComposeError('Outlook sending is not available on this server');
      try {
        await this.opts.graphSend(userId, account.id, raw);
      } catch (err) {
        throw new MailServerError((err as Error).message, 'protocol');
      }
    } else try {
      if (this.opts.blockPrivateHosts) await assertPublicHost(account.smtp.host);
      const accessToken = account.auth === 'google' && this.opts.smtpToken ? await this.opts.smtpToken(userId, account.id) : undefined;
      const transport = createSmtpTransport(account.smtp, accessToken);
      try {
        await transport.sendMail({ envelope, raw });
      } finally {
        transport.close();
      }
    } catch (err) {
      throw describeError(err, `SMTP ${account.smtp.host}`);
    }
  }

  /**
   * An auto-reply (out of office, …). Marked as one (RFC 3834 Auto-Submitted, and Microsoft's
   * X-Auto-Response-Suppress) so other auto-responders don't answer it, and not saved to Sent.
   */
  async sendAutoReply(userId: string, accountId: string, r: { to: string; subject: string; text: string; inReplyTo: string | null }): Promise<void> {
    const account = this.store.getAccountSecret(userId, accountId);
    if (!account) throw new ComposeError('Unknown sender account');
    if (!isValidAddress(r.to)) throw new ComposeError(`Invalid address: ${r.to}`);
    const ref = r.inReplyTo && /^<[^<>\s@]+@[^<>\s@]+>$/.test(r.inReplyTo) ? r.inReplyTo : undefined;
    const composer = new MailComposer({
      from: { name: account.displayName, address: account.email },
      to: r.to,
      subject: r.subject,
      text: r.text,
      inReplyTo: ref,
      references: ref ? [ref] : undefined,
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
      disableFileAccess: true,
      disableUrlAccess: true,
      xMailer: 'DreyMail',
    });
    const raw = await composer.compile().build();
    await this.deliver(userId, account, raw, { from: account.email, to: [r.to] });
  }

  /** Answers a calendar invitation: a short note with the iTIP REPLY the organizer's calendar reads. */
  async sendInvitationReply(userId: string, accountId: string, r: { to: string; subject: string; text: string; ics: string }): Promise<void> {
    const account = this.store.getAccountSecret(userId, accountId);
    if (!account) throw new ComposeError('Unknown sender account');
    if (!isValidAddress(r.to)) throw new ComposeError(`Invalid address: ${r.to}`);
    const composer = new MailComposer({
      from: { name: account.displayName, address: account.email },
      to: r.to,
      subject: r.subject,
      text: r.text,
      icalEvent: { method: 'REPLY', content: r.ics },
      disableFileAccess: true,
      disableUrlAccess: true,
      xMailer: 'DreyMail',
    });
    const mail = composer.compile();
    const raw = await mail.build();
    await this.deliver(userId, account, raw, { from: account.email, to: [r.to] });
  }

  async saveDraft(userId: string, p: ComposePayload, uploads: OutgoingAttachment[]): Promise<DraftResult> {
    const { account, message } = await this.prepare(userId, p, uploads, false);
    const { raw } = await buildRawMessage(message, { keepBcc: true });
    const drafts = await this.mail.specialFolder(userId, account.id, 'drafts');
    if (!drafts) throw new MailServerError('This account has no Drafts folder', 'protocol');
    const res = await this.mail.append(userId, account.id, drafts, raw, ['\\Draft', '\\Seen']);
    if (p.replaceDraft) await this.mail.deleteDraft(userId, p.replaceDraft).catch(() => undefined);
    const draft =
      res && res.uid && res.uidValidity
        ? { accountId: account.id, folder: drafts, uid: res.uid, uidValidity: res.uidValidity.toString() }
        : null;
    return { draft };
  }
}
