// Bidirectional BFS over the GitHub follow graph. Pure module: it takes a
// `fetchJson` function so it can run against the real API proxy in the
// browser, or a mocked graph in tests.

import { toGraph, maxDisjointRoutes, findGatekeepers, selectDiverseChains, disjointCount } from './paths.js';

const CHAIN_SAMPLE = 500; // chains listed per length, as input for picking diverse ones
const SHOWN_CHAINS = 3;

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
    // Everyone one step closer to the root who links to this person, so the
    // explored graph holds every shortest path, not just the first one found.
    parents: new Map([[rootLogin, []]]),
    discoveredBy: new Map(),
  };
}

// Number of shortest paths from the side's root to `login`, by summing over
// parents (memoised per side).
function pathCounter(side) {
  const memo = new Map();
  const count = (login) => {
    if (!memo.has(login)) {
      const ps = side.parents.get(login);
      memo.set(login, ps.length ? ps.reduce((n, p) => n + count(p), 0) : 1);
    }
    return memo.get(login);
  };
  return count;
}

// Every shortest path from the side's root to `login`, root first, one at a time.
function* pathsTo(side, login) {
  const ps = side.parents.get(login);
  if (!ps.length) {
    yield [login];
    return;
  }
  for (const p of [...ps].sort()) {
    for (const path of pathsTo(side, p)) yield [...path, login];
  }
}

function* chainsThrough(sideS, sideT, meetLogin) {
  for (const left of pathsTo(sideS, meetLogin)) {
    for (const right of pathsTo(sideT, meetLogin)) yield [...left, ...right.reverse().slice(1)];
  }
}

// Up to `cap` chains, taken in turn from each meeting person so a sample of a
// huge set doesn't all run through the first one.
// ponytail: a 500-chain sample; the route counts don't depend on it (they use the parent links).
function sampleChains(sideS, sideT, meetLogins, cap) {
  const gens = meetLogins.map((m) => chainsThrough(sideS, sideT, m));
  const out = [];
  while (gens.length && out.length < cap) {
    for (let i = 0; i < gens.length && out.length < cap;) {
      const next = gens[i].next();
      if (next.done) gens.splice(i, 1);
      else {
        out.push(next.value);
        i += 1;
      }
    }
  }
  return out;
}

// The links of every shortest path from a side's root to the meeting people,
// as [from, to] pairs pointing from source to target.
function pathLinks(side, meetLogins, towardRoot) {
  const links = [];
  const seen = new Set();
  const stack = [...meetLogins];
  while (stack.length) {
    const login = stack.pop();
    if (seen.has(login)) continue;
    seen.add(login);
    for (const p of side.parents.get(login)) {
      links.push(towardRoot ? [login, p] : [p, login]);
      stack.push(p);
    }
  }
  return links;
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
    parents: side.parents.get(login),
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
    // With fewer than 3 independent shortest routes, search one degree
    // further for alternatives, spending at most this share of the requests
    // used so far (and never more than maxRequests in total).
    altRoutes = true,
    extraBudget = 0.25,
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

  let reason = null;
  let stopInfo = {};
  let round = 0;

  // Expands one side by a degree. Returns why it stopped early, or null.
  async function expandRound(expandSource, ceiling, extra = false) {
    const side = expandSource ? sideS : sideT;
    const other = expandSource ? sideT : sideS;
    const sideName = expandSource ? 'source' : 'target';
    // The cost is the number of people this side still has to check, the
    // same number the choice of side compares.
    emit('round', {
      round: ++round,
      side: sideName,
      depth: side.depth + 1,
      frontierSize: side.frontier.length,
      estimatedCost: side.frontier.length,
      otherSideCost: other.frontier.length,
      ...(extra ? { extra: true } : {}),
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
          if (requests >= ceiling) { roundStop = { reason: 'budget' }; return false; }
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
              side.parents.set(neighbor, [login]);
              emit('discover', {
                side: sideName,
                login: neighbor,
                parent: login,
                depth: side.depth,
                avatarUrl: u.avatar_url,
                edge: kind === 'following' ? { from: login, to: neighbor } : { from: neighbor, to: login },
              });
            } else if (side.nodes.get(neighbor).depth === side.depth) {
              const ps = side.parents.get(neighbor);
              if (!ps.includes(login)) ps.push(login);
            }
          }
          if (items.length < 100) break;
          page += 1;
        }
      }
      checked += 1;
      return true;
    });

    side.frontier = [...nextDiscovered.keys()].filter((login) => side.nodes.get(login).depth === side.depth);
    side.discoveredBy = nextDiscovered;
    return roundStop;
  }

  // People in the newest ring of `side` that the other side has also
  // reached, grouped by the length of the chain through them.
  function meetings(side, other) {
    const byLength = new Map();
    for (const login of side.frontier) {
      if (!other.nodes.has(login)) continue;
      const combined = side.depth + other.nodes.get(login).depth;
      if (!byLength.has(combined)) byLength.set(combined, []);
      byLength.get(combined).push(login);
    }
    return byLength;
  }

  let meetLogins = null; // every person where a shortest chain crosses from one side to the other
  let shortest = 0;

  while (true) {
    if (sideS.depth + sideT.depth >= maxDegrees) { reason = 'max_degrees'; break; }
    if (!sideS.frontier.length || !sideT.frontier.length) { reason = 'dead_end'; break; }
    if (signal?.aborted) { reason = 'aborted'; break; }

    const expandSource = sideS.frontier.length <= sideT.frontier.length;
    const roundStop = await expandRound(expandSource, maxRequests);
    if (roundStop) { ({ reason, ...stopInfo } = roundStop); break; }

    const found = expandSource ? meetings(sideS, sideT) : meetings(sideT, sideS);
    if (found.size) {
      shortest = Math.min(...found.keys());
      meetLogins = found.get(shortest).sort();
      break;
    }
  }

  if (!meetLogins) {
    return {
      status: 'not_found',
      reason,
      resetAt: stopInfo.reset ?? null,
      message: stopInfo.message ?? null,
      retryAfter: stopInfo.retryAfter ?? null,
      limits: { maxDegrees, maxPages },
      source: srcUser.login,
      target: tgtUser.login,
      explored: { source: sideSnapshot(sideS), target: sideSnapshot(sideT) },
      stats: { explored: sideS.nodes.size + sideT.nodes.size, requests, cacheHits, ms: Date.now() - startedAt },
    };
  }

  const s = srcUser.login;
  const t = tgtUser.login;
  const directed = mode === 'chain';
  const firstMeet = meetLogins[0];
  emit('meet', { login: firstMeet, sourceDepth: sideS.nodes.get(firstMeet).depth, targetDepth: sideT.nodes.get(firstMeet).depth });

  // Every shortest chain crosses the meeting ring exactly once, so the total
  // is (paths from source to m) x (paths from m to target), summed over it.
  const countS = pathCounter(sideS);
  const countT = pathCounter(sideT);
  const totalShortestChains = meetLogins.reduce((n, m) => n + countS(m) * countT(m), 0);

  const linksThrough = (meets) => [...pathLinks(sideS, meets, false), ...pathLinks(sideT, meets, true)];
  let routeLinks = linksThrough(meetLogins);
  let candidates = sampleChains(sideS, sideT, meetLogins, CHAIN_SAMPLE);

  // Fewer than 3 independent shortest routes: look one degree further, on a
  // small extra budget. Whatever stops it, the chains already found stand.
  const frontiers = [sideS.frontier.length, sideT.frontier.length];
  if (
    altRoutes && shortest + 1 <= maxDegrees && !signal?.aborted && (frontiers[0] || frontiers[1])
    && maxDisjointRoutes(toGraph(routeLinks, directed), s, t).count < SHOWN_CHAINS
  ) {
    const expandSource = frontiers[1] === 0 || (frontiers[0] > 0 && frontiers[0] <= frontiers[1]);
    const ceiling = Math.min(maxRequests, requests + Math.ceil(requests * extraBudget));
    try {
      await expandRound(expandSource, ceiling, true);
    } catch {
      // keep the shortest chains
    }
    const found = expandSource ? meetings(sideS, sideT) : meetings(sideT, sideS);
    const alt = (found.get(shortest + 1) ?? []).sort();
    routeLinks = [...routeLinks, ...linksThrough(alt)];
    candidates = [...candidates, ...sampleChains(sideS, sideT, alt, CHAIN_SAMPLE)];
  }

  const hopsOf = (logins) => logins.slice(0, -1).map((from, i) => ({ from, to: logins[i + 1], direction: relation(from, logins[i + 1], edges) }));
  const asCandidate = (logins) => ({ logins, mutualHops: hopsOf(logins).filter((h) => h.direction === 'mutual').length });

  // Routes and gatekeepers are counted over the chains found, so the summary
  // always agrees with the chains shown.
  const graph = toGraph(routeLinks, directed);
  const routes = maxDisjointRoutes(graph, s, t);
  const gatekeepers = findGatekeepers(graph, s, t);
  const pool = candidates.map(asCandidate);
  let chosen = selectDiverseChains(pool, SHOWN_CHAINS);
  // The second pick can block two others that would both have been free.
  // Max-flow around the first chain finds the most routes that avoid it, so
  // when that beats the greedy picks, keep the first chain and use those.
  const first = chosen[0];
  const around = maxDisjointRoutes(graph, s, t, first.logins.slice(1, -1));
  if (disjointCount(chosen) < Math.min(SHOWN_CHAINS, 1 + around.count)) {
    chosen = selectDiverseChains(pool, SHOWN_CHAINS, [first, ...around.paths.slice(0, SHOWN_CHAINS - 1).map(asCandidate)]);
  }

  const chains = chosen.map((c) => ({
    logins: c.logins,
    hops: hopsOf(c.logins),
    degrees: c.logins.length - 1,
    alternative: c.logins.length - 1 > shortest,
    shared: c.shared,
  }));
  const { logins: path, hops } = chains[0];

  // How far along each chain the source's search drew it; the rest was the
  // target's. The animation draws each half on its own side.
  const meetIndex = (logins) => {
    let m = 0;
    while (m + 1 < logins.length && sideS.nodes.get(logins[m + 1])?.depth === m + 1) m += 1;
    return m;
  };
  emit('path', { logins: path, edges: hops, meetIndex: meetIndex(path) });
  emit('chains', { chains: chains.map((c) => ({ logins: c.logins, meetIndex: meetIndex(c.logins) })), gatekeepers });

  const explored = { source: sideSnapshot(sideS), target: sideSnapshot(sideT) };
  const nodesInfo = new Map();
  for (const n of [...explored.source, ...explored.target]) {
    nodesInfo.set(n.login, { avatar_url: n.avatar_url, html_url: n.html_url });
  }

  return {
    status: 'found',
    source: s,
    target: t,
    degrees: path.length - 1,
    path,
    hops,
    chains,
    totalShortestChains,
    disjointRouteCount: routes.count,
    gatekeepers,
    nodesInfo,
    explored,
    stats: { explored: sideS.nodes.size + sideT.nodes.size, requests, cacheHits, ms: Date.now() - startedAt },
  };
}
