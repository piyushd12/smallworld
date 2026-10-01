import { findConnection, SearchError } from './search.js';
import { parseShareQuery, buildShareQuery } from './share.js';
import { mountWatch } from './animation/controls.js';
import { createDemoFetch, DEMO_PAIRS } from './animation/demo-graph.js';

const form = document.getElementById('search-form');
const sourceInput = document.getElementById('source');
const targetInput = document.getElementById('target');
const maxDegreesInput = document.getElementById('max-degrees');
const maxPagesInput = document.getElementById('max-pages');
const findBtn = document.getElementById('find-btn');
const stopBtn = document.getElementById('stop-btn');
const statusLine = document.getElementById('status-line');
const errorBox = document.getElementById('error-box');
const resultSection = document.getElementById('result');
const headlineEl = document.getElementById('headline');
const chainsEl = document.getElementById('chains');
const routesEl = document.getElementById('routes');
const routesSummary = document.getElementById('routes-summary');
const altRoutesInput = document.getElementById('alt-routes');
const demoPick = document.getElementById('demo-pick');
const graphSvg = document.getElementById('graph');
const statsEl = document.getElementById('stats');
const tokenWarning = document.getElementById('token-warning');
const sharedNote = document.getElementById('shared-note');
const copyBtn = document.getElementById('copy-link');
const nativeShareBtn = document.getElementById('native-share');
const demoBtn = document.getElementById('demo-btn');
const animateToggle = document.getElementById('animate');
const replayBtn = document.getElementById('replay-btn');
const watch = mountWatch(document.getElementById('watch'));

let controller = null;
let lastRun = null; // { timeline, demo } of the result on screen, for "Replay search"
let maxPagesTouched = false;
maxPagesInput.addEventListener('input', () => { maxPagesTouched = true; });

// Discover whether the server has a token so we can warn the user and pick a
// sane default for max pages (higher rate limit == can afford more pages).
fetch('/api/rate_limit')
  .then((r) => r.json())
  .then((data) => {
    if (!data.hasToken) {
      tokenWarning.hidden = false;
      if (!maxPagesTouched) maxPagesInput.value = 1;
    }
  })
  .catch(() => {});

function normalizeUsername(raw) {
  let s = raw.trim().replace(/^@/, '');
  const urlMatch = s.match(/github\.com\/([^/?#]+)/i);
  if (urlMatch) s = urlMatch[1];
  return s.replace(/\/+$/, '');
}

function makeFetchJson() {
  return async function fetchJson(path, { signal } = {}) {
    const res = await fetch(path, { signal });
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    // Anything the server answered from its cache cost no GitHub quota.
    const cached = ['hit', 'revalidated', 'stale'].includes(res.headers.get('x-cache'));
    let data = null;
    try {
      data = await res.json();
    } catch {
      // no/invalid JSON body
    }
    return { status: res.status, data, remaining, reset, cached };
  };
}

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function resetUI() {
  errorBox.hidden = true;
  resultSection.hidden = true;
  sharedNote.hidden = true;
  statusLine.hidden = false;
  statusLine.textContent = 'Starting search…';
}

function updateStatus({ degree, checked, requests, cacheHits, remaining }) {
  statusLine.hidden = false;
  const rate = remaining != null ? `, ${remaining} rate limit remaining` : '';
  statusLine.textContent =
    `Searching degree ${degree}… ${checked} users checked, ${requests} GitHub requests (${cacheHits} more from cache)${rate}.`;
}

const smoothScroll = (el) => el.scrollIntoView({
  behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  block: 'start',
});

// Runs one search. With "Animate search" on, the result is shown once the
// animation has played out, then the page scrolls down to it.
async function runSearch({ source, target, mode, maxDegrees, maxPages, fetchJson, demo = false }) {
  const altRoutes = altRoutesInput.checked;
  const animate = animateToggle.checked;
  controller = new AbortController();
  findBtn.disabled = true;
  demoBtn.disabled = true;
  demoPick.disabled = true;
  stopBtn.hidden = false;
  resetUI();
  if (animate) {
    watch.startLive({ linkProfiles: !demo });
    smoothScroll(document.getElementById('watch'));
  } else {
    watch.hide();
  }

  try {
    const result = await findConnection(source, target, {
      fetchJson,
      mode,
      maxDegrees,
      maxPages,
      altRoutes,
      signal: controller.signal,
      onProgress: updateStatus,
      onEvent: animate ? watch.push : undefined,
    });
    const show = () => {
      handleResult(result, mode, demo);
      if (animate) smoothScroll(resultSection.hidden ? errorBox : resultSection);
    };
    if (animate) {
      statusLine.textContent = 'Search finished, finishing the animation…';
      watch.whenDone(show);
    } else {
      show();
    }
  } catch (err) {
    handleError(err);
  } finally {
    findBtn.disabled = false;
    demoBtn.disabled = false;
    demoPick.disabled = false;
    stopBtn.hidden = true;
    controller = null;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const source = normalizeUsername(sourceInput.value);
  const target = normalizeUsername(targetInput.value);
  if (!source || !target) return;
  runSearch({
    source,
    target,
    mode: form.mode.value,
    maxDegrees: Number(maxDegreesInput.value) || 6,
    maxPages: Number(maxPagesInput.value) || 1,
    fetchJson: makeFetchJson(),
  });
});

// Demo mode: the real search, run against a made-up network in the browser,
// so it works in a presentation with no network and no token.
demoBtn.addEventListener('click', () => {
  animateToggle.checked = true;
  const pair = DEMO_PAIRS[demoPick.value] ?? DEMO_PAIRS.long;
  runSearch({
    source: pair.source,
    target: pair.target,
    mode: 'either',
    maxDegrees: 6,
    maxPages: 3,
    fetchJson: createDemoFetch(),
    demo: true,
  });
});

replayBtn.addEventListener('click', () => {
  if (!lastRun) {
    // A shared link has no recorded search, so run it for real.
    animateToggle.checked = true;
    form.requestSubmit();
    return;
  }
  watch.replay(lastRun.timeline, { linkProfiles: !lastRun.demo });
  smoothScroll(document.getElementById('watch'));
  watch.whenDone(() => smoothScroll(resultSection));
});

stopBtn.addEventListener('click', () => {
  if (controller) controller.abort();
});

function handleError(err) {
  statusLine.hidden = true;
  if (err?.name === 'AbortError') {
    showError('Search stopped.');
  } else if (err instanceof SearchError && err.code === 'bad_token') {
    showError('GitHub rejected the server’s token (401 Bad credentials). Check GITHUB_TOKEN in .env.');
  } else if (err instanceof TypeError) {
    showError('Could not reach the server. Is it running? (npm start)');
  } else {
    showError(err?.message || 'Something went wrong.');
  }
}

function handleResult(result, mode, demo) {
  statusLine.hidden = true;
  if (result.status === 'same') {
    showError('Source and target are the same user.');
    return;
  }
  if (result.status === 'user_not_found') {
    showError(`User "@${result.login}" was not found on GitHub.`);
    return;
  }
  if (result.status === 'not_found') {
    showError(notFoundMessage(result));
    return;
  }
  renderFound(result, mode, demo);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const TRY_EITHER = 'Switch the link mode to "Either person follows the other" in Settings to count follows in both directions.';

// Why no chain was found, in terms the user can act on. The first three are
// certain (read straight from the profiles); the rest mean "not within the
// limits of this search", never "no connection exists".
function notFoundMessage(result) {
  const { maxDegrees, maxPages } = result.limits ?? {};
  switch (result.reason) {
    case 'isolated':
      return `@${result.login} has no followers and follows no one, so they aren't connected to anyone on GitHub.`;
    case 'source_follows_nobody':
      return `@${result.login} doesn't follow anyone, so no follow chain can start from them. ${TRY_EITHER}`;
    case 'target_has_no_followers':
      return `Nobody follows @${result.login}, so no follow chain can reach them. ${TRY_EITHER}`;
    case 'max_degrees':
      return `No chain within ${plural(maxDegrees, 'degree')}. Raise "Max degrees" in Settings to search further.`;
    case 'dead_end':
      return `Checked everyone reachable when reading ${plural(maxPages, 'page')} (${maxPages * 100} accounts) of each follower list, without finding a chain. Raise "Max pages" in Settings to read more of each list.`;
    case 'budget':
      return `Stopped after ${result.stats.requests} GitHub requests, the per-search limit, without finding a chain. Try fewer degrees or pages.`;
    case 'rate_limit': {
      const when = result.resetAt ? new Date(result.resetAt * 1000).toLocaleTimeString() : 'soon';
      return `Hit the GitHub rate limit before finding a chain. It resets at ${when}.`;
    }
    case 'ip_limit': {
      const mins = Math.ceil((result.retryAfter ?? 3600) / 60);
      return `Too many GitHub lookups from your network. Try again in about ${plural(mins, 'minute')}.`;
    }
    case 'error':
      return `GitHub request failed${result.message ? `: ${result.message}` : ''}. Try again.`;
    case 'aborted':
      return 'Search stopped before a chain was found.';
    default:
      return 'No chain found within the limits (see "How it works" below).';
  }
}

// `demo` results are made-up people: nothing links to GitHub or gets shared.
function renderFound(result, mode, demo = false) {
  resultSection.hidden = false;
  const between = result.degrees - 1;
  headlineEl.textContent = `@${result.source} is ${result.degrees} degrees from @${result.target} (${between} people in between)`;
  renderRoutesSummary(result);

  // The selected chain is highlighted in the graph and is the one shared.
  const select = (i) => {
    renderChains(result, !demo, i, select);
    renderGraph(result, !demo, i);
    if (!demo) renderSharePanel(result, mode, i);
  };
  select(0);
  renderStats(result, demo);

  lastRun = result.timeline ? { timeline: result.timeline, demo } : null;
  replayBtn.hidden = false;
  replayBtn.textContent = lastRun ? 'Replay search' : 'Watch it search';
  for (const el of document.querySelectorAll('#share > :not(#replay-btn)')) el.hidden = demo;
}

// Escapes values from the GitHub API (avatar/profile URLs) before they're
// interpolated into innerHTML/SVG strings, since they cross a trust boundary.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function directionLabel(d) {
  if (d === 'follows') return 'follows';
  if (d === 'followed_by') return 'followed by';
  if (d === 'mutual') return 'follow each other';
  return '→';
}

const listNames = (logins) => {
  const names = logins.map((l) => `@${l}`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

// One person every route passes through, or how many independent routes there
// are, plus how many shortest chains were found. A shared link has none of this.
function renderRoutesSummary(result) {
  routesEl.hidden = result.totalShortestChains == null;
  if (routesEl.hidden) return;
  const gk = result.gatekeepers;
  const n = result.disjointRouteCount;
  let first;
  if (gk.length === 1) first = `Everything goes through @${gk[0]}. They're the gatekeeper for this connection.`;
  else if (gk.length) first = `Everything goes through ${listNames(gk)}. They're the gatekeepers for this connection.`;
  else if (n >= 3) first = `${n} independent routes. The connection doesn't depend on any one person.`;
  else first = `${plural(n, 'independent route')}.`;
  const total = result.totalShortestChains;
  const chains = `${total.toLocaleString('en-US')} shortest ${total === 1 ? 'chain' : 'chains'}`;
  routesSummary.textContent = `${first} We found ${chains} of ${plural(result.degrees, 'degree')}.`;
}

// Up to three chain rows. With more than one, each gets a radio to select it.
function renderChains(result, linkProfiles, selected, onSelect) {
  const hadFocus = chainsEl.contains(document.activeElement);
  chainsEl.innerHTML = '';
  const many = result.chains.length > 1;
  chainsEl.setAttribute('role', many ? 'radiogroup' : 'presentation');
  result.chains.forEach((chain, i) => {
    const row = document.createElement('div');
    row.className = `chain-row c${i + 1}${many && i === selected ? ' selected' : ''}`;
    if (many) {
      const label = document.createElement('label');
      label.className = 'chain-pick';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'chain';
      input.checked = i === selected;
      input.addEventListener('change', () => onSelect(i));
      const swatch = document.createElement('i');
      swatch.className = 'chain-swatch';
      const text = document.createElement('span');
      text.textContent = `Chain ${i + 1} · ${plural(chain.degrees, 'degree')}${chain.alternative ? ', alternative route' : ''}`;
      label.append(input, swatch, text);
      row.appendChild(label);
    }
    const line = document.createElement('div');
    line.className = 'chain';
    renderChain(line, chain, result, linkProfiles);
    row.appendChild(line);
    chainsEl.appendChild(row);
  });
  // Re-rendering replaced the focused radio; put focus back for keyboard users.
  if (hadFocus) chainsEl.querySelectorAll('input')[selected]?.focus();
}

function renderChain(el, chain, result, linkProfiles) {
  const gatekeepers = new Set(result.gatekeepers ?? []);
  chain.logins.forEach((login, i) => {
    const info = result.nodesInfo.get(login) || {};
    const card = document.createElement(linkProfiles ? 'a' : 'span');
    card.className = 'card';
    if (linkProfiles) {
      card.href = info.html_url || `https://github.com/${login}`;
      card.target = '_blank';
      card.rel = 'noopener';
    }
    const img = document.createElement('img');
    img.src = info.avatar_url || '';
    img.alt = '';
    img.loading = 'lazy';
    const span = document.createElement('span');
    span.textContent = `@${login}`;
    card.append(img, span);
    const badgeText = gatekeepers.has(login) ? 'Gatekeeper'
      : chain.shared?.has(login) ? `also in Chain ${chain.shared.get(login) + 1}` : null;
    if (badgeText) {
      const badge = document.createElement('span');
      badge.className = gatekeepers.has(login) ? 'badge badge-gatekeeper' : 'badge';
      badge.textContent = badgeText;
      card.appendChild(badge);
    }
    el.appendChild(card);

    if (i < chain.logins.length - 1) {
      const arrow = document.createElement('div');
      arrow.className = 'arrow';
      arrow.textContent = `→ ${directionLabel(chain.hops[i].direction)}`;
      el.appendChild(arrow);
    }
  });
}

// Lays out the chains in lanes: chain 1 along the middle, chains 2 and 3
// above and below it. Every chain runs from the source on the left to the
// target on the right, its people spread evenly, so chains of different
// lengths line up at both ends. A person in several chains sits where their
// first chain puts them. Up to 12 other explored users per degree go in
// small dots outside the lanes.
const LANE_GAP = 70;
const LANE_OFFSET = [0, -LANE_GAP, LANE_GAP];

function buildLayout(result) {
  const { chains } = result;
  const longest = Math.max(...chains.map((c) => c.degrees));
  const colW = 130;
  const band = chains.length > 1 ? LANE_GAP : 0;
  const mainY = 170 + band;
  const width = longest * colW;
  const x0 = 30 + colW / 2;
  const svgW = Math.max(420, (longest + 1) * colW + 60);
  const svgH = 340 + 2 * band;
  const pos = new Map();

  chains.forEach((chain, k) => {
    chain.logins.forEach((login, i) => {
      if (pos.has(login)) return;
      const end = i === 0 || i === chain.degrees;
      pos.set(login, { x: x0 + (i / chain.degrees) * width, y: mainY + (end ? 0 : LANE_OFFSET[k]) });
    });
  });

  const degrees = result.degrees;
  const excl = new Set(chains.flatMap((c) => c.logins));
  const columns = [];
  for (let c = 0; c <= degrees; c++) {
    const fromSource = result.explored.source.filter((n) => n.depth === c && !excl.has(n.login));
    const fromTarget = result.explored.target.filter((n) => degrees - n.depth === c && !excl.has(n.login));
    const seen = new Set();
    const others = [];
    for (const n of [...fromSource, ...fromTarget]) {
      if (seen.has(n.login) || others.length >= 12) continue;
      seen.add(n.login);
      others.push(n);
    }
    const x = x0 + (c / degrees) * width;
    others.forEach((n, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const rank = Math.floor(i / 2) + 1;
      pos.set(n.login, { x, y: mainY + side * (band + 30 + rank * 24) });
    });
    columns.push(others);
  }
  return { svgW, svgH, pos, columns };
}

function renderGraph(result, linkProfiles, selected = 0) {
  const { svgW, svgH, pos, columns } = buildLayout(result);
  const { chains } = result;
  // Made-up demo users have no profile, so their dots aren't links.
  const link = (href, cls, inner) => (linkProfiles
    ? `<a href="${esc(href)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${inner}</a>`
    : `<g${cls ? ` class="${cls}"` : ''}>${inner}</g>`);
  graphView.base = { x: 0, y: 0, w: svgW, h: svgH };
  fitGraph();

  const parts = [];
  parts.push(
    '<defs>' +
      chains.map((_, k) => `<marker id="arrow-${k + 1}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
        `<path d="M0,0 L10,5 L0,10 Z" class="arrowhead c${k + 1}"></path></marker>`).join('') +
      '<clipPath id="avatarClip"><circle cx="18" cy="18" r="18"/></clipPath>' +
      '<clipPath id="smallAvatarClip"><circle cx="10" cy="10" r="10"/></clipPath>' +
      '</defs>',
  );

  for (const others of columns) {
    for (const n of others) {
      const p = pos.get(n.login);
      const parentPos = pos.get(n.parent);
      if (!p || !parentPos) continue;
      parts.push(`<line x1="${parentPos.x}" y1="${parentPos.y}" x2="${p.x}" y2="${p.y}" class="explore-line"></line>`);
    }
  }

  // The selected chain is drawn last, so it sits on top.
  const order = chains.map((_, k) => k).filter((k) => k !== selected).concat(selected);
  for (const k of order) {
    const dim = chains.length > 1 && k !== selected ? ' dim' : '';
    chains[k].hops.forEach((hop) => {
      const a = pos.get(hop.from);
      const b = pos.get(hop.to);
      if (!a || !b) return;
      const reversed = hop.direction === 'followed_by';
      const [p1, p2] = reversed ? [b, a] : [a, b];
      const marker = `url(#arrow-${k + 1})`;
      const markerStart = hop.direction === 'mutual' ? ` marker-start="${marker}"` : '';
      parts.push(
        `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" class="path-line c${k + 1}${dim}" marker-end="${marker}"${markerStart}></line>`,
      );
    });
  }

  for (const others of columns) {
    for (const n of others) {
      const p = pos.get(n.login);
      if (!p) continue;
      parts.push(link(
        n.html_url || `https://github.com/${n.login}`,
        'dot-link',
        `<g transform="translate(${p.x - 10}, ${p.y - 10})" class="dot-group">` +
          '<title>@' + esc(n.login) + '</title>' +
          '<circle cx="10" cy="10" r="11" class="dot-ring"></circle>' +
          `<image href="${esc(n.avatar_url || '')}" width="20" height="20" clip-path="url(#smallAvatarClip)"></image>` +
          '</g>',
      ));
    }
  }

  // Each person once, with a ring in the colour of every chain they're on.
  const gatekeepers = new Set(result.gatekeepers ?? []);
  const people = [...new Set(chains.flatMap((c) => c.logins))];
  for (const login of people) {
    const p = pos.get(login);
    const info = result.nodesInfo.get(login) || {};
    const memberOf = chains.map((c, k) => (c.logins.includes(login) ? k : -1)).filter((k) => k >= 0);
    const rings = memberOf.map((k, j) => `<circle cx="18" cy="18" r="${19 + 3 * (memberOf.length - 1 - j)}" class="avatar-ring c${k + 1}"></circle>`).join('');
    const dim = chains.length > 1 && !memberOf.includes(selected) ? ' dim' : '';
    parts.push(link(
      info.html_url || `https://github.com/${login}`,
      `chain-node${dim}${gatekeepers.has(login) ? ' gatekeeper' : ''}`,
      `<g transform="translate(${p.x - 18}, ${p.y - 18})">` +
        `<title>@${esc(login)}${gatekeepers.has(login) ? ' (gatekeeper)' : ''}</title>` +
        rings +
        `<image href="${esc(info.avatar_url || '')}" width="36" height="36" clip-path="url(#avatarClip)"></image>` +
        '</g>' +
        `<text x="${p.x}" y="${p.y + 34 + 3 * (memberOf.length - 1)}" class="avatar-label" text-anchor="middle">@${esc(login)}</text>`,
    ));
  }

  graphSvg.innerHTML = parts.join('');
}

// ---- Pan and zoom for the result graph ----
// The graph starts fitted to its box. Drag pans, Ctrl + scroll or a pinch
// zooms, and double-click or "Fit" goes back. It only moves the viewBox.

const GRAPH_MIN_ZOOM = 0.5;
const GRAPH_MAX_ZOOM = 8;
const graphView = { base: { x: 0, y: 0, w: 420, h: 340 }, vb: null };

function setViewBox(vb) {
  graphView.vb = vb;
  graphSvg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}

function fitGraph() {
  setViewBox({ ...graphView.base });
}

// Zooms by `factor` around a point on screen, keeping that point still.
function zoomGraph(clientX, clientY, factor) {
  const { vb, base } = graphView;
  const zoom = base.w / vb.w;
  const f = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, zoom * factor)) / zoom;
  const p = new DOMPoint(clientX, clientY).matrixTransform(graphSvg.getScreenCTM().inverse());
  setViewBox({ x: p.x - (p.x - vb.x) / f, y: p.y - (p.y - vb.y) / f, w: vb.w / f, h: vb.h / f });
}

function zoomGraphCenter(factor) {
  const r = graphSvg.getBoundingClientRect();
  zoomGraph(r.left + r.width / 2, r.top + r.height / 2, factor);
}

function panGraph(dx, dy) {
  const scale = graphSvg.getScreenCTM().a; // screen pixels per viewBox unit
  const { vb } = graphView;
  setViewBox({ ...vb, x: vb.x - dx / scale, y: vb.y - dy / scale });
}

{
  const pointers = new Map(); // pointerId -> [clientX, clientY]
  let gesture = null; // { start, moved }
  let swallowClick = false;
  const midpoint = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
  };

  graphSvg.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swallowClick = false;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) gesture = { start: [e.clientX, e.clientY], moved: false };
    else if (gesture) gesture.moved = true;
  });

  graphSvg.addEventListener('pointermove', (e) => {
    if (!gesture || !pointers.has(e.pointerId)) return;
    const before = pointers.size === 2 ? midpoint() : null;
    const [ox, oy] = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (!gesture.moved) {
      if (Math.hypot(e.clientX - gesture.start[0], e.clientY - gesture.start[1]) <= 4) return;
      gesture.moved = true;
    }
    // Capture only once it's a drag, so a plain click still reaches the links.
    if (!graphSvg.hasPointerCapture(e.pointerId)) graphSvg.setPointerCapture(e.pointerId);
    graphSvg.classList.add('dragging');
    if (before) {
      const after = midpoint();
      zoomGraph(after.x, after.y, before.d ? after.d / before.d : 1);
      panGraph(after.x - before.x, after.y - before.y);
    } else {
      panGraph(e.clientX - ox, e.clientY - oy);
    }
  });

  const endPointer = (e) => {
    if (gesture?.moved) swallowClick = true;
    pointers.delete(e.pointerId);
    if (!pointers.size) {
      gesture = null;
      graphSvg.classList.remove('dragging');
    }
  };
  graphSvg.addEventListener('pointerup', endPointer);
  graphSvg.addEventListener('pointercancel', endPointer);

  // A drag that ends over a profile link must not open it.
  graphSvg.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  graphSvg.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomGraph(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.002));
  }, { passive: false });

  graphSvg.addEventListener('dblclick', (e) => {
    e.preventDefault();
    fitGraph();
  });
  document.getElementById('graph-zoom-in').addEventListener('click', () => zoomGraphCenter(1.4));
  document.getElementById('graph-zoom-out').addEventListener('click', () => zoomGraphCenter(1 / 1.4));
  document.getElementById('graph-fit').addEventListener('click', fitGraph);
}

function renderStats(result, demo) {
  statsEl.innerHTML = '';
  statsEl.hidden = !result.stats;
  if (!result.stats) return;
  const items = demo
    ? [`${result.stats.explored} users explored`, 'Demo network, no GitHub requests', `${(result.stats.ms / 1000).toFixed(1)}s`]
    : [
      `${result.stats.explored} users explored`,
      `${result.stats.requests} GitHub requests used`,
      `${result.stats.cacheHits} answered from cache`,
      `${(result.stats.ms / 1000).toFixed(1)}s`,
    ];
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    statsEl.appendChild(li);
  }
}

// ---- Sharing ----

// The form says "chain", the URL says "follow".
const urlMode = (mode) => (mode === 'chain' ? 'follow' : 'either');

// Shares the selected chain, and the gatekeeper if every route has one.
function renderSharePanel(result, mode, selected = 0) {
  const chain = result.chains[selected];
  const query = buildShareQuery({
    from: result.source, to: result.target, via: chain.logins.slice(1, -1), mode: urlMode(mode), gk: result.gatekeepers?.[0],
  });
  history.replaceState(null, '', query);

  const link = `${location.origin}/${query}`;
  const text = `I'm ${chain.degrees} degrees away from @${result.target} on GitHub. Trace your own chain:`;
  document.getElementById('share-x').href =
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
  document.getElementById('share-linkedin').href =
    `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(link)}`;
  document.getElementById('download-image').href = `/og.png${query}`;
  fetch(`/og.png${query}`).catch(() => {}); // warm the server's image cache so a crawler doesn't wait for the first render

  copyBtn.textContent = 'Copy link';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent = 'Copied';
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
  };
  nativeShareBtn.hidden = !navigator.share;
  nativeShareBtn.onclick = () => navigator.share({ text, url: link }).catch(() => {});
}

// Turns a verify-path reply into the same shape a search produces, so the
// normal renderers draw it.
function renderShared(data, mode) {
  const path = data.users.map((u) => u.login);
  const hops = data.edges.map((e) => ({
    from: e.from,
    to: e.to,
    direction: e.aFollowsB && e.bFollowsA ? 'mutual' : e.aFollowsB ? 'follows' : 'followed_by',
  }));
  const nodesInfo = new Map(data.users.map((u) => [u.login, { avatar_url: u.avatarUrl, html_url: u.url }]));
  statusLine.hidden = true;
  renderFound({
    status: 'found', source: path[0], target: path.at(-1), degrees: hops.length, path, hops, nodesInfo,
    chains: [{ logins: path, hops, degrees: hops.length, alternative: false, shared: new Map() }],
    explored: { source: [], target: [] }, stats: null,
  }, mode);
  sharedNote.hidden = false;
}

document.getElementById('search-again').addEventListener('click', () => form.requestSubmit());

// A shared link fills the form, then either shows the verified chain or searches.
async function openSharedLink(shared, mode) {
  resetUI();
  statusLine.textContent = 'Checking shared result…';
  try {
    const res = await fetch(`/api/verify-path?users=${[shared.from, ...shared.via, shared.to].join(',')}&mode=${shared.mode}`);
    const data = await res.json();
    if (data.valid) return renderShared(data, mode);
  } catch {
    // fall through to a normal search
  }
  form.requestSubmit();
}

const shared = parseShareQuery(new URLSearchParams(location.search));
if (shared) {
  const mode = shared.mode === 'follow' ? 'chain' : 'either';
  sourceInput.value = shared.from;
  targetInput.value = shared.to;
  form.mode.value = mode;
  if (shared.via) openSharedLink(shared, mode);
  else form.requestSubmit();
}
