// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Backups API (DreyMail 11.9). /api's preHandler has authenticated the user.

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
