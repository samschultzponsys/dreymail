// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import type { SmimeInfo } from './smime.js';
import type { ParsedEmail } from './parse.js';

/** A message as read: decoded, and decrypted where it was encrypted. */
export interface OpenedMessage {
  email: ParsedEmail;
  smime: SmimeInfo | null;
}

/**
 * The last few messages opened, decoded, in memory for a few minutes (DreyMail 14.1), so opening
 * a picture or another attachment of the message being read (or replying to it) needs neither the
 * mail server nor decoding the whole message again. Messages larger than the mail cache keeps
 * (often those with photos) would otherwise be downloaded again for every attachment. Content of a
 * message never changes for its UID, so nothing here goes stale; it is only ever for the same user.
 */
export class OpenedMemo {
  private readonly entries = new Map<string, { value: OpenedMessage; size: number; at: number }>();
  private total = 0;

  constructor(
    private readonly maxBytes = 512 * 1024 * 1024,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): OpenedMessage | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.now() - e.at > this.ttlMs) {
      this.delete(key);
      return null;
    }
    // Most recently used last.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }

  /** Keep a message; `size` is its raw size (about what its decoded parts take). */
  set(key: string, value: OpenedMessage, size: number) {
    this.delete(key);
    if (size > this.maxBytes / 2) return;
    this.entries.set(key, { value, size, at: this.now() });
    this.total += size;
    for (const [k] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.delete(k);
    }
  }

  delete(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.total -= e.size;
  }

  /** Forget every message whose key starts with `prefix` (an account removed). */
  deletePrefix(prefix: string) {
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.delete(k);
  }

  get bytes() {
    return this.total;
  }
}
