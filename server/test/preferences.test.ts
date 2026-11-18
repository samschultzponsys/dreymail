// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: tests for the All inboxes preference.

import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/db.js';
import { prefsSchema } from '../src/routes/api.js';

const base = { theme: 'system', pageSize: 50, markReadOnOpen: true, swipeLeft: 'delete', swipeRight: 'archive', notificationContent: 'full' };

describe('screen transitions preference', () => {
  it('is the plain slide by default for new users (10.0)', () => {
    expect(DEFAULT_PREFERENCES.screenTransitions).toBe('slide');
  });
  it('is the slide when saved by a client that does not know about it yet', () => {
    expect(prefsSchema.parse(base).screenTransitions).toBe('slide');
  });
  it('accepts Off, Slide, and the squirrel at Fast, Medium and Slow, and rejects anything else', () => {
    for (const v of ['off', 'slide', 'fast', 'medium', 'slow']) expect(prefsSchema.parse({ ...base, screenTransitions: v }).screenTransitions).toBe(v);
    expect(prefsSchema.safeParse({ ...base, screenTransitions: 'ludicrous' }).success).toBe(false);
    expect(prefsSchema.safeParse({ ...base, screenTransitions: false }).success).toBe(false);
  });
});

describe('contact pictures preference', () => {
  it('stays on when saved by a client that does not know about it yet', () => {
    expect(prefsSchema.parse(base).contactPhotos).toBe(true);
  });
  it('can be turned off', () => {
    expect(prefsSchema.parse({ ...base, contactPhotos: false }).contactPhotos).toBe(false);
    expect(prefsSchema.safeParse({ ...base, contactPhotos: 'no' }).success).toBe(false);
  });
});

describe('all inboxes preference', () => {
  it('is on by default and stays on when saved by a client that does not know about it yet', () => {
    expect(DEFAULT_PREFERENCES.unifiedInbox).toBe(true);
    expect(prefsSchema.parse(base).unifiedInbox).toBe(true);
  });
  it('can be turned off', () => {
    expect(prefsSchema.parse({ ...base, unifiedInbox: false }).unifiedInbox).toBe(false);
    expect(prefsSchema.safeParse({ ...base, unifiedInbox: 'no' }).success).toBe(false);
  });
});
