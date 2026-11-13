// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: draws DreyMail's icon (a cyan envelope in an indigo drey) instead of
// upstream's squirrel; adds day/night variants and an adaptive favicon.
//
// Regenerates every app icon from the artwork defined below (1024x1024 units).
// Writes the SVG variants to web/icons-src/, branding/ and web/public/ (favicon, in-app brand marks), and the PNGs to
// web/public/icons/. The rasterizer is not a project dependency:
//   npm i --no-save @resvg/resvg-js && node scripts/icons.mjs
import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const SRC = 'web/icons-src';
const OUT = 'web/public/icons';

// The envelope is the app accent (--accent-fill in web/src/styles.css); its fold line is the night navy.
const CYAN = '#22d3ee';
const NAVY = '#141b34';
const NIGHT = { bg: NAVY, edge: '#2c3766', flap: NAVY, twig: '#6c7bd9', bowl: '#3b47a8', weave: '#6c7bd9', rim: '#5562c8' };
const DAY = { bg: '#e8ecff', edge: '#c9d0f5', flap: NAVY, twig: '#3b47a8', bowl: '#3b47a8', weave: '#7f8be6', rim: '#2f3a96' };

const ENVELOPE_RECT = 'x="262" y="250" width="500" height="350" rx="35"';
const FLAP = 'M 290 280 L 512 432 L 734 280';
const TWIGS = ['M 130 500 L 262 560', 'M 150 610 L 270 590', 'M 894 498 L 760 560', 'M 880 620 L 756 592'];
const BOWL = 'M 168 548 C 300 600 724 600 856 548 C 850 760 700 864 512 864 C 324 864 174 760 168 548 Z';
const WEAVE = [
  'M 200 610 C 360 680 640 690 830 600',
  'M 220 690 C 400 760 640 760 800 680',
  'M 280 770 C 420 830 620 830 740 760',
  'M 230 600 C 330 720 470 800 620 846',
  'M 800 610 C 700 730 560 800 400 846',
];
const RIM = 'M 160 548 C 300 606 724 606 864 548';
const TILT = 'rotate(-9 512 425)';

const art = (p) =>
  `<g transform="${TILT}"><rect ${ENVELOPE_RECT} fill="${CYAN}"/>` +
  `<path d="${FLAP}" fill="none" stroke="${p.flap}" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/></g>` +
  `<g stroke="${p.twig}" stroke-width="26" stroke-linecap="round">${TWIGS.map((d) => `<path d="${d}"/>`).join('')}</g>` +
  `<path d="${BOWL}" fill="${p.bowl}"/>` +
  `<g stroke="${p.weave}" stroke-width="18" stroke-linecap="round" fill="none">${WEAVE.map((d) => `<path d="${d}"/>`).join('')}</g>` +
  `<path d="${RIM}" fill="none" stroke="${p.rim}" stroke-width="40" stroke-linecap="round"/>`;

const svg = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"';
const TILE = 'x="8" y="8" width="1008" height="1008" rx="216"';
// Rounded tile with a thin lighter edge, so the dark tile still stands out on a dark page.
const tile = (p) => `<svg ${svg}><title>DreyMail</title><rect ${TILE} fill="${p.bg}" stroke="${p.edge}" stroke-width="16"/>${art(p)}</svg>\n`;
// Full bleed, opaque: launchers apply their own mask, so the art shrinks into the 80% safe circle.
const fullBleed = `<svg ${svg}><title>DreyMail</title><rect width="1024" height="1024" fill="${NIGHT.bg}"/><g transform="translate(512 512) scale(0.88) translate(-512 -540)">${art(NIGHT)}</g></svg>\n`;
// Notification badge: Android only uses the alpha channel, so a white silhouette on transparent, with the fold line
// cut out of the envelope.
const badge =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="110 133 804 804"><defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">` +
  `<g transform="${TILT}"><rect ${ENVELOPE_RECT} fill="#fff"/><path d="${FLAP}" fill="none" stroke="#000" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/></g>` +
  `<path d="${RIM}" fill="none" stroke="#000" stroke-width="90" stroke-linecap="round"/></mask></defs>` +
  `<g fill="#fff"><rect width="1024" height="1024" mask="url(#m)"/><path d="${BOWL}"/></g>` +
  `<g stroke="#fff" stroke-width="26" stroke-linecap="round">${TWIGS.map((d) => `<path d="${d}"/>`).join('')}</g></svg>\n`;

// Browser tab icon: follows the system light/dark setting (day tile in light, night tile in dark).
const cls = (p) =>
  `.bg{fill:${p.bg};stroke:${p.edge}}.fl{stroke:${p.flap}}.tw{stroke:${p.twig}}.bw{fill:${p.bowl}}.wv{stroke:${p.weave}}.rm{stroke:${p.rim}}`;
const adaptive =
  `<svg ${svg}><title>DreyMail</title><style>${cls(DAY)}@media (prefers-color-scheme: dark){${cls(NIGHT)}}</style>` +
  `<rect class="bg" ${TILE} stroke-width="16"/>` +
  `<g transform="${TILT}"><rect ${ENVELOPE_RECT} fill="${CYAN}"/><path class="fl" d="${FLAP}" fill="none" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/></g>` +
  `<g class="tw" stroke-width="26" stroke-linecap="round">${TWIGS.map((d) => `<path d="${d}"/>`).join('')}</g>` +
  `<path class="bw" d="${BOWL}"/>` +
  `<g class="wv" stroke-width="18" stroke-linecap="round" fill="none">${WEAVE.map((d) => `<path d="${d}"/>`).join('')}</g>` +
  `<path class="rm" d="${RIM}" fill="none" stroke-width="40" stroke-linecap="round"/></svg>\n`;

const variants = {
  'icon.svg': tile(NIGHT),
  'icon-day.svg': tile(DAY),
  'full-bleed.svg': fullBleed,
  'badge.svg': badge,
};
// License notice written into every SVG (AGPL-3.0 §5(a)). Files that replace upstream's squirrel icons at the same
// path also say they were modified.
const NOTICE =
  'DreyMail icon artwork. Copyright (C) 2026 samschultzponsys. Part of DreyMail, a modified version of Ratatoskr ' +
  '(https://github.com/magnuspihl/Ratatoskr), Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL ' +
  'v3.0 only; see LICENSE and NOTICE. Generated by scripts/icons.mjs.';
const MODIFIED = " Modified by samschultzponsys, 2026-11-13: DreyMail artwork replaces upstream's squirrel icon.";
// Modified by samschultzponsys, 2026-11-13: Android launcher icons.
const write = (file, content, replacesUpstream = false) =>
  fs.writeFileSync(file, content.replace(/^(<svg[^>]*>)/, `$1<!-- ${NOTICE}${replacesUpstream ? MODIFIED : ''} -->`));

for (const [name, content] of Object.entries(variants)) write(`${SRC}/${name}`, content, name !== 'icon-day.svg');
write('web/public/favicon.svg', adaptive, true);
// In-app logo (sidebar, login): CSS shows the one matching the app's own theme.
write('web/public/brand-night.svg', variants['icon.svg']);
write('web/public/brand-day.svg', variants['icon-day.svg']);
write('branding/dreymail-icon.svg', variants['icon.svg']);
write('branding/dreymail-icon-day.svg', variants['icon-day.svg']);

const pngs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['full-bleed.svg', 'icon-maskable-512.png', 512],
  ['full-bleed.svg', 'apple-touch-icon.png', 180],
  ['badge.svg', 'badge-96.png', 96],
];
for (const [src, out, size] of pngs) {
  const png = new Resvg(variants[src], { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(`${OUT}/${out}`, png);
  console.log(`${OUT}/${out}`);
}
fs.writeFileSync('branding/dreymail-icon-512.png', new Resvg(variants['icon.svg'], { fitTo: { mode: 'width', value: 512 } }).render().asPng());

// Android app (android/): adaptive launcher icon foreground (the art inside Android's 66% safe zone,
// on transparent; the background layer is the night navy) and a legacy square icon.
const androidRes = 'android/app/src/main/res';
const foreground = `<svg ${svg}><g transform="translate(512 512) scale(0.6) translate(-512 -540)">${art(NIGHT)}</g></svg>\n`;
for (const [dir, size] of [['mipmap-mdpi', 108], ['mipmap-hdpi', 162], ['mipmap-xhdpi', 216], ['mipmap-xxhdpi', 324], ['mipmap-xxxhdpi', 432]]) {
  fs.mkdirSync(`${androidRes}/${dir}`, { recursive: true });
  fs.writeFileSync(`${androidRes}/${dir}/ic_launcher_foreground.png`, new Resvg(foreground, { fitTo: { mode: 'width', value: size } }).render().asPng());
  const legacy = Math.round((size * 48) / 108);
  fs.writeFileSync(`${androidRes}/${dir}/ic_launcher.png`, new Resvg(variants['icon.svg'], { fitTo: { mode: 'width', value: legacy } }).render().asPng());
}
