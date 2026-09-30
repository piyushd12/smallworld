// Draws the search on a <canvas>: two waves of dots growing from the source
// and the target, and the chain once they meet. Canvas rather than SVG
// because a search can find thousands of people.

import { createLayout, hash } from './layout.js';

export const MAX_NODES = 3000;
const FADE_MS = 450;
const GLOW_MS = 700;
const PULSE_MS = 1200;
const FLASH_MS = 1000;
const SEGMENT_MS = 420;
const DIM_MS = 900;
const DIMMED = 0.15;
const HUBS_PER_SIDE = 6;
const GRID = 24; // hit-test cell size, CSS pixels
const VIEW_MS = 900;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const DRAG_THRESHOLD = 4; // pixels a pointer moves before a tap becomes a drag

const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOut = (x) => 1 - (1 - x) ** 3;

// GitHub serves avatars at any size; ask for a small one.
function sizedAvatar(url) {
  if (!url?.startsWith('https://avatars.githubusercontent.com/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}s=96`;
}

export function createRenderer(canvas, { tooltip, tick = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  const layout = createLayout();
  const images = new Map();
  let width = 0;
  let height = 0;
  let dpr = 1;
  let colors = {};
  // Pan and zoom: screen = world * k + (x, y). Sizes are divided by the zoom
  // (see px), so dots and labels keep their size on screen.
  const IDENTITY = { k: 1, x: 0, y: 0 };
  let view = IDENTITY;
  let viewAnim = null; // { from, to, start }
  let userMoved = false; // the viewer panned or zoomed, so don't move the view for them
  let zoom = 1;
  const px = (n) => n / zoom;
  let raf = null;
  let running = false;
  let dirty = true;
  let animateUntil = 0;
  let showHubs = true;
  let linkProfiles = true;

  // Search state, rebuilt on reset().
  let all; // "side:login" -> node, for everyone discovered
  let visible; // the nodes being drawn (at most MAX_NODES)
  let rings; // "side:depth" -> { seen, members }, the sampled nodes per ring
  let roots;
  let children; // "side:login" -> number of people discovered through them
  let frontier; // side -> depth of the ring being built
  let pulses;
  let glows;
  let meet;
  let chain; // { nodes, segments, start }
  let ringCap;
  let grid;
  let gridStale;
  let gridZoom;

  const reduced = () => reducedMotionQuery.matches;
  const duration = (ms) => (reduced() ? 0 : ms);
  const progress = (start, ms, t) => (duration(ms) ? clamp01((t - start) / ms) : 1);

  function readColors() {
    const css = getComputedStyle(canvas);
    const v = (name) => css.getPropertyValue(name).trim();
    colors = {
      source: v('--wave-source'), target: v('--wave-target'), path: v('--path'),
      bg: v('--surface'), text: v('--text'), muted: v('--muted'), line: v('--line'),
    };
    dirty = true;
  }
  darkQuery.addEventListener('change', readColors);

  function reset() {
    all = new Map();
    visible = new Set();
    rings = new Map();
    roots = {};
    children = new Map();
    frontier = { source: 0, target: 0 };
    pulses = [];
    glows = [];
    meet = null;
    chain = null;
    ringCap = Math.floor(MAX_NODES / 6);
    grid = new Map();
    gridStale = false;
    view = IDENTITY;
    viewAnim = null;
    userMoved = false;
    layout.clear();
    hideTooltip();
    dirty = true;
  }

  function viewAt(t) {
    if (!viewAnim) return view;
    const k = easeOut(progress(viewAnim.start, VIEW_MS, t));
    if (k >= 1) {
      view = viewAnim.to;
      viewAnim = null;
      return view;
    }
    const { from, to } = viewAnim;
    const mix = (a, b) => a + (b - a) * k;
    return { k: mix(from.k, to.k), x: mix(from.x, to.x), y: mix(from.y, to.y) };
  }

  function setView(v, animate = false) {
    const now = performance.now();
    if (animate && duration(VIEW_MS)) {
      viewAnim = { from: viewAt(now), to: v, start: now };
      busyFor(VIEW_MS);
    } else {
      viewAnim = null;
      view = v;
      dirty = true;
    }
  }

  // Frames the given nodes (with room for avatars and names), never zooming
  // in past 1x. If they already fit the unmoved canvas, it stays unmoved.
  function fitView(nodes, animate) {
    if (!nodes.length || !width || !height) return;
    const pad = Math.max(48, unit() / 12);
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (minX >= pad && maxX <= width - pad && minY >= pad && maxY <= height - pad) {
      setView(IDENTITY, animate);
      return;
    }
    const k = Math.max(MIN_ZOOM, Math.min(1, (width - 2 * pad) / Math.max(1, maxX - minX), (height - 2 * pad) / Math.max(1, maxY - minY)));
    setView({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k }, animate);
  }

  const chainAndRoots = () => [...new Set([roots.source, roots.target, ...(chain?.nodes ?? [])].filter(Boolean))];

  function fit() {
    userMoved = false;
    fitView(chain ? chainAndRoots() : [...visible], true);
  }

  // Zooms by `factor` around a point on screen, keeping that point still.
  function zoomAt(sx, sy, factor) {
    const v = viewAt(performance.now());
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor));
    setView({ k, x: sx - ((sx - v.x) * k) / v.k, y: sy - ((sy - v.y) * k) / v.k });
    userMoved = true;
  }

  function panBy(dx, dy) {
    const v = viewAt(performance.now());
    setView({ k: v.k, x: v.x + dx, y: v.y + dy });
    userMoved = true;
  }

  function busyFor(ms) {
    animateUntil = Math.max(animateUntil, performance.now() + duration(ms));
    dirty = true;
  }

  function loadImage(url) {
    if (!url || images.has(url)) return;
    const img = new Image();
    img.onload = () => { dirty = true; };
    img.src = sizedAvatar(url);
    images.set(url, img);
  }

  function place(node) {
    const p = layout.pos(node.side, node.login);
    node.x = p.x;
    node.y = p.y;
  }

  function show(node) {
    node.shown = true;
    node.born = performance.now();
    visible.add(node);
    gridStale = true;
  }

  // Keeps each ring to an even sample: once full, a newcomer takes a random
  // (hash-chosen, so repeatable) member's place with the odds of reservoir
  // sampling. The totals in the captions still count everyone.
  function admit(node) {
    const key = `${node.side}:${node.depth}`;
    let ring = rings.get(key);
    if (!ring) rings.set(key, (ring = { seen: 0, members: [] }));
    ring.seen += 1;
    if (ring.members.length < ringCap) {
      ring.members.push(node);
      show(node);
      return;
    }
    const slot = Math.floor(hash(node.login, ring.seen) * ring.seen);
    if (slot < ringCap) {
      const out = ring.members[slot];
      if (!out.pinned) {
        out.shown = false;
        visible.delete(out);
      }
      ring.members[slot] = node;
      show(node);
    }
  }

  function nodeOf(side, login) {
    return all.get(`${side}:${login}`);
  }

  function apply(ev) {
    const now = performance.now();
    switch (ev.type) {
      case 'start':
        reset();
        // depth(source) + depth(target) never exceeds maxDegrees, so there are
        // at most that many rings beyond the two roots.
        ringCap = Math.floor(MAX_NODES / Math.max(1, ev.maxDegrees ?? 6));
        break;
      case 'discover': {
        layout.place(ev);
        const node = { side: ev.side, login: ev.login, parent: ev.parent, depth: ev.depth, avatarUrl: ev.avatarUrl, shown: false };
        place(node);
        all.set(`${ev.side}:${ev.login}`, node);
        if (ev.depth === 0) {
          roots[ev.side] = node;
          node.pinned = true;
          loadImage(ev.avatarUrl);
          show(node);
        } else {
          const pk = `${ev.side}:${ev.parent}`;
          children.set(pk, (children.get(pk) ?? 0) + 1);
          admit(node);
        }
        busyFor(FADE_MS);
        break;
      }
      case 'expand':
        glows.push({ side: ev.side, login: ev.login, start: now });
        busyFor(GLOW_MS);
        break;
      case 'round':
        frontier[ev.side] = ev.depth;
        pulses.push({ side: ev.side, depth: ev.depth, start: now });
        busyFor(PULSE_MS);
        break;
      case 'meet':
        meet = { login: ev.login, start: now };
        busyFor(FLASH_MS);
        break;
      case 'path': {
        const logins = ev.logins;
        const m = meet ? logins.indexOf(meet.login) : logins.length - 1;
        // The source half is drawn where the source wave found it, the target
        // half where the target wave did; the meeting node is on both.
        const nodes = logins.map((login, i) => nodeOf(i <= m ? 'source' : 'target', login)).filter(Boolean);
        for (const n of nodes) {
          n.pinned = true;
          if (!n.shown) show(n);
          loadImage(n.avatarUrl);
        }
        // Segments are drawn from both ends toward the meeting point.
        const segments = [];
        for (let i = 0; i < nodes.length - 1; i++) {
          segments.push({ a: nodes[i], b: nodes[i + 1], order: i < m ? i : nodes.length - 2 - i, reverse: i >= m });
        }
        const steps = Math.max(m, nodes.length - 1 - m);
        chain = { nodes, segments, start: now + duration(FLASH_MS * 0.6), steps };
        busyFor(FLASH_MS * 0.6 + steps * SEGMENT_MS + DIM_MS);
        // The meeting point can be far out on a ring, off the canvas: frame
        // the whole chain unless the viewer has moved the view themselves.
        if (!userMoved) fitView(chainAndRoots(), true);
        break;
      }
      default:
        break;
    }
  }

  // How long until the chain has finished drawing, so the page can wait for it.
  function settleMs() {
    return Math.max(0, animateUntil - performance.now());
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    layout.resize(width, height);
    for (const n of all.values()) place(n);
    // Positions moved with the new size, so the old pan/zoom no longer applies.
    userMoved = false;
    if (chain) fitView(chainAndRoots(), false);
    else setView(IDENTITY);
    gridStale = true;
    dirty = true;
  }

  // ---- drawing ----

  const unit = () => Math.min(width, height * 1.6);
  // Sizes in world units that look the same on screen at any zoom.
  const dotRadius = () => px(Math.max(2.4, unit() / 260));
  const avatarRadius = (node) => {
    const base = px(Math.max(13, unit() / 28));
    return node.depth === 0 ? base : base * 0.78;
  };
  const isBig = (node) => node.depth === 0 || (chain && chain.nodes.includes(node));

  function ellipse(side, r) {
    const e = layout.ring(side, r);
    ctx.beginPath();
    ctx.ellipse(e.x, e.y, Math.max(0, e.rx), Math.max(0, e.ry), 0, 0, Math.PI * 2);
  }

  function dimAt(t) {
    return chain ? 1 - (1 - DIMMED) * progress(chain.start, DIM_MS, t) : 1;
  }

  function drawRings(t, dim) {
    ctx.lineWidth = px(1);
    ctx.setLineDash([px(4), px(6)]);
    for (const side of ['source', 'target']) {
      if (!frontier[side]) continue;
      ctx.globalAlpha = 0.45 * dim;
      ctx.strokeStyle = colors[side];
      ellipse(side, frontier[side]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    pulses = pulses.filter((p) => t - p.start < duration(PULSE_MS));
    for (const p of pulses) {
      const k = easeOut(progress(p.start, PULSE_MS, t));
      ctx.globalAlpha = 0.5 * (1 - k);
      ctx.lineWidth = px(2 + 6 * (1 - k));
      ctx.strokeStyle = colors[p.side];
      ellipse(p.side, p.depth - 1 + k);
      ctx.stroke();
    }
  }

  function drawEdges(dim) {
    ctx.lineWidth = px(1);
    for (const side of ['source', 'target']) {
      ctx.beginPath();
      for (const n of visible) {
        if (n.side !== side || n.depth === 0) continue;
        const p = nodeOf(side, n.parent);
        if (!p) continue;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(n.x, n.y);
      }
      ctx.globalAlpha = 0.16 * dim;
      ctx.strokeStyle = colors[side];
      ctx.stroke();
    }
  }

  function drawDots(t, dim) {
    const r = dotRadius();
    for (const side of ['source', 'target']) {
      ctx.fillStyle = colors[side];
      // Fully faded-in dots go in one batch; new ones are drawn one by one.
      ctx.beginPath();
      for (const n of visible) {
        if (n.side !== side || isBig(n)) continue;
        const k = progress(n.born, FADE_MS, t);
        if (k < 1) continue;
        ctx.moveTo(n.x + r, n.y);
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      ctx.globalAlpha = 0.85 * dim;
      ctx.fill();
      for (const n of visible) {
        if (n.side !== side || isBig(n)) continue;
        const k = progress(n.born, FADE_MS, t);
        if (k >= 1) continue;
        ctx.globalAlpha = 0.85 * dim * k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * (0.3 + 0.7 * easeOut(k)) * (1 + 0.6 * (1 - k)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawGlows(t) {
    glows = glows.filter((g) => t - g.start < duration(GLOW_MS));
    for (const g of glows) {
      const n = nodeOf(g.side, g.login);
      if (!n || !n.shown) continue;
      const k = progress(g.start, GLOW_MS, t);
      const r = dotRadius() * (2 + 4 * k);
      const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r);
      grad.addColorStop(0, colors[g.side]);
      grad.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.7 * (1 - k);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function label(text, x, y, { color = colors.text, size = 12, weight = 600, alpha = 1 } = {}) {
    ctx.globalAlpha = alpha;
    ctx.font = `${weight} ${px(size)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = px(4);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colors.bg;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function hubs() {
    const out = [];
    for (const side of ['source', 'target']) {
      const list = [...visible]
        .filter((n) => n.side === side && !isBig(n) && children.get(`${side}:${n.login}`))
        .sort((a, b) => children.get(`${b.side}:${b.login}`) - children.get(`${a.side}:${a.login}`));
      out.push(...list.slice(0, HUBS_PER_SIDE));
    }
    return out;
  }

  function drawHubLabels(dim) {
    const size = Math.max(10, Math.round(unit() / 80));
    for (const n of hubs()) label(`@${n.login}`, n.x, n.y + dotRadius() + px(3), { size, weight: 500, color: colors.muted, alpha: dim });
  }

  function drawChain(t) {
    if (!chain) return;
    ctx.strokeStyle = colors.path;
    ctx.lineCap = 'round';
    ctx.lineWidth = px(Math.max(3, unit() / 220));
    ctx.globalAlpha = 1;
    for (const s of chain.segments) {
      const k = easeOut(progress(chain.start + s.order * duration(SEGMENT_MS), SEGMENT_MS, t));
      if (k <= 0) continue;
      // Grow each segment from the outer end toward the meeting point.
      const [from, to] = s.reverse ? [s.b, s.a] : [s.a, s.b];
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
      ctx.stroke();
    }
  }

  function drawAvatar(n, t) {
    const r = avatarRadius(n);
    const ring = chain && chain.nodes.includes(n) ? colors.path : colors[n.side];
    const k = progress(n.born, FADE_MS, t);
    ctx.globalAlpha = k;
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + px(3), 0, Math.PI * 2);
    ctx.fill();
    const img = images.get(n.avatarUrl);
    ctx.save();
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.clip();
    if (img?.complete && img.naturalWidth) ctx.drawImage(img, n.x - r, n.y - r, r * 2, r * 2);
    else {
      ctx.fillStyle = colors.bg;
      ctx.fill();
    }
    ctx.restore();
    const size = Math.max(11, Math.round(unit() / 60));
    label(`@${n.login}`, n.x, n.y + r + px(6), { size, alpha: k });
  }

  function drawMeetFlash(t) {
    if (!meet) return;
    const k = progress(meet.start, FLASH_MS, t);
    if (k >= 1) return;
    const n = nodeOf('source', meet.login) ?? nodeOf('target', meet.login);
    if (!n) return;
    const r = avatarRadius(n) * (1 + 3 * easeOut(k));
    ctx.globalAlpha = 0.8 * (1 - k);
    ctx.strokeStyle = colors.path;
    ctx.lineWidth = px(4);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width, height);
    const v = viewAt(t);
    zoom = v.k;
    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
    const dim = dimAt(t);
    drawRings(t, dim);
    drawEdges(dim);
    drawGlows(t);
    drawDots(t, dim);
    if (showHubs) drawHubLabels(dim);
    drawChain(t);
    drawMeetFlash(t);
    const big = [...visible].filter(isBig);
    for (const n of big) drawAvatar(n, t);
    ctx.globalAlpha = 1;
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    tick();
    const t = performance.now();
    if (!dirty && t > animateUntil) return;
    dirty = false;
    draw(t);
  }

  function start() {
    if (running) return;
    running = true;
    if (!document.hidden) raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  document.addEventListener('visibilitychange', () => {
    if (!running) return;
    if (document.hidden) cancelAnimationFrame(raf);
    else {
      dirty = true;
      raf = requestAnimationFrame(frame);
    }
  });

  new ResizeObserver(() => resize()).observe(canvas);

  // ---- hover, tap and click ----

  // The grid is in world units, with cells GRID screen pixels wide at the
  // current zoom, so it is rebuilt when the zoom changes.
  function rebuildGrid() {
    grid = new Map();
    const cell = GRID / zoom;
    for (const n of visible) {
      const key = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(n);
    }
    gridStale = false;
    gridZoom = zoom;
  }

  // Finds the node under a point on screen.
  function hitTest(sx, sy) {
    const v = viewAt(performance.now());
    zoom = v.k;
    if (gridStale || gridZoom !== zoom) rebuildGrid();
    const x = (sx - v.x) / v.k;
    const y = (sy - v.y) / v.k;
    const cell = GRID / zoom;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let best = null;
    let bestD = Infinity;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        for (const n of grid.get(`${cx + i},${cy + j}`) ?? []) {
          const reach = isBig(n) ? avatarRadius(n) + px(3) : Math.max(px(8), dotRadius() * 2.5);
          const d = Math.hypot(n.x - x, n.y - y);
          if (d <= reach && (d < bestD || (isBig(n) && !isBig(best)))) {
            best = n;
            bestD = d;
          }
        }
      }
    }
    return best;
  }

  const profileUrl = (login) => `https://github.com/${encodeURIComponent(login)}`;

  function showTooltip(n, withLink) {
    if (!tooltip) return;
    const from = roots[n.side]?.login ?? '';
    tooltip.replaceChildren();
    const name = document.createElement('strong');
    name.textContent = `@${n.login}`;
    const detail = document.createElement('span');
    const steps = n.depth === 0 ? (n.side === 'source' ? 'where the search starts' : 'where the search ends')
      : `${n.depth} step${n.depth === 1 ? '' : 's'} from @${from}`;
    detail.textContent = `${n.side === 'source' ? 'Source' : 'Target'} side · ${steps}`;
    tooltip.append(name, detail);
    if (withLink && linkProfiles) {
      const a = document.createElement('a');
      a.href = profileUrl(n.login);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open profile';
      tooltip.append(a);
    }
    tooltip.hidden = false;
    // Keep the tooltip inside the canvas.
    const v = viewAt(performance.now());
    const sx = n.x * v.k + v.x;
    const sy = n.y * v.k + v.y;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    const left = Math.min(Math.max(4, sx - tw / 2), width - tw - 4);
    const top = sy - th - 12 >= 4 ? sy - th - 12 : sy + 14;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  const local = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  // Drag to pan (one pointer), pinch to zoom (two). A pointer that barely
  // moves is a click or tap instead.
  const pointers = new Map(); // pointerId -> [x, y]
  let gesture = null; // { start: [x, y], moved }

  const midpoint = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = ''; // let the grab/grabbing cursor from CSS show
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) gesture = { start: local(e), moved: false };
    else if (gesture) gesture.moved = true; // a second finger: a pinch, not a tap
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId) && gesture) {
      const before = pointers.size === 2 ? midpoint() : null;
      const [ox, oy] = pointers.get(e.pointerId);
      pointers.set(e.pointerId, p);
      if (!gesture.moved && Math.hypot(p[0] - gesture.start[0], p[1] - gesture.start[1]) > DRAG_THRESHOLD) gesture.moved = true;
      if (!gesture.moved) return;
      hideTooltip();
      canvas.classList.add('dragging');
      if (before) {
        const after = midpoint();
        zoomAt(after.x, after.y, before.d ? after.d / before.d : 1);
        panBy(after.x - before.x, after.y - before.y);
      } else if (pointers.size === 1) {
        panBy(p[0] - ox, p[1] - oy);
      }
      return;
    }
    if (e.pointerType !== 'mouse') return;
    const n = hitTest(...p);
    canvas.style.cursor = n && linkProfiles ? 'pointer' : '';
    if (n) showTooltip(n, false);
    else hideTooltip();
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (!pointers.size) {
      gesture = null;
      canvas.classList.remove('dragging');
    }
  }
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !pointers.size) hideTooltip();
  });

  // Ctrl + scroll (which is also what a trackpad pinch sends) zooms; a plain
  // scroll keeps scrolling the page, except in fullscreen where there is none.
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey && !document.fullscreenElement) return;
    e.preventDefault();
    zoomAt(...local(e), Math.exp(-e.deltaY * 0.002));
  }, { passive: false });

  canvas.addEventListener('dblclick', fit);

  canvas.addEventListener('pointerup', (e) => {
    const tap = gesture && !gesture.moved;
    endPointer(e);
    if (!tap) return;
    const n = hitTest(...local(e));
    if (e.pointerType === 'mouse') {
      if (n && linkProfiles) window.open(profileUrl(n.login), '_blank', 'noopener');
      return;
    }
    // Touch has no hover: a tap shows the tooltip, with a link to the profile.
    if (n) showTooltip(n, true);
    else hideTooltip();
  });

  reset();
  readColors();

  return {
    apply,
    reset,
    start,
    stop,
    settleMs,
    refreshColors: readColors,
    setHubLabels(on) {
      showHubs = on;
      dirty = true;
    },
    setLinkProfiles(on) {
      linkProfiles = on;
    },
    fit,
    zoomBy: (factor) => zoomAt(width / 2, height / 2, factor),
  };
}
