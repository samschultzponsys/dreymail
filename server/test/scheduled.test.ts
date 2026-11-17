// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ComposePayload } from '../../shared/types.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { ScheduledSends } from '../src/mail/scheduled.js';

function setup(send: (payload: ComposePayload, files: { filename: string; content: Buffer }[]) => Promise<void>) {
  const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
  const u = store.upsertUser('local', 'sam', '', 'Sam');
  const a = store.createAccount(u.id, {
    name: 'G', displayName: 'S', email: 's@x.example', color: '#22d3ee',
    imap: { host: 'h', port: 993, tls: 'tls', user: 'u', password: 'p' }, smtp: { host: 'h', port: 465, tls: 'tls', user: 'u', password: 'p' }, appendSent: true,
  });
  const sched = new ScheduledSends(store, async (_u, p, f) => (await send(p, f), {} as never));
  const payload = { accountId: a.id, to: 'bob@example.com', cc: '', bcc: '', subject: 'Hello later', html: '<p>Hi</p>' } as ComposePayload;
  return { store, u, a, sched, payload };
}

describe('send later', () => {
  it('keeps the message sealed and sends it when due, attachments included', async () => {
    const sent: { subject: string; file: string }[] = [];
    const { store, u, sched, payload } = setup(async (p, f) => void sent.push({ subject: p.subject, file: f[0]!.content.toString() }));
    const s = sched.schedule(u.id, payload, [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('attached') }], Date.now() + 60_000);
    expect(s).toMatchObject({ subject: 'Hello later', to: 'bob@example.com', status: 'pending' });
    const row = store.db.prepare('SELECT message FROM scheduled_sends').get() as { message: string };
    expect(row.message).not.toContain('Hello later');
    await sched.tick();
    expect(sent).toEqual([]);
    expect(sched.sendNow(u.id, s.id)).toBe(true);
    await sched.tick();
    expect(sent).toEqual([{ subject: 'Hello later', file: 'attached' }]);
    expect(sched.list(u.id)).toEqual([]);
  });

  it('a failed send stays listed with its error; cancel removes it', async () => {
    const { u, sched, payload } = setup(async () => {
      throw new Error('SMTP said no');
    });
    const s = sched.schedule(u.id, payload, [], Date.now() - 1);
    await sched.tick();
    expect(sched.list(u.id)[0]).toMatchObject({ status: 'failed', error: 'SMTP said no' });
    expect(sched.cancel(u.id, s.id)).toBe(true);
    expect(sched.list(u.id)).toEqual([]);
  });

  it("someone else can't cancel it; a send cut off by a restart isn't resent blindly", () => {
    const { store, u, sched, payload } = setup(async () => undefined);
    const s = sched.schedule(u.id, payload, [], Date.now() + 1000);
    expect(sched.cancel('someone-else', s.id)).toBe(false);
    store.db.prepare("UPDATE scheduled_sends SET status = 'sending'").run();
    sched.start();
    sched.stop();
    expect(sched.list(u.id)[0]).toMatchObject({ status: 'failed' });
  });

  it('undo hands the message back, attachments included, only to its owner and only before it goes out', async () => {
    const sent: string[] = [];
    const { store, u, sched, payload } = setup(async (p) => void sent.push(p.subject));
    const s = sched.schedule(u.id, payload, [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('attached') }], Date.now() + 10_000);
    expect(Date.parse(s.createdAt)).toBeLessThanOrEqual(Date.now());
    expect(sched.takeBack('someone-else', s.id)).toBeNull();
    const back = sched.takeBack(u.id, s.id)!;
    expect(back.payload.subject).toBe('Hello later');
    expect(back.files).toEqual([{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('attached').toString('base64') }]);
    expect(sched.list(u.id)).toEqual([]);
    expect(sched.takeBack(u.id, s.id)).toBeNull();
    // Already going out: too late.
    const t = sched.schedule(u.id, payload, [], Date.now() + 10_000);
    store.db.prepare("UPDATE scheduled_sends SET status = 'sending' WHERE id = ?").run(t.id);
    expect(sched.takeBack(u.id, t.id)).toBeNull();
    await sched.tick();
    expect(sent).toEqual([]);
  });
});
