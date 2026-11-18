// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Database migrations run by position (PRAGMA user_version), so the list is append-only: a
// migration inserted in the middle is skipped by every database that is already past that point.
// That happened once (Microsoft sign-in columns, before 2.0's migration), so this pins the order.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Keyring } from '../src/crypto.js';
import { MIGRATIONS, Store } from '../src/db.js';

/** The first table or column each migration creates, in order. Add new ones at the end only. */
const ORDER = [
  'users', 'image_domains', 'push_subscriptions', 'snoozes', 'password_hash', 'username', 'signatures', 'is_admin', 'fcm_tokens',
  'auth', 'display_name', 'saved_searches', 'roles', 'icon', 'icon_image', 'ai_connections', 'learning_from', 'blocked_senders',
  'scheduled_sends', 'passkeys', 'calendars', 'source', 'user_identities', 'auth', 'mailbox_groups', 'threaded', 'pinned_folders',
  'icon_image', 'users', 'auto_replies', 'address_book', 'calendar_alerts', 'followups',
];

const marker = (m: (typeof MIGRATIONS)[number]) => {
  const t = typeof m === 'string' ? m : m.toString();
  const r = /CREATE TABLE(?: IF NOT EXISTS)? (\w+)|ADD COLUMN (\w+)|UPDATE (\w+)|INSERT[^(]*INTO (\w+)/.exec(t);
  return r ? r.slice(1).find(Boolean) : '?';
};

describe('database migrations', () => {
  it('only ever grow at the end', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(ORDER.length);
    expect(MIGRATIONS.slice(0, ORDER.length).map(marker)).toEqual(ORDER);
  });

  it('repair a database that skipped the Microsoft sign-in columns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mig-'));
    const file = path.join(dir, 'dreymail.db');
    // A database made before the misplaced migration existed: everything up to 2.0's migration ran,
    // and its version counts the slot the Microsoft migration later took.
    const raw = new DatabaseSync(file);
    const skipped = ORDER.indexOf('auth');
    const upTo = ORDER.indexOf('display_name');
    for (let i = 0; i <= upTo; i++) {
      if (i === skipped) continue;
      const m = MIGRATIONS[i]!;
      if (typeof m === 'string') raw.exec(m);
      else m(raw);
    }
    raw.exec(`PRAGMA user_version = ${upTo + 1}`);
    expect((raw.prepare("SELECT name FROM pragma_table_info('accounts')").all() as { name: string }[]).some((c) => c.name === 'auth')).toBe(false);
    raw.close();

    const store = new Store(file, new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const cols = (store.db.prepare("SELECT name FROM pragma_table_info('accounts')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['auth', 'oauth_token']));
    // Google sign-in works on it now.
    const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
    expect(store.saveGoogleAccount(user.id, { email: 'sam@gmail.com', name: 'Gmail', displayName: 'Sam', color: '#ef4444', refreshToken: 'rt' }).auth).toBe('google');
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops the passwords of accounts with single sign-on connected (7.6)', () => {
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const linked = store.createPasswordUser('local', 'sam', 'hash1')!;
    const plain = store.createPasswordUser('local', 'eve', 'hash2')!;
    store.connectIdentity(linked.id, 'https://idp.example', 'sub-sam');
    store.db.exec(MIGRATIONS[ORDER.lastIndexOf('users')] as string);
    expect(store.getUser(linked.id)!.hasPassword).toBe(false);
    expect(store.getUser(plain.id)!.hasPassword).toBe(true);
    store.db.close();
  });
});
