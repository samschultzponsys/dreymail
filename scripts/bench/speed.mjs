// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// How fast DreyMail is, measured end to end (DreyMail 14.2). Compares builds against a GreenMail
// mail server (Docker) behind a proxy that adds a realistic network: by default 80 ms round trip
// and 50 Mbit/s, about what a home server sees talking to Office 365.
//
//   node scripts/bench/speed.mjs <label>=<path to dist/server/server/src/app.js> [...more]
//        [--suite open|list|search|actions|startup] [--rtt 80] [--mbit 50] [--reps 5]
//
// Suites: open (messages, conversations, pictures), list (folders), search (word searches and
// filters, one folder and all mail), actions (read, flag, archive, delete, send), startup (the built web app
// in Chromium, from opening it to the mail list, on a desktop on the LAN and a phone on 4G; the
// build's dist/web is served).
//
// Each build runs in its own process, on a fresh mailbox seeded the same way, with its own
// default settings (what people get). Prints the median and the slowest of each measurement.

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

if (process.env.BENCH_CHILD) await child(JSON.parse(process.env.BENCH_CHILD));
else await driver();

// ---- driver: GreenMail, the slow network, one process per build ------------------------------

async function driver() {
  const builds = args.filter((a) => a.includes('=') && !a.startsWith('--')).map((a) => a.split('='));
  if (!builds.length) throw new Error('usage: speed.mjs <label>=<dist app.js> ...');
  const rtt = Number(opt('rtt', 80));
  const mbit = Number(opt('mbit', 50));
  const reps = Number(opt('reps', 5));
  const suite = opt('suite', 'open');
  const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
  const id = docker('run', '-d', '--rm', '-p', '127.0.0.1::3025', '-p', '127.0.0.1::3143', '-e',
    'GREENMAIL_OPTS=-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled', 'greenmail/standalone:2.1.3');
  const port = (p) => Number(docker('port', id, `${p}/tcp`).split('\n')[0].split(':').pop());
  const imapPort = port(3143);
  const smtpPort = port(3025);
  try {
    await waitForGreeting(imapPort);
    const proxy = await slowProxy(imapPort, rtt / 2, (mbit * 1e6) / 8 / 1000);
    // Sending goes over the same kind of network.
    const smtpProxy = await slowProxy(smtpPort, rtt / 2, (mbit * 1e6) / 8 / 1000);
    const results = {};
    for (const [label, app] of builds) {
      process.stderr.write(`\n== ${label} ==\n`);
      const webPort = suite === 'startup' ? await freePort() : 0;
      results[label] = await new Promise((resolve, reject) => {
        const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1]], {
          env: { ...process.env, NODE_ENV: 'test', BENCH_CHILD: JSON.stringify({ app, imapPort, slowPort: proxy.port, smtpPort, slowSmtpPort: smtpProxy.port, reps, suite, webPort }) },
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        let out = '';
        let measured = null;
        c.stdout.on('data', (d) => {
          out += d;
          // startup: the server is ready; the browser measures, then the server is stopped.
          const ready = out.match(/^READY (.*)$/m);
          if (ready && !measured) {
            measured = browserRuns(`http://127.0.0.1:${webPort}`, JSON.parse(ready[1]).cookie, reps).then(
              (r) => (c.stdin.end('stop\n'), r),
              (err) => (c.kill(), reject(err)),
            );
          }
        });
        c.on('exit', async (code) => {
          if (measured) return resolve(await measured);
          code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(`${label} exited ${code}`));
        });
      });
    }
    proxy.close();
    smtpProxy.close();
    report(results, { rtt, mbit, reps });
  } finally {
    docker('rm', '-f', id);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The built web app in Chromium, from opening it to the mail list: a desktop on the LAN and a phone
 * on 4G (slower network, 4× slower processor), each a first visit (nothing cached) and a reload.
 */
async function browserRuns(baseUrl, cookie, reps) {
  // Playwright isn't one of DreyMail's dependencies: installed globally (or with npm i --no-save playwright).
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  const profiles = {
    'desktop on the LAN': { latency: 2, down: 200e6 / 8, up: 200e6 / 8, cpu: 1, viewport: { width: 1400, height: 900 }, mobile: false },
    'phone on 4G': { latency: 120, down: 12e6 / 8, up: 4e6 / 8, cpu: 4, viewport: { width: 390, height: 844 }, mobile: true },
  };
  const out = {};
  const add = (k, v) => (out[k] ??= []).push(v);
  try {
    for (const [name, p] of Object.entries(profiles)) {
      for (let r = 0; r < reps; r++) {
        const context = await browser.newContext({ viewport: p.viewport, isMobile: p.mobile, hasTouch: p.mobile });
        await context.addCookies([{ name: 'dm_session', value: cookie.replace(/^dm_session=/, ''), url: baseUrl }]);
        // When the first list row shows and the loading screen goes, from the start of navigation.
        await context.addInitScript(() => {
          const w = window;
          w.__dm = { row: null, splash: null };
          let seen = false;
          const check = () => {
            const t = performance.now();
            if (w.__dm.row === null && document.querySelector('.row-main')) w.__dm.row = t;
            const s = document.getElementById('splash');
            // Gone once it was there (a slow page arrives in pieces: not before it is parsed).
            if (s) seen = true;
            if (w.__dm.splash === null && seen && (!s || s.classList.contains('gone'))) w.__dm.splash = t;
          };
          new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        });
        const page = await context.newPage();
        // The page's own script must run: a blocked one (Content-Security-Policy) is counted.
        let blocked = 0;
        page.on('console', (msg) => {
          if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) blocked++;
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: p.latency, downloadThroughput: p.down, uploadThroughput: p.up });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });
        let bytes = 0;
        let requests = 0;
        // BENCH_WATERFALL=1: each request's start and end (ms since navigation), first run only.
        const timeline = new Map();
        let navStart = 0;
        cdp.on('Network.requestWillBeSent', (e) => {
          requests++;
          if (e.type === 'Document') navStart = e.timestamp;
          timeline.set(e.requestId, { url: e.request.url.replace(baseUrl, ''), start: e.timestamp });
        });
        cdp.on('Network.loadingFinished', (e) => {
          bytes += e.encodedDataLength;
          const t = timeline.get(e.requestId);
          if (t) t.end = e.timestamp;
        });
        for (const visit of ['first visit', 'reload']) {
          bytes = 0;
          requests = 0;
          if (visit === 'first visit') await page.goto(`${baseUrl}/`, { waitUntil: 'commit' });
          else await page.reload({ waitUntil: 'commit' });
          await page.waitForFunction(() => window.__dm.row !== null && window.__dm.splash !== null, null, { timeout: 60_000, polling: 50 });
          const m = await page.evaluate(() => window.__dm);
          add(`${name}, ${visit}: mail list shown`, m.row);
          add(`${name}, ${visit}: loading screen gone`, m.splash);
          // Let the app settle (WebSocket, background requests, and what it remembers for its next
          // start, 4 s in) before counting what it loaded and starting again.
          await page.waitForTimeout(5000);
          if (process.env.BENCH_WATERFALL && r === 0) {
            const rows = [...timeline.values()].filter((t) => t.start >= navStart).sort((x, y) => x.start - y.start);
            process.stderr.write(`  ${name}, ${visit} (list ${Math.round(m.row)}, loading screen ${Math.round(m.splash)}):\n${rows.map((t) => `    ${String(Math.round((t.start - navStart) * 1000)).padStart(5)} → ${t.end ? String(Math.round((t.end - navStart) * 1000)).padStart(5) : '    …'}  ${t.url.slice(0, 90)}`).join('\n')}\n`);
          }
          timeline.clear();
          add(`${name}, ${visit}: downloaded (KB)`, bytes / 1024);
          add(`${name}, ${visit}: requests`, requests);
          add(`${name}, ${visit}: scripts blocked (must be 0)`, blocked);
          blocked = 0;
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}

function report(results, net) {
  const labels = Object.keys(results);
  const keys = [...new Set(labels.flatMap((l) => Object.keys(results[l])))];
  const stat = (xs) => {
    if (!xs?.length) return '–';
    const s = [...xs].sort((a, b) => a - b);
    return `${Math.round(s[Math.floor((s.length - 1) / 2)])} / ${Math.round(s.at(-1))}`;
  };
  console.log(`\nNetwork: ${net.rtt} ms round trip, ${net.mbit} Mbit/s; ${net.reps} runs each. Milliseconds, median / slowest.\n`);
  console.log(`| Measurement | ${labels.join(' | ')} |`);
  console.log(`|---|${labels.map(() => '---:').join('|')}|`);
  for (const k of keys) console.log(`| ${k} | ${labels.map((l) => stat(results[l][k])).join(' | ')} |`);
}

async function waitForGreeting(port) {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('data', (d) => (s.destroy(), resolve(d.toString().startsWith('* OK'))));
      s.once('error', () => resolve(false));
      s.once('close', () => resolve(false));
      s.setTimeout(2000, () => (s.destroy(), resolve(false)));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('GreenMail did not start');
}

/** A TCP proxy that delays every byte by `oneWayMs` and limits each direction to `bytesPerMs`. */
function slowProxy(target, oneWayMs, bytesPerMs) {
  const lane = (dst) => {
    const queue = [];
    let free = 0;
    let timer = null;
    const pump = () => {
      timer = null;
      const now = performance.now();
      while (queue.length && queue[0].at <= now) dst.write(queue.shift().chunk);
      if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0].at - now));
    };
    return (chunk) => {
      const now = performance.now();
      free = Math.max(now, free) + chunk.length / bytesPerMs;
      queue.push({ at: free + oneWayMs, chunk });
      if (!timer) timer = setTimeout(pump, Math.max(0, queue[0].at - now));
    };
  };
  const server = net.createServer((client) => {
    const upstream = net.connect(target, '127.0.0.1');
    const up = lane(upstream);
    const down = lane(client);
    client.on('data', up);
    upstream.on('data', down);
    const end = () => (client.destroy(), upstream.destroy());
    client.on('close', end);
    upstream.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() })));
}

// ---- child: one build, measured ---------------------------------------------------------------

async function child({ app: appPath, imapPort, slowPort, smtpPort, slowSmtpPort, reps, suite, webPort }) {
  const root = path.resolve(path.dirname(appPath));
  const { buildApp } = await import(pathToFileURL(appPath).href);
  const { loadConfig } = await import(pathToFileURL(path.join(root, 'config.js')).href);
  const { Keyring } = await import(pathToFileURL(path.join(root, 'crypto.js')).href);
  const { Store } = await import(pathToFileURL(path.join(root, 'db.js')).href);
  const { ImapFlow } = await import('imapflow');
  const { DatabaseSync } = await import('node:sqlite');
  const log = (...m) => process.stderr.write(`${m.join(' ')}\n`);

  const user = `bench-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const direct = async (fn, as = user) => {
    const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: { user: as, pass: 'x' }, logger: false });
    c.on('error', () => {});
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.logout();
    }
  };

  // Mail like a work inbox: mostly short mail, some newsletters, some photos.
  const lorem = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: ${crypto.randomBytes(48).toString('base64')} quarterly figures, schedules and notes.`).join(' ');
  const textMail = (subject, thread = {}, extra = '') => mime(subject, 'text/plain', `${lorem(30)} ${extra}`, thread);
  const newsletter = (subject) => mime(subject, 'text/html', `<html><body><table width="600">${Array.from({ length: 300 }, (_, i) => `<tr><td style="font-family:Arial;color:#333;padding:8px"><h3>Story ${i}</h3><p>${lorem(3)}</p><a href="https://example.com/${i}">Read more</a></td></tr>`).join('')}</table></body></html>`);
  const photos = (subject, n = 2, bytes = 4_000_000) => {
    const parts = Array.from({ length: n }, (_, i) => `--b\r\nContent-Type: image/jpeg; name=photo${i}.jpg\r\nContent-Disposition: attachment; filename=photo${i}.jpg\r\nContent-Transfer-Encoding: base64\r\n\r\n${crypto.randomBytes(bytes).toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n`).join('');
    return Buffer.from(`${head(subject)}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nPhotos from the weekend\r\n${parts}--b--\r\n`);
  };
  function head(subject, { id, inReplyTo } = {}) {
    const thread = inReplyTo ? `In-Reply-To: ${inReplyTo}\r\nReferences: ${inReplyTo}\r\n` : '';
    return `From: Kim <kim@example.com>\r\nTo: ${user}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: ${id ?? `<${crypto.randomUUID()}@example.com>`}\r\n${thread}`;
  }
  function mime(subject, type, body, thread) {
    return Buffer.from(`${head(subject, thread)}MIME-Version: 1.0\r\nContent-Type: ${type}; charset=utf-8\r\n\r\n${body}\r\n`);
  }

  log('seeding');
  const user2 = `bench2-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await direct(async (c) => {
    await c.mailboxCreate('Sent').catch(() => undefined);
    if (suite === 'search' || suite === 'actions') {
      // A work mailbox of ten folders; one message in ten (in every folder) mentions the lighthouse.
      const word = (i) => (i % 10 === 3 ? 'lighthouse' : '');
      for (let i = 0; i < 300; i++) await c.append('INBOX', textMail(`Thread ${i}`, { id: `<t${i}@bench.example>` }, word(i)), i % 7 === 0 ? [] : ['\\Seen']);
      for (let i = 0; i < 120; i++) await c.append('Sent', textMail(`Re: Thread ${i * 2}`, { inReplyTo: `<t${i * 2}@bench.example>` }, word(i)), ['\\Seen']);
      for (const f of ['Archive', 'Trash', 'Projects', 'Receipts', 'Travel', 'Family', 'Clients', 'Old']) {
        await c.mailboxCreate(f).catch(() => undefined);
        for (let i = 0; i < 60; i++) await c.append(f, textMail(`${f} note ${i}`, {}, word(i)), ['\\Seen']);
      }
      return;
    }
    if (suite === 'list' || suite === 'startup') {
      // A work mailbox: conversations with your replies in Sent, an Archive, some unread mail.
      for (let i = 0; i < 300; i++) await c.append('INBOX', textMail(`Thread ${i}`, { id: `<t${i}@bench.example>` }), i % 7 === 0 ? [] : ['\\Seen']);
      for (let i = 0; i < 120; i++) await c.append('Sent', textMail(`Re: Thread ${i * 2}`, { inReplyTo: `<t${i * 2}@bench.example>` }), ['\\Seen']);
      await c.mailboxCreate('Archive').catch(() => undefined);
      for (let i = 0; i < 250; i++) await c.append('Archive', textMail(`Archived ${i}`), ['\\Seen']);
      return;
    }
    for (let i = 0; i < 250; i++) await c.append('INBOX', textMail(`Note ${i}`), ['\\Seen']);
    for (let i = 0; i < 40; i++) await c.append('INBOX', newsletter(`Newsletter ${i}`), ['\\Seen']);
    for (let i = 0; i < 10; i++) await c.append('INBOX', photos(`Photos ${i}`), []);
  });
  if (suite === 'list' || suite === 'startup') {
    await direct(async (c) => {
      await c.mailboxCreate('Sent').catch(() => undefined);
      for (let i = 0; i < 150; i++) await c.append('INBOX', textMail(`Second ${i}`), ['\\Seen']);
    }, user2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreymail-bench-'));
  const cacheFile = path.join(dir, 'cache.db');
  const config = loadConfig({
    NODE_ENV: 'test',
    DREYMAIL_SECRET_KEY: crypto.randomBytes(48).toString('base64'),
    DREYMAIL_DEV_LOGIN: 'true',
    DREYMAIL_DATA_DIR: '/nonexistent-not-used',
    DREYMAIL_BASE_URL: webPort ? `http://127.0.0.1:${webPort}` : 'http://localhost:8080',
    // startup: this build's web app.
    DREYMAIL_WEB_DIR: path.resolve(path.dirname(appPath), '../../../web'),
  });
  const store = new Store(':memory:', new Keyring(config.secretKey).credentialKey);
  const ctx = await buildApp(config, { store, logger: false, cacheFile, pushTransport: async () => 'sent', pushHostCheck: async () => {} });
  await ctx.app.ready();
  const login = await ctx.app.inject({ method: 'GET', url: '/auth/dev-login' });
  const cookie = `dm_session=${login.cookies.find((c) => c.name === 'dm_session').value}`;
  const api = async (method, url, body) => {
    const res = await ctx.app.inject({ method, url, headers: { cookie, 'x-dreymail': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body.slice(0, 200)}`);
    return res;
  };
  const userId = (await api('GET', '/api/me')).json().id;
  const server = { host: '127.0.0.1', port: slowPort, tls: 'none', user, password: 'pw' };
  // Sent mail is saved to Sent by DreyMail (as for Outlook and most servers), over the same slow network.
  const account = (await api('POST', '/api/accounts', { name: 'Bench', displayName: 'Bench', email: user, color: '#224466', imap: server, smtp: { ...server, port: slowSmtpPort ?? smtpPort }, appendSent: suite === 'actions' })).json();
  // Watched like a session would (notifications on: the server follows the inbox).
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  await api('POST', '/api/push/subscriptions', { endpoint: 'https://fcm.googleapis.com/fcm/send/bench', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });

  const sync = ctx.cacheSync;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Nothing under way: the inbox synced and watched, and the background filling done. */
  const settled = async (acc = account, folders = [], maxMs = 600_000) => {
    const end = Date.now() + maxMs;
    let quiet = 0;
    let last = '';
    const began = Date.now();
    while (Date.now() < end) {
      const t = Date.now();
      await sync.idle();
      const current = sync.isCurrent(userId, acc.id, 'INBOX') && folders.every((p) => !!sync.ready(userId, acc.id, p));
      const indexing = sync.isIndexing(userId, acc.id);
      const state = `current=${current} indexing=${indexing} idle-wait=${Date.now() - t > 1000 ? 'long' : 'short'}`;
      if (process.env.BENCH_DEBUG && state !== last) log(`  +${((Date.now() - began) / 1000).toFixed(1)}s ${state}`);
      last = state;
      if (current && !indexing) {
        if (++quiet >= 5) return;
      } else quiet = 0;
      await sleep(200);
    }
    throw new Error('never settled');
  };
  const list = async () => (await api('GET', `/api/messages?accountId=${account.id}&folder=INBOX&limit=50`)).json().messages;
  const ref = (m) => `accountId=${account.id}&folder=INBOX&uid=${m.uid}&uidValidity=${m.uidValidity}`;
  const timed = async (fn, label = '') => {
    const t = performance.now();
    traceFrom = t;
    trace.length = 0;
    await fn();
    const ms = performance.now() - t;
    if (process.env.BENCH_TRACE && label) log(`  trace ${label}: ${Math.round(ms)} ms\n    ${trace.join('\n    ')}`);
    return ms;
  };
  const dropBodies = (uids) => {
    const db = new DatabaseSync(cacheFile);
    db.exec('PRAGMA busy_timeout = 5000');
    const stmt = db.prepare(`DELETE FROM bodies WHERE uid = ? AND folder_id = (SELECT id FROM folders WHERE account_id = ? AND path = 'INBOX')`);
    for (const u of uids) stmt.run(u, account.id);
    db.close();
  };
  const out = {};
  const add = (k, v) => (out[k] ??= []).push(v);

  // BENCH_TRACE=1: when each sync step starts and ends (ms since the arrival), for working out delays.
  const trace = [];
  let traceFrom = 0;
  if (process.env.BENCH_TRACE) {
    const wrap = (obj, name, label = name) => {
      const orig = obj[name];
      obj[name] = function (...a) {
        const t = performance.now();
        const lane = a.find((x) => typeof x === 'string' && /^(main|read|sync|folders|search\d)$/.test(x)) ?? (name === 'withMailbox' ? 'main' : '');
        const folder = name === 'withMailbox' && typeof a[2] === 'string' ? ` ${a[2]}` : '';
        const done = () => trace.push(`${label}${lane ? `(${lane}${folder})` : ''} ${Math.round(t - traceFrom)}→${Math.round(performance.now() - traceFrom)}`);
        const r = orig.apply(this, a);
        if (r && typeof r.then === 'function') r.then(done, done);
        else done();
        return r;
      };
    };
    for (const m of ['update', 'prefetch', 'fill', 'fetchBodies', 'beforeListing']) if (typeof sync[m] === 'function') wrap(sync, m);
    wrap(ctx.pool, 'withMailbox', 'imap');
    wrap(ctx.pool, 'withClient', 'client');
  }
  /** Requests to the mail server while `fn` runs (deterministic, unlike times). */
  let imapCalls = 0;
  let counting = false;
  const countImap = () => {
    if (counting) return;
    counting = true;
    for (const name of ['withMailbox', 'withClient']) {
      const orig = ctx.pool[name];
      ctx.pool[name] = function (...a) {
        imapCalls++;
        return orig.apply(this, a);
      };
    }
  };
  const measured = async (label, fn) => {
    countImap();
    const before = imapCalls;
    const t = performance.now();
    traceFrom = t;
    trace.length = 0;
    const res = await fn();
    add(label, performance.now() - t);
    add(`${label} (mail-server requests)`, imapCalls - before);
    if (process.env.BENCH_TRACE) log(`  trace ${label}: ${Math.round(performance.now() - t)} ms\n    ${trace.join('\n    ')}`);
    return res;
  };
  const folders = ['Sent', 'Archive', 'Trash', 'Projects', 'Receipts', 'Travel', 'Family', 'Clients', 'Old'];

  log('first sync and background filling');
  const t0 = performance.now();
  await settled();
  add('setup: first fill of 300 messages (s, informational)', (performance.now() - t0) / 1000);
  if (suite === 'startup') {
    // Two mailboxes (All inboxes), filled; then the browser measures (see browserRuns).
    const account2 = (await api('POST', '/api/accounts', { name: 'Bench 2', displayName: 'Bench 2', email: user2, color: '#664422', imap: { ...server, user: user2 }, smtp: { ...server, user: user2, port: smtpPort }, appendSent: false })).json();
    await settled(account, ['Sent']);
    await settled(account2);
    await ctx.app.listen({ port: webPort, host: '127.0.0.1' });
    process.stdout.write(`READY ${JSON.stringify({ cookie })}\n`);
    await new Promise((resolve) => process.stdin.once('data', resolve));
    await ctx.app.close();
    process.exit(0);
  }
  if (suite === 'search' || suite === 'actions') {
    await (suite === 'search' ? searchSuite() : actionsSuite());
    await ctx.app.close();
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  if (suite === 'list') {
    await listSuite();
    await ctx.app.close();
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }

  /**
   * The app's list, as the web app keeps it: fetched again whenever the server says the inbox
   * changed (IMAP IDLE saw something, or a sync finished), one request at a time.
   */
  let onInbox = () => {};
  const forward = ctx.pool.onEvent;
  ctx.pool.onEvent = (u, e) => {
    if (e.type === 'mailbox' && e.folder === 'INBOX') onInbox();
    forward(u, e);
  };
  const listedWhen = (subject, start) =>
    new Promise((resolve, reject) => {
      let inflight = false;
      let again = false;
      let done = false;
      const refresh = async () => {
        if (done) return;
        if (inflight) {
          again = true;
          return;
        }
        inflight = true;
        try {
          do {
            again = false;
            const m = (await list()).find((x) => x.subject === subject);
            if (m && !done) {
              done = true;
              clearTimeout(giveUp);
              onInbox = () => {};
              resolve({ m, at: performance.now() });
            }
          } while (again && !done);
        } finally {
          inflight = false;
        }
      };
      const giveUp = setTimeout(() => ((done = true), reject(new Error(`${subject} never listed`))), 120_000);
      onInbox = () => void refresh();
      void refresh();
    });

  /** Mail arrives (from another client); the user clicks the newest as soon as it is listed. */
  const arrival = async (name, make, n) => {
    for (let r = 0; r < reps; r++) {
      await settled();
      const subjects = Array.from({ length: n }, (_, i) => `${name} ${r}.${i}`);
      const start = performance.now();
      traceFrom = start;
      trace.length = 0;
      const shown = listedWhen(subjects.at(-1), start);
      await direct(async (c) => {
        for (const s of subjects) await c.append('INBOX', make(s), []);
      });
      const { m: newest, at: listed } = await shown;
      await api('GET', `/api/message?${ref(newest)}`);
      const opened = performance.now();
      add(`${name}: arrival → listed`, listed - start);
      add(`${name}: listed → open`, opened - listed);
      add(`${name}: arrival → open`, opened - start);
      if (process.env.BENCH_TRACE) log(`  trace ${name} #${r}: listed ${Math.round(listed - start)}, opened ${Math.round(opened - start)}\n    ${trace.join('\n    ')}`);
    }
  };
  async function searchSuite() {
    log('  filling and indexing every folder');
    await settled(account, folders);
    const get = (url) => api('GET', url).then((r) => r.json());
    const inFolder = (p, extra) => `/api/messages?accountId=${account.id}&folder=${encodeURIComponent(p)}&limit=50${extra}`;
    const all = (extra) => `/api/messages?limit=50&filter=${encodeURIComponent(JSON.stringify({ where: 'all' }))}${extra}`;
    const fromKim = encodeURIComponent(JSON.stringify({ from: 'kim' }));
    for (let r = 0; r < reps; r++) {
      log(`  search round ${r + 1}`);
      await settled(account, folders);
      const hits = await measured('inbox: a word', () => get(inFolder('INBOX', '&q=lighthouse')));
      if (hits.messages.length !== 30) throw new Error(`inbox search found ${hits.messages.length}, not 30`);
      await measured('inbox: a word, quick answer from the index', () => get(inFolder('INBOX', '&q=lighthouse&quick=1')));
      await measured('Archive: a word', () => get(inFolder('Archive', '&q=lighthouse')));
      const everywhere = await measured('all mail (10 folders): a word', () => get(all('&q=lighthouse')));
      if (everywhere.messages.length < 50) throw new Error(`all-mail search found ${everywhere.messages.length}`);
      await measured('inbox: from (a filter)', () => get(inFolder('INBOX', `&filter=${fromKim}`)));
      await measured('all mail: a word and unread only', () => get(all('&q=lighthouse&unread=1')));
    }
  }

  async function actionsSuite() {
    await settled(account, folders);
    const inbox = async () => (await api('GET', `/api/messages?accountId=${account.id}&folder=INBOX&limit=200`)).json().messages;
    const act = (messages, action) => api('POST', '/api/messages/actions', { messages: messages.map(({ accountId, folder, uid, uidValidity }) => ({ accountId, folder, uid, uidValidity })), action });
    const multipart = (payload) => {
      const b = `----bench${crypto.randomUUID()}`;
      return { body: `--${b}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n--${b}--\r\n`, type: `multipart/form-data; boundary=${b}` };
    };
    for (let r = 0; r < reps; r++) {
      log(`  actions round ${r + 1}`);
      await settled(account, folders);
      const msgs = await inbox();
      const [a, b, c, d] = msgs.slice(r * 4, r * 4 + 4);
      await measured('mark read', () => act([a], { type: 'seen', value: !a.seen }));
      await measured('flag', () => act([b], { type: 'flagged', value: true }));
      await measured('mark 20 read at once', () => act(msgs.slice(100 + r * 20, 120 + r * 20), { type: 'seen', value: true }));
      await measured('archive', () => act([c], { type: 'archive' }));
      await measured('delete (to Trash)', () => act([d], { type: 'delete' }));
      const { body, type } = multipart({ accountId: account.id, to: user, cc: '', bcc: '', subject: `Bench send ${r}`, html: `<p>${lorem(5)}</p>`, inReplyTo: null, references: [], forwardFrom: null, replaceDraft: null, answering: null });
      await measured('send (and save to Sent)', async () => {
        const res = await ctx.app.inject({ method: 'POST', url: '/api/send', payload: body, headers: { cookie, 'x-dreymail': '1', 'content-type': type } });
        if (res.statusCode >= 400) throw new Error(`send: ${res.statusCode} ${res.body.slice(0, 200)}`);
      });
    }
  }

  async function listSuite() {
    const account2 = (await api('POST', '/api/accounts', { name: 'Bench 2', displayName: 'Bench 2', email: user2, color: '#664422', imap: { ...server, user: user2 }, smtp: { ...server, user: user2, port: smtpPort }, appendSent: false })).json();
    const all = async () => {
      await settled(account, ['Sent', 'Archive']);
      await settled(account2);
    };
    log('  filling both mailboxes');
    await all();
    const measure = (label, url) => measured(label, () => api('GET', url).then((r) => r.json()));
    const folder = (p, extra = '') => `/api/messages?accountId=${account.id}&folder=${encodeURIComponent(p)}&limit=50${extra}`;
    for (let r = 0; r < reps; r++) {
      log(`  list round ${r + 1}`);
      await all();
      const p1 = await measure('inbox', folder('INBOX'));
      const p2 = await measure('inbox page 2', folder('INBOX', `&cursor=${encodeURIComponent(p1.cursor)}`));
      await measure('inbox page 3', folder('INBOX', `&cursor=${encodeURIComponent(p2.cursor)}`));
      await all();
      await measure('Sent', folder('Sent'));
      await all();
      await measure('Archive (other folder)', folder('Archive'));
      await measure('Archive again right away', folder('Archive'));
      await all();
      await measure('All inboxes (2 mailboxes)', '/api/messages?limit=50');
      await all();
      await measure('inbox, unread only', folder('INBOX', '&unread=1'));
      await all();
      await measure('inbox, refresh button', folder('INBOX', '&fresh=1'));
      await all();
      // Another mail client marks 150 messages: the inbox has changed when it is listed.
      await direct(async (c) => {
        await c.mailboxOpen('INBOX');
        await (r % 2 ? c.messageFlagsRemove('1:150', ['\\Flagged']) : c.messageFlagsAdd('1:150', ['\\Flagged']));
      });
      await sleep(350);
      await measure('inbox, just changed by another client', folder('INBOX'));
      await all();
      // A folder never opened before.
      const fresh = `Projects ${r}`;
      await direct(async (c) => {
        await c.mailboxCreate(fresh);
        for (let i = 0; i < 80; i++) await c.append(fresh, textMail(`Project note ${r}.${i}`), ['\\Seen']);
      });
      await measure('folder never opened before', folder(fresh));
      await sleep(1000);
      await measure('that folder, 1 s later', folder(fresh));
    }
  }

  log('new mail');
  await settled();
  log('  settled, measuring');
  await arrival('1 new message', newsletter, 1);
  await arrival('8 new messages at once', newsletter, 8);
  await arrival('1 new photo message (2 x 4 MB)', (s) => photos(s), 1);

  if (process.env.BENCH_ONLY_ARRIVALS) {
    await ctx.app.close();
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  log('content not kept');
  await settled();
  const all = (await api('GET', `/api/messages?accountId=${account.id}&folder=INBOX&limit=200`)).json().messages;
  const notes = all.filter((m) => /^Newsletter \d+$/.test(m.subject));
  for (let r = 0; r < reps; r++) {
    const m = notes[r];
    await settled();
    dropBodies([m.uid]);
    add('open, content not kept (idle)', await timed(() => api('GET', `/api/message?${ref(m)}`)));
  }
  for (let r = 0; r < reps; r++) {
    const m = notes[reps + r];
    await settled();
    dropBodies([m.uid]);
    // Another client marks 150 messages and new mail comes in: syncs run while the user opens.
    await direct(async (c) => {
      await c.mailboxOpen('INBOX');
      await (r % 2 ? c.messageFlagsRemove('1:150', ['\\Flagged']) : c.messageFlagsAdd('1:150', ['\\Flagged']));
      for (let i = 0; i < 3; i++) await c.append('INBOX', newsletter(`Busy ${r}.${i}`), []);
    });
    await sleep(350); // the watcher hears of it and a sync starts
    add('open, content not kept, while syncing', await timed(() => api('GET', `/api/message?${ref(m)}`)));
  }

  // A conversation opening: its four messages asked for at once, none kept yet.
  for (let r = 0; r < reps; r++) {
    const picked = notes.slice(2 * reps + 4 * r, 2 * reps + 4 * r + 4);
    if (picked.length < 4) break;
    await settled();
    dropBodies(picked.map((m) => m.uid));
    add('conversation of 4, none kept: all open', await timed(() => Promise.all(picked.map((m) => api('GET', `/api/message?${ref(m)}`)))));
  }

  log('photos');
  const photoMsgs = all.filter((m) => /^Photos \d+$/.test(m.subject));
  const lag = monitorEventLoopDelay({ resolution: 5 });
  for (let r = 0; r < Math.min(reps, photoMsgs.length); r++) {
    const m = photoMsgs[r];
    await settled();
    lag.reset();
    lag.enable();
    add('photo message: open', await timed(() => api('GET', `/api/message?${ref(m)}`), 'photo message: open'));
    lag.disable();
    add('photo message: server stalled during open (worst, ms)', lag.max / 1e6);
    add('photo message: 1st picture', await timed(() => api('GET', `/api/attachment?${ref(m)}&index=0`)));
    add('photo message: 2nd picture', await timed(() => api('GET', `/api/attachment?${ref(m)}&index=1`)));
    add('photo message: 1st picture again', await timed(() => api('GET', `/api/attachment?${ref(m)}&index=0`)));
  }
  for (let r = 0; r < Math.min(reps, photoMsgs.length - reps); r++) {
    const m = photoMsgs[reps + r];
    await settled();
    dropBodies([m.uid]);
    add('photo message not kept: open', await timed(() => api('GET', `/api/message?${ref(m)}`)));
    add('photo message not kept: 1st picture', await timed(() => api('GET', `/api/attachment?${ref(m)}&index=0`)));
    add('photo message not kept: 2nd picture', await timed(() => api('GET', `/api/attachment?${ref(m)}&index=1`)));
  }

  await ctx.app.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
