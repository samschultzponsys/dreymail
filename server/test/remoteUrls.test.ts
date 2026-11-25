// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRaw } from '../src/mail/parse.js';
import { collectRemoteImageUrls, sanitizeRemoteUrlsReference } from '../src/mail/sanitize.js';

const fixtures = path.join(import.meta.dirname, 'fixtures');

/** A small random generator, so every run tries the same inputs. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

// Pieces that can hold (or hide) an image URL, in the places the sanitizer looks and some it doesn't.
const urls = ['https://a.example/x.png', '//cdn.example/y.gif', 'HTTP://B.EXAMPLE/z.jpg', 'http://127.0.0.1/local.png', 'cid:part1', 'data:image/png;base64,AAAA', 'javascript:alert(1)', ' https://pad.example/sp.png ', 'https://a.example/x.png?q=1&amp;r=2', 'https://ent.example/&#x61;.png'];
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;
const pieces = (r: () => number): string[] => {
  const u = () => pick(r, urls);
  return [
    `<img src="${u()}">`,
    `<IMG SRC=${u().replace(/\s/g, '')}>`,
    `<img src='${u()}' src="https://dup.example/second.png">`,
    `<td background="${u()}">cell</td>`,
    `<table background="${u()}"><tr><td>x</td></tr></table>`,
    `<div style="background:url(${u()})">s</div>`,
    `<div style="background-image: url('${u()}'); color: red">s</div>`,
    `<p style="color:blue">plain</p>`,
    `<p style="background:\\75 rl(${u()})">escaped</p>`,
    `<style>.a{background:url("${u()}")} .b{color:red}</style>`,
    `<style>@import url(${u()}); .c{background-image:url(${u()})}</style>`,
    `<script>var i = '<img src="${u()}">';</script>`,
    `<textarea><img src="${u()}"></textarea>`,
    `<noscript><img src="${u()}"></noscript>`,
    `<svg><image href="${u()}"/><img src="${u()}"></svg>`,
    `<title><img src="${u()}"></title>`,
    `<!-- <img src="${u()}"> -->`,
    `<a href="${u()}">link</a>`,
    `&#55357;&#56842; <b>emoji</b>`,
    `<img src="${u()}`,
    `<object data="${u()}"><img src="${u()}"></object>`,
    // Nesting, unclosed and mismatched tags around the elements whose contents are skipped.
    `<noscript>`,
    `</noscript>`,
    `<NoScript ><b><img src="${u()}"></b></noscript >`,
    `<button><img src="${u()}"><span><img src="${u()}"></span></button>`,
    `<select><option><img src="${u()}"></option></select>`,
    `<svg><g><foreignObject><img src="${u()}"></foreignObject></g></svg>`,
    `<head><style>.h{background:url(${u()})}</style></head>`,
    `<math><mi><img src="${u()}"></mi>`,
    `</div>`,
    `<div><p><b>`,
    `</b></p>`,
    `<iframe src="${u()}"><img src="${u()}"></iframe>`,
    `<template><img src="${u()}"></template>`,
    `<table><tr><td background="${u()}"><button><td background="${u()}"></td></button></td></tr></table>`,
  ];
};

describe('remote image URLs', () => {
  it('finds exactly what sanitizing the whole message finds, in hostile mail', async () => {
    for (const f of fs.readdirSync(path.join(fixtures, 'hostile'))) {
      const html = fs.readFileSync(path.join(fixtures, 'hostile', f), 'utf8');
      expect(collectRemoteImageUrls(html), f).toEqual(sanitizeRemoteUrlsReference(html));
    }
    for (const f of fs.readdirSync(path.join(fixtures, 'mime'))) {
      const e = await parseRaw(fs.readFileSync(path.join(fixtures, 'mime', f)));
      if (e.html) expect(collectRemoteImageUrls(e.html), f).toEqual(sanitizeRemoteUrlsReference(e.html));
    }
  });

  it('finds exactly what sanitizing the whole message finds, in 20,000 generated messages', () => {
    const r = rng(14_1);
    let found = 0;
    for (let i = 0; i < 20_000; i++) {
      const all = pieces(r);
      const html = Array.from({ length: 1 + Math.floor(r() * 12) }, () => pick(r, all)).join(r() < 0.5 ? '\n' : '');
      const want = sanitizeRemoteUrlsReference(html);
      found += want.length;
      expect(collectRemoteImageUrls(html), html).toEqual(want);
    }
    // The inputs did hold remote images (the comparison isn't of empty lists).
    expect(found).toBeGreaterThan(15_000);
    // 20,000 sanitizings take a few seconds on a slow CI machine.
  }, 60_000);
});
