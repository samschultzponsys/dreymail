// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// One-time upgrade of data written before DreyMail 1.5, when the project still used the names it
// started from (database file, key-derivation salt, environment variable prefix). This file is the
// only place those old names appear, and only so existing data can be carried over: without them
// the old database can't be found and the stored mail passwords can't be decrypted. Once every
// instance has started on 1.5 or later it can be deleted.

import fs from 'node:fs';
import path from 'node:path';
import { Keyring } from './crypto.js';
import type { Store } from './db.js';

export const OLD_DB_FILE = 'ratatoskr.db';
const OLD_KEY_SALT = 'ratatoskr';
export const OLD_ENV_PREFIX = 'RATATOSKR_';

export const DB_FILE = 'dreymail.db';
const KEYS_MARKER = { key: 'keys', value: 'dreymail-v1' };

/** Environment variables still using the old prefix, as config errors naming the new variable. */
export function oldEnvErrors(env: NodeJS.ProcessEnv): string[] {
  const old = Object.keys(env).filter((k) => k.startsWith(OLD_ENV_PREFIX));
  return old.length ? [`Rename these environment variables to the DREYMAIL_ prefix: ${old.map((k) => `${k} -> DREYMAIL_${k.slice(OLD_ENV_PREFIX.length)}`).join(', ')}`] : [];
}

/**
 * Before the database opens: moves an old database file (with its WAL files) to the new name. The
 * mail cache is dropped too: it's encrypted with keys that change, and it refills itself.
 */
export function moveOldDataFiles(dataDir: string, log: (msg: string) => void): void {
  const from = path.join(dataDir, OLD_DB_FILE);
  const to = path.join(dataDir, DB_FILE);
  if (fs.existsSync(to) || !fs.existsSync(from)) return;
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(from + suffix)) fs.renameSync(from + suffix, to + suffix);
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dataDir, 'cache.db' + suffix), { force: true });
  log(`Upgraded data: ${OLD_DB_FILE} is now ${DB_FILE}; the mail cache will be rebuilt.`);
}

/**
 * After the database opens: re-encrypts stored secrets with DreyMail's own keys, once. A database
 * without users has nothing to move and is just marked.
 */
export function rekeyOldSecrets(store: Store, secretKey: string, log: (msg: string) => void): void {
  if (store.getSetting<string>(KEYS_MARKER.key) === KEYS_MARKER.value) return;
  const moved = store.rekeyFrom(new Keyring(secretKey, OLD_KEY_SALT).credentialKey, KEYS_MARKER);
  if (moved) log(`Upgraded data: re-encrypted ${moved} mail account credential(s) with DreyMail's keys.`);
}

/** Keys as data written before 1.5 used them (for tests of this upgrade). */
export const oldKeyring = (secretKey: string) => new Keyring(secretKey, OLD_KEY_SALT);
