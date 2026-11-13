// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AccountInput } from '../../shared/types.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { DB_FILE, OLD_DB_FILE, OLD_ENV_PREFIX, oldEnvErrors, oldKeyring } from '../src/upgrade.js';

const secret = crypto.randomBytes(48).toString('base64');
const account: AccountInput = {
  name: 'Work', displayName: 'Sam', email: 'sam@example.com', color: '#22d3ee',
  imap: { host: 'mail.example.com', port: 993, tls: 'tls', user: 'sam', password: 'imap-pw' },
  smtp: { host: 'mail.example.com', port: 465, tls: 'tls', user: 'sam', password: 'smtp-pw' },
  appendSent: true,
};

describe('upgrading data from before 1.5', () => {
  it('renames the old database, drops the cache and re-encrypts mail passwords so they still open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-upgrade-'));
    try {
      const old = new Store(path.join(dir, OLD_DB_FILE), oldKeyring(secret).credentialKey);
      const user = old.upsertUser('local', 'sam', '', 'Sam');
      const acc = old.createAccount(user.id, account);
      old.close();
      fs.writeFileSync(path.join(dir, 'cache.db'), 'stale');

      const { app, store } = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_DATA_DIR: dir }), { logger: false, cacheFile: null });
      expect(fs.existsSync(path.join(dir, DB_FILE))).toBe(true);
      expect(fs.existsSync(path.join(dir, OLD_DB_FILE))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'cache.db'))).toBe(false);
      const secretView = store.getAccountSecret(user.id, acc.id)!;
      expect([secretView.imap.password, secretView.smtp.password]).toEqual(['imap-pw', 'smtp-pw']);
      await app.close();

      // Only once: a second start leaves the (now new-key) secrets alone.
      const again = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_DATA_DIR: dir }), { logger: false, cacheFile: null });
      expect(again.store.getAccountSecret(user.id, acc.id)!.imap.password).toBe('imap-pw');
      await again.app.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('new installs use their own keys', () => {
    expect(new Keyring(secret).credentialKey.equals(oldKeyring(secret).credentialKey)).toBe(false);
  });

  it('refuses to start with old environment variable names and says what to rename them to', () => {
    const old = { [`${OLD_ENV_PREFIX}SECRET_KEY`]: secret };
    expect(oldEnvErrors({ ...old, DREYMAIL_SECRET_KEY: secret })[0]).toMatch(/-> DREYMAIL_SECRET_KEY/);
    expect(() => loadConfig({ ...old, DREYMAIL_SECRET_KEY: secret })).toThrow(/DREYMAIL_ prefix/);
    expect(oldEnvErrors({ DREYMAIL_SECRET_KEY: secret })).toEqual([]);
  });
});
