// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// S/MIME (RFC 8551) for DreyMail 10.6: signed mail is checked (the signature over the exact bytes,
// the signer's certificate, its chain to a public root, and that it belongs to the sender); mail
// encrypted to you is decrypted with your certificate's key; mail you send can be signed and
// encrypted. Certificates come as a .p12 / .pfx file per mailbox. RSA keys (what S/MIME
// certificates use); node-forge does the PKCS #7 work.

import tls from 'node:tls';
import forge from 'node-forge';

export class SmimeError extends Error {}

export interface SmimeKey {
  keyPem: string;
  certPem: string;
  /** Intermediate certificates sent along with signatures. */
  chainPems: string[];
}

/** What the reader says about a message's S/MIME. */
export interface SmimeInfo {
  encrypted: boolean;
  /** Encrypted but no key here could open it. */
  undecryptable?: boolean;
  signed: boolean;
  /** The signature matches the message (nothing was changed). */
  valid?: boolean;
  /** The signer's certificate chains to a public root and is in date. */
  trusted?: boolean;
  /** The certificate is for the sender's address. */
  matchesSender?: boolean;
  signer?: { email: string; name: string; issuer: string };
  /** Why it isn't valid or trusted. */
  problem?: string;
}

// ---- MIME helpers -----------------------------------------------------------------------------

/** Header block (unfolded lines kept as written) and body of a MIME entity. */
export function splitEntity(raw: Buffer): { head: string; body: Buffer } {
  const s = raw.toString('latin1');
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: s, body: Buffer.alloc(0) };
  return { head: s.slice(0, m.index), body: raw.subarray(m.index + m[0].length) };
}

export function header(head: string, name: string): string {
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  return new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded)?.[1]?.trim() ?? '';
}

const param = (value: string, name: string) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(value)?.slice(1).find((x) => x !== undefined) ?? '';
const crlf = (b: Buffer) => Buffer.from(b.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');

/** The parts of a multipart body, as exact bytes (between the boundary lines). */
export function multipartParts(body: Buffer, boundary: string): Buffer[] {
  const s = body.toString('latin1');
  const marker = `--${boundary}`;
  const out: Buffer[] = [];
  let i = s.indexOf(marker);
  while (i >= 0) {
    let start = i + marker.length;
    if (s.startsWith('--', start)) break;
    start = s.indexOf('\n', start) + 1;
    if (start <= 0) break;
    const next = s.indexOf(`\n${marker}`, start);
    if (next < 0) break;
    const end = s[next - 1] === '\r' ? next - 1 : next;
    out.push(Buffer.from(s.slice(start, end), 'latin1'));
    i = next + 1;
  }
  return out;
}

/** Headers of the message itself (From, To, Subject…), without the ones about its content. */
function messageHeaders(head: string): string {
  const lines = head.split(/\r?\n(?![ \t])/);
  return lines.filter((l) => !/^(content-[a-z-]+|mime-version):/i.test(l)).join('\r\n');
}

const b64lines = (der: string) => (forge.util.encode64(der).match(/.{1,76}/g) ?? []).join('\r\n');

// ---- certificates ----------------------------------------------------------------------------

/** A .p12 / .pfx file: the key, its certificate and the chain. Throws a readable error. */
export function readP12(file: Buffer, password: string): SmimeKey & { email: string; notAfter: string; subject: string } {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(file.toString('binary')), password);
  } catch (err) {
    throw new SmimeError(/mac|password|Invalid/i.test((err as Error).message) ? 'Wrong password for this certificate file' : 'This is not a .p12 / .pfx certificate file');
  }
  const keyBag = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag! })[forge.pki.oids.pkcs8ShroudedKeyBag!] ?? []), ...(p12.getBags({ bagType: forge.pki.oids.keyBag! })[forge.pki.oids.keyBag!] ?? [])][0];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag! })[forge.pki.oids.certBag!] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  if (!keyBag?.key) throw new SmimeError('The file has no private key (export it with its key)');
  const key = keyBag.key as forge.pki.rsa.PrivateKey;
  // The certificate whose public key is this key's.
  const own = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n));
  if (!own) throw new SmimeError("The file's certificate doesn't match its key (only RSA S/MIME certificates are supported)");
  return {
    keyPem: forge.pki.privateKeyToPem(key),
    certPem: forge.pki.certificateToPem(own),
    chainPems: certs.filter((c) => c !== own).map((c) => forge.pki.certificateToPem(c)),
    email: emailsOf(own)[0] ?? '',
    notAfter: own.validity.notAfter.toISOString(),
    subject: String(own.subject.getField('CN')?.value ?? ''),
  };
}

/** The addresses a certificate is for (subjectAltName rfc822Name, else the subject's emailAddress). */
export function emailsOf(cert: forge.pki.Certificate): string[] {
  const out: string[] = [];
  const san = cert.getExtension('subjectAltName') as { altNames?: { type: number; value: string }[] } | null;
  for (const n of san?.altNames ?? []) if (n.type === 1) out.push(n.value.toLowerCase());
  const e = cert.subject.getField('E') ?? cert.subject.getField({ name: 'emailAddress' } as never);
  if (e?.value) out.push(String(e.value).toLowerCase());
  return [...new Set(out)];
}

let roots: forge.pki.CAStore | null = null;
/** Public root certificates (Node's list; RSA ones, as forge reads them). */
function rootStore(): forge.pki.CAStore {
  if (roots) return roots;
  const store = forge.pki.createCaStore([]);
  for (const pem of tls.rootCertificates) {
    try {
      store.addCertificate(forge.pki.certificateFromPem(pem));
    } catch {
      /* not RSA: forge can't read it */
    }
  }
  return (roots = store);
}

// ---- reading -----------------------------------------------------------------------------------

/**
 * Opens a message: decrypts it if it is encrypted and one of `keys` opens it, and checks its
 * signature. Returns the readable message (what the reader shows) and what was found, or null
 * when the message isn't S/MIME.
 */
export function openMessage(raw: Buffer, from: string, keys: SmimeKey[]): { raw: Buffer; info: SmimeInfo; signerCert?: string } | null {
  let { head, body } = splitEntity(raw);
  let type = header(head, 'content-type').toLowerCase();
  const info: SmimeInfo = { encrypted: false, signed: false };
  let current = raw;
  // Encrypted (enveloped-data).
  if (/application\/(x-)?pkcs7-mime/.test(type) && /smime-type\s*=\s*"?enveloped-data/.test(type)) {
    info.encrypted = true;
    const inner = decrypt(body, keys);
    if (!inner) return { raw, info: { ...info, undecryptable: true } };
    current = Buffer.concat([Buffer.from(`${messageHeaders(head)}\r\n`, 'latin1'), crlf(inner)]);
    ({ head, body } = splitEntity(current));
    type = header(head, 'content-type').toLowerCase();
  }
  let signerCert: string | undefined;
  if (/multipart\/signed/.test(type) && /pkcs7-signature/.test(type)) {
    const parts = multipartParts(body, param(header(head, 'content-type'), 'boundary'));
    if (parts.length >= 2) {
      const sig = splitEntity(parts[1]!);
      const r = verifyDetached(crlf(parts[0]!), Buffer.from(sig.body.toString('latin1').replace(/\s+/g, ''), 'base64'), from);
      Object.assign(info, r.info);
      signerCert = r.cert;
      // Shown as the signed part (the signature isn't an attachment to look at).
      current = Buffer.concat([Buffer.from(`${messageHeaders(head)}\r\n`, 'latin1'), parts[0]!]);
    }
  } else if (/application\/(x-)?pkcs7-mime/.test(type) && /signed-data/.test(type)) {
    // Opaque signed: the content is inside the signature.
    const r = verifyOpaque(Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64'), from);
    Object.assign(info, r.info);
    signerCert = r.cert;
    if (r.content) current = Buffer.concat([Buffer.from(`${messageHeaders(head)}\r\n`, 'latin1'), crlf(r.content)]);
  }
  if (!info.encrypted && !info.signed) return null;
  return { raw: current, info, signerCert };
}

function decrypt(body: Buffer, keys: SmimeKey[]): Buffer | null {
  let p7: forge.pkcs7.PkcsEnvelopedData;
  try {
    p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64').toString('binary'))) as forge.pkcs7.PkcsEnvelopedData;
  } catch {
    return null;
  }
  for (const k of keys) {
    try {
      const cert = forge.pki.certificateFromPem(k.certPem);
      const recipient = p7.findRecipient(cert);
      if (!recipient) continue;
      p7.decrypt(recipient, forge.pki.privateKeyFromPem(k.keyPem) as forge.pki.rsa.PrivateKey);
      return Buffer.from((p7.content as forge.util.ByteStringBuffer).getBytes(), 'binary');
    } catch {
      /* try the next key */
    }
  }
  return null;
}

interface Capture {
  certificates?: forge.asn1.Asn1[];
  authenticatedAttributes?: forge.asn1.Asn1[];
  signature?: string;
  digestAlgorithm?: string;
  content?: forge.asn1.Asn1;
}

/** Signature, certificates and signed attributes of a SignedData (forge doesn't verify on its own). */
function readSignedData(der: Buffer): { capture: Capture; certs: forge.pki.Certificate[] } {
  const asn1 = forge.asn1.fromDer(der.toString('binary'));
  const msg = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData & { rawCapture?: Capture };
  return { capture: msg.rawCapture ?? {}, certs: msg.certificates ?? [] };
}

const DIGESTS: Record<string, () => forge.md.MessageDigest> = {
  [forge.pki.oids.sha256!]: () => forge.md.sha256.create(),
  [forge.pki.oids.sha384!]: () => forge.md.sha384.create(),
  [forge.pki.oids.sha512!]: () => forge.md.sha512.create(),
  [forge.pki.oids.sha1!]: () => forge.md.sha1.create(),
};

function check(content: Buffer, capture: Capture, certs: forge.pki.Certificate[], from: string): { info: Partial<SmimeInfo>; cert?: string } {
  const algOid = capture.digestAlgorithm ? forge.asn1.derToOid(capture.digestAlgorithm) : '';
  const md = DIGESTS[algOid];
  if (!md || !capture.signature) return { info: { signed: true, valid: false, problem: 'The signature uses a method DreyMail can’t check' } };
  const contentDigest = md().update(content.toString('binary')).digest().getBytes();
  let signedBytes = content.toString('binary');
  if (capture.authenticatedAttributes?.length) {
    // The signature covers the signed attributes; one of them is the content's digest.
    const digestAttr = capture.authenticatedAttributes.find((a) => forge.asn1.derToOid((a.value as forge.asn1.Asn1[])[0]!.value as string) === forge.pki.oids.messageDigest);
    const said = digestAttr ? (((digestAttr.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[])[0]!.value as string) : null;
    if (said !== contentDigest) return { info: { signed: true, valid: false, problem: 'The message was changed after it was signed' } };
    signedBytes = forge.asn1.toDer(forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, capture.authenticatedAttributes)).getBytes();
  }
  const digest = md().update(signedBytes).digest().getBytes();
  const signer = certs.find((c) => {
    try {
      return (c.publicKey as forge.pki.rsa.PublicKey).verify(digest, capture.signature!);
    } catch {
      return false;
    }
  });
  if (!signer) return { info: { signed: true, valid: false, problem: certs.length ? 'The signature doesn’t match the message' : 'The signature came without its certificate' } };
  const emails = emailsOf(signer);
  const info: Partial<SmimeInfo> = {
    signed: true,
    valid: true,
    signer: { email: emails[0] ?? '', name: String(signer.subject.getField('CN')?.value ?? ''), issuer: String(signer.issuer.getField('CN')?.value ?? signer.issuer.getField('O')?.value ?? '') },
    matchesSender: !!from && emails.includes(from.toLowerCase()),
  };
  const now = new Date();
  if (now < signer.validity.notBefore || now > signer.validity.notAfter) {
    info.trusted = false;
    info.problem = 'The signer’s certificate has expired or isn’t valid yet';
  } else {
    try {
      forge.pki.verifyCertificateChain(rootStore(), [signer, ...certs.filter((c) => c !== signer)]);
      info.trusted = true;
    } catch {
      info.trusted = false;
      info.problem = 'The signer’s certificate isn’t from an authority DreyMail knows';
    }
  }
  if (info.valid && !info.matchesSender) info.problem = info.problem ?? 'The certificate is for another address than the sender’s';
  return { info, cert: forge.pki.certificateToPem(signer) };
}

function verifyDetached(content: Buffer, signature: Buffer, from: string): { info: Partial<SmimeInfo>; cert?: string } {
  try {
    const { capture, certs } = readSignedData(signature);
    return check(content, capture, certs, from);
  } catch {
    return { info: { signed: true, valid: false, problem: 'The signature can’t be read' } };
  }
}

function verifyOpaque(der: Buffer, from: string): { info: Partial<SmimeInfo>; cert?: string; content?: Buffer } {
  try {
    const { capture, certs } = readSignedData(der);
    const c = capture.content;
    // The content is an OCTET STRING (possibly in pieces) inside [0].
    const octets = c ? flattenOctets(c) : '';
    const content = Buffer.from(octets, 'binary');
    return { ...check(content, capture, certs, from), content };
  } catch {
    return { info: { signed: true, valid: false, problem: 'The signature can’t be read' } };
  }
}
function flattenOctets(n: forge.asn1.Asn1): string {
  if (typeof n.value === 'string') return n.value;
  return (n.value as forge.asn1.Asn1[]).map(flattenOctets).join('');
}

// ---- sending -----------------------------------------------------------------------------------

/** The message's content as its own MIME entity (its Content-* headers and body). */
function contentEntity(head: string, body: Buffer): Buffer {
  const lines = head.split(/\r?\n(?![ \t])/).filter((l) => /^content-[a-z-]+:/i.test(l));
  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), crlf(body)]);
}

/** Signs a whole message (multipart/signed, detached, SHA-256). */
export function signMessage(raw: Buffer, key: SmimeKey): Buffer {
  const { head, body } = splitEntity(raw);
  const entity = contentEntity(head, body);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(entity.toString('binary'));
  const cert = forge.pki.certificateFromPem(key.certPem);
  p7.addCertificate(cert);
  for (const c of key.chainPems) p7.addCertificate(forge.pki.certificateFromPem(c));
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(key.keyPem) as forge.pki.rsa.PrivateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [{ type: forge.pki.oids.contentType!, value: forge.pki.oids.data! }, { type: forge.pki.oids.messageDigest! }, { type: forge.pki.oids.signingTime!, value: new Date() as never }],
  });
  p7.sign({ detached: true });
  const sig = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const boundary = `----dm-signed-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return Buffer.concat([
    Buffer.from(`${messageHeaders(head)}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="${boundary}"\r\n\r\nThis is a signed message.\r\n--${boundary}\r\n`, 'latin1'),
    entity,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/pkcs7-signature; name="smime.p7s"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="smime.p7s"\r\n\r\n${b64lines(sig)}\r\n--${boundary}--\r\n`, 'latin1'),
  ]);
}

/** Encrypts a whole message to these certificates (AES-256-CBC). Include the sender's own, to read it in Sent. */
export function encryptMessage(raw: Buffer, certPems: string[]): Buffer {
  const { head, body } = splitEntity(raw);
  const entity = contentEntity(head, body);
  const p7 = forge.pkcs7.createEnvelopedData();
  for (const pem of certPems) p7.addRecipient(forge.pki.certificateFromPem(pem));
  p7.content = forge.util.createBuffer(entity.toString('binary'));
  p7.encrypt(undefined, forge.pki.oids['aes256-CBC']);
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(
    `${messageHeaders(head)}\r\nMIME-Version: 1.0\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="smime.p7m"\r\n\r\n${b64lines(der)}\r\n`,
    'latin1',
  );
}
