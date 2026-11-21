// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Backups (11.9): a user's data out and back in (also on another server with another key), the
// password-protected file, and the automatic daily copies.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackupError, exportUser, importUser, openBackup, sealBackup, Snapshots } from '../src/backup.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const newKey = () => new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey;

function setup(key = newKey(), name = 'sam') {
  const store = new Store(':memory:', key);
  const user = store.upsertUser('local', name, '', name, name);
  const acc = store.createAccount(user.id, {
    name: 'Work',
    displayName: 'Sam',
    email: `${name}@example.com`,
    color: '#3b82f6',
    imap: { host: 'imap.example.com', port: 993, tls: 'tls', user: name, password: 'imap-secret' },
    smtp: { host: 'smtp.example.com', port: 465, tls: 'tls', user: name, password: 'smtp-secret' },
    appendSent: true,
  } as never);
  store.db.prepare("INSERT INTO signatures (id, user_id, name, html, on_replies, created_at) VALUES ('sig1', ?, 'Default', '<p>Thanks</p>', 1, 1)").run(user.id);
  store.db.prepare("INSERT INTO contacts (id, user_id, name, emails, phones, company, title, notes, updated_at) VALUES ('c1', ?, 'Ada', '[\"ada@example.com\"]', '[]', '', '', '', 1)").run(user.id);
  store.setPreferences(user.id, { ...store.getUser(user.id)!.preferences, accentColor: '#22d3ee' } as never);
  return { store, key, user, acc };
}

describe('backups', () => {
  it('restore on another server (another secret key, another user id), with the passwords', () => {
    const a = setup();
    const file = sealBackup(exportUser(a.store.db, a.key, a.user.id, '11.9'), 'a long password');
    expect(file.toString()).not.toContain('imap-secret');
    expect(file.toString()).not.toContain('Thanks');

    const b = new Store(':memory:', newKey());
    const other = b.upsertUser('local', 'samuel', '', 'Samuel', 'samuel');
    const keyB = (b as unknown as { credentialKey: Buffer }).credentialKey;
    const summary = importUser(b.db, keyB, other.id, openBackup(file, 'a long password'));
    expect(summary.restored).toMatchObject({ accounts: 1, signatures: 1, contacts: 1 });
    const [acc] = b.listAccounts(other.id);
    expect(acc).toMatchObject({ name: 'Work', email: 'sam@example.com' });
    expect(b.getAccountSecret(other.id, acc!.id)).toMatchObject({ imap: { password: 'imap-secret' }, smtp: { password: 'smtp-secret' } });
    expect((b.getUser(other.id)!.preferences as { accentColor?: string }).accentColor).toBe('#22d3ee');
  });

  it('refuses a wrong password', () => {
    const a = setup();
    const file = sealBackup(exportUser(a.store.db, a.key, a.user.id, '11.9'), 'a long password');
    expect(() => openBackup(file, 'not it at all')).toThrow(BackupError);
    expect(() => openBackup(Buffer.from('hello'), 'x')).toThrow(/not a DreyMail backup/);
    expect(() => sealBackup(exportUser(a.store.db, a.key, a.user.id, '11.9'), 'short')).toThrow(/8 characters/);
  });

  it('puts back what was removed since', () => {
    const a = setup();
    const data = exportUser(a.store.db, a.key, a.user.id, '11.9');
    a.store.deleteAccount(a.user.id, a.acc.id);
    a.store.db.prepare('DELETE FROM contacts').run();
    importUser(a.store.db, a.key, a.user.id, data);
    expect(a.store.listAccounts(a.user.id).map((x) => x.id)).toEqual([a.acc.id]);
    expect(a.store.getAccountSecret(a.user.id, a.acc.id)!.imap.password).toBe('imap-secret');
    expect(a.store.db.prepare('SELECT COUNT(*) AS n FROM contacts').get()).toEqual({ n: 1 });
  });

  it("won't take over another user's data on the same server, and changes nothing then", () => {
    const a = setup();
    const data = exportUser(a.store.db, a.key, a.user.id, '11.9');
    const bob = a.store.upsertUser('local', 'bob', '', 'Bob', 'bob');
    a.store.db.prepare("INSERT INTO contacts (id, user_id, name, emails, phones, company, title, notes, updated_at) VALUES ('c2', ?, 'Bob’s', '[]', '[]', '', '', '', 1)").run(bob.id);
    expect(() => importUser(a.store.db, a.key, bob.id, data)).toThrow(/another user/);
    expect(a.store.db.prepare("SELECT name FROM contacts WHERE user_id = ?").all(bob.id)).toEqual([{ name: 'Bob’s' }]);
  });

  it('automatic backups: a daily copy, old ones removed, and a user restores from one', () => {
    const a = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-backups-'));
    try {
      let keep = 7;
      const snaps = new Snapshots({ db: a.store.db, dir, keepDays: () => keep });
      snaps.tick();
      snaps.tick(); // one a day
      expect(snaps.list()).toHaveLength(1);
      const manual = snaps.create(true);
      expect(snaps.list()).toHaveLength(2);
      expect(snaps.hasUser(manual.name, a.user.id)).toBe(true);
      // Changed since: restore from the copy.
      a.store.deleteAccount(a.user.id, a.acc.id);
      const db = snaps.open(manual.name);
      const data = exportUser(db, a.key, a.user.id, '11.9');
      db.close();
      importUser(a.store.db, a.key, a.user.id, data);
      expect(a.store.listAccounts(a.user.id)).toHaveLength(1);
      // Older than the days kept: removed.
      const old = new Date(Date.now() - 10 * 86_400_000);
      for (const s of snaps.list()) fs.utimesSync(path.join(dir, s.name), old, old);
      snaps.tick();
      expect(snaps.list().every((s) => Date.parse(s.createdAt) > Date.now() - 86_400_000)).toBe(true);
      keep = 0;
      expect(() => snaps.open('../dreymail.db')).toThrow(BackupError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backups over the API', () => {
  it('download through a one-time link, then restore the file', async () => {
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const secret = crypto.randomBytes(48).toString('base64');
    const store = new Store(':memory:', new Keyring(secret).credentialKey);
    const ctx = await buildApp(loadConfig({ DREYMAIL_SECRET_KEY: secret, DREYMAIL_BASE_URL: 'https://mail.example.com' }), { store, logger: false, cacheFile: null });
    try {
      const reg = await ctx.app.inject({ method: 'POST', url: '/auth/password/register', payload: { username: 'sam', password: 'a long password' }, headers: { 'x-dreymail': '1' } });
      const cookie = `dm_session=${reg.cookies.find((c) => c.name === 'dm_session')!.value}`;
      const h = { cookie, 'x-dreymail': '1' };
      const userId = store.listUsers()[0]!.id;
      store.db.prepare("INSERT INTO contacts (id, user_id, name, emails, phones, company, title, notes, updated_at) VALUES ('c1', ?, 'Ada', '[]', '[]', '', '', '', 1)").run(userId);
      const prep = (await ctx.app.inject({ method: 'POST', url: '/api/backup/prepare', payload: { password: 'backup password' }, headers: h })).json() as { url: string; name: string };
      expect(prep.name).toMatch(/^dreymail-backup-sam-\d{4}-\d{2}-\d{2}\.json$/);
      const file = await ctx.app.inject({ method: 'GET', url: prep.url, headers: { cookie } });
      expect(file.headers['content-disposition']).toContain('attachment');
      // The link works once.
      expect((await ctx.app.inject({ method: 'GET', url: prep.url, headers: { cookie } })).statusCode).toBe(404);
      store.db.prepare('DELETE FROM contacts').run();
      const bad = await ctx.app.inject({ method: 'POST', url: '/api/backup/restore', payload: { file: file.rawPayload.toString('base64'), password: 'wrong one!' }, headers: h });
      expect(bad.statusCode).toBe(400);
      const ok = await ctx.app.inject({ method: 'POST', url: '/api/backup/restore', payload: { file: file.rawPayload.toString('base64'), password: 'backup password' }, headers: h });
      expect(ok.json()).toMatchObject({ ok: true, summary: { restored: { contacts: 1 } } });
      // No data folder in this test: no automatic backups.
      expect((await ctx.app.inject({ method: 'GET', url: '/api/backup/automatic', headers: h })).json()).toEqual({ keepDays: 0, backups: [] });
    } finally {
      await ctx.app.close();
    }
  });
});
