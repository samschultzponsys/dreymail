// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { MAIL_PROVIDERS, isMicrosoftAddress, providerForEmail, providerForServers } from '../../shared/mailProviders.js';

describe('mail provider presets', () => {
  it('are complete and consistent', () => {
    const ids = new Set<string>();
    const domains = new Set<string>();
    for (const p of MAIL_PROVIDERS) {
      expect(ids.has(p.id), p.id).toBe(false);
      ids.add(p.id);
      for (const s of [p.imap, p.smtp]) {
        expect(s.host).toMatch(/^[a-z0-9.-]+$/);
        expect(s.port).toBeGreaterThan(0);
        expect(['tls', 'starttls']).toContain(s.tls);
      }
      // SMTP: implicit TLS only on 465, STARTTLS elsewhere.
      if (p.smtp.tls === 'tls') expect(p.smtp.port, p.id).toBe(465);
      else expect(p.smtp.port, p.id).not.toBe(465);
      for (const d of p.domains) {
        expect(domains.has(d), d).toBe(false);
        domains.add(d);
      }
    }
  });

  it('are picked from the address, and recognized from the servers', () => {
    expect(providerForEmail('Someone@iCloud.com')?.id).toBe('icloud');
    expect(providerForEmail('a@gmx.de')?.id).toBe('gmx-net');
    expect(providerForEmail('a@my-own-domain.com')).toBeNull();
    expect(providerForEmail('not an address')).toBeNull();
    expect(isMicrosoftAddress('a@hotmail.com')).toBe(true);
    expect(providerForServers('imap.fastmail.com', 'smtp.fastmail.com')?.name).toBe('Fastmail');
    expect(providerForServers('imap.fastmail.com', 'smtp.other.com')).toBeNull();
  });
});
