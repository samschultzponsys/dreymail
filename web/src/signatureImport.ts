// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Importing a signature made for Outlook: the .zip a signature tool gives you (or its .htm and the
// pictures from the "<name>_files" folder). Its pictures are relative files, so they are put into
// the signature itself (data: URLs); when a message is sent they become ordinary inline pictures.

/** Files in a .zip, by path. Reads stored and deflated entries (all that signature zips use). */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This isn’t a .zip file.');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('The .zip file is damaged.');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes).replace(/\\/g, '/');
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || size > 20 * 1024 * 1024) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflate(data));
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The file an <img src> in the .htm points at ("Sam Schultz_files/top.gif", URL-encoded or not). */
export function resolveAsset(src: string, paths: string[]): string | null {
  let want = src.trim();
  try {
    want = decodeURIComponent(want);
  } catch {
    /* keep it as it is */
  }
  want = want.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (!want || /^[a-z][a-z0-9+.-]*:/.test(want)) return null; // http:, data:, cid:… aren't files here
  const lower = paths.map((p) => p.toLowerCase());
  const exact = lower.findIndex((p) => p === want || p.endsWith(`/${want}`));
  if (exact >= 0) return paths[exact]!;
  const base = want.split('/').pop()!;
  const byName = lower.findIndex((p) => p.split('/').pop() === base);
  return byName >= 0 ? paths[byName]! : null;
}

const TYPES: Record<string, string> = { gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' };
export const imageType = (path: string) => TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;

function dataUrl(bytes: Uint8Array, type: string): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

/** The signature's HTML, with its pictures inside it. */
export async function importSignature(files: File[]): Promise<string> {
  const all = new Map<string, Uint8Array>();
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) for (const [p, b] of await readZip(bytes)) all.set(p, b);
    else all.set((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, bytes);
  }
  const paths = [...all.keys()];
  const page = paths.find((p) => /\.html?$/i.test(p) && !p.split('/').pop()!.startsWith('.'));
  if (!page) throw new Error('No signature (.htm file) found. Choose the .zip, or the .htm file and its pictures.');
  const raw = all.get(page)!;
  const head = new TextDecoder('latin1').decode(raw.subarray(0, 2000));
  const charset = /charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  let html: string;
  try {
    html = new TextDecoder(charset).decode(raw);
  } catch {
    html = new TextDecoder('utf-8').decode(raw);
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const missing: string[] = [];
  for (const img of [...doc.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? '';
    const file = resolveAsset(src, paths);
    const type = file ? imageType(file) : null;
    if (file && type) img.setAttribute('src', dataUrl(all.get(file)!, type));
    else if (!/^(https?:|data:image\/)/i.test(src)) missing.push(src);
  }
  if (missing.length) throw new Error(`These pictures weren’t included: ${missing.join(', ')}. Choose the .zip, or the .htm file together with its pictures.`);
  // It goes into the editor next: nothing in it may run. (The server cleans it again on saving.)
  doc.body.querySelectorAll('script, style, iframe, object, embed, link, meta, form, input, button, textarea, select, svg, math, base').forEach((el) => el.remove());
  for (const el of [...doc.body.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(attr.name);
      else if ((n === 'href' && !/^(https?:|mailto:|tel:)/i.test(attr.value.trim())) || (n === 'src' && !/^(https?:|data:image\/)/i.test(attr.value.trim()))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML.trim();
}
