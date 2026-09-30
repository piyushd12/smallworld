// Renders the 1200x630 share-preview PNGs: satori (element tree -> SVG) then
// resvg (SVG -> PNG). No JSX or build step, just plain object trees.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const W = 1200;
const H = 630;
const BG = '#14161a';
const SURFACE = '#1d2025';
const TEXT = '#e8eaed';
const MUTED = '#9aa3b2';
const ACCENT = '#5b8cff'; // the app's dark-theme accent
const PAD = 60;
const ARROW_W = 56;

// satori can't read WOFF2, so load the WOFF files once at startup.
const require = createRequire(import.meta.url);
const font = (weight) => ({
  name: 'Inter',
  weight,
  style: 'normal',
  data: fs.readFileSync(require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`)),
});
const fonts = [font(400), font(700)];

const h = (type, style, children) => ({ type, props: { style, children } });
const img = (src, width, height, style = {}) => ({ type: 'img', props: { src, width, height, style } });

// The Inter latin subset has no arrow glyphs, so arrows are tiny SVG images.
const arrowSvg = (kind, size = 40, color = ACCENT) => {
  const head = (x, dir) => `<path d="M${x + 10 * dir} 8 L${x} 20 L${x + 10 * dir} 32" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  const line = `<path d="M6 20 H34" stroke="${color}" stroke-width="4" stroke-linecap="round"/>`;
  let body = line;
  if (kind !== 'back') body += head(34, -1);
  if (kind !== 'forward') body += head(6, 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">${body}</svg>`;
  return img(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, size, size);
};

const host = (publicUrl) => new URL(publicUrl).host;

// Fetches a GitHub avatar as a data URI; null on any failure or slow response.
export async function loadAvatar(login) {
  try {
    const res = await fetch(`https://github.com/${login}.png?size=128`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/png';
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  } catch {
    return null;
  }
}

function hue(login) {
  let n = 0;
  for (const c of login) n = (n * 31 + c.charCodeAt(0)) % 360;
  return n;
}

function avatar(login, src, size) {
  if (src) return img(src, size, size, { borderRadius: size / 2, border: `3px solid ${ACCENT}` });
  return h('div', {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size,
    borderRadius: size / 2, background: `hsl(${hue(login)}, 45%, 38%)`, color: '#fff',
    fontSize: size * 0.45, fontWeight: 700,
  }, login[0].toUpperCase());
}

function person(login, src, size, colW, labelSize) {
  // The label may spill into the arrow gaps on either side, so long names survive 8-person rows.
  const labelW = colW + ARROW_W - 8;
  return h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', width: colW }, [
    avatar(login, src, size),
    h('div', { display: 'flex', justifyContent: 'center', width: labelW, marginTop: 14 },
      h('div', {
        display: 'block', maxWidth: labelW, fontSize: labelSize, color: TEXT,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }, `@${login}`)),
  ]);
}

function headline(parts, fontSize) {
  // parts: strings and arrow images, laid out in one row.
  return h('div', { display: 'flex', alignItems: 'center', gap: 20, fontSize, fontWeight: 700, color: TEXT }, parts);
}

function footer(publicUrl) {
  return h('div', {
    display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: 26, color: MUTED,
  }, [
    h('div', { display: 'flex' }, 'smallworld · trace your own chain'),
    h('div', { display: 'flex', color: ACCENT }, host(publicUrl)),
  ]);
}

function frame(children, publicUrl) {
  return h('div', {
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: W, height: H,
    padding: PAD, background: BG, fontFamily: 'Inter',
  }, [h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', flexGrow: 1, justifyContent: 'center' }, children), footer(publicUrl)]);
}

const fontSizeFor = (text) => (text.length > 34 ? 40 : text.length > 24 ? 52 : 64);

function chainCard(verified, avatars, publicUrl) {
  const { users, edges } = verified;
  const n = users.length;
  const degrees = n - 1;
  const colW = Math.floor((W - 2 * PAD - (n - 1) * ARROW_W) / n);
  const size = Math.min(128, colW);
  const labelSize = n > 6 ? 18 : n > 4 ? 22 : 26;
  const first = users[0].login;
  const last = users[n - 1].login;

  const row = [];
  users.forEach((u, i) => {
    row.push(person(u.login, avatars[i], size, colW, labelSize));
    if (i < n - 1) {
      const e = edges[i];
      const kind = e.aFollowsB && e.bFollowsA ? 'both' : e.aFollowsB ? 'forward' : 'back';
      row.push(h('div', { display: 'flex', justifyContent: 'center', width: ARROW_W, marginTop: -(size / 2) - 14 }, arrowSvg(kind)));
    }
  });

  return frame([
    headline([`@${first}`, arrowSvg('forward', 52), `@${last}`], fontSizeFor(`@${first}@${last}`)),
    h('div', { display: 'flex', marginTop: 14, fontSize: 34, color: MUTED }, `${degrees} ${degrees === 1 ? 'degree' : 'degrees'} apart on GitHub`),
    h('div', { display: 'flex', alignItems: 'center', marginTop: 56 }, row),
  ], publicUrl);
}

function questionCard(q, avatars, publicUrl) {
  const size = 150;
  return frame([
    headline([`@${q.from}`, arrowSvg('forward', 52), '?', arrowSvg('forward', 52), `@${q.to}`], fontSizeFor(`@${q.from}?@${q.to}`) * 0.8),
    h('div', { display: 'flex', marginTop: 14, fontSize: 34, color: MUTED }, 'How many follows apart are they?'),
    h('div', { display: 'flex', alignItems: 'center', gap: 40, marginTop: 50 }, [
      person(q.from, avatars[0], size, 260, 26),
      h('div', { display: 'flex', fontSize: 72, fontWeight: 700, color: ACCENT }, '?'),
      person(q.to, avatars[1], size, 260, 26),
    ]),
  ], publicUrl);
}

function defaultCard(publicUrl) {
  const dots = [];
  for (let i = 0; i < 7; i++) {
    const big = i === 0 || i === 6;
    dots.push(h('div', { display: 'flex', width: big ? 64 : 36, height: big ? 64 : 36, borderRadius: 32, background: big ? ACCENT : SURFACE, border: `3px solid ${ACCENT}` }, ''));
    if (i < 6) dots.push(h('div', { display: 'flex', width: 46, height: 0, borderTop: `4px dashed ${MUTED}` }, ''));
  }
  return frame([
    h('div', { display: 'flex', fontSize: 96, fontWeight: 700, color: TEXT }, 'smallworld'),
    h('div', { display: 'flex', marginTop: 20, maxWidth: 900, textAlign: 'center', fontSize: 34, color: MUTED }, 'A small-world explorer that traces the shortest chain of follows between any two GitHub users'),
    h('div', { display: 'flex', alignItems: 'center', marginTop: 56 }, dots),
  ], publicUrl);
}

async function toPng(tree) {
  const svg = await satori(tree, { width: W, height: H, fonts });
  return new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
}

export const renderDefault = (publicUrl) => toPng(defaultCard(publicUrl));

// q: parsed share query or null. verified: { valid, edges, users } or null.
export async function renderOg(q, verified, publicUrl) {
  if (!q) return renderDefault(publicUrl);
  if (verified?.valid && verified.users.length >= 2) {
    const avatars = await Promise.all(verified.users.map((u) => loadAvatar(u.login)));
    return toPng(chainCard(verified, avatars, publicUrl));
  }
  const avatars = await Promise.all([loadAvatar(q.from), loadAvatar(q.to)]);
  return toPng(questionCard(q, avatars, publicUrl));
}
