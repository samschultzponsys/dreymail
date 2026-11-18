// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// S/MIME (10.6): a certificate from a .p12, signing and checking, encrypting and decrypting,
// and noticing a changed message.

import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { encryptMessage, openMessage, readP12, signMessage } from '../src/mail/smime.js';

function makeP12(email: string, password: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: email.split('@')[0] }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 1, value: email }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

const MESSAGE = Buffer.from(
  'From: Sam <sam@example.com>\r\nTo: ada@example.com\r\nSubject: Contract\r\nMessage-ID: <x@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nPlease sign by Friday.\r\n',
);

describe('S/MIME', () => {
  const sam = readP12(makeP12('sam@example.com', 'pw'), 'pw');
  const ada = readP12(makeP12('ada@example.com', 'pw2'), 'pw2');

  it('reads a .p12 and refuses a wrong password', () => {
    expect(sam.email).toBe('sam@example.com');
    expect(() => readP12(makeP12('x@example.com', 'right'), 'wrong')).toThrow(/password/i);
  });

  it("signs, and the signature checks out (a self-made certificate isn't trusted)", () => {
    const signed = signMessage(MESSAGE, sam);
    expect(signed.toString()).toContain('multipart/signed');
    const r = openMessage(signed, 'sam@example.com', [])!;
    expect(r.info).toMatchObject({ signed: true, valid: true, matchesSender: true, trusted: false, signer: { email: 'sam@example.com' } });
    expect(r.raw.toString()).toContain('Please sign by Friday.');
    expect(r.signerCert).toContain('BEGIN CERTIFICATE');
    // From someone else's address: valid, but not theirs.
    expect(openMessage(signed, 'mallory@example.com', [])!.info.matchesSender).toBe(false);
  });

  it('notices a message changed after signing', () => {
    const tampered = Buffer.from(signMessage(MESSAGE, sam).toString().replace('Friday', 'Monday'));
    expect(openMessage(tampered, 'sam@example.com', [])!.info).toMatchObject({ signed: true, valid: false, problem: expect.stringMatching(/changed/) });
  });

  it('encrypts to the recipients and the sender, and only their keys open it', () => {
    const sealed = encryptMessage(signMessage(MESSAGE, sam), [ada.certPem, sam.certPem]);
    expect(sealed.toString()).toContain('enveloped-data');
    expect(sealed.toString()).not.toContain('Friday');
    // Ada opens it and sees Sam's valid signature inside.
    const r = openMessage(sealed, 'sam@example.com', [ada])!;
    expect(r.info).toMatchObject({ encrypted: true, signed: true, valid: true });
    expect(r.raw.toString()).toContain('Please sign by Friday.');
    expect(r.raw.toString()).toContain('Subject: Contract');
    // Without the right key it stays closed.
    const eve = readP12(makeP12('eve@example.com', 'e'), 'e');
    expect(openMessage(sealed, 'sam@example.com', [eve])!.info).toMatchObject({ encrypted: true, undecryptable: true });
  });

  it('leaves ordinary mail alone', () => {
    expect(openMessage(MESSAGE, 'sam@example.com', [sam])).toBeNull();
  });
});

describe('S/MIME certificates in DreyMail', () => {
  it('imports a .p12, keeps senders’ certificates from their signed mail, and encrypts to them', async () => {
    const crypto = await import('node:crypto');
    const { Keyring } = await import('../src/crypto.js');
    const { Store } = await import('../src/db.js');
    const { SmimeStore } = await import('../src/mail/smimeStore.js');
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const user = store.upsertUser('local', 'ada', '', 'Ada', 'ada');
    const acc = store.createAccount(user.id, { name: 'Ada', displayName: 'Ada', email: 'ada@example.com', color: '#22d3ee', imap: { host: 'i', port: 993, tls: 'tls', user: 'a', password: 'p' }, smtp: { host: 's', port: 465, tls: 'tls', user: 'a', password: 'p' }, appendSent: true } as never);
    const s = new SmimeStore(store);
    expect(s.save(user.id, acc.id, makeP12('ada@example.com', 'pw'), 'pw')).toMatchObject({ email: 'ada@example.com' });
    // Sam's signed mail arrives: checked, and Sam's certificate is kept.
    const sam = readP12(makeP12('sam@example.com', 'x'), 'x');
    const opened = s.open(user.id, acc.id, signMessage(MESSAGE, sam))!;
    expect(opened.info).toMatchObject({ signed: true, valid: true });
    expect(s.missing(user.id, ['sam@example.com', 'bob@example.com'])).toEqual(['bob@example.com']);
    // Ada can now send Sam encrypted, signed mail, and read her own copy.
    const reply = Buffer.from(MESSAGE.toString().replace('From: Sam <sam@example.com>', 'From: Ada <ada@example.com>').replace('To: ada@example.com', 'To: sam@example.com'));
    const out = s.protect(user.id, acc.id, reply, { sign: true, encrypt: true, recipients: ['sam@example.com'] });
    expect(out.toString()).toContain('enveloped-data');
    expect(s.open(user.id, acc.id, out)!.info).toMatchObject({ encrypted: true, signed: true, valid: true, matchesSender: true });
    expect(openMessage(out, 'ada@example.com', [sam])!.raw.toString()).toContain('Please sign by Friday.');
    expect(() => s.protect(user.id, acc.id, reply, { sign: false, encrypt: true, recipients: ['bob@example.com'] })).toThrow(/bob@example.com/);
  });
});
