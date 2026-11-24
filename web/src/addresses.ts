// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The To, Cc and Bcc fields stay comma-separated text (what drafts, replies and sending use); this
// splits that text into finished addresses (shown as bubbles) and the one being typed.
// DreyMail 13.4: names in quotes may hold commas ("Last, First" <…>).

/**
 * "a@b.example", "Name <a@b.example>" or "\"Last, First\" <a@b.example>" (DreyMail 13.4: a quoted
 * name may hold commas, as Outlook's "Last, First" names do).
 */
const ADDRESS = /^(?:(?:"[^"]*"|[^<>,;"]*)\s*<\s*)?[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+(?:\s*>)?$/;

export function isAddress(token: string): boolean {
  const t = token.trim();
  if (!ADDRESS.test(t)) return false;
  // Angle brackets come in pairs.
  return t.includes('<') === t.endsWith('>');
}

/** Finished entries (everything before the last comma) and what is being typed after it. */
export function splitAddresses(value: string): { done: string[]; draft: string } {
  // Commas and semicolons inside a quoted name or <…> don't end an entry.
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const draft = parts.pop() ?? '';
  return { done: parts.map((p) => p.trim()).filter(Boolean), draft: draft.replace(/^\s+/, '') };
}

/** The value with these entries finished and nothing being typed. */
export function joinAddresses(done: string[], draft = ''): string {
  return done.length ? `${done.join(', ')}, ${draft}` : draft;
}

/**
 * After the user typed: a comma or semicolon finishes the entry before it; a space finishes it
 * only when it is a complete address (names have spaces in them).
 */
export function afterTyping(value: string): string {
  const { done, draft } = splitAddresses(value);
  if (/\s$/.test(draft) && isAddress(draft)) return joinAddresses([...done, draft.trim()]);
  return joinAddresses(done, draft);
}

/** Finish what is being typed if it is a complete address (Enter, Tab, leaving the field). */
export function finishDraft(value: string): string {
  const { done, draft } = splitAddresses(value);
  return isAddress(draft) ? joinAddresses([...done, draft.trim()]) : value;
}

/** Remove the i-th finished entry. */
export function removeAddress(value: string, i: number): string {
  const { done, draft } = splitAddresses(value);
  return joinAddresses(done.filter((_, k) => k !== i), draft);
}

/** Backspace in an empty field: the last bubble becomes text again, to edit. */
export function reopenLast(value: string): string {
  const { done, draft } = splitAddresses(value);
  if (draft || !done.length) return value;
  return joinAddresses(done.slice(0, -1), done[done.length - 1]);
}

/** What a bubble shows: the name if there is one, else the address. */
export function bubbleLabel(entry: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(entry);
  return m ? m[1]!.trim() || m[2]!.trim() : entry.trim();
}
