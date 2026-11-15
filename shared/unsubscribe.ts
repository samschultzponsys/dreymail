// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/** Ways to unsubscribe a message offers (List-Unsubscribe, RFC 2369; one-click, RFC 8058). */
export interface UnsubscribeOptions {
  /** https address to POST "List-Unsubscribe=One-Click" to (DreyMail does it for you). */
  oneClick: string | null;
  /** https page to open. */
  url: string | null;
  /** mailto: address to write to. */
  mailto: string | null;
}

export function parseUnsubscribe(listUnsub: string, listUnsubPost: string): UnsubscribeOptions | null {
  const targets = [...listUnsub.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  const url = targets.find((t) => /^https:\/\//i.test(t)) ?? null;
  const mailto = targets.find((t) => /^mailto:/i.test(t)) ?? null;
  if (!url && !mailto) return null;
  const oneClick = url && /List-Unsubscribe=One-Click/i.test(listUnsubPost) ? url : null;
  return { oneClick, url, mailto };
}
