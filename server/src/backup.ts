// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Backups (DreyMail 11.9).
//
// - A user's own backup: everything of theirs in dreymail.db (mailboxes with their passwords and
//   sign-ins, groups, signatures, settings, rules, contacts, tasks, calendars, …) as one file,
//   encrypted with a password they choose (scrypt + AES-256-GCM). Secrets are taken out of the
//   server's encryption and sealed again on restore, so a backup also restores on another
//   DreyMail server with another secret key.
// - Automatic backups: a daily copy of the whole database (VACUUM INTO) in <data>/backups, kept for
//   a number of days. A user can restore their own data from one of them; an administrator can
//   restore the whole server by putting a copy back in place of dreymail.db (same secret key).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { decrypt, encrypt } from './crypto.js';

type Row = Record<string, unknown>;
type Db = DatabaseSync;

export class BackupError extends Error {}

/** How a table's rows belong to a user. Parents come before their children. */
interface TableSpec {
  table: string;
  /** The column holding the user's id, or a query for the row ids to take (`?` = the user's id). */
  owner?: string;
  where?: string;
}

const TABLES: TableSpec[] = [
  { table: 'mailbox_groups', owner: 'user_id' },
  { table: 'accounts', owner: 'user_id' },
  { table: 'signatures', owner: 'user_id' },
  { table: 'signature_accounts', where: 'account_id IN (SELECT id FROM accounts WHERE user_id = ?)' },
  { table: 'address_book', owner: 'user_id' },
  { table: 'recent_recipients', owner: 'user_id' },
  { table: 'blocked_senders', owner: 'user_id' },
  { table: 'image_domains', owner: 'user_id' },
  { table: 'saved_searches', owner: 'user_id' },
  { table: 'followups', owner: 'user_id' },
  { table: 'snoozes', where: 'account_id IN (SELECT id FROM accounts WHERE user_id = ?)' },
  { table: 'auto_replies', owner: 'user_id' },
  { table: 'smime_keys', owner: 'user_id' },
  { table: 'smime_certs', owner: 'user_id' },
  { table: 'contacts', owner: 'user_id' },
  { table: 'task_lists', owner: 'user_id' },
  { table: 'tasks', where: 'list_id IN (SELECT id FROM task_lists WHERE user_id = ?)' },
  { table: 'calendars', owner: 'owner_id' },
  { table: 'calendar_sources', owner: 'owner_id' },
  { table: 'calendar_events', where: 'calendar_id IN (SELECT id FROM calendars WHERE owner_id = ?)' },
  { table: 'calendar_hidden', owner: 'user_id' },
  { table: 'invite_responses', owner: 'user_id' },
  { table: 'ai_connections', owner: 'user_id' },
  { table: 'ai_mailboxes', owner: 'user_id' },
  { table: 'ai_rules', owner: 'user_id' },
  { table: 'ai_history', owner: 'user_id' },
  { table: 'ai_observations', owner: 'user_id' },
];
// Left out on purpose: sign-in (passkeys, identities), this device's push registrations, scheduled
// sends (restoring an old one could send it again), and what DreyMail works out again by itself
// (reminder state, inbox positions, usage counters, caches).

/** Not in a backup, but kept through a restore (see importUser). */
const PRESERVED = [
  { table: 'scheduled_sends', where: 'user_id = ?' },
  { table: 'calendar_shares', where: 'calendar_id IN (SELECT id FROM calendars WHERE owner_id = ?)' },
];

/** The user's own settings and picture on their user row. */
const USER_COLUMNS = ['preferences', 'display_name', 'name', 'avatar', 'avatar_type', 'avatar_version', 'gravatar'];

/** Columns sealed with the server's key, and the context each is sealed for. */
interface SecretSpec {
  table: string;
  column: string;
  aad: (row: Row, userId: string) => string;
}
const setting = (key: string) => `instance-setting:${key}`;
const SECRETS: SecretSpec[] = [
  { table: 'accounts', column: 'imap_password', aad: (r, u) => `account-credential:${u}:${String(r.id)}:imap` },
  { table: 'accounts', column: 'smtp_password', aad: (r, u) => `account-credential:${u}:${String(r.id)}:smtp` },
  { table: 'accounts', column: 'oauth_token', aad: (r, u) => `account-oauth:${u}:${String(r.id)}` },
  { table: 'smime_keys', column: 'key_sealed', aad: (r, u) => setting(`smime:${u}:${String(r.account_id)}`) },
  { table: 'calendar_sources', column: 'secret', aad: (r) => setting(`caldav:${String(r.id)}`) },
  { table: 'ai_connections', column: 'api_key', aad: (r) => setting(`ai-connection:${String(r.id)}`) },
];

export interface BackupData {
  format: 'dreymail-backup';
  version: 1;
  app: string;
  createdAt: string;
  /** Who it was made for (shown when restoring). */
  username: string;
  user: Row;
  tables: Record<string, Row[]>;
}

const columnsOf = (db: Db, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const hasTable = (db: Db, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

function selectRows(db: Db, spec: TableSpec, userId: string): Row[] {
  if (!hasTable(db, spec.table)) return [];
  const where = spec.owner ? `${spec.owner} = ?` : spec.where!;
  return db.prepare(`SELECT * FROM ${spec.table} WHERE ${where}`).all(userId) as Row[];
}

/** JSON can't hold bytes: pictures travel as base64. */
function toJson(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : v;
  return out;
}
function fromJson(v: unknown): unknown {
  if (v && typeof v === 'object' && '$b64' in v) return Buffer.from(String((v as { $b64: string }).$b64), 'base64');
  return v;
}

/** Everything of the user's in a database, with secrets in the clear (the file is encrypted). */
export function exportUser(db: Db, credentialKey: Buffer, userId: string, app: string): BackupData {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Row | undefined;
  if (!user) throw new BackupError('No such user in this backup');
  const tables: Record<string, Row[]> = {};
  for (const spec of TABLES) {
    const rows = selectRows(db, spec, userId);
    for (const s of SECRETS.filter((x) => x.table === spec.table)) {
      for (const r of rows) {
        const sealed = r[s.column];
        if (typeof sealed !== 'string' || !sealed) continue;
        try {
          r[s.column] = decrypt(credentialKey, sealed, s.aad(r, userId));
        } catch {
          r[s.column] = ''; // unreadable here: the user signs in to that mailbox again
        }
      }
    }
    tables[spec.table] = rows.map(toJson);
  }
  const own: Row = {};
  for (const c of USER_COLUMNS) if (c in user) own[c] = user[c];
  return { format: 'dreymail-backup', version: 1, app, createdAt: new Date().toISOString(), username: String(user.username || user.email || ''), user: toJson(own), tables };
}

export interface RestoreSummary {
  /** Rows restored per table. */
  restored: Record<string, number>;
  /** Rows left out because what they point at isn't on this server (another user's calendar, …). */
  skipped: number;
  accountIds: string[];
}

/**
 * Replaces the user's data with a backup's, in one transaction: on any real problem (an id that
 * belongs to someone else here) nothing changes.
 */
export function importUser(db: Db, credentialKey: Buffer, userId: string, data: BackupData): RestoreSummary {
  if (data?.format !== 'dreymail-backup' || data.version !== 1 || typeof data.tables !== 'object') throw new BackupError('This is not a DreyMail backup');
  const before = (db.prepare('SELECT id FROM accounts WHERE user_id = ?').all(userId) as { id: string }[]).map((r) => r.id);
  const summary: RestoreSummary = { restored: {}, skipped: 0, accountIds: [] };
  db.exec('BEGIN IMMEDIATE');
  try {
    // Kept as they are, though removing the old mailboxes and calendars would take them along:
    // scheduled sends and who the calendars are shared with. Put back below where their mailbox or
    // calendar is still there.
    const kept = PRESERVED.filter((p) => hasTable(db, p.table)).map((p) => ({ ...p, rows: db.prepare(`SELECT * FROM ${p.table} WHERE ${p.where}`).all(userId) as Row[] }));
    // Out with the old (children first; deleting mailboxes and lists takes their rows along).
    for (const spec of [...TABLES].reverse()) {
      if (!hasTable(db, spec.table)) continue;
      const where = spec.owner ? `${spec.owner} = ?` : spec.where!;
      db.prepare(`DELETE FROM ${spec.table} WHERE ${where}`).run(userId);
    }
    for (const spec of TABLES) {
      const rows = data.tables[spec.table];
      if (!Array.isArray(rows) || !rows.length || !hasTable(db, spec.table)) continue;
      const here = new Set(columnsOf(db, spec.table));
      let n = 0;
      for (const raw of rows) {
        const row: Row = {};
        for (const [k, v] of Object.entries(raw as Row)) if (here.has(k)) row[k] = fromJson(v);
        if (spec.owner) row[spec.owner] = userId;
        for (const s of SECRETS.filter((x) => x.table === spec.table)) {
          const plain = row[s.column];
          if (typeof plain === 'string' && plain) row[s.column] = encrypt(credentialKey, plain, s.aad(row, userId));
        }
        const cols = Object.keys(row);
        try {
          db.prepare(`INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(cols.map((c) => row[c]) as never[]));
          n++;
        } catch (err) {
          const msg = (err as Error).message;
          if (/FOREIGN KEY/i.test(msg)) {
            summary.skipped++;
            continue;
          }
          if (/UNIQUE|PRIMARY KEY/i.test(msg)) throw new BackupError(`This backup's data belongs to another user on this server (${spec.table})`);
          throw err;
        }
      }
      summary.restored[spec.table] = n;
    }
    for (const k of kept)
      for (const row of k.rows) {
        const cols = Object.keys(row);
        try {
          db.prepare(`INSERT OR IGNORE INTO ${k.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(cols.map((c) => row[c]) as never[]));
        } catch {
          // its mailbox or calendar isn't in the backup
        }
      }
    const user = data.user && typeof data.user === 'object' ? data.user : {};
    const here = new Set(columnsOf(db, 'users'));
    const cols = USER_COLUMNS.filter((c) => c in user && here.has(c));
    if (cols.length) db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...(cols.map((c) => fromJson(user[c])) as never[]), userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const after = (db.prepare('SELECT id FROM accounts WHERE user_id = ?').all(userId) as { id: string }[]).map((r) => r.id);
  summary.accountIds = [...new Set([...before, ...after])];
  return summary;
}

// ---- the file: gzip, then AES-256-GCM with a key from the password (scrypt) ------------------------

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };

export function sealBackup(data: BackupData, password: string): Buffer {
  if (password.length < 8) throw new BackupError('Use a backup password of at least 8 characters');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('dreymail-backup-v1'));
  const body = Buffer.concat([c.update(zlib.gzipSync(JSON.stringify(data))), c.final()]);
  return Buffer.from(
    JSON.stringify({
      format: 'dreymail-backup',
      version: 1,
      app: data.app,
      createdAt: data.createdAt,
      username: data.username,
      kdf: { name: 'scrypt', salt: salt.toString('base64'), ...SCRYPT },
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      data: body.toString('base64'),
    }),
  );
}

export function openBackup(file: Buffer, password: string): BackupData {
  let outer: { format?: string; version?: number; kdf?: { name: string; salt: string; N: number; r: number; p: number }; iv?: string; tag?: string; data?: string };
  try {
    outer = JSON.parse(file.toString('utf8'));
  } catch {
    throw new BackupError('This is not a DreyMail backup file');
  }
  if (outer.format !== 'dreymail-backup' || outer.version !== 1 || outer.kdf?.name !== 'scrypt' || !outer.iv || !outer.tag || !outer.data) throw new BackupError('This is not a DreyMail backup file');
  const { N, r, p } = outer.kdf;
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N > 1 << 20 || r > 32 || p > 16) throw new BackupError('This backup file is damaged');
  const key = crypto.scryptSync(password, Buffer.from(outer.kdf.salt, 'base64'), 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(outer.iv, 'base64'));
    d.setAAD(Buffer.from('dreymail-backup-v1'));
    d.setAuthTag(Buffer.from(outer.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(outer.data, 'base64')), d.final()]);
    return JSON.parse(zlib.gunzipSync(plain, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8')) as BackupData;
  } catch {
    throw new BackupError('Wrong password, or the file is damaged');
  }
}

// ---- automatic backups: daily copies of the whole database ------------------------------------------

export interface Snapshot {
  name: string;
  createdAt: string;
  bytes: number;
}

const SNAPSHOT_RE = /^dreymail-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.db$/;

export class Snapshots {
  constructor(
    private readonly deps: {
      db: Db;
      dir: string | null;
      /** Days kept (0: automatic backups off). Read each time, so a change applies at once. */
      keepDays: () => number;
      log?: (msg: string) => void;
    },
  ) {}

  get enabled() {
    return !!this.deps.dir;
  }

  list(): Snapshot[] {
    const dir = this.deps.dir;
    if (!dir || !fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => SNAPSHOT_RE.test(n))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, createdAt: st.mtime.toISOString(), bytes: st.size };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A copy of the database now (`manual`: with the time in its name, so several a day are kept). */
  create(manual = false): Snapshot {
    const dir = this.deps.dir;
    if (!dir) throw new BackupError('Automatic backups need a data folder');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const name = manual ? `dreymail-${day}-${now.toISOString().slice(11, 19).replace(/:/g, '')}.db` : `dreymail-${day}.db`;
    const file = path.join(dir, name);
    const tmp = `${file}.tmp`;
    fs.rmSync(tmp, { force: true });
    this.deps.db.prepare('VACUUM INTO ?').run(tmp);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    const st = fs.statSync(file);
    return { name, createdAt: st.mtime.toISOString(), bytes: st.size };
  }

  /** Today's copy if there isn't one yet, and copies older than the days kept removed. */
  tick() {
    const keep = this.deps.keepDays();
    if (!this.deps.dir || keep <= 0) return;
    const today = `dreymail-${new Date().toISOString().slice(0, 10)}.db`;
    try {
      if (!fs.existsSync(path.join(this.deps.dir, today))) {
        this.create();
        this.deps.log?.(`Automatic backup: ${today}`);
      }
      const cutoff = Date.now() - keep * 86_400_000;
      for (const s of this.list()) if (Date.parse(s.createdAt) < cutoff) fs.rmSync(path.join(this.deps.dir, s.name), { force: true });
    } catch (err) {
      this.deps.log?.(`Automatic backup failed: ${(err as Error).message}`);
    }
  }

  /** Opens one copy (read-only) to restore a user's data from it. */
  open(name: string): Db {
    if (!this.deps.dir || !SNAPSHOT_RE.test(name)) throw new BackupError('No such backup');
    const file = path.join(this.deps.dir, name);
    if (!fs.existsSync(file)) throw new BackupError('No such backup');
    return new DatabaseSync(file, { readOnly: true });
  }

  /** Whether a copy has data of this user (so their list only shows copies they can restore from). */
  hasUser(name: string, userId: string): boolean {
    let db: Db | null = null;
    try {
      db = this.open(name);
      return !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }
}
