// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-16: automatic image loading for your own domains, people you
// write to, and images on the sender's own domain.
// Modified by samschultzponsys, 2026-11-21: images from everyone you know, or from all mail (not Junk).
// Modified by samschultzponsys, 2026-11-25: known senders looked up one address at a time.

import { domainToASCII, domainToUnicode } from 'node:url';
import type { DomainName } from '../../../shared/types.js';
import { organisationDomain } from '../net/avatars.js';
import { flattenAddresses, type ParsedEmail } from './parse.js';

/**
 * Per-user "always load images from this sender domain". The decision is made on the server
 * when a message is fetched; loading itself reuses the normal server-side image inlining.
 */

export const MAX_ALLOWED_DOMAINS = 500;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Normalise a domain to its lowercase ASCII (punycode) form, or null if it isn't a plausible
 * host name. Accepts a pasted address ("news@example.com"), a leading "@" or "*.", and a
 * trailing dot. Unicode and punycode spellings of the same domain normalise identically.
 */
export function normaliseDomain(input: string): string | null {
  let s = input.trim();
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  s = s.replace(/^\*\./, '').replace(/\.$/, '');
  if (!s || s.length > 253) return null;
  const ascii = domainToASCII(s).replace(/\.$/, '');
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  // A numeric TLD means an IP address, not a domain.
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return ascii;
}

export function displayDomain(ascii: string): DomainName {
  return { domain: ascii, display: domainToUnicode(ascii) || ascii };
}

/** True if `domain` is `allowed` or one of its subdomains. Both must already be normalised. */
export function domainMatches(domain: string, allowed: string): boolean {
  return domain === allowed || domain.endsWith(`.${allowed}`);
}

/** The most specific allowlist entry covering `domain`, if any. */
export function findAllowedDomain(domain: string, allowlist: readonly string[]): string | null {
  let best: string | null = null;
  for (const a of allowlist) if (domainMatches(domain, a) && (!best || a.length > best.length)) best = a;
  return best;
}

/** Normalised domain of the (first) From address. */
export function senderDomain(email: ParsedEmail): string | null {
  const from = flattenAddresses(email.from)[0]?.address ?? '';
  const at = from.lastIndexOf('@');
  return at < 0 ? null : normaliseDomain(from.slice(at + 1));
}

/**
 * Did the receiving server record a DMARC failure for the From domain? Only the topmost
 * Authentication-Results header counts: it was added by the server that delivered the message to
 * us; anything below it may have come from the sender. A result with a header.from for some
 * other domain is ignored; one without header.from is taken to be about the From domain.
 */
export function dmarcFailed(email: ParsedEmail, fromDomain: string): boolean {
  const top = email.headers.find((h) => h.key === 'authentication-results');
  if (!top) return false;
  // Drop RFC 5322 comments, e.g. "dmarc=fail (p=reject dis=none)".
  let value = top.value;
  for (let prev = ''; prev !== value; ) {
    prev = value;
    value = value.replace(/\([^()]*\)/g, ' ');
  }
  // The first element is the authserv-id; the rest are results.
  for (const part of value.split(';').slice(1)) {
    const m = /^\s*dmarc\s*=\s*([a-z]+)/i.exec(part);
    if (!m || m[1]!.toLowerCase() !== 'fail') continue;
    const hf = /\bheader\.from\s*=\s*"?([^\s";]+)"?/i.exec(part);
    const about = hf ? normaliseDomain(hf[1]!) : fromDomain;
    if (about === fromDomain) return true;
  }
  return false;
}

export interface RemoteDecision {
  /** Inline remote images for this response. */
  load: boolean;
  senderDomain: string | null;
  /** Allowlist entry that made the images load automatically. */
  allowedBy: string | null;
  /** The sender is allowlisted but the message failed DMARC, so nothing loaded automatically. */
  skipped: 'dmarc-fail' | null;
  /** Why images loaded by themselves (DreyMail): the list, your own domain, someone you wrote to, or the sender's own server. */
  reason?: 'list' | 'own' | 'contact' | 'sender' | 'everyone' | null;
}

/** Automatic loading beyond the "always load from" list (Settings → Images). */
export interface AutoImages {
  /** Domains of the user's own mailboxes ("your own domains"), without public ones like gmail.com; empty when switched off. */
  ownDomains: readonly string[];
  /** Addresses the user knows (wrote to, had mail from, contacts); empty when switched off. */
  contacts: { has(address: string): boolean };
  /** Load images in all mail (DreyMail 12.1; never in Junk, nor for a forged sender). */
  everyone?: boolean;
  /** Load when every remote image is on the sender's own domain. */
  senderHosted: boolean;
  /** The message's remote image URLs (for senderHosted). */
  imageUrls: readonly string[];
}

const hostOf = (u: string) => {
  try {
    return normaliseDomain(new URL(u).hostname);
  } catch {
    return null;
  }
};

/**
 * `explicit`: true = the user clicked "Load images", false = the client wants the blocked
 * version (e.g. for quoting), undefined = let the allowlist decide.
 */
export function decideRemoteImages(email: ParsedEmail, explicit: boolean | undefined, allowlist: readonly string[], auto?: AutoImages): RemoteDecision {
  const domain = senderDomain(email);
  if (explicit !== undefined) return { load: explicit, senderDomain: domain, allowedBy: null, skipped: null };
  if (!domain) return { load: false, senderDomain: domain, allowedBy: null, skipped: null };
  const listed = findAllowedDomain(domain, allowlist);
  let reason: RemoteDecision['reason'] = listed ? 'list' : null;
  let allowedBy = listed;
  if (!reason && auto) {
    // Exactly your own domain (a newsletter subdomain of it doesn't count).
    const own = auto.ownDomains.find((d) => d === domain);
    const from = flattenAddresses(email.from)[0]?.address?.trim().toLowerCase() ?? '';
    if (own) [reason, allowedBy] = ['own', own];
    else if (from && auto.contacts.has(from)) [reason, allowedBy] = ['contact', domain];
    else if (auto.everyone) [reason, allowedBy] = ['everyone', domain];
    else if (auto.senderHosted && auto.imageUrls.length > 0) {
      const org = organisationDomain(domain);
      if (auto.imageUrls.every((u) => { const h = hostOf(u); return !!h && domainMatches(h, org); })) [reason, allowedBy] = ['sender', org];
    }
  }
  if (!reason) return { load: false, senderDomain: domain, allowedBy: null, skipped: null };
  // A forged sender (failed DMARC) never gets images loaded by itself.
  if (dmarcFailed(email, domain)) return { load: false, senderDomain: domain, allowedBy: null, skipped: 'dmarc-fail' };
  return { load: true, senderDomain: domain, allowedBy, skipped: null, reason };
}
