// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// One-click unsubscribe (RFC 8058): POST "List-Unsubscribe=One-Click" to the sender's https
// address. Public hosts only, no cookies, no redirects followed.

import { assertPublicHost } from './ssrf.js';

export class UnsubscribeError extends Error {}

export async function oneClickUnsubscribe(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsubscribeError('Not a valid unsubscribe address');
  }
  if (url.protocol !== 'https:') throw new UnsubscribeError('Only https unsubscribe links are followed');
  await assertPublicHost(url.hostname);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click', redirect: 'manual', signal: ctl.signal });
    if (res.status >= 400) throw new UnsubscribeError(`The sender's server answered ${res.status}; try their unsubscribe page instead`);
  } catch (err) {
    if (err instanceof UnsubscribeError) throw err;
    throw new UnsubscribeError(`Could not unsubscribe: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
