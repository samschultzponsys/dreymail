// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Signatures in the composer: which signature an account uses, and putting it into the message
// body (below the space you type in, above any quoted or forwarded message).

import type { Signature } from '../../shared/types';

/** Marks the signature block in the editor, so it can be swapped when the From account changes. */
export const SIGNATURE_ATTR = 'data-dm-signature';

/** The signature for this account, if it has one that applies to this kind of message. */
export function signatureFor(signatures: Signature[] | undefined, accountId: string, isReply: boolean): Signature | null {
  const sig = signatures?.find((s) => s.accountIds.includes(accountId)) ?? null;
  return sig && (!isReply || sig.onReplies) ? sig : null;
}

/**
 * Puts this signature into the editor (or takes it out, for null), keeping whatever the user has
 * typed. An existing signature is replaced in place; a new one goes after the first line, where the
 * caret starts, so in replies it sits above the quoted message.
 */
export function applySignature(editor: HTMLElement, sigHtml: string | null): void {
  const existing = editor.querySelector(`[${SIGNATURE_ATTR}]`);
  if (existing) {
    if (sigHtml === null) existing.remove();
    else existing.innerHTML = sigHtml;
    return;
  }
  if (sigHtml === null) return;
  const div = editor.ownerDocument.createElement('div');
  div.setAttribute(SIGNATURE_ATTR, '1');
  div.innerHTML = sigHtml;
  const first = editor.firstElementChild;
  if (first) first.after(div);
  else editor.append(editor.ownerDocument.createElement('p'), div);
}
