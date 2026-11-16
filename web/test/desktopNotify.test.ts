// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

type Show = { tag: string; title: string; body: string; iconPath: string; onClick?: () => void };
const notify = createRequire(import.meta.url)('../../desktop/notify.cjs') as {
  gvString(s: string): string;
  notifyArgs(o: { appName: string; replacesId: number; iconPath: string; title: string; body: string; desktopEntry: string }): string[];
  parseNotifyId(out: string): number | null;
  parseMonitorLine(line: string): { type: string; id: number; action?: string } | null;
  createNotifier(o: {
    execFile: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string) => void) => void;
    spawn: (cmd: string, args: string[], opts: unknown) => unknown;
    appName: string;
    desktopEntry: string;
  }): { show(n: Show): Promise<boolean>; stop(): void };
};

describe('desktop notifications through gdbus', () => {
  it('quotes text as GVariant strings', () => {
    expect(notify.gvString("Re: Sam's \\ report")).toBe("'Re: Sam\\'s \\\\ report'");
    expect(notify.gvString('line one\nline two\u0007')).toBe("'line one\\nline two'");
  });

  it('builds the Notify call with the desktop entry, icon and a click action', () => {
    const args = notify.notifyArgs({ appName: 'DreyMail', replacesId: 7, iconPath: '/home/u/icon.png', title: 'Hi', body: 'There', desktopEntry: 'io.example.app' });
    expect(args.slice(0, 2)).toEqual(['call', '--session']);
    expect(args).toContain('org.freedesktop.Notifications.Notify');
    expect(args.slice(-8)).toEqual([
      "'DreyMail'",
      'uint32 7',
      "'/home/u/icon.png'",
      "'Hi'",
      "'There'",
      "['default', 'Open']",
      "{'desktop-entry': <'io.example.app'>, 'image-path': <'/home/u/icon.png'>}",
      'int32 -1',
    ]);
  });

  it('reads the id and the monitor signals', () => {
    expect(notify.parseNotifyId('(uint32 42,)\n')).toBe(42);
    expect(notify.parseNotifyId('Error: nope')).toBeNull();
    expect(notify.parseMonitorLine("/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 42, 'default')")).toEqual({ type: 'action', id: 42, action: 'default' });
    expect(notify.parseMonitorLine('/org/freedesktop/Notifications: org.freedesktop.Notifications.NotificationClosed (uint32 42, uint32 2)')).toEqual({ type: 'closed', id: 42 });
    expect(notify.parseMonitorLine('something else')).toBeNull();
  });

  it('replaces a notification with the same tag, reports clicks, and says when gdbus fails', async () => {
    const calls: string[][] = [];
    let nextId = 10;
    let fail = false;
    const stdout = new PassThrough();
    const monitor = Object.assign(new EventEmitter(), { stdout, kill: () => undefined });
    const n = notify.createNotifier({
      execFile: (_cmd, args, _opts, cb) => {
        calls.push(args);
        if (fail) cb(new Error('gdbus: not found'), '');
        else cb(null, `(uint32 ${nextId++},)\n`);
      },
      spawn: () => monitor,
      appName: 'DreyMail',
      desktopEntry: 'io.example.app',
    });
    let clicked = 0;
    expect(await n.show({ tag: 'a', title: 'One', body: '', iconPath: '', onClick: () => clicked++ })).toBe(true);
    expect(await n.show({ tag: 'a', title: 'Two', body: '', iconPath: '' })).toBe(true);
    expect(calls[0]).toContain('uint32 0');
    expect(calls[1]).toContain('uint32 10');
    stdout.write("/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 10, 'default')\n");
    await new Promise((r) => setImmediate(r));
    expect(clicked).toBe(0); // replaced by id 11
    let clicked2 = 0;
    expect(await n.show({ tag: 'b', title: 'Three', body: '', iconPath: '', onClick: () => clicked2++ })).toBe(true);
    stdout.write("/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 12, 'default')\n");
    await new Promise((r) => setImmediate(r));
    expect(clicked2).toBe(1);
    fail = true;
    expect(await n.show({ tag: 'c', title: 'Four', body: '', iconPath: '' })).toBe(false);
  });
});
