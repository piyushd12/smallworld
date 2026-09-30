// Bidirectional BFS over the GitHub follow graph. Pure module: it takes a
// `fetchJson` function so it can run against the real API proxy in the
// browser, or a mocked graph in tests.

export class SearchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function runPool(items, limit, worker) {
  let idx = 0;
  let stop = false;
  async function runOne() {
    while (idx < items.length && !stop) {
      const item = items[idx++];
      if ((await worker(item)) === false) stop = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

function initSide(rootLogin, rootInfo) {
  return {
    depth: 0,
    frontier: [rootLogin],
    nodes: new Map([[rootLogin, { ...rootInfo, depth: 0 }]]),
    parent: new Map([[rootLogin, null]]),
    discoveredBy: new Map(),
  };
}

function relation(a, b, edges) {
  const ab = edges.has(`${a}>${b}`);
  const ba = edges.has(`${b}>${a}`);
  if (ab && ba) return 'mutual';
  if (ab) return 'follows';
  if (ba) return 'followed_by';
  return 'unknown';
}

function sideSnapshot(side) {
  return [...side.nodes.entries()].map(([login, info]) => ({
    login,
    parent: side.parent.get(login) ?? null,
    depth: info.depth,
    avatar_url: info.avatar_url,
    html_url: info.html_url,
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How a search ended, in the coarse terms the animation narrates. The exact
// internal reason travels alongside as `detail`.
const END_REASONS = {
  max_degrees: 'max-degrees',
  rate_limit: 'rate-limit',
  ip_limit: 'rate-limit',
  budget: 'rate-limit',
  aborted: 'stopped',
  error: 'error',
  dead_end: 'dead-end',
  isolated: 'dead-end',
  source_follows_nobody: 'dead-end',
  target_has_no_followers: 'dead-end',
};

// Runs the search and records what it does as a list of events (the
// timeline), passing each one to `onEvent` as it happens. The events only
// report; they never change which chain is found.
export async function findConnection(source, target, opts) {
  const { onEvent = () => {}, mode = 'either', maxDegrees = 6 } = opts;
  const startedAt = Date.now();
  const timeline = [];
  const emit = (type, data) => {
    const event = { type, t: Date.now() - startedAt, ...data };
    timeline.push(event);
    onEvent(event);
  };

  emit('start', { source, target, mode, maxDegrees });
  let result;
  try {
    result = await search(source, target, opts, emit);
  } catch (err) {
    const stopped = err?.code === 'aborted' || err?.name === 'AbortError';
    emit('end', { found: false, reason: stopped ? 'stopped' : 'error', detail: err?.code ?? 'error', stats: null });
    throw err;
  }
  const found = result.status === 'found';
  emit('end', {
    found,
    reason: found ? 'found' : END_REASONS[result.reason] ?? 'error',
    detail: result.reason ?? result.status,
    stats: result.stats,
  });
  result.timeline = timeline;
  return result;
}

async function search(source, target, opts, emit) {
  const {
    fetchJson,
    mode = 'either',
    maxDegrees = 6,
    maxPages = 3,
    concurrency = 4,
    // One shared token serves every visitor, so a single search may spend at
    // most this many real GitHub requests (cache hits are free).
    maxRequests = 400,
    signal,
    onProgress = () => {},
  } = opts;

  const startedAt = Date.now();
  let requests = 0; // real GitHub requests
  let cacheHits = 0; // answered from the server's cache, costing no quota
  let checked = 0;
  const edges = new Set(); // "a>b" means a follows b

  const stats = () => ({ explored: 0, requests, cacheHits, ms: Date.now() - startedAt });

  if (source.trim().toLowerCase() === target.trim().toLowerCase()) {
    return { status: 'same', source, target, path: [source], hops: [], stats: stats() };
  }

  // fetchJson plus bookkeeping, and a couple of retries for transient 5xx
  // errors so one flaky GitHub response doesn't end an otherwise good search.
  async function get(path) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchJson(path, { signal });
      if (res.cached) cacheHits += 1;
      else requests += 1;
      if (res.status >= 500 && attempt < 3) {
        await sleep(attempt * 500);
        continue;
      }
      return res;
    }
  }

  async function fetchUser(login) {
    let res;
    try {
      res = await get(`/api/user/${login}`);
    } catch (err) {
      if (err?.name === 'AbortError') throw new SearchError('aborted', 'Search was stopped');
      throw err;
    }
    if (res.status === 401) throw new SearchError('bad_token', 'GitHub token is invalid');
    if (res.status === 404) return null;
    if (res.status !== 200) throw new SearchError('fetch_error', res.data?.message || 'GitHub request failed');
    return res.data;
  }

  const [srcUser, tgtUser] = await Promise.all([fetchUser(source), fetchUser(target)]);
  if (!srcUser) return { status: 'user_not_found', login: source, stats: stats() };
  if (!tgtUser) return { status: 'user_not_found', login: target, stats: stats() };

  // Some searches are impossible from the two profiles alone, so say why
  // up front instead of spending requests on follower lists.
  const impossible = (reason, login) => ({
    status: 'not_found', reason, login, source: srcUser.login, target: tgtUser.login, stats: stats(),
  });
  for (const u of [srcUser, tgtUser]) {
    if (u.followers === 0 && u.following === 0) return impossible('isolated', u.login);
  }
  if (mode === 'chain') {
    if (srcUser.following === 0) return impossible('source_follows_nobody', srcUser.login);
    if (tgtUser.followers === 0) return impossible('target_has_no_followers', tgtUser.login);
  }

  const sideS = initSide(srcUser.login, srcUser);
  const sideT = initSide(tgtUser.login, tgtUser);
  for (const [side, u] of [['source', srcUser], ['target', tgtUser]]) {
    emit('discover', { side, login: u.login, parent: null, depth: 0, avatarUrl: u.avatar_url, edge: null });
  }

  function kindsFor(isSourceSide) {
    if (mode === 'chain') return isSourceSide ? ['following'] : ['followers'];
    return ['following', 'followers'];
  }

  let meet = null;
  let reason = null;
  let stopInfo = {};
  let round = 0;

  while (true) {
    if (sideS.depth + sideT.depth >= maxDegrees) { reason = 'max_degrees'; break; }
    if (!sideS.frontier.length || !sideT.frontier.length) { reason = 'dead_end'; break; }
    if (signal?.aborted) { reason = 'aborted'; break; }

    const expandSource = sideS.frontier.length <= sideT.frontier.length;
    const side = expandSource ? sideS : sideT;
    const other = expandSource ? sideT : sideS;
    const sideName = expandSource ? 'source' : 'target';
    // The cost is the number of people this side still has to check, the
    // same number the choice above compares.
    emit('round', {
      round: ++round,
      side: sideName,
      depth: side.depth + 1,
      frontierSize: side.frontier.length,
      estimatedCost: side.frontier.length,
      otherSideCost: other.frontier.length,
    });
    side.depth += 1;

    const ordered = [...side.frontier].sort(
      (a, b) => (side.discoveredBy.get(b) || 0) - (side.discoveredBy.get(a) || 0),
    );
    const nextDiscovered = new Map();
    let roundStop = null;

    await runPool(ordered, concurrency, async (login) => {
      emit('expand', { side: sideName, login, depth: side.depth - 1 });
      for (const kind of kindsFor(expandSource)) {
        let page = 1;
        while (page <= maxPages) {
          if (signal?.aborted) { roundStop = { reason: 'aborted' }; return false; }
          if (requests >= maxRequests) { roundStop = { reason: 'budget' }; return false; }
          let res;
          try {
            res = await get(`/api/${kind}/${login}?page=${page}`);
          } catch (err) {
            if (err?.name === 'AbortError') { roundStop = { reason: 'aborted' }; return false; }
            throw err;
          }
          onProgress({ degree: sideS.depth + sideT.depth, checked, requests, cacheHits, remaining: res.remaining });

          if (res.status === 401) throw new SearchError('bad_token', 'GitHub token is invalid');
          if (res.status === 429 && res.data?.limit === 'per_ip') {
            roundStop = { reason: 'ip_limit', retryAfter: res.data.retryAfter };
            return false;
          }
          if (res.status === 403 || res.status === 429) {
            roundStop = { reason: 'rate_limit', reset: res.reset };
            return false;
          }
          // A failed request is not the frontier running dry; keep the two
          // apart so a real error never shows up as "no link found".
          if (res.status !== 200) {
            roundStop = { reason: 'error', message: res.data?.message };
            return false;
          }

          const items = res.data.items ?? [];
          for (const u of items) {
            const neighbor = u.login;
            if (neighbor === login) continue;
            if (kind === 'following') edges.add(`${login}>${neighbor}`);
            else edges.add(`${neighbor}>${login}`);

            nextDiscovered.set(neighbor, (nextDiscovered.get(neighbor) || 0) + 1);
            if (!side.nodes.has(neighbor)) {
              side.nodes.set(neighbor, { avatar_url: u.avatar_url, html_url: u.html_url, depth: side.depth });
              side.parent.set(neighbor, login);
              emit('discover', {
                side: sideName,
                login: neighbor,
                parent: login,
                depth: side.depth,
                avatarUrl: u.avatar_url,
                edge: kind === 'following' ? { from: login, to: neighbor } : { from: neighbor, to: login },
              });
            }
          }
          if (items.length < 100) break;
          page += 1;
        }
      }
      checked += 1;
      return true;
    });

    if (roundStop) { ({ reason, ...stopInfo } = roundStop); break; }

    side.frontier = [...nextDiscovered.keys()].filter((login) => side.nodes.get(login).depth === side.depth);
    side.discoveredBy = nextDiscovered;

    for (const login of side.frontier) {
      if (other.nodes.has(login)) {
        const combined = side.depth + other.nodes.get(login).depth;
        if (!meet || combined < meet.combined) meet = { login, combined };
      }
    }
    if (meet) break;
  }

  const explored = { source: sideSnapshot(sideS), target: sideSnapshot(sideT) };
  const baseStats = { explored: sideS.nodes.size + sideT.nodes.size, requests, cacheHits, ms: Date.now() - startedAt };

  if (!meet) {
    return {
      status: 'not_found',
      reason,
      resetAt: stopInfo.reset ?? null,
      message: stopInfo.message ?? null,
      retryAfter: stopInfo.retryAfter ?? null,
      limits: { maxDegrees, maxPages },
      source: srcUser.login,
      target: tgtUser.login,
      explored,
      stats: baseStats,
    };
  }

  const left = [];
  for (let cur = meet.login; cur != null; cur = sideS.parent.get(cur)) left.unshift(cur);
  const right = [];
  for (let cur = sideT.parent.get(meet.login); cur != null; cur = sideT.parent.get(cur)) right.push(cur);
  const path = [...left, ...right];

  const hops = [];
  for (let i = 0; i < path.length - 1; i++) {
    hops.push({ from: path[i], to: path[i + 1], direction: relation(path[i], path[i + 1], edges) });
  }
  emit('meet', { login: meet.login, sourceDepth: sideS.nodes.get(meet.login).depth, targetDepth: sideT.nodes.get(meet.login).depth });
  emit('path', { logins: path, edges: hops });

  const nodesInfo = new Map();
  for (const n of [...explored.source, ...explored.target]) {
    nodesInfo.set(n.login, { avatar_url: n.avatar_url, html_url: n.html_url });
  }

  return {
    status: 'found',
    source: srcUser.login,
    target: tgtUser.login,
    degrees: path.length - 1,
    path,
    hops,
    nodesInfo,
    explored,
    stats: baseStats,
  };
}
