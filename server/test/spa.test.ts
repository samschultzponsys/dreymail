// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-15: the privacy page at /privacy.
// Modified by samschultzponsys, 2026-11-25: compressed files and long caching for hashed assets.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CSP, buildApp, cspFor, isSpaRequest, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

describe('isSpaRequest', () => {
  const html = 'text/html,application/xhtml+xml,*/*;q=0.8';
  it('serves the shell for client routes requested by a browser', () => {
    expect(isSpaRequest('GET', '/mail/abc/INBOX.Sent?open=abc.1.2', html)).toBe(true);
    expect(isSpaRequest('GET', '/mail/abc/Archive%2F2026', html)).toBe(true);
    expect(isSpaRequest('HEAD', '/', html)).toBe(true);
  });
  it('never swallows API, auth, health checks, non-GET or non-HTML requests', () => {
    expect(isSpaRequest('GET', '/api/nope', html)).toBe(false);
    expect(isSpaRequest('GET', '/api', html)).toBe(false);
    expect(isSpaRequest('GET', '/auth/whatever', html)).toBe(false);
    expect(isSpaRequest('GET', '/healthz', html)).toBe(false);
    expect(isSpaRequest('POST', '/mail/abc/INBOX', html)).toBe(false);
    expect(isSpaRequest('GET', '/assets/missing.js', '*/*')).toBe(false);
  });
});

describe("the page's Content-Security-Policy", () => {
  it("allows the page's own inline script by its hash, and nothing else", () => {
    const html = '<head><script>start()</script><script type="module" src="/assets/a.js"></script></head>';
    const hash = crypto.createHash('sha256').update('start()').digest('base64');
    expect(cspFor(html)).toContain(`script-src 'self' 'sha256-${hash}';`);
    expect(cspFor(html).split('; ').find((d) => d.startsWith('script-src'))).toBe(`script-src 'self' 'sha256-${hash}'`);
    expect(cspFor(null)).toBe(APP_CSP);
    expect(cspFor('<p>no scripts</p>')).toBe(APP_CSP);
  });
});

describe('SPA fallback in the production server', () => {
  let ctx: App;
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-web-'));

  beforeAll(async () => {
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>shell</title>');
    fs.writeFileSync(path.join(webDir, 'privacy.html'), '<!doctype html><title>Privacy</title>');
    // As scripts/compress-web.mjs leaves the build.
    fs.mkdirSync(path.join(webDir, 'assets'));
    const script = 'console.log("app");'.repeat(200);
    fs.writeFileSync(path.join(webDir, 'assets', 'index-AbC123.js'), script);
    fs.writeFileSync(path.join(webDir, 'assets', 'index-AbC123.js.br'), zlib.brotliCompressSync(script));
    fs.writeFileSync(path.join(webDir, 'assets', 'index-AbC123.js.gz'), zlib.gzipSync(script));
    const config = loadConfig({
      NODE_ENV: 'test',
      DREYMAIL_SECRET_KEY: crypto.randomBytes(48).toString('base64'),
      DREYMAIL_DEV_LOGIN: 'true',
      DREYMAIL_WEB_DIR: webDir,
    });
    ctx = await buildApp(config, { store: new Store(':memory:', new Keyring(config.secretKey).credentialKey), logger: false });
  });
  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(webDir, { recursive: true, force: true });
  });

  const get = (url: string, accept = 'text/html') => ctx.app.inject({ method: 'GET', url, headers: { accept } });

  it('answers deep links with index.html', async () => {
    const res = await get('/mail/3f2a9c1e/INBOX.Sent?open=3f2a9c1e.5.9');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>shell</title>');
  });
  it('keeps JSON errors for unknown API and auth paths', async () => {
    expect((await get('/api/does-not-exist')).headers['content-type']).toContain('application/json');
    const auth = await get('/auth/does-not-exist');
    expect(auth.statusCode).toBe(404);
    expect(auth.body).not.toContain('shell');
  });
  it('serves the privacy page at /privacy (for Google and Microsoft app registrations)', async () => {
    const res = await get('/privacy');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Privacy</title>');
  });
  it('sends the compressed build to browsers that accept it, and lets them keep hashed assets', async () => {
    const br = await ctx.app.inject({ method: 'GET', url: '/assets/index-AbC123.js', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.statusCode).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(zlib.brotliDecompressSync(br.rawPayload).toString()).toBe('console.log("app");'.repeat(200));
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const gz = await ctx.app.inject({ method: 'GET', url: '/assets/index-AbC123.js', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    const plain = await ctx.app.inject({ method: 'GET', url: '/assets/index-AbC123.js' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe('console.log("app");'.repeat(200));
    // The page itself is always checked again (it names the current assets).
    expect((await get('/mail/x/INBOX')).headers['cache-control']).toBe('no-cache');
  });
  it('does not answer missing assets with HTML', async () => {
    const res = await get('/assets/missing.js', '*/*');
    expect(res.statusCode).toBe(404);
  });
});
