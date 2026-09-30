import { findConnection, SearchError } from './search.js';
import { parseShareQuery, buildShareQuery } from './share.js';
import { mountWatch } from './animation/controls.js';
import { createDemoFetch, DEMO_PAIR } from './animation/demo-graph.js';

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
const chainEl = document.getElementById('chain');
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
  const animate = animateToggle.checked;
  controller = new AbortController();
  findBtn.disabled = true;
  demoBtn.disabled = true;
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
  runSearch({
    source: DEMO_PAIR.source,
    target: DEMO_PAIR.target,
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
  renderChain(result, !demo);
  renderGraph(result, !demo);
  renderStats(result, demo);

  lastRun = result.timeline ? { timeline: result.timeline, demo } : null;
  replayBtn.hidden = false;
  replayBtn.textContent = lastRun ? 'Replay search' : 'Watch it search';
  for (const el of document.querySelectorAll('#share > :not(#replay-btn)')) el.hidden = demo;
  if (demo) return;
  renderSharePanel(result, mode);
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

function renderChain(result, linkProfiles) {
  chainEl.innerHTML = '';
  result.path.forEach((login, i) => {
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
    chainEl.appendChild(card);

    if (i < result.path.length - 1) {
      const arrow = document.createElement('div');
      arrow.className = 'arrow';
      arrow.textContent = `→ ${directionLabel(result.hops[i].direction)}`;
      chainEl.appendChild(arrow);
    }
  });
}

// Lays out the path down the middle row, one column per degree, and up to 12
// other explored users per column as small dots above/below it.
function buildLayout(result) {
  const degrees = result.path.length - 1;
  const colW = 130;
  const mainY = 170;
  const svgW = Math.max(420, (degrees + 1) * colW + 60);
  const svgH = 340;
  const pos = new Map();

  result.path.forEach((login, c) => {
    pos.set(login, { x: 30 + c * colW + colW / 2, y: mainY });
  });

  const excl = new Set(result.path);
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
    const x = 30 + c * colW + colW / 2;
    others.forEach((n, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const rank = Math.floor(i / 2) + 1;
      pos.set(n.login, { x, y: mainY + side * (30 + rank * 24) });
    });
    columns.push(others);
  }
  return { degrees, svgW, svgH, pos, columns };
}

function renderGraph(result, linkProfiles) {
  const { svgW, svgH, pos, columns } = buildLayout(result);
  // Made-up demo users have no profile, so their dots aren't links.
  const link = (href, cls, inner) => (linkProfiles
    ? `<a href="${esc(href)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${inner}</a>`
    : `<g${cls ? ` class="${cls}"` : ''}>${inner}</g>`);
  graphView.base = { x: 0, y: 0, w: svgW, h: svgH };
  fitGraph();

  const parts = [];
  parts.push(
    '<defs>' +
      '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 Z" class="arrowhead"></path>' +
      '</marker>' +
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

  result.hops.forEach((hop) => {
    const a = pos.get(hop.from);
    const b = pos.get(hop.to);
    if (!a || !b) return;
    const reversed = hop.direction === 'followed_by';
    const x1 = reversed ? b.x : a.x;
    const y1 = reversed ? b.y : a.y;
    const x2 = reversed ? a.x : b.x;
    const y2 = reversed ? a.y : b.y;
    const markerStart = hop.direction === 'mutual' ? ' marker-start="url(#arrow)"' : '';
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="path-line" marker-end="url(#arrow)"${markerStart}></line>`,
    );
  });

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

  result.path.forEach((login) => {
    const p = pos.get(login);
    const info = result.nodesInfo.get(login) || {};
    parts.push(link(
      info.html_url || `https://github.com/${login}`,
      '',
      `<g transform="translate(${p.x - 18}, ${p.y - 18})">` +
        '<circle cx="18" cy="18" r="19" class="avatar-ring"></circle>' +
        `<image href="${esc(info.avatar_url || '')}" width="36" height="36" clip-path="url(#avatarClip)"></image>` +
        '</g>' +
        `<text x="${p.x}" y="${p.y + 34}" class="avatar-label" text-anchor="middle">@${esc(login)}</text>`,
    ));
  });

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

function renderSharePanel(result, mode) {
  const query = buildShareQuery({ from: result.source, to: result.target, via: result.path.slice(1, -1), mode: urlMode(mode) });
  history.replaceState(null, '', query);

  const link = `${location.origin}/${query}`;
  const text = `I'm ${result.degrees} degrees away from @${result.target} on GitHub. Trace your own chain:`;
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
