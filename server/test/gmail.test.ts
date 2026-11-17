// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Gmail specifics (9.7): Archive moves to All Mail (Gmail has no Archive folder; DreyMail used to
// make an "Archive" label), and a message's labels are read and changed with X-GM-LABELS.

import { describe, expect, it } from 'vitest';
import { MailService } from '../src/imap/mail.js';

function fakeGmail(opts: { archiveFolder?: boolean } = {}) {
  const folders = [
    { path: 'INBOX', name: 'INBOX', flags: new Set<string>(), specialUse: '\\Inbox', delimiter: '/', parentPath: '' },
    { path: '[Gmail]', name: '[Gmail]', flags: new Set(['\\Noselect']), delimiter: '/', parentPath: '' },
    { path: '[Gmail]/All Mail', name: 'All Mail', flags: new Set<string>(), specialUse: '\\All', delimiter: '/', parentPath: '[Gmail]' },
    { path: '[Gmail]/Trash', name: 'Trash', flags: new Set<string>(), specialUse: '\\Trash', delimiter: '/', parentPath: '[Gmail]' },
    { path: 'Work', name: 'Work', flags: new Set<string>(), delimiter: '/', parentPath: '' },
    ...(opts.archiveFolder ? [{ path: 'Archive', name: 'Archive', flags: new Set<string>(), specialUse: '\\Archive', delimiter: '/', parentPath: '' }] : []),
  ];
  const calls: string[] = [];
  let labels = new Set(['\\Inbox', '\\Important', 'Work']);
  const client = {
    capabilities: new Set(['X-GM-EXT-1', 'UIDPLUS', 'MOVE']),
    fetchAll: async () => [{ uid: 7, envelope: { messageId: '<m@x>', from: [{ address: 'a@x' }] } }],
    fetchOne: async () => ({ uid: 7, labels }),
    messageMove: async (_r: string, dest: string) => (calls.push(`move ${dest}`), { uidValidity: 9n, uidMap: new Map([[7, 70]]) }),
    messageFlagsAdd: async (_r: string, f: string[], o: { useLabels?: boolean }) => {
      calls.push(`add ${f.join(',')}${o.useLabels ? ' (labels)' : ''}`);
      for (const x of f) labels.add(x);
    },
    messageFlagsRemove: async (_r: string, f: string[], o: { useLabels?: boolean }) => {
      calls.push(`remove ${f.join(',')}${o.useLabels ? ' (labels)' : ''}`);
      labels = new Set([...labels].filter((x) => !f.includes(x)));
    },
    mailboxCreate: async (p: string[]) => (calls.push(`create ${p.join('/')}`), { path: p.join('/') }),
  };
  const pool = {
    folders: async () => folders,
    withMailbox: async (_u: string, _a: string, _f: string, fn: (c: typeof client, m: { uidValidity: bigint }) => unknown) => fn(client, { uidValidity: 1n }),
    withClient: async (_u: string, _a: string, fn: (c: typeof client) => unknown) => fn(client),
  };
  return { mail: new MailService(pool as never, null), calls };
}
const ref = { accountId: 'a', folder: 'INBOX', uid: 7, uidValidity: '1' };

describe('Gmail', () => {
  it('archives to All Mail instead of making an Archive label', async () => {
    const g = fakeGmail();
    const r = await g.mail.applyAction('u', 'a', 'INBOX', '1', [7], { type: 'archive' });
    expect(g.calls).toEqual(['move [Gmail]/All Mail']);
    expect(r).toMatchObject({ createdFolder: null, undo: { folder: '[Gmail]/All Mail', uids: [70], restoreTo: 'INBOX' } });
  });

  it('still uses a real Archive folder where there is one', async () => {
    const g = fakeGmail({ archiveFolder: true });
    await g.mail.applyAction('u', 'a', 'INBOX', '1', [7], { type: 'archive' });
    expect(g.calls).toEqual(['move Archive']);
  });

  it('reads and changes labels', async () => {
    const g = fakeGmail();
    expect(await g.mail.labels('u', ref)).toEqual({ labels: ['INBOX', 'Work'], available: ['INBOX', 'Work'] });
    await g.mail.setLabels('u', ref, [], ['INBOX']);
    expect(g.calls).toEqual(['remove \\Inbox (labels)']);
    expect((await g.mail.labels('u', ref))!.labels).toEqual(['Work']);
  });
});
