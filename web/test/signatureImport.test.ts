// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { imageType, readZip, resolveAsset } from '../src/signatureImport';

/** A minimal .zip: one stored and one deflated entry, as signature tools make them. */
function makeZip(files: { name: string; data: Buffer; deflate: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const body = f.deflate ? zlib.deflateRawSync(f.data) : f.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

describe('importing a signature made for Outlook', () => {
  it('reads the files of its .zip', async () => {
    const htm = Buffer.from('<html><body><img src="Sam%20Schultz_files/top.gif"></body></html>'.repeat(20));
    const gif = Buffer.from('GIF89a…frames');
    const files = await readZip(makeZip([
      { name: 'Ponsys signature/Sam Schultz.htm', data: htm, deflate: true },
      { name: 'Ponsys signature/Sam Schultz_files/top.gif', data: gif, deflate: false },
      { name: 'Ponsys signature/Sam Schultz_files/', data: Buffer.alloc(0), deflate: false },
    ]));
    expect([...files.keys()]).toEqual(['Ponsys signature/Sam Schultz.htm', 'Ponsys signature/Sam Schultz_files/top.gif']);
    expect(Buffer.from(files.get('Ponsys signature/Sam Schultz.htm')!).equals(htm)).toBe(true);
    expect(Buffer.from(files.get('Ponsys signature/Sam Schultz_files/top.gif')!).equals(gif)).toBe(true);
    await expect(readZip(new Uint8Array(100))).rejects.toThrow(/zip/);
  });

  it('finds the file each picture points at', () => {
    const paths = ['Ponsys signature/Sam Schultz.htm', 'Ponsys signature/Sam Schultz_files/top.gif', 'Ponsys signature/Sam Schultz_files/name.png'];
    expect(resolveAsset('Sam Schultz_files/top.gif', paths)).toBe('Ponsys signature/Sam Schultz_files/top.gif');
    expect(resolveAsset('Sam%20Schultz_files/name.png', paths)).toBe('Ponsys signature/Sam Schultz_files/name.png');
    // Chosen as single files (no folder): matched by name.
    expect(resolveAsset('Sam Schultz_files/top.gif', ['Sam Schultz.htm', 'top.gif'])).toBe('top.gif');
    expect(resolveAsset('https://example.com/logo.png', paths)).toBeNull();
    expect(resolveAsset('Sam Schultz_files/missing.png', paths)).toBeNull();
    expect(imageType('x/top.GIF')).toBe('image/gif');
    expect(imageType('font.ttf')).toBeNull();
  });
});
