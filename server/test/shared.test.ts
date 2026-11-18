// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Shared Microsoft 365 mailboxes (10.5): opened over IMAP as the shared address with the parent
// mailbox's sign-in; removed with it; not offered for calendars a second time.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

describe('shared mailboxes', () => {
  it("use the parent's sign-in, and go with it", () => {
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
    const work = store.saveMicrosoftAccount(user.id, { email: 'sam@corp.com', name: 'Work', displayName: 'Sam', color: '#0078d4', refreshToken: 'rt-1' });
    const gmail = store.saveGoogleAccount(user.id, { email: 'sam@gmail.com', name: 'Gmail', displayName: 'Sam', color: '#ef4444', refreshToken: 'g' });
    expect(() => store.addSharedMailbox(user.id, gmail.id, { email: 'x@corp.com', name: 'X', color: '#000000' })).toThrow(/Microsoft/);
    const support = store.addSharedMailbox(user.id, work.id, { email: 'support@corp.com', name: 'Support', color: '#0ea5e9' });
    expect(support).toMatchObject({ auth: 'microsoft', sharedOf: work.id, email: 'support@corp.com', imap: { host: 'outlook.office365.com', user: 'support@corp.com' } });
    // The token is the parent's; a rotated token is kept on the parent.
    expect(store.getOAuthToken(user.id, support.id)).toBe('rt-1');
    store.setOAuthToken(user.id, support.id, 'rt-2');
    expect(store.getOAuthToken(user.id, work.id)).toBe('rt-2');
    expect(store.getAccountSecret(user.id, support.id)!.imap.oauth).toEqual({ provider: 'microsoft', userId: user.id, accountId: support.id });
    // Removing the parent removes the shared mailbox.
    store.deleteAccount(user.id, work.id);
    expect(store.listAccounts(user.id).map((a) => a.email)).toEqual(['sam@gmail.com']);
  });
});
