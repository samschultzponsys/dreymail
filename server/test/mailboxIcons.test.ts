// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isMailboxIcon, MAILBOX_ICONS } from '../../shared/mailboxIcons.js';
import type { AccountInput } from '../../shared/types.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

describe('mailbox icons', () => {
  it('every icon is one plain path the service worker and Android accept', () => {
    const entries = Object.entries(MAILBOX_ICONS);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    for (const [key, { label, path }] of entries) {
      expect(key).toMatch(/^[a-z0-9-]+$/);
      expect(label.length).toBeGreaterThan(0);
      // The same check web/public/sw.js makes before drawing.
      expect(path).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
      expect(path.length).toBeLessThan(4000);
      // Joined shapes never start relative to the previous one.
      expect(path).not.toMatch(/^m/);
    }
  });

  it('only known keys count', () => {
    expect(isMailboxIcon('briefcase')).toBe(true);
    expect(isMailboxIcon('toString')).toBe(false);
    expect(isMailboxIcon('<svg>')).toBe(false);
    expect(isMailboxIcon(undefined)).toBe(false);
  });

  it('is stored per mailbox and listed with it', () => {
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const sam = store.upsertUser('local', 'sam', '', 'Sam');
    const input: AccountInput = {
      name: 'Work',
      displayName: 'Sam',
      email: 'sam@example.com',
      color: '#ef4444',
      imap: { host: 'h', port: 993, tls: 'tls', user: 'u', password: 'p' },
      smtp: { host: 'h', port: 465, tls: 'tls', user: 'u', password: 'p' },
      appendSent: true,
    };
    const a = store.createAccount(sam.id, input);
    expect(a.icon).toBe('');
    store.setAccountIcon(sam.id, a.id, 'briefcase');
    expect(store.listAccounts(sam.id)[0]!.icon).toBe('briefcase');
    // Someone else can't change it.
    const eve = store.upsertUser('local', 'eve', '', 'Eve');
    store.setAccountIcon(eve.id, a.id, 'dog');
    expect(store.listAccounts(sam.id)[0]!.icon).toBe('briefcase');
  });
});
