import test from 'node:test';
import assert from 'node:assert/strict';
import { findConnection, SearchError } from '../public/search.js';
import { createDemoFetch, DEMO_PAIR, mulberry32 } from '../public/animation/demo-graph.js';

// Builds a fake `fetchJson` over a small following-graph. `following` maps a
// login to the list of logins it follows; followers are derived by reversal.
function buildFakeFetch(following) {
  const followers = {};
  for (const [who, list] of Object.entries(following)) {
    for (const target of list) (followers[target] ??= []).push(who);
  }
  const allLogins = new Set([...Object.keys(following), ...Object.values(following).flat()]);
  const calls = [];

  const fetchJson = async (path) => {
    calls.push(path);
    const userMatch = path.match(/^\/api\/user\/([^/?]+)$/);
    if (userMatch) {
      const login = userMatch[1];
      if (!allLogins.has(login)) return { status: 404, data: { message: 'Not Found' }, remaining: 100, reset: null };
      return {
        status: 200,
        data: {
          login,
          avatar_url: '',
          html_url: `https://github.com/${login}`,
          type: 'User',
          followers: (followers[login] || []).length,
          following: (following[login] || []).length,
        },
        remaining: 100,
        reset: null,
      };
    }
    const listMatch = path.match(/^\/api\/(following|followers)\/([^/?]+)\?page=(\d+)$/);
    if (listMatch) {
      const [, kind, login, pageStr] = listMatch;
      const list = Number(pageStr) === 1 ? (kind === 'following' ? following : followers)[login] || [] : [];
      return {
        status: 200,
        data: { items: list.map((l) => ({ login: l, avatar_url: '', html_url: `https://github.com/${l}` })) },
        remaining: 100,
        reset: null,
      };
    }
    throw new Error(`unexpected path in mock: ${path}`);
  };

  return { fetchJson, calls };
}

// alice <-> bob follow each other; bob -> carol -> dave is a one-way chain.
const graphA = {
  alice: ['bob'],
  bob: ['carol', 'alice'],
  carol: ['dave'],
  dave: [],
};

test('finds a known 3-hop path', async () => {
  const { fetchJson } = buildFakeFetch(graphA);
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'found');
  assert.equal(result.degrees, 3);
  assert.deepEqual(result.path, ['alice', 'bob', 'carol', 'dave']);
});

test('reports correct edge directions, including a mutual hop', async () => {
  const { fetchJson } = buildFakeFetch(graphA);
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 6, maxPages: 1 });
  assert.deepEqual(result.hops, [
    { from: 'alice', to: 'bob', direction: 'mutual' },
    { from: 'bob', to: 'carol', direction: 'follows' },
    { from: 'carol', to: 'dave', direction: 'follows' },
  ]);
});

test('same source and target short-circuits with no network calls', async () => {
  const { fetchJson, calls } = buildFakeFetch(graphA);
  const result = await findConnection('Alice', 'alice', { fetchJson, maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'same');
  assert.equal(calls.length, 0);
});

test('unknown user is reported as user_not_found', async () => {
  const { fetchJson } = buildFakeFetch(graphA);
  const result = await findConnection('alice', 'ghost', { fetchJson, maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'user_not_found');
  assert.equal(result.login, 'ghost');
});

test('stops at max degrees when the real path is longer', async () => {
  const { fetchJson } = buildFakeFetch(graphA);
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 2, maxPages: 1 });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'max_degrees');
});

test('stops when the rate limit runs out', async () => {
  const fetchJson = async (path) => {
    if (/^\/api\/user\//.test(path)) {
      const login = path.split('/').pop();
      return { status: 200, data: { login, avatar_url: '', html_url: '' }, remaining: 1, reset: null };
    }
    return { status: 403, data: { message: 'rate limit exceeded' }, remaining: 0, reset: 1700000000 };
  };
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'rate_limit');
  assert.equal(result.resetAt, 1700000000);
});

// sam -> pat -> robin (a one-way chain) PLUS robin -> sam directly, so
// either-direction mode has a 1-hop shortcut that follow-chains-only can't use.
const graphB = {
  sam: ['pat'],
  pat: ['robin'],
  robin: ['sam'],
};

test('follow-chains-only mode finds a different path than either-direction mode', async () => {
  const { fetchJson: eitherFetch } = buildFakeFetch(graphB);
  const either = await findConnection('sam', 'robin', { fetchJson: eitherFetch, mode: 'either', maxDegrees: 6, maxPages: 1 });
  assert.equal(either.degrees, 1);
  assert.deepEqual(either.path, ['sam', 'robin']);

  const { fetchJson: chainFetch } = buildFakeFetch(graphB);
  const chain = await findConnection('sam', 'robin', { fetchJson: chainFetch, mode: 'chain', maxDegrees: 6, maxPages: 1 });
  assert.equal(chain.degrees, 2);
  assert.deepEqual(chain.path, ['sam', 'pat', 'robin']);
});

test('a bad token (401) is surfaced as a thrown SearchError', async () => {
  const fetchJson = async () => ({ status: 401, data: { message: 'Bad credentials' }, remaining: null, reset: null });
  await assert.rejects(
    () => findConnection('alice', 'dave', { fetchJson, maxDegrees: 6, maxPages: 1 }),
    (err) => err instanceof SearchError && err.code === 'bad_token',
  );
});

// Wraps the fake so list requests (not user lookups) can be made to misbehave.
function withListResponses(fetchJson, respond) {
  return async (path, opts) => (path.startsWith('/api/user/') ? fetchJson(path, opts) : respond(path, opts, fetchJson));
}

test('a failed request is reported as an error, not as "no link found"', async () => {
  const { fetchJson: real } = buildFakeFetch(graphA);
  const fetchJson = withListResponses(real, async () => ({ status: 500, data: { message: 'boom' } }));
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'error');
  assert.equal(result.message, 'boom');
});

test('retries a transient 5xx instead of giving up', async () => {
  const { fetchJson: real } = buildFakeFetch(graphA);
  let failuresLeft = 1;
  const fetchJson = withListResponses(real, async (path, opts, next) => {
    if (failuresLeft-- > 0) return { status: 502, data: { message: 'timeout' } };
    return next(path, opts);
  });
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'found');
  assert.deepEqual(result.path, ['alice', 'bob', 'carol', 'dave']);
});

test('stops at the per-search GitHub request budget', async () => {
  const { fetchJson } = buildFakeFetch(graphA);
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 6, maxPages: 1, maxRequests: 3 });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'budget');
});

test('answers from the server cache cost nothing against the budget', async () => {
  const { fetchJson: real } = buildFakeFetch(graphA);
  const fetchJson = async (path, opts) => ({ ...(await real(path, opts)), cached: true });
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 6, maxPages: 1, maxRequests: 1 });
  assert.equal(result.status, 'found');
  assert.equal(result.stats.requests, 0);
  assert.ok(result.stats.cacheHits > 0);
});

test('the server per-IP limit is reported as such, not as GitHub rate limiting', async () => {
  const { fetchJson: real } = buildFakeFetch(graphA);
  const fetchJson = withListResponses(real, async () => ({ status: 429, data: { limit: 'per_ip', retryAfter: 120 } }));
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 6, maxPages: 1 });
  assert.equal(result.reason, 'ip_limit');
  assert.equal(result.retryAfter, 120);
});

// quiet follows no one; fan follows quiet; loner has no follows either way.
const graphC = { fan: ['quiet'], quiet: [], loner: [] };
const listCalls = (calls) => calls.filter((p) => !p.startsWith('/api/user/'));

test('follow chains only: a source who follows nobody is ruled out before any list is fetched', async () => {
  const { fetchJson, calls } = buildFakeFetch(graphC);
  const result = await findConnection('quiet', 'fan', { fetchJson, mode: 'chain', maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'source_follows_nobody');
  assert.equal(result.login, 'quiet');
  assert.equal(listCalls(calls).length, 0);
});

test('follow chains only: a target with no followers is ruled out before any list is fetched', async () => {
  // a follows b and c follows a, but nobody follows c
  const { fetchJson, calls } = buildFakeFetch({ a: ['b'], c: ['a'] });
  const result = await findConnection('a', 'c', { fetchJson, mode: 'chain', maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'target_has_no_followers');
  assert.equal(result.login, 'c');
  assert.equal(listCalls(calls).length, 0);
});

test('follow chains only still finds a chain when one exists in the forward direction', async () => {
  const { fetchJson } = buildFakeFetch(graphC);
  const result = await findConnection('fan', 'quiet', { fetchJson, mode: 'chain', maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'found');
  assert.deepEqual(result.path, ['fan', 'quiet']);
});

test('either direction still works where follow chains only are impossible', async () => {
  const { fetchJson } = buildFakeFetch(graphC);
  const result = await findConnection('quiet', 'fan', { fetchJson, mode: 'either', maxDegrees: 6, maxPages: 1 });
  assert.equal(result.status, 'found');
  assert.deepEqual(result.hops, [{ from: 'quiet', to: 'fan', direction: 'followed_by' }]);
});

test('an account with no follows either way is reported as isolated in any mode', async () => {
  const { fetchJson, calls } = buildFakeFetch(graphC);
  const result = await findConnection('fan', 'loner', { fetchJson, mode: 'either', maxDegrees: 6, maxPages: 1 });
  assert.equal(result.reason, 'isolated');
  assert.equal(result.login, 'loner');
  assert.equal(listCalls(calls).length, 0);
});

test('a limit-based miss reports the limits it was searched within', async () => {
  const { fetchJson } = buildFakeFetch(graphA);
  const result = await findConnection('alice', 'dave', { fetchJson, maxDegrees: 2, maxPages: 1 });
  assert.equal(result.reason, 'max_degrees');
  assert.deepEqual(result.limits, { maxDegrees: 2, maxPages: 1 });
});

// ---- Search events (the timeline the animation plays) ----

async function demoSearch(opts = {}) {
  const seen = [];
  const result = await findConnection(DEMO_PAIR.source, DEMO_PAIR.target, {
    fetchJson: createDemoFetch({ delayMs: 0 }),
    maxPages: 3,
    onEvent: (ev) => seen.push(ev),
    ...opts,
  });
  return { result, events: result.timeline, seen };
}

test('events: the timeline starts with start, ends with end, and is what onEvent saw', async () => {
  const { result, events, seen } = await demoSearch();
  assert.equal(result.status, 'found');
  assert.deepEqual(events[0], {
    type: 'start', t: events[0].t, source: DEMO_PAIR.source, target: DEMO_PAIR.target, mode: 'either', maxDegrees: 6,
  });
  assert.equal(events.at(-1).type, 'end');
  assert.equal(events.at(-1).found, true);
  assert.equal(events.at(-1).reason, 'found');
  assert.deepEqual(seen, events);
  for (let i = 1; i < events.length; i++) {
    assert.equal(typeof events[i].t, 'number');
    assert.ok(events[i].t >= events[i - 1].t, 'timestamps never go back');
  }
});

test('events: every discovered node\'s parent was discovered earlier, one level up', async () => {
  const { events } = await demoSearch();
  const depthOf = { source: new Map(), target: new Map() };
  for (const ev of events.filter((e) => e.type === 'discover')) {
    if (ev.depth === 0) {
      assert.equal(ev.parent, null);
    } else {
      assert.ok(depthOf[ev.side].has(ev.parent), `parent of ${ev.login} was seen before it`);
      assert.equal(ev.depth, depthOf[ev.side].get(ev.parent) + 1);
      assert.deepEqual([ev.edge.from, ev.edge.to].sort(), [ev.parent, ev.login].sort());
    }
    assert.ok(!depthOf[ev.side].has(ev.login), 'each node is discovered once per side');
    depthOf[ev.side].set(ev.login, ev.depth);
  }
});

test('events: meet comes before path, and the path matches the result', async () => {
  const { result, events } = await demoSearch();
  const meetAt = events.findIndex((e) => e.type === 'meet');
  const pathAt = events.findIndex((e) => e.type === 'path');
  assert.ok(meetAt > 0 && pathAt > meetAt);
  const meet = events[meetAt];
  assert.equal(meet.sourceDepth + meet.targetDepth, result.degrees);
  assert.ok(result.path.includes(meet.login));
  assert.deepEqual(events[pathAt].logins, result.path);
  assert.deepEqual(events[pathAt].edges, result.hops);
  assert.equal(result.degrees, DEMO_PAIR.degrees);
});

test('events: each round expands the side the cost rule picks', async () => {
  const { events } = await demoSearch();
  // Frontier sizes rebuilt from the discoveries: a side's frontier is
  // everyone it found at its newest depth.
  const perDepth = { source: new Map(), target: new Map() };
  const depth = { source: 0, target: 0 };
  const frontier = (side) => perDepth[side].get(depth[side]) ?? 0;
  const rounds = [];
  for (const ev of events) {
    if (ev.type === 'discover') perDepth[ev.side].set(ev.depth, (perDepth[ev.side].get(ev.depth) ?? 0) + 1);
    if (ev.type !== 'round') continue;
    rounds.push(ev);
    const other = ev.side === 'source' ? 'target' : 'source';
    assert.equal(ev.frontierSize, frontier(ev.side));
    assert.equal(ev.estimatedCost, frontier(ev.side));
    assert.equal(ev.otherSideCost, frontier(other));
    const expected = frontier('source') <= frontier('target') ? 'source' : 'target';
    assert.equal(ev.side, expected, `round ${ev.round} picks the smaller frontier (ties go to the source)`);
    assert.equal(ev.depth, depth[ev.side] + 1);
    depth[ev.side] = ev.depth;
  }
  assert.ok(rounds.length >= 3);
  assert.deepEqual(rounds.map((r) => r.round), rounds.map((_, i) => i + 1));
  assert.ok(rounds.some((r) => r.side === 'target'), 'both sides get a turn');
});

test('events: a search that finds no chain still ends with a reason', async () => {
  const { result, events } = await demoSearch({ maxDegrees: 2 });
  assert.equal(result.status, 'not_found');
  const end = events.at(-1);
  assert.deepEqual([end.type, end.found, end.reason, end.detail], ['end', false, 'max-degrees', 'max_degrees']);
  assert.ok(!events.some((e) => e.type === 'meet' || e.type === 'path'));
});

test('events: a thrown error still emits end before rethrowing', async () => {
  const seen = [];
  const fetchJson = async () => ({ status: 401, data: {}, remaining: null, reset: null });
  await assert.rejects(() => findConnection('alice', 'dave', { fetchJson, onEvent: (e) => seen.push(e) }));
  assert.deepEqual([seen[0].type, seen.at(-1).type, seen.at(-1).reason], ['start', 'end', 'error']);
});

// ---- Multiple chains ----

test('records every parent at the same depth, not just the first', async () => {
  // s reaches m through both a and b; t has extra dead ends so the source side expands twice.
  const { fetchJson } = buildFakeFetch({
    s: ['a', 'b'], a: ['m'], b: ['m'], m: ['t'], t: ['z1', 'z2', 'z3', 'z4', 'z5'],
  });
  const result = await findConnection('s', 't', { fetchJson, maxPages: 1 });
  const m = result.explored.source.find((n) => n.login === 'm');
  assert.deepEqual([...m.parents].sort(), ['a', 'b']);
  assert.equal(m.parent, m.parents[0]);
  assert.equal(result.totalShortestChains, 2);
  assert.deepEqual(result.chains.map((c) => c.logins.join('-')).sort(), ['s-a-m-t', 's-b-m-t']);
});

// Every simple path of exactly `len` links, by brute force.
function countPathsBrute(following, s, t, len, directed) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const [a, list] of Object.entries(following)) {
    for (const b of list) {
      add(a, b);
      if (!directed) add(b, a);
    }
  }
  let n = 0;
  const walk = (cur, seen, depth) => {
    if (depth === len) {
      if (cur === t) n += 1;
      return;
    }
    for (const next of adj.get(cur) ?? []) if (!seen.has(next)) walk(next, new Set([...seen, next]), depth + 1);
  };
  walk(s, new Set([s]), 0);
  return n;
}

function randomGraph(seed, n, links) {
  const rand = mulberry32(seed);
  const following = {};
  for (let i = 0; i < n; i++) following[`u${i}`] = [];
  for (let k = 0; k < links; k++) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a !== b && !following[`u${a}`].includes(`u${b}`)) following[`u${a}`].push(`u${b}`);
  }
  return following;
}

test('totalShortestChains matches brute force, with no double counting through shared people', async () => {
  const layered = { s: ['a1', 'a2', 'a3'] };
  for (const a of ['a1', 'a2', 'a3']) layered[a] = ['b1', 'b2', 'b3'];
  for (const b of ['b1', 'b2', 'b3']) layered[b] = ['c1', 'c2', 'c3'];
  for (const c of ['c1', 'c2', 'c3']) layered[c] = ['t'];
  const cases = [
    { name: 'diamonds in a row', g: { s: ['a1', 'a2'], a1: ['m'], a2: ['m'], m: ['b1', 'b2'], b1: ['t'], b2: ['t'] } },
    { name: '3x3x3 layers', g: layered },
    { name: 'shared middle', g: { s: ['a', 'b', 'c'], a: ['m', 'n'], b: ['m'], c: ['n'], m: ['t'], n: ['t', 'm'] } },
  ];
  for (let seed = 1; seed <= 6; seed++) cases.push({ name: `random ${seed}`, g: randomGraph(seed, 40, 90) });

  let checked = 0;
  for (const { name, g } of cases) {
    for (const mode of ['either', 'chain']) {
      const directed = mode === 'chain';
      const pairs = name.startsWith('random') ? [['u0', 'u1'], ['u2', 'u3'], ['u4', 'u5']] : [['s', 't']];
      for (const [s, t] of pairs) {
        const { fetchJson } = buildFakeFetch(g);
        const result = await findConnection(s, t, { fetchJson, mode, maxPages: 1, maxDegrees: 8 });
        if (result.status !== 'found') continue;
        const brute = countPathsBrute(g, s, t, result.degrees, directed);
        assert.equal(result.totalShortestChains, brute, `${name} ${mode} ${s}->${t}`);
        assert.equal(countPathsBrute(g, s, t, result.degrees - 1, directed), 0, 'and it really is shortest');
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 15, `compared ${checked} searches`);
});

test('chains: the first is the result path, and each hop has a direction', async () => {
  const { fetchJson } = buildFakeFetch({ s: ['a', 'b', 'c'], a: ['t'], b: ['t'], c: ['t'], t: ['b'] });
  const result = await findConnection('s', 't', { fetchJson, maxPages: 1 });
  assert.deepEqual(result.chains[0].logins, result.path);
  assert.deepEqual(result.chains[0].hops, result.hops);
  // b <-> t is mutual, so that chain goes first.
  assert.deepEqual(result.path, ['s', 'b', 't']);
  assert.equal(result.chains.length, 3);
  assert.equal(result.disjointRouteCount, 3);
  assert.deepEqual(result.gatekeepers, []);
});

test('gatekeeper: one person every chain runs through', async () => {
  const { fetchJson } = buildFakeFetch({ s: ['a', 'b'], a: ['g'], b: ['g'], g: ['c', 'd'], c: ['t'], d: ['t'] });
  const result = await findConnection('s', 't', { fetchJson, maxPages: 1 });
  assert.deepEqual(result.gatekeepers, ['g']);
  assert.equal(result.disjointRouteCount, 1);
  assert.equal(result.totalShortestChains, 4);
  assert.ok(result.chains.slice(1).every((c) => c.shared.get('g') === 0));
});

// s-a-b-t is the only shortest chain; s-c-d-e-t shares no one with it.
const altGraph = { s: ['a', 'c'], a: ['b'], b: ['t'], c: ['d'], d: ['e'], e: ['t'] };

test('extra search finds a one-degree-longer alternative when only one shortest chain exists', async () => {
  const { fetchJson } = buildFakeFetch(altGraph);
  const events = [];
  const result = await findConnection('s', 't', { fetchJson, maxPages: 1, onEvent: (e) => events.push(e) });
  assert.equal(result.degrees, 3);
  assert.equal(result.totalShortestChains, 1);
  assert.deepEqual(result.chains.map((c) => [c.logins.join('-'), c.alternative]), [['s-a-b-t', false], ['s-c-d-e-t', true]]);
  assert.equal(result.disjointRouteCount, 2);
  assert.ok(events.some((e) => e.type === 'round' && e.extra));
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('meet') < types.indexOf('path') && types.indexOf('path') < types.indexOf('chains'));

  const off = await findConnection('s', 't', { fetchJson: buildFakeFetch(altGraph).fetchJson, maxPages: 1, altRoutes: false });
  assert.equal(off.chains.length, 1);
});

test('extra search stays within its budget, maxRequests and max degrees', async () => {
  const run = async (opts) => {
    const fake = buildFakeFetch(altGraph);
    let atMeet = null;
    const events = [];
    const result = await findConnection('s', 't', {
      fetchJson: fake.fetchJson,
      maxPages: 1,
      concurrency: 1,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'meet') atMeet = fake.calls.length;
      },
      ...opts,
    });
    return { result, events, atMeet, total: fake.calls.length };
  };

  const free = await run({});
  assert.ok(free.total > free.atMeet, 'the extra round ran');
  assert.ok(free.total <= free.atMeet + Math.ceil(free.atMeet * 0.25), `${free.total} requests after ${free.atMeet}`);

  const none = await run({ extraBudget: 0 });
  assert.equal(none.total, none.atMeet, 'no extra budget, no extra requests');
  assert.equal(none.result.status, 'found');

  const capped = await run({ maxRequests: free.atMeet + 1 });
  assert.ok(capped.total <= free.atMeet + 1);

  const atMax = await run({ maxDegrees: 3 });
  assert.equal(atMax.result.degrees, 3);
  assert.ok(!atMax.events.some((e) => e.extra), 'no search beyond max degrees');
});
