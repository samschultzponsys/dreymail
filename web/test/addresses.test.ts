// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { afterTyping, bubbleLabel, finishDraft, isAddress, removeAddress, reopenLast, splitAddresses } from '../src/addresses';

describe('address bubbles', () => {
  it('knows a complete address', () => {
    expect(isAddress('sam@example.com')).toBe(true);
    expect(isAddress('Sam Smith <sam@example.com>')).toBe(true);
    expect(isAddress('"Smith, Sam" <sam@example.com>')).toBe(true); // a quoted name may hold a comma (13.4)
    expect(isAddress('sam@example')).toBe(false);
    expect(isAddress('sam')).toBe(false);
    expect(isAddress('Sam <sam@example.com')).toBe(false);
  });

  it('turns a typed address into a bubble on space, comma or semicolon', () => {
    expect(afterTyping('sam@example.com ')).toBe('sam@example.com, ');
    expect(splitAddresses(afterTyping('sam@example.com '))).toEqual({ done: ['sam@example.com'], draft: '' });
    expect(afterTyping('Sam ')).toBe('Sam '); // a name being typed keeps its space
    expect(afterTyping('Sam Smith <sam@example.com> ')).toBe('Sam Smith <sam@example.com>, ');
    expect(splitAddresses('a@x.com; b@y.com,c')).toEqual({ done: ['a@x.com', 'b@y.com'], draft: 'c' });
  });

  it('finishes on Enter or leaving the field only when complete', () => {
    expect(finishDraft('a@x.com, b@y.com')).toBe('a@x.com, b@y.com, ');
    expect(finishDraft('a@x.com, b@y')).toBe('a@x.com, b@y');
  });

  it('removes bubbles and reopens the last one on Backspace', () => {
    expect(removeAddress('a@x.com, b@y.com, c', 0)).toBe('b@y.com, c');
    expect(reopenLast('a@x.com, b@y.com, ')).toBe('a@x.com, b@y.com');
    expect(splitAddresses(reopenLast('a@x.com, b@y.com, '))).toEqual({ done: ['a@x.com'], draft: 'b@y.com' });
    expect(reopenLast('a@x.com, b')).toBe('a@x.com, b');
  });

  it('labels a bubble with the name if there is one', () => {
    expect(bubbleLabel('Sam Smith <sam@example.com>')).toBe('Sam Smith');
    expect(bubbleLabel('"Sam" <sam@example.com>')).toBe('Sam');
    expect(bubbleLabel('<sam@example.com>')).toBe('sam@example.com');
    expect(bubbleLabel('sam@example.com')).toBe('sam@example.com');
  });
});

describe('Outlook "Last, First" names (13.4)', () => {
  it('keeps a quoted name with a comma in one bubble', () => {
    const value = '"Estomo, Toni" <Toni.Estomo@ncrvoyix.com>, "Grujic, Mihailo" <mihailo@example.com>, Techs <techs@ponsys.com>, ';
    const { done, draft } = splitAddresses(value);
    expect(done).toEqual(['"Estomo, Toni" <Toni.Estomo@ncrvoyix.com>', '"Grujic, Mihailo" <mihailo@example.com>', 'Techs <techs@ponsys.com>']);
    expect(draft).toBe('');
    expect(done.every(isAddress)).toBe(true);
    expect(done.map(bubbleLabel)).toEqual(['Estomo, Toni', 'Grujic, Mihailo', 'Techs']);
    // Removing one leaves the others whole.
    expect(splitAddresses(removeAddress(value, 0)).done).toEqual(done.slice(1));
  });
});
