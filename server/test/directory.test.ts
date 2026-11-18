// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { Directory } from '../src/directory.js';

describe('company directory in suggestions (10.3)', () => {
  it('asks Microsoft 365 and Google Workspace where allowed, and merges the answers', async () => {
    const store = new Store(':memory:', new Keyring(crypto.randomBytes(48).toString('base64')).credentialKey);
    const user = store.upsertUser('local', 'sam', '', 'Sam', 'sam');
    store.saveMicrosoftAccount(user.id, { email: 'sam@corp.com', name: 'Work', displayName: 'Sam', color: '#0078d4', refreshToken: 'rt' });
    const gg = store.saveGoogleAccount(user.id, { email: 'sam@gmail.com', name: 'Gmail', displayName: 'Sam', color: '#ef4444', refreshToken: 'rt' });
    const urls: string[] = [];
    const dir = new Directory({
      store,
      microsoft: { accessToken: async () => 'mt' } as never,
      // Google: directory not allowed for this mailbox.
      google: { accessToken: async () => 'gt', allowed: async () => false } as never,
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ value: [{ displayName: 'Ada Lovelace', scoredEmailAddresses: [{ address: 'Ada@Corp.com' }] }, { displayName: 'No mail', scoredEmailAddresses: [] }] }) };
      },
    });
    expect(await dir.search(user.id, 'a')).toEqual([]);
    expect(await dir.search(user.id, 'ada')).toEqual([{ name: 'Ada Lovelace', address: 'ada@corp.com' }]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/me/people?$search=%22ada%22');
    expect(await dir.available(user.id, gg.id)).toBe(false);
  });
});
