// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Backups API (DreyMail 11.9; device settings since 12.0). /api's preHandler has authenticated the user.

import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Access } from '../access.js';
import { BackupError, exportUser, importUser, openBackup, sealBackup, type RestoreSummary, type Snapshots } from '../backup.js';
import type { Store } from '../db.js';

export function registerBackupRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    credentialKey: Buffer;
    snapshots: Snapshots;
    access: Access;
    version: string;
    keepDays: () => number;
    /** After a restore: drop connections and folder lists of the user's (old and new) mailboxes. */
    onRestored: (userId: string, summary: RestoreSummary) => void;
  },
) {
  const { store, credentialKey, snapshots, access } = deps;
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BackupError) return reply.code(400).send({ error: err.message });
    throw err;
  };

  // Download: the user's data as one file, encrypted with the password they give. Made here and
  // fetched from a short-lived link, so the Android app's downloader (a plain GET with the login
  // cookie) can save it too.
  const ready = new Map<string, { userId: string; name: string; file: Buffer; until: number }>();
  app.post('/api/backup/prepare', async (req, reply) => {
    const body = z.object({ password: z.string().min(1).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Give a backup password' });
    try {
      const user = req.user!;
      const file = sealBackup(exportUser(store.db, credentialKey, user.id, deps.version), body.data.password);
      const name = `dreymail-backup-${String(user.username || 'user').replace(/[^A-Za-z0-9._-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
      const now = Date.now();
      for (const [k, v] of ready) if (v.until < now) ready.delete(k);
      const token = crypto.randomBytes(24).toString('base64url');
      ready.set(token, { userId: user.id, name, file, until: now + 5 * 60_000 });
      return { url: `/api/backup/file/${token}`, name };
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.get<{ Params: { token: string } }>('/api/backup/file/:token', async (req, reply) => {
    const f = ready.get(req.params.token);
    if (!f || f.userId !== req.user!.id || f.until < Date.now()) return reply.code(404).send({ error: 'This backup link has expired; make the backup again' });
    ready.delete(req.params.token);
    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', `attachment; filename="${f.name}"`)
      .header('cache-control', 'no-store')
      .send(f.file);
  });

  // Restore from a file (sent as base64 with its password). Replaces the user's data.
  app.post('/api/backup/restore', { bodyLimit: 96 * 1024 * 1024 }, async (req, reply) => {
    const body = z.object({ file: z.string().min(1).max(128 * 1024 * 1024), password: z.string().min(1).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Choose a backup file and give its password' });
    try {
      const data = openBackup(Buffer.from(body.data.file, 'base64'), body.data.password);
      const summary = importUser(store.db, credentialKey, req.user!.id, data);
      deps.onRestored(req.user!.id, summary);
      return { ok: true, from: data.createdAt, app: data.app, summary };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Automatic backups this user can restore from.
  app.get('/api/backup/automatic', async (req) => ({
    keepDays: snapshots.enabled ? deps.keepDays() : 0,
    backups: snapshots.list().filter((s) => snapshots.hasUser(s.name, req.user!.id)),
  }));

  app.post<{ Params: { name: string } }>('/api/backup/automatic/:name/restore', async (req, reply) => {
    let db: DatabaseSync | null = null;
    try {
      db = snapshots.open(req.params.name);
      const data = exportUser(db, credentialKey, req.user!.id, deps.version);
      db.close();
      db = null;
      const summary = importUser(store.db, credentialKey, req.user!.id, data);
      deps.onRestored(req.user!.id, summary);
      return { ok: true, summary };
    } catch (err) {
      return fail(reply, err);
    } finally {
      db?.close();
    }
  });

  // Each device's own settings (DreyMail 12.0): saved by the device on its schedule or by hand,
  // listed so another device (or the same one after a reinstall) can take them.
  const deviceId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
  app.get('/api/device-backups', async (req) =>
    (store.db.prepare('SELECT device_id, name, kind, updated_at, length(data) AS bytes FROM device_backups WHERE user_id = ? ORDER BY updated_at DESC').all(req.user!.id) as { device_id: string; name: string; kind: string; updated_at: number; bytes: number }[]).map((r) => ({
      deviceId: r.device_id,
      name: r.name,
      kind: r.kind,
      savedAt: new Date(r.updated_at).toISOString(),
      bytes: r.bytes,
    })),
  );
  app.put<{ Params: { id: string } }>('/api/device-backups/:id', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const id = deviceId.safeParse(req.params.id);
    const body = z.object({ name: z.string().trim().max(100).default(''), kind: z.enum(['browser', 'desktop', 'android']), data: z.record(z.string(), z.unknown()) }).safeParse(req.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: 'Check the device settings' });
    const data = JSON.stringify(body.data.data);
    if (data.length > 3 * 1024 * 1024) return reply.code(400).send({ error: 'These device settings are too large' });
    const count = (store.db.prepare('SELECT COUNT(*) AS n FROM device_backups WHERE user_id = ? AND device_id != ?').get(req.user!.id, id.data) as { n: number }).n;
    if (count >= 50) return reply.code(400).send({ error: 'Remove some saved devices first' });
    store.db
      .prepare('INSERT INTO device_backups (user_id, device_id, name, kind, data, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, device_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at')
      .run(req.user!.id, id.data, body.data.name, body.data.kind, data, Date.now());
    return { ok: true, savedAt: new Date().toISOString() };
  });
  const deviceRow = (userId: string, id: string) => store.db.prepare('SELECT name, kind, data, updated_at FROM device_backups WHERE user_id = ? AND device_id = ?').get(userId, id) as { name: string; kind: string; data: string; updated_at: number } | undefined;
  app.get<{ Params: { id: string } }>('/api/device-backups/:id', async (req, reply) => {
    const r = deviceRow(req.user!.id, req.params.id);
    if (!r) return reply.code(404).send({ error: 'No such saved device' });
    return { name: r.name, kind: r.kind, savedAt: new Date(r.updated_at).toISOString(), data: JSON.parse(r.data) as unknown };
  });
  // As a file (a plain GET, so the Android app's downloader saves it too).
  app.get<{ Params: { id: string } }>('/api/device-backups/:id/file', async (req, reply) => {
    const r = deviceRow(req.user!.id, req.params.id);
    if (!r) return reply.code(404).send({ error: 'No such saved device' });
    const name = `dreymail-device-${(r.name || r.kind).replace(/[^A-Za-z0-9._-]+/g, '_')}-${new Date(r.updated_at).toISOString().slice(0, 10)}.json`;
    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .send(r.data);
  });
  app.delete<{ Params: { id: string } }>('/api/device-backups/:id', async (req) => {
    store.db.prepare('DELETE FROM device_backups WHERE user_id = ? AND device_id = ?').run(req.user!.id, req.params.id);
    return { ok: true };
  });

  // Administrators: every automatic backup, and one made now.
  app.get('/api/admin/backups', async (req, reply) => {
    if (!access.require(req, reply, 'server.manage')) return reply;
    return { enabled: snapshots.enabled, keepDays: deps.keepDays(), backups: snapshots.list() };
  });
  app.post('/api/admin/backups', async (req, reply) => {
    if (!access.require(req, reply, 'server.manage')) return reply;
    try {
      return snapshots.create(true);
    } catch (err) {
      return fail(reply, err);
    }
  });
}
