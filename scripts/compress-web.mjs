// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Compresses the built web app ahead of time (DreyMail 14.4): a .br and a .gz next to every text
// file worth it, which the server sends to browsers that accept them. Done once at build, so
// serving costs nothing (the main script goes from about 800 KB to about 200 KB).
//
//   node scripts/compress-web.mjs [dist/web]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(process.argv[2] ?? 'dist/web');
const TEXT = /\.(js|css|html|svg|json|webmanifest|txt|map)$/;
let before = 0;
let after = 0;

for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !TEXT.test(entry.name)) continue;
  const file = path.join(entry.parentPath ?? entry.path, entry.name);
  const data = fs.readFileSync(file);
  if (data.length < 1024) continue;
  const br = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  const gz = zlib.gzipSync(data, { level: 9 });
  // Only where it saves something worth a second file.
  if (br.length < data.length * 0.9) fs.writeFileSync(`${file}.br`, br);
  if (gz.length < data.length * 0.9) fs.writeFileSync(`${file}.gz`, gz);
  before += data.length;
  after += Math.min(br.length, data.length);
}
console.log(`compressed web app: ${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB (brotli)`);
