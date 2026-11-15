// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/**
 * Finds a one-time code (sign-in, verification, 2FA) in a message so it can be copied with one
 * click. Only near words that announce a code, so order numbers and prices aren't picked up.
 */

const KEYWORD = /\b(code|codes|verification|verify|otp|one[- ]time|passcode|pass code|pin|security|sign[- ]?in|log[- ]?in|2fa|two[- ]factor|confirmation|confirm|token|kod|código|code de)\b/gi;
const CANDIDATE = /(?<![\w$€£.,/:-])(\d{4,8}|\d{3}[ -]\d{3}|\d{2}[ -]\d{2}[ -]\d{2}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})(?![\w%.,/:-])/g;

function clean(c: string): string {
  return c.replace(/[ -]/g, '');
}

function plausible(c: string): boolean {
  const d = clean(c);
  // A bare year is almost never a code.
  if (/^(19|20)\d\d$/.test(d)) return false;
  return true;
}

/** The code, or null. Looks at the subject first, then the text around code-ish words. */
export function findCode(subject: string, text: string): string | null {
  // "Security code" as the subject, the code alone in the first lines.
  KEYWORD.lastIndex = 0;
  if (subject && KEYWORD.test(subject)) {
    CANDIDATE.lastIndex = 0;
    let c: RegExpExecArray | null;
    const head = text.slice(0, 300);
    while ((c = CANDIDATE.exec(head))) if (plausible(c[1]!)) return clean(c[1]!);
  }
  for (const source of [subject, text.slice(0, 5000)]) {
    if (!source) continue;
    KEYWORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = KEYWORD.exec(source))) {
      // Codes stand close to the word: "Your code is 123456", "123456 is your code".
      const start = Math.max(0, m.index - 60);
      const window = source.slice(start, m.index + m[0].length + 80);
      CANDIDATE.lastIndex = 0;
      let c: RegExpExecArray | null;
      while ((c = CANDIDATE.exec(window))) if (plausible(c[1]!)) return clean(c[1]!);
    }
  }
  return null;
}
