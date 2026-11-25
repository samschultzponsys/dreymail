// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Starting quickly (DreyMail 14.4): the page's script asks for what the app asked for last time; the app takes those answers. */

const bootScript = /<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(import.meta.dirname, '../index.html'), 'utf8'))![1]!;

const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe("the page's first script", () => {
  const run = (saved: unknown, where = '/mail/a/INBOX') => {
    const fetch = vi.fn(() => Promise.resolve(json({})));
    const localStorage = storage();
    if (saved) localStorage.setItem('dreymail.boot', JSON.stringify(saved));
    const window: Record<string, unknown> = {};
    const [pathname, search = ''] = where.split(/(?=\?)/);
    vm.runInNewContext(bootScript, { window, localStorage, fetch, location: { pathname, search } });
    return { fetch, window };
  };

  it("asks for this page's requests at once, with the app's header, what the list needs first", () => {
    const { fetch, window } = run({ v: 1, routes: { '/mail/a/INBOX': ['/api/me', '/api/version', '/api/accounts', '/api/scheduled', '/api/messages?accountId=a&folder=INBOX'] }, common: ['/api/me'] });
    expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['/api/me', '/api/accounts', '/api/messages?accountId=a&folder=INBOX', '/api/version', '/api/scheduled']);
    expect((fetch.mock.calls[0] as unknown[])[1]).toEqual({ headers: { 'x-dreymail': '1' }, credentials: 'same-origin' });
    expect(Object.keys((window.__dmPreload as { requests: object }).requests)).toHaveLength(5);
  });
  it('asks only for what is not page-specific on a page not started on before', () => {
    const { fetch } = run({ v: 1, routes: { '/': ['/api/me', '/api/messages?x'] }, common: ['/api/me'] }, '/mail/b/Archive');
    expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['/api/me']);
  });
  it('asks for who you are and your mailboxes without memory (a new device), and never for anything but the API', () => {
    const urls = (saved: unknown) => run(saved).fetch.mock.calls.map((c) => (c as unknown[])[0]);
    expect(urls(null)).toEqual(['/api/me', '/api/accounts', '/api/groups']);
    expect(urls({ v: 2, routes: {} })).toEqual(['/api/me', '/api/accounts', '/api/groups']);
    const { fetch } = run({ v: 1, routes: { '/': ['https://evil.example/x', '//evil.example/y', '/auth/logout', 7, '/api/me'] } }, '/');
    expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['/api/me']);
  });
});

describe('the app takes what boot.js started', () => {
  let fetch: ReturnType<typeof vi.fn>;
  let win: Record<string, unknown>;
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fetch = vi.fn(() => Promise.resolve(json({ from: 'fetch' })));
    win = { location: { pathname: '/mail/a/INBOX', search: '' }, setTimeout, dispatchEvent: () => true };
    vi.stubGlobal('window', win);
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('fetch', fetch);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses an answer boot.js got once, then asks itself', async () => {
    win.__dmPreload = { at: Date.now(), requests: { '/api/me': Promise.resolve(json({ from: 'boot' })) } };
    const { request } = await import('../src/api');
    expect(await request('GET', '/api/me')).toEqual({ from: 'boot' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await request('GET', '/api/me')).toEqual({ from: 'fetch' });
  });
  it('ignores old answers, failed ones and anything but GET', async () => {
    win.__dmPreload = { at: Date.now() - 20_000, requests: { '/api/me': Promise.resolve(json({ from: 'boot' })) } };
    const { request } = await import('../src/api');
    expect(await request('GET', '/api/me')).toEqual({ from: 'fetch' });
    win.__dmPreload = { at: Date.now(), requests: { '/api/accounts': Promise.reject(new Error('offline')), '/api/send': Promise.resolve(json({ from: 'boot' })) } };
    expect(await request('GET', '/api/accounts')).toEqual({ from: 'fetch' });
    expect(await request('POST', '/api/send', {})).toEqual({ from: 'fetch' });
  });
  it('passes errors on as before (a signed-out start shows the sign-in page)', async () => {
    win.__dmPreload = { at: Date.now(), requests: { '/api/me': Promise.resolve(json({ error: 'Not signed in' }, 401)) } };
    const { request, ApiError } = await import('../src/api');
    await expect(request('GET', '/api/me')).rejects.toBeInstanceOf(ApiError);
  });
  it('remembers what it asked for in its first seconds, per page', async () => {
    const { request } = await import('../src/api');
    await request('GET', '/api/me');
    await request('GET', '/api/messages?accountId=a&folder=INBOX');
    await request('POST', '/api/folders/read', {});
    vi.advanceTimersByTime(5000);
    await request('GET', '/api/later');
    vi.advanceTimersByTime(5000);
    const saved = JSON.parse(localStorage.getItem('dreymail.boot')!);
    expect(saved.routes['/mail/a/INBOX']).toEqual(['/api/me', '/api/messages?accountId=a&folder=INBOX']);
    expect(saved.common).toEqual(['/api/me']);
  });
});
