// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Saving sent mail to Sent (9.6): no second copy when the server filed the message itself.

import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/imap/connect.js', async (orig) => ({
  ...(await orig<typeof import('../src/imap/connect.js')>()),
  createSmtpTransport: () => ({ sendMail: async () => ({}), close: () => undefined }),
}));

const { ComposeService } = await import('../src/mail/send.js');
const { Keyring } = await import('../src/crypto.js');
const { Store } = await import('../src/db.js');

function setup(filed: boolean) {
  const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
  const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
  const acc = store.createAccount(user.id, { name: 'Work', displayName: 'Sam', email: 'sam@example.com', color: '#22d3ee', imap: { host: 'imap.example.com', port: 993, tls: 'tls', user: 'sam', password: 'pw' }, smtp: { host: 'smtp.example.com', port: 465, tls: 'tls', user: 'sam', password: 'pw' }, appendSent: true } as never);
  const appended: string[] = [];
  const looked: string[] = [];
  const mail = {
    specialFolder: async () => 'Sent',
    hasMessageId: async (_u: string, _a: string, _f: string, id: string) => (looked.push(id), filed),
    append: async (_u: string, _a: string, folder: string) => void appended.push(folder),
  };
  const compose = new ComposeService(store, mail as never, { maxMessageBytes: 1e7, blockPrivateHosts: false });
  return { compose, user, acc, appended, looked };
}
const payload = (accountId: string) => ({ accountId, to: 'ada@example.com', cc: '', bcc: '', subject: 'Hi', html: '<p>Hi</p>', inReplyTo: null, references: [], forwardFrom: null, replaceDraft: null, answering: null }) as never;

describe('the copy in Sent', () => {
  it('is saved when the server did not file one', async () => {
    const t = setup(false);
    const r = await t.compose.send(t.user.id, payload(t.acc.id), []);
    expect(r.savedToSent).toBe(true);
    expect(t.looked).toEqual([r.messageId]);
    expect(t.appended).toEqual(['Sent']);
  });

  it('is not saved twice when the server filed it itself', async () => {
    const t = setup(true);
    const r = await t.compose.send(t.user.id, payload(t.acc.id), []);
    expect(r.savedToSent).toBe(true);
    expect(t.appended).toEqual([]);
  });
});
