// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { Signature } from '../../shared/types';
import { signatureFor } from '../src/signature';

describe('picking the signature in the composer', () => {
  const sigs: Signature[] = [
    { id: '1', name: 'Work', html: 'w', accountIds: ['gmail'], onReplies: true },
    { id: '2', name: 'Short', html: 's', accountIds: ['purely'], onReplies: false },
  ];
  it("uses the From account's signature; skips replies when the signature says so", () => {
    expect(signatureFor(sigs, 'gmail', false)?.name).toBe('Work');
    expect(signatureFor(sigs, 'gmail', true)?.name).toBe('Work');
    expect(signatureFor(sigs, 'purely', false)?.name).toBe('Short');
    expect(signatureFor(sigs, 'purely', true)).toBeNull();
    expect(signatureFor(sigs, 'other', false)).toBeNull();
    expect(signatureFor(undefined, 'gmail', false)).toBeNull();
  });
});
