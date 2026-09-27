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

export async function findConnection(source, target, opts) {
  const {
    fetchJson,
    mode = 'either',
    maxDegrees = 6,
    maxPages = 3,
    concurrency = 4,
    signal,
    onProgress = () => {},
  } = opts;

  const startedAt = Date.now();
  let requests = 0;
  let checked = 0;
  const edges = new Set(); // "a>b" means a follows b

  const stats = () => ({ explored: 0, requests, ms: Date.now() - startedAt });

  if (source.trim().toLowerCase() === target.trim().toLowerCase()) {
    return { status: 'same', source, target, path: [source], hops: [], stats: stats() };
  }

  async function fetchUser(login) {
    let res;
    try {
      res = await fetchJson(`/api/user/${login}`, { signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw new SearchError('aborted', 'Search was stopped');
      throw err;
    }
    requests += 1;
    if (res.status === 401) throw new SearchError('bad_token', 'GitHub token is invalid');
    if (res.status === 404) return null;
    if (res.status !== 200) throw new SearchError('fetch_error', res.data?.message || 'GitHub request failed');
    return res.data;
  }

  const [srcUser, tgtUser] = await Promise.all([fetchUser(source), fetchUser(target)]);
  if (!srcUser) return { status: 'user_not_found', login: source, stats: stats() };
  if (!tgtUser) return { status: 'user_not_found', login: target, stats: stats() };

  const sideS = initSide(srcUser.login, srcUser);
  const sideT = initSide(tgtUser.login, tgtUser);

  function kindsFor(isSourceSide) {
    if (mode === 'chain') return isSourceSide ? ['following'] : ['followers'];
    return ['following', 'followers'];
  }

  let meet = null;
  let reason = null;
  let resetAt = null;

  while (true) {
    if (sideS.depth + sideT.depth >= maxDegrees) { reason = 'max_degrees'; break; }
    if (!sideS.frontier.length || !sideT.frontier.length) { reason = 'dead_end'; break; }
    if (signal?.aborted) { reason = 'aborted'; break; }

    const expandSource = sideS.frontier.length <= sideT.frontier.length;
    const side = expandSource ? sideS : sideT;
    const other = expandSource ? sideT : sideS;
    side.depth += 1;

    const ordered = [...side.frontier].sort(
      (a, b) => (side.discoveredBy.get(b) || 0) - (side.discoveredBy.get(a) || 0),
    );
    const nextDiscovered = new Map();
    let roundStop = null;

    await runPool(ordered, concurrency, async (login) => {
      for (const kind of kindsFor(expandSource)) {
        let page = 1;
        while (page <= maxPages) {
          if (signal?.aborted) { roundStop = { reason: 'aborted' }; return false; }
          let res;
          try {
            res = await fetchJson(`/api/${kind}/${login}?page=${page}`, { signal });
          } catch (err) {
            if (err?.name === 'AbortError') { roundStop = { reason: 'aborted' }; return false; }
            throw err;
          }
          requests += 1;
          onProgress({ degree: sideS.depth + sideT.depth, checked, requests, remaining: res.remaining });

          if (res.status === 401) throw new SearchError('bad_token', 'GitHub token is invalid');
          if (res.status === 403 || res.status === 429) {
            roundStop = { reason: 'rate_limit', reset: res.reset };
            return false;
          }
          if (res.status !== 200) { roundStop = { reason: 'dead_end' }; return false; }

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
            }
          }
          if (items.length < 100) break;
          page += 1;
        }
      }
      checked += 1;
      return true;
    });

    if (roundStop) { reason = roundStop.reason; resetAt = roundStop.reset ?? null; break; }

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
  const baseStats = { explored: sideS.nodes.size + sideT.nodes.size, requests, ms: Date.now() - startedAt };

  if (!meet) {
    return { status: 'not_found', reason, resetAt, source: srcUser.login, target: tgtUser.login, explored, stats: baseStats };
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
