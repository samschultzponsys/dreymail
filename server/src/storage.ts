// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Space used per user, for Settings → Storage (administration): what each user's rows take up in
// the main database, and their mailboxes' copies in the mail cache. Sizes are the bytes of the
// stored values (encrypted where they are encrypted); SQLite's own overhead (indexes, page slack)
// is not counted, so the files on disk are somewhat larger than the sum.

import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { StorageDatabaseUsage } from '../../shared/types.js';

export type DatabaseCategory = keyof StorageDatabaseUsage;

/** Tables of the main database by what they hold; anything not listed counts as settings. */
const CATEGORY: Record<string, DatabaseCategory> = {
  calendars: 'calendar',
  calendar_shares: 'calendar',
  calendar_hidden: 'calendar',
  calendar_events: 'calendar',
  calendar_sources: 'calendar',
  invite_responses: 'calendar',
  scheduled_sends: 'scheduled',
  ai_connections: 'ai',
  ai_mailboxes: 'ai',
  ai_rules: 'ai',
  ai_history: 'ai',
  ai_usage: 'ai',
  ai_observations: 'ai',
};

/** Columns holding uploaded pictures (profile, mailbox and group icons), counted on their own. */
const PICTURE_COLUMNS = new Set(['avatar', 'icon_image']);

/** Tables that belong to no user (instance-wide). */
const SHARED = new Set(['instance_settings', 'roles']);

/**
 * How to find the owning user of a table's rows: the column itself, or a join through the table
 * that has it. Checked in order; tables matching none are skipped.
 */
function ownerOf(table: string, cols: Set<string>): { join: string; owner: string } | null {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  if (table === 'users') return { join: '', owner: 't.id' };
  if (cols.has('user_id')) return { join: '', owner: 't.user_id' };
  if (cols.has('owner_id')) return { join: '', owner: 't.owner_id' };
  if (cols.has('account_id')) return { join: `JOIN accounts o ON o.id = t.${q('account_id')}`, owner: 'o.user_id' };
  if (cols.has('calendar_id')) return { join: 'JOIN calendars o ON o.id = t.calendar_id', owner: 'o.owner_id' };
  if (cols.has('reply_id')) return { join: 'JOIN auto_replies o ON o.id = t.reply_id', owner: 'o.user_id' };
  if (cols.has('connection_id')) return { join: 'JOIN ai_connections o ON o.id = t.connection_id', owner: 'o.user_id' };
  return null;
}

export const emptyDatabaseUsage = (): StorageDatabaseUsage => ({ pictures: 0, calendar: 0, scheduled: 0, ai: 0, settings: 0 });

/** Bytes per user in the main database, by category. */
export function databaseUsage(db: DatabaseSync): Map<string, StorageDatabaseUsage> {
  const out = new Map<string, StorageDatabaseUsage>();
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) {
    if (SHARED.has(name)) continue;
    const cols = (db.prepare(`SELECT name FROM pragma_table_info(${`'${name.replace(/'/g, "''")}'`})`).all() as { name: string }[]).map((c) => c.name);
    const owner = ownerOf(name, new Set(cols));
    if (!owner || cols.length === 0) continue;
    // Bytes of each value as stored (text in UTF-8, blobs as is, numbers as their digits: close enough).
    const size = (list: string[]) => (list.length ? list.map((c) => `COALESCE(length(CAST(t.${q(c)} AS BLOB)), 0)`).join(' + ') : '0');
    const pictures = cols.filter((c) => PICTURE_COLUMNS.has(c));
    const rest = cols.filter((c) => !PICTURE_COLUMNS.has(c));
    let rows: { owner: string | null; pictures: number; rest: number }[];
    try {
      rows = db
        .prepare(`SELECT ${owner.owner} AS owner, SUM(${size(pictures)}) AS pictures, SUM(${size(rest)}) AS rest FROM ${q(name)} t ${owner.join} GROUP BY 1`)
        .all() as typeof rows;
    } catch {
      continue; // a table shaped differently than expected: leave it out rather than fail the report
    }
    const category = CATEGORY[name] ?? 'settings';
    for (const r of rows) {
      if (!r.owner) continue;
      const u = out.get(r.owner) ?? emptyDatabaseUsage();
      u.pictures += Number(r.pictures) || 0;
      u[category] += Number(r.rest) || 0;
      out.set(r.owner, u);
    }
  }
  return out;
}

/** Size of an SQLite file on disk, with its write-ahead log; 0 if it doesn't exist (or is in memory). */
export function sqliteFileBytes(file: string | null): number {
  if (!file || file === ':memory:') return 0;
  let total = 0;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      total += fs.statSync(f).size;
    } catch {
      /* not there */
    }
  }
  return total;
}
