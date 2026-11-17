// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// A minimal D-Bus client (session bus, Unix socket, no dependencies), just enough for desktop
// notifications: method calls, their replies, and signals. Used by the flatpak so a notification
// is shown and its click is heard on the same connection: notification servers (KDE Plasma among
// them) may send the click only to the connection that showed the notification, which a one-off
// `gdbus call` can't receive because it has already exited.
'use strict';

const net = require('node:net');

// ---- wire format ------------------------------------------------------------------------------

const ALIGN = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, h: 4, s: 4, o: 4, g: 1, a: 4, '(': 8, '{': 8, v: 1 };

/** Index just past the single complete type starting at `i` in `sig`. */
function typeEnd(sig, i) {
  const c = sig[i];
  if (c === 'a') return typeEnd(sig, i + 1);
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}';
    let j = i + 1;
    while (sig[j] !== close) {
      if (j >= sig.length) throw new Error(`bad signature ${sig}`);
      j = typeEnd(sig, j);
    }
    return j + 1;
  }
  if (!(c in ALIGN)) throw new Error(`bad signature ${sig}`);
  return i + 1;
}

/** The complete types of a signature, e.g. "sa{sv}i" → ["s", "a{sv}", "i"]. */
function splitSignature(sig) {
  const out = [];
  for (let i = 0; i < sig.length; ) {
    const end = typeEnd(sig, i);
    out.push(sig.slice(i, end));
    i = end;
  }
  return out;
}

/** Little-endian writer; offsets (for alignment) count from the start of what it writes. */
class Writer {
  constructor() {
    this.buf = Buffer.alloc(256);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  align(n) {
    const pad = (n - (this.len % n)) % n;
    this.ensure(pad);
    this.buf.fill(0, this.len, this.len + pad);
    this.len += pad;
  }
  u8(v) {
    this.ensure(1);
    this.buf.writeUInt8(v, this.len);
    this.len += 1;
  }
  u32(v) {
    this.align(4);
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.len);
    this.len += 4;
  }
  bytes(b) {
    this.ensure(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }
  value(type, v) {
    const c = type[0];
    switch (c) {
      case 'y':
        return this.u8(v);
      case 'b':
        return this.u32(v ? 1 : 0);
      case 'n':
      case 'q':
        this.align(2);
        this.ensure(2);
        c === 'n' ? this.buf.writeInt16LE(v, this.len) : this.buf.writeUInt16LE(v, this.len);
        this.len += 2;
        return;
      case 'i':
        this.align(4);
        this.ensure(4);
        this.buf.writeInt32LE(v, this.len);
        this.len += 4;
        return;
      case 'u':
      case 'h':
        return this.u32(v);
      case 'x':
      case 't':
        this.align(8);
        this.ensure(8);
        c === 'x' ? this.buf.writeBigInt64LE(BigInt(v), this.len) : this.buf.writeBigUInt64LE(BigInt(v), this.len);
        this.len += 8;
        return;
      case 'd':
        this.align(8);
        this.ensure(8);
        this.buf.writeDoubleLE(v, this.len);
        this.len += 8;
        return;
      case 's':
      case 'o': {
        const b = Buffer.from(String(v), 'utf8');
        this.u32(b.length);
        this.bytes(b);
        return this.u8(0);
      }
      case 'g': {
        const b = Buffer.from(String(v), 'ascii');
        this.u8(b.length);
        this.bytes(b);
        return this.u8(0);
      }
      case 'v': {
        const [sig, inner] = v;
        this.value('g', sig);
        return this.value(sig, inner);
      }
      case 'a': {
        const elem = type.slice(1);
        this.u32(0);
        const lenAt = this.len - 4;
        this.align(ALIGN[elem[0]]);
        const start = this.len;
        for (const item of v) this.value(elem, item);
        this.buf.writeUInt32LE(this.len - start, lenAt);
        return;
      }
      case '(':
      case '{': {
        this.align(8);
        const parts = splitSignature(type.slice(1, -1));
        parts.forEach((t, k) => this.value(t, v[k]));
        return;
      }
      default:
        throw new Error(`can't write type ${type}`);
    }
  }
  result() {
    return this.buf.subarray(0, this.len);
  }
}

/** Reader for one message; `base` is where the message starts (alignment counts from there). */
class Reader {
  constructor(buf, little, base = 0) {
    this.buf = buf;
    this.little = little;
    this.base = base;
    this.pos = base;
  }
  align(n) {
    this.pos += (n - ((this.pos - this.base) % n)) % n;
  }
  need(n) {
    if (this.pos + n > this.buf.length) throw new Error('truncated D-Bus message');
  }
  u8() {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  u32() {
    this.align(4);
    this.need(4);
    const v = this.little ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  value(type) {
    const c = type[0];
    const L = this.little;
    switch (c) {
      case 'y':
        return this.u8();
      case 'b':
        return this.u32() !== 0;
      case 'n':
      case 'q': {
        this.align(2);
        this.need(2);
        const v = c === 'n' ? (L ? this.buf.readInt16LE(this.pos) : this.buf.readInt16BE(this.pos)) : L ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos);
        this.pos += 2;
        return v;
      }
      case 'i': {
        this.align(4);
        this.need(4);
        const v = L ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos);
        this.pos += 4;
        return v;
      }
      case 'u':
      case 'h':
        return this.u32();
      case 'x':
      case 't': {
        this.align(8);
        this.need(8);
        const v =
          c === 'x' ? (L ? this.buf.readBigInt64LE(this.pos) : this.buf.readBigInt64BE(this.pos)) : L ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos);
        this.pos += 8;
        return v;
      }
      case 'd': {
        this.align(8);
        this.need(8);
        const v = L ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos);
        this.pos += 8;
        return v;
      }
      case 's':
      case 'o': {
        const n = this.u32();
        this.need(n + 1);
        const v = this.buf.toString('utf8', this.pos, this.pos + n);
        this.pos += n + 1;
        return v;
      }
      case 'g': {
        const n = this.u8();
        this.need(n + 1);
        const v = this.buf.toString('ascii', this.pos, this.pos + n);
        this.pos += n + 1;
        return v;
      }
      case 'v': {
        const sig = this.value('g');
        return [sig, this.value(sig)];
      }
      case 'a': {
        const elem = type.slice(1);
        const n = this.u32();
        this.align(ALIGN[elem[0]]);
        const end = this.pos + n;
        if (end > this.buf.length) throw new Error('truncated D-Bus message');
        const out = [];
        while (this.pos < end) out.push(this.value(elem));
        return out;
      }
      case '(':
      case '{': {
        this.align(8);
        return splitSignature(type.slice(1, -1)).map((t) => this.value(t));
      }
      default:
        throw new Error(`can't read type ${type}`);
    }
  }
}

const TYPE = { call: 1, return: 2, error: 3, signal: 4 };
const FIELD = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8 };
const FIELD_TYPE = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g' };

/** One message as bytes. `msg`: { type, serial, flags?, path?, interface?, member?, errorName?, replySerial?, destination?, signature?, body? } */
function encodeMessage(msg) {
  const body = new Writer();
  const sig = msg.signature || '';
  const types = splitSignature(sig);
  types.forEach((t, k) => body.value(t, msg.body[k]));
  const fields = [];
  for (const [name, code] of Object.entries(FIELD)) {
    if (msg[name] === undefined || msg[name] === null || (name === 'signature' && !sig)) continue;
    fields.push([code, [FIELD_TYPE[code], msg[name]]]);
  }
  const head = new Writer();
  head.u8(0x6c); // 'l': little-endian
  head.u8(TYPE[msg.type]);
  head.u8(msg.flags || 0);
  head.u8(1);
  head.u32(body.len);
  head.u32(msg.serial);
  head.value('a(yv)', fields);
  head.align(8);
  return Buffer.concat([head.result(), body.result()]);
}

/** Total length of the message at the start of `buf`, or 0 if more bytes are needed. */
function messageLength(buf) {
  if (buf.length < 16) return 0;
  const little = buf[0] === 0x6c;
  const bodyLen = little ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLen = little ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const headerLen = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8);
  const total = headerLen + bodyLen;
  if (total > 128 * 1024 * 1024) throw new Error('D-Bus message too large');
  return buf.length >= total ? total : 0;
}

/** Parse one complete message. */
function decodeMessage(buf) {
  const little = buf[0] === 0x6c;
  if (!little && buf[0] !== 0x42) throw new Error('bad D-Bus message');
  const r = new Reader(buf, little);
  r.pos = 1;
  const typeCode = r.u8();
  const flags = r.u8();
  r.u8(); // version
  const bodyLen = r.u32();
  const serial = r.u32();
  const fields = r.value('a(yv)');
  r.align(8);
  const msg = { type: Object.keys(TYPE).find((k) => TYPE[k] === typeCode) || 'unknown', flags, serial, body: [] };
  for (const [code, [, value]] of fields) {
    const name = Object.keys(FIELD).find((k) => FIELD[k] === code);
    if (name) msg[name] = value;
  }
  const bodyStart = r.pos;
  if (msg.signature) {
    const br = new Reader(buf.subarray(bodyStart, bodyStart + bodyLen), little);
    msg.body = splitSignature(msg.signature).map((t) => br.value(t));
  }
  return msg;
}

// ---- connection -------------------------------------------------------------------------------

/** Socket paths from a bus address such as "unix:path=/run/user/1000/bus" (abstract sockets too). */
function socketPaths(address) {
  const out = [];
  for (const part of String(address || '').split(';')) {
    if (!part.startsWith('unix:')) continue;
    const kv = Object.fromEntries(
      part
        .slice(5)
        .split(',')
        .map((p) => {
          const at = p.indexOf('=');
          return [p.slice(0, at), decodeURIComponent(p.slice(at + 1))];
        }),
    );
    if (kv.path) out.push(kv.path);
    else if (kv.abstract) out.push(`\0${kv.abstract}`);
  }
  return out;
}

/**
 * Connect and authenticate (EXTERNAL, as our user) and say Hello. Resolves to a bus:
 * { name, call(opts) → Promise<body[]>, send(msg), onMessage(fn), close(), closed }.
 */
function connect({ address = process.env.DBUS_SESSION_BUS_ADDRESS, uid = process.getuid?.(), timeoutMs = 5000, createConnection = net.createConnection } = {}) {
  const paths = socketPaths(address);
  if (!paths.length) return Promise.reject(new Error('no D-Bus session bus address'));
  const tryPath = (k) => open(paths[k], uid, timeoutMs, createConnection).catch((err) => (k + 1 < paths.length ? tryPath(k + 1) : Promise.reject(err)));
  return tryPath(0);
}

function open(socketPath, uid, timeoutMs, createConnection) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let phase = 'auth';
    let buf = Buffer.alloc(0);
    let serial = 0;
    const pending = new Map();
    const listeners = new Set();
    const bus = { name: '', closed: false };
    const timer = setTimeout(() => fail(new Error('D-Bus connection timed out')), timeoutMs);

    const fail = (err) => {
      clearTimeout(timer);
      if (phase !== 'ready') reject(err);
      sock.destroy();
    };

    bus.send = (msg) => {
      if (bus.closed) throw new Error('D-Bus connection closed');
      const s = ++serial;
      sock.write(encodeMessage({ ...msg, serial: s }));
      return s;
    };
    bus.call = ({ destination, path, interface: iface, member, signature = '', body = [] }) =>
      new Promise((res, rej) => {
        let s;
        try {
          s = bus.send({ type: 'call', destination, path, interface: iface, member, signature, body });
        } catch (err) {
          rej(err);
          return;
        }
        const t = setTimeout(() => {
          pending.delete(s);
          rej(new Error(`D-Bus call ${member} timed out`));
        }, timeoutMs);
        pending.set(s, { res, rej, t });
      });
    bus.onMessage = (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    };
    bus.close = () => sock.end();

    const dispatch = (msg) => {
      if ((msg.type === 'return' || msg.type === 'error') && pending.has(msg.replySerial)) {
        const p = pending.get(msg.replySerial);
        pending.delete(msg.replySerial);
        clearTimeout(p.t);
        if (msg.type === 'return') p.res(msg.body);
        else p.rej(new Error(`${msg.errorName}: ${msg.body[0] ?? ''}`));
        return;
      }
      for (const fn of listeners) {
        try {
          fn(msg);
        } catch {
          /* a listener's problem is its own */
        }
      }
    };

    sock.on('connect', () => {
      const hexUid = Buffer.from(String(uid ?? 0)).toString('hex');
      sock.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${hexUid}\r\n`)]));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (phase === 'auth') {
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.toString('ascii', 0, nl);
          buf = buf.subarray(nl + 2);
          if (!line.startsWith('OK ')) throw new Error(`D-Bus authentication refused: ${line}`);
          sock.write('BEGIN\r\n');
          phase = 'hello';
          bus
            .call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'Hello' })
            .then(([name]) => {
              bus.name = name;
              phase = 'ready';
              clearTimeout(timer);
              resolve(bus);
            })
            .catch(fail);
        }
        for (;;) {
          const n = messageLength(buf);
          if (!n) break;
          const raw = buf.subarray(0, n);
          buf = buf.subarray(n);
          dispatch(decodeMessage(raw));
        }
      } catch (err) {
        fail(err);
      }
    });
    sock.on('error', (err) => fail(err));
    sock.on('close', () => {
      bus.closed = true;
      clearTimeout(timer);
      for (const p of pending.values()) {
        clearTimeout(p.t);
        p.rej(new Error('D-Bus connection closed'));
      }
      pending.clear();
      if (phase !== 'ready') reject(new Error('D-Bus connection closed'));
      for (const fn of listeners) {
        try {
          fn({ type: 'disconnected', body: [] });
        } catch {
          /* ignore */
        }
      }
    });
  });
}

// ---- notifications ----------------------------------------------------------------------------

const NOTIFICATIONS = { destination: 'org.freedesktop.Notifications', path: '/org/freedesktop/Notifications', interface: 'org.freedesktop.Notifications' };

/**
 * A notifier over one long-lived bus connection: show({ tag, title, body, iconPath, onClick }) →
 * Promise<boolean> (false if the bus or the notification service can't be reached, so the caller
 * can fall back). A notification with the tag of one still shown replaces it. Clicks ("default"
 * action) call that notification's onClick. Reconnects on the next show after the bus goes away.
 */
function createBusNotifier({ appName, desktopEntry, log = () => {}, connectBus = connect }) {
  const idByTag = new Map();
  const byId = new Map(); // id → { tag, onClick }
  let busPromise = null;

  const forget = (id) => {
    const entry = byId.get(id);
    if (!entry) return;
    byId.delete(id);
    if (idByTag.get(entry.tag) === id) idByTag.delete(entry.tag);
  };

  const getBus = () => {
    if (!busPromise) {
      busPromise = connectBus()
        .then(async (bus) => {
          bus.onMessage((msg) => {
            if (msg.type === 'disconnected') {
              busPromise = null;
              idByTag.clear();
              byId.clear();
              return;
            }
            if (msg.type !== 'signal' || msg.interface !== NOTIFICATIONS.interface) return;
            if (msg.member === 'ActionInvoked' && msg.body[1] === 'default') byId.get(msg.body[0])?.onClick?.();
            if (msg.member === 'NotificationClosed') forget(msg.body[0]);
          });
          // Clicks may come as broadcasts (GNOME) or only to us (KDE Plasma): ask for both.
          await bus.call({
            destination: 'org.freedesktop.DBus',
            path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus',
            member: 'AddMatch',
            signature: 's',
            body: [`type='signal',interface='${NOTIFICATIONS.interface}',path='${NOTIFICATIONS.path}'`],
          });
          return bus;
        })
        .catch((err) => {
          busPromise = null;
          throw err;
        });
    }
    return busPromise;
  };

  const show = async ({ tag, title, body, iconPath, onClick }) => {
    try {
      const bus = await getBus();
      const hints = [['desktop-entry', ['s', desktopEntry]]];
      if (iconPath) hints.push(['image-path', ['s', iconPath]]);
      const [id] = await bus.call({
        ...NOTIFICATIONS,
        member: 'Notify',
        signature: 'susssasa{sv}i',
        body: [appName, idByTag.get(tag) ?? 0, iconPath || '', title, body, ['default', 'Open'], hints, -1],
      });
      const old = idByTag.get(tag);
      if (old !== undefined && old !== id) byId.delete(old);
      idByTag.set(tag, id);
      byId.set(id, { tag, onClick });
      return true;
    } catch (err) {
      log(`D-Bus notify failed: ${err.message}`);
      return false;
    }
  };

  const stop = () => {
    void busPromise?.then((bus) => bus.close()).catch(() => undefined);
    busPromise = null;
  };

  return { show, stop };
}

module.exports = { splitSignature, encodeMessage, decodeMessage, messageLength, socketPaths, connect, createBusNotifier, Writer, Reader };
