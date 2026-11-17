// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Msg = { type: string; serial: number; sender?: string; destination?: string; member?: string; interface?: string; path?: string; replySerial?: number; signature?: string; body: unknown[] };
type Bus = {
  name: string;
  send(m: Partial<Msg> & { type: string }): number;
  call(o: { destination: string; path: string; interface: string; member: string; signature?: string; body?: unknown[] }): Promise<unknown[]>;
  onMessage(fn: (m: Msg) => void): () => void;
  close(): void;
};
const dbus = createRequire(import.meta.url)('../../desktop/dbus.cjs') as {
  splitSignature(s: string): string[];
  encodeMessage(m: unknown): Buffer;
  decodeMessage(b: Buffer): Msg;
  messageLength(b: Buffer): number;
  socketPaths(a: string): string[];
  connect(o: { address: string }): Promise<Bus>;
  createBusNotifier(o: { appName: string; desktopEntry: string; connectBus: () => Promise<Bus>; log?: (m: string) => void }): {
    show(n: { tag: string; title: string; body: string; iconPath: string; onClick?: () => void }): Promise<boolean>;
    stop(): void;
  };
};
const gdbusNotify = createRequire(import.meta.url)('../../desktop/notify.cjs') as {
  notifyArgs(o: { appName: string; replacesId: number; iconPath: string; title: string; body: string; desktopEntry: string }): string[];
};

describe('D-Bus wire format', () => {
  it('splits signatures into complete types', () => {
    expect(dbus.splitSignature('susssasa{sv}i')).toEqual(['s', 'u', 's', 's', 's', 'as', 'a{sv}', 'i']);
    expect(dbus.splitSignature('a(yv)u')).toEqual(['a(yv)', 'u']);
  });

  it('round-trips a Notify call', () => {
    const msg = {
      type: 'call',
      serial: 9,
      destination: 'org.freedesktop.Notifications',
      path: '/org/freedesktop/Notifications',
      interface: 'org.freedesktop.Notifications',
      member: 'Notify',
      signature: 'susssasa{sv}i',
      body: ['DreyMail', 3, '', 'Sam · Work', "Re: it's\nfine ✓", ['default', 'Open'], [['desktop-entry', ['s', 'io.example.app']]], -1],
    };
    const raw = dbus.encodeMessage(msg);
    expect(raw.length % 8 === 0 || dbus.messageLength(raw) === raw.length).toBe(true);
    expect(dbus.messageLength(raw)).toBe(raw.length);
    expect(dbus.messageLength(raw.subarray(0, raw.length - 1))).toBe(0);
    expect(dbus.decodeMessage(raw)).toMatchObject(msg);
  });

  it('finds socket paths in bus addresses', () => {
    expect(dbus.socketPaths('unix:path=/run/flatpak/bus')).toEqual(['/run/flatpak/bus']);
    expect(dbus.socketPaths('unix:abstract=/tmp/dbus-x,guid=1;tcp:host=x')).toEqual(['\0/tmp/dbus-x']);
    expect(dbus.socketPaths('')).toEqual([]);
  });
});

const tools = ['dbus-daemon', 'gdbus'].every((t) => spawnSync('which', [t]).status === 0);

describe.skipIf(!tools)('notifications over a real session bus', () => {
  let dir = '';
  let address = '';
  let daemon: ChildProcess | null = null;
  let server: Bus;
  const received: unknown[][] = [];
  let nextId = 40;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreymail-dbus-'));
    address = `unix:path=${path.join(dir, 'bus')}`;
    daemon = spawn('dbus-daemon', ['--session', '--nofork', `--address=${address}`, '--print-address=1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve) => daemon!.stdout!.once('data', () => resolve()));
    // A stand-in for the desktop's notification service.
    server = await dbus.connect({ address });
    await server.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'RequestName', signature: 'su', body: ['org.freedesktop.Notifications', 4] });
    server.onMessage((m) => {
      if (m.type !== 'call' || m.member !== 'Notify') return;
      received.push(m.body);
      const replaces = m.body[1] as number;
      server.send({ type: 'return', replySerial: m.serial, destination: m.sender, signature: 'u', body: [replaces || ++nextId] });
    });
  });

  afterAll(() => {
    server?.close();
    daemon?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const signal = (member: string, signature: string, body: unknown[], destination?: string) =>
    server.send({ type: 'signal', path: '/org/freedesktop/Notifications', interface: 'org.freedesktop.Notifications', member, signature, body, destination });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    return ok();
  };

  it('shows a notification and hears its click, sent only to us (KDE Plasma) or to everyone (GNOME)', async () => {
    const notifier = dbus.createBusNotifier({ appName: 'DreyMail', desktopEntry: 'io.github.samschultzponsys.DreyMail', connectBus: () => dbus.connect({ address }) });
    const clicks: string[] = [];
    expect(await notifier.show({ tag: 'a:1', title: 'Sam', body: 'Hello', iconPath: '/x/icon.png', onClick: () => clicks.push('one') })).toBe(true);
    expect(received.at(-1)).toEqual(['DreyMail', 0, '/x/icon.png', 'Sam', 'Hello', ['default', 'Open'], [['desktop-entry', ['s', 'io.github.samschultzponsys.DreyMail']], ['image-path', ['s', '/x/icon.png']]], -1]);
    const first = nextId;
    // A click sent to everyone (GNOME).
    signal('ActionInvoked', 'us', [first, 'default']);
    expect(await until(() => clicks.length === 1)).toBe(true);

    expect(await notifier.show({ tag: 'a:2', title: 'Eve', body: 'Hi', iconPath: '', onClick: () => clicks.push('two') })).toBe(true);
    // Find the notifier's own bus name from the server's view (the sender of the last Notify).
    let notifierName = '';
    const off = server.onMessage((m) => {
      if (m.member === 'Notify') notifierName = m.sender ?? '';
    });
    await notifier.show({ tag: 'a:2', title: 'Eve', body: 'Hi again', iconPath: '', onClick: () => clicks.push('two') });
    off();
    expect(received.at(-1)![1]).toBe(nextId); // same tag: replaces the shown one
    signal('ActionInvoked', 'us', [nextId, 'default'], notifierName);
    expect(await until(() => clicks.length === 2)).toBe(true);
    expect(clicks).toEqual(['one', 'two']);
    // Other actions and closed notifications don't open anything.
    signal('ActionInvoked', 'us', [nextId, 'other'], notifierName);
    signal('NotificationClosed', 'uu', [nextId, 2], notifierName);
    signal('ActionInvoked', 'us', [nextId, 'default'], notifierName);
    await new Promise((r) => setTimeout(r, 100));
    expect(clicks).toEqual(['one', 'two']);
    notifier.stop();
  });

  it('a click sent only to the notifying connection never reaches another one (why gdbus monitor missed it)', async () => {
    const monitor = await dbus.connect({ address });
    await monitor.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: ["type='signal',interface='org.freedesktop.Notifications'"] });
    const caller = await dbus.connect({ address }); // like a one-off `gdbus call`
    const seen: Msg[] = [];
    monitor.onMessage((m) => m.member === 'ActionInvoked' && seen.push(m));
    signal('ActionInvoked', 'us', [99, 'default'], caller.name);
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toEqual([]);
    monitor.close();
    caller.close();
  });

  it('speaks the same wire format as gdbus, both ways', async () => {
    // gdbus calls our stand-in server: it decodes gdbus's message, and gdbus decodes our reply.
    const args = gdbusNotify.notifyArgs({ appName: 'DreyMail', replacesId: 0, iconPath: '/i.png', title: "Sam's \"news\"", body: 'line 1\nline 2 ✓', desktopEntry: 'io.example.app' });
    const withAddress = args.map((a) => (a === '--session' ? `--address=${address}` : a));
    const out = await new Promise<string>((resolve, reject) => execFile('gdbus', withAddress, (err, stdout) => (err ? reject(err) : resolve(stdout))));
    expect(out.trim()).toBe(`(uint32 ${nextId},)`);
    expect(received.at(-1)).toEqual(['DreyMail', 0, '/i.png', "Sam's \"news\"", 'line 1\nline 2 ✓', ['default', 'Open'], [['desktop-entry', ['s', 'io.example.app']], ['image-path', ['s', '/i.png']]], -1]);

    // gdbus sends a signal to our client, which decodes it.
    const client = await dbus.connect({ address });
    const got: Msg[] = [];
    client.onMessage((m) => got.push(m));
    await new Promise<void>((resolve, reject) =>
      execFile('gdbus', ['emit', `--address=${address}`, '--object-path', '/org/freedesktop/Notifications', '--signal', 'org.freedesktop.Notifications.ActionInvoked', '--dest', client.name, '7', "'default'"], (err) => (err ? reject(err) : resolve())),
    );
    expect(await until(() => got.some((m) => m.member === 'ActionInvoked'))).toBe(true);
    expect(got.find((m) => m.member === 'ActionInvoked')!.body).toEqual([7, 'default']);
    client.close();
  });

  it('reports failure (so the app falls back) when nothing is listening', async () => {
    const logs: string[] = [];
    const notifier = dbus.createBusNotifier({ appName: 'DreyMail', desktopEntry: 'x', connectBus: () => dbus.connect({ address: `unix:path=${path.join(dir, 'nothing')}` }), log: (m) => logs.push(m) });
    expect(await notifier.show({ tag: 't', title: 'a', body: 'b', iconPath: '' })).toBe(false);
    expect(logs[0]).toMatch(/D-Bus notify failed/);
  });
});
