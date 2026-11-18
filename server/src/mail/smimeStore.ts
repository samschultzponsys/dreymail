// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// S/MIME certificates (DreyMail 10.6): your own per mailbox (from a .p12 / .pfx file; the key is
// sealed with the server's key), and other people's, kept from their signed mail so you can encrypt
// to them. Reading and sending use these.

import type { Store } from '../db.js';
import { encryptMessage, header, openMessage, readP12, signMessage, splitEntity, SmimeError, type SmimeInfo, type SmimeKey } from './smime.js';

export interface SmimeCertView {
  accountId: string;
  email: string;
  subject: string;
  notAfter: string;
}

const addressOf = (v: string) => (/<([^<>@\s]+@[^<>@\s]+)>/.exec(v)?.[1] ?? /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(v)?.[1] ?? '').toLowerCase();

export class SmimeStore {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  list(userId: string): SmimeCertView[] {
    return (this.db.prepare('SELECT account_id, email, subject, not_after FROM smime_keys WHERE user_id = ?').all(userId) as { account_id: string; email: string; subject: string; not_after: string }[]).map((r) => ({
      accountId: r.account_id,
      email: r.email,
      subject: r.subject,
      notAfter: r.not_after,
    }));
  }

  /** Imports a .p12 / .pfx for a mailbox. */
  save(userId: string, accountId: string, file: Buffer, password: string): SmimeCertView {
    if (!this.store.listAccounts(userId).some((a) => a.id === accountId)) throw new SmimeError('Mailbox not found');
    const k = readP12(file, password);
    const sealed = this.store.sealSecret(`smime:${userId}:${accountId}`, k.keyPem);
    this.db
      .prepare('INSERT INTO smime_keys (user_id, account_id, key_sealed, cert_pem, chain, email, subject, not_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, account_id) DO UPDATE SET key_sealed = excluded.key_sealed, cert_pem = excluded.cert_pem, chain = excluded.chain, email = excluded.email, subject = excluded.subject, not_after = excluded.not_after')
      .run(userId, accountId, sealed, k.certPem, JSON.stringify(k.chainPems), k.email, k.subject, k.notAfter, Date.now());
    return { accountId, email: k.email, subject: k.subject, notAfter: k.notAfter };
  }

  remove(userId: string, accountId: string) {
    this.db.prepare('DELETE FROM smime_keys WHERE user_id = ? AND account_id = ?').run(userId, accountId);
  }

  private keys(userId: string, accountId?: string): (SmimeKey & { accountId: string })[] {
    const rows = this.db.prepare(`SELECT * FROM smime_keys WHERE user_id = ?${accountId ? ' AND account_id = ?' : ''}`).all(...(accountId ? [userId, accountId] : [userId])) as Record<string, string>[];
    const out: (SmimeKey & { accountId: string })[] = [];
    for (const r of rows) {
      try {
        out.push({ accountId: r.account_id!, keyPem: this.store.openSecret(`smime:${userId}:${r.account_id}`, r.key_sealed!), certPem: r.cert_pem!, chainPems: JSON.parse(r.chain ?? '[]') as string[] });
      } catch {
        /* the server's key changed: import the file again */
      }
    }
    return out;
  }

  /** A received message as the reader shows it: decrypted (the mailbox's key first), its signature checked. */
  open(userId: string, accountId: string, raw: Buffer): { raw: Buffer; info: SmimeInfo } | null {
    const head = splitEntity(raw).head;
    const type = header(head, 'content-type').toLowerCase();
    if (!/pkcs7|multipart\/signed/.test(type)) return null;
    const keys = this.keys(userId);
    keys.sort((a, b) => Number(b.accountId === accountId) - Number(a.accountId === accountId));
    const from = addressOf(header(head, 'from'));
    const r = openMessage(raw, from, keys);
    if (!r) return null;
    // A valid signature from the sender's own certificate: keep it, to encrypt to them later.
    if (r.signerCert && r.info.valid && r.info.matchesSender && from)
      this.db.prepare('INSERT INTO smime_certs (user_id, email, cert_pem, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, email) DO UPDATE SET cert_pem = excluded.cert_pem, seen_at = excluded.seen_at').run(userId, from, r.signerCert, Date.now());
    return { raw: r.raw, info: r.info };
  }

  /** Recipients whose certificate DreyMail doesn't have (they can't get encrypted mail yet). */
  missing(userId: string, addresses: string[]): string[] {
    const own = new Set(this.list(userId).map((k) => k.email));
    return [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => !own.has(a) && !this.db.prepare('SELECT 1 FROM smime_certs WHERE user_id = ? AND email = ?').get(userId, a));
  }

  /** Signs and/or encrypts an outgoing message from this mailbox. */
  protect(userId: string, accountId: string, raw: Buffer, opts: { sign: boolean; encrypt: boolean; recipients: string[] }): Buffer {
    const key = this.keys(userId, accountId)[0];
    if (!key) throw new SmimeError('This mailbox has no S/MIME certificate (Settings → General → Signed and encrypted mail)');
    let out = opts.sign ? signMessage(raw, key) : raw;
    if (opts.encrypt) {
      const missing = this.missing(userId, opts.recipients);
      if (missing.length) throw new SmimeError(`Can't encrypt to ${missing.join(', ')}: DreyMail has no certificate for them yet (it keeps one when they send you signed mail)`);
      // Recipients that are your own mailboxes use those mailboxes' certificates.
      const ownCerts = new Map((this.db.prepare('SELECT email, cert_pem FROM smime_keys WHERE user_id = ?').all(userId) as { email: string; cert_pem: string }[]).map((r) => [r.email, r.cert_pem]));
      const certs = opts.recipients.map((a) => ownCerts.get(a.toLowerCase()) ?? (this.db.prepare('SELECT cert_pem FROM smime_certs WHERE user_id = ? AND email = ?').get(userId, a.toLowerCase()) as { cert_pem: string } | undefined)?.cert_pem ?? '');
      out = encryptMessage(out, [...certs.filter(Boolean), key.certPem]);
    }
    return out;
  }
}
