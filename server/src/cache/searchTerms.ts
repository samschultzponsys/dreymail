// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Words for the search index in the mail cache (DreyMail 12.3). Text becomes a set of terms:
// words of letters and digits, lowercased, without accents, with simple English endings taken off
// ("printers", "printed" and "printing" all find "printer"/"print"). A search looks for messages
// that have every term of the query. The cache stores only keyed hashes of the terms, never the
// words (see store.ts).

/** Longest word indexed; longer runs (hashes, encoded data) are skipped. */
const MAX_WORD = 40;
/** Most terms kept from one message's text (headers always count). */
export const MAX_BODY_TERMS = 3000;

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** "printers" → "printer", "boxes" → "box", "tickets" → "ticket", "printing"/"printed" → "print". */
export function stem(w: string): string {
  if (/^\d+$/.test(w) || w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (/(?:ches|shes|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The terms of a text, at most `limit` of them (first come). */
export function termsOf(text: string, limit = Infinity): Set<string> {
  const out = new Set<string>();
  for (const m of fold(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length > MAX_WORD || (w.length < 2 && !/\d/.test(w))) continue;
    out.add(stem(w));
    if (out.size >= limit) break;
  }
  return out;
}

/** The terms a search for `q` needs (every one must be there). Empty: nothing indexable to look for. */
export function queryTerms(q: string): string[] {
  return [...termsOf(q)];
}
