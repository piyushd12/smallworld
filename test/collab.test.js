import test from 'node:test';
import assert from 'node:assert/strict';
import { findConnection, createCollabExpander } from '../public/search.js';
import { createDemoFetch, DEMO_PAIRS, demoGraph, DEMO_BOTS } from '../public/animation/demo-graph.js';

// A fake GitHub for collaboration mode. `repos` maps "owner/name" to
// { stars, fork, people: { login: commits }, bots: { login: commits }, more, status }.
// Each person's repo list is everyone's repos they appear in, unless `reposOf` overrides it.
function buildCollabFetch(repos, reposOf = {}) {
  const lists = new Map();
  for (const [name, r] of Object.entries(repos)) {
    for (const login of Object.keys(r.people ?? {})) {
      if (!lists.has(login)) lists.set(login, []);
      lists.get(login).push(name);
    }
  }
  for (const [login, names] of Object.entries(reposOf)) lists.set(login, names);
  const calls = [];
  const ok = (data) => ({ status: 200, data, remaining: 100, reset: null });

  const fetchJson = async (path) => {
    calls.push(path);
    const user = path.match(/^\/api\/user\/([^/?]+)$/);
    if (user) {
      if (!lists.has(user[1])) return { status: 404, data: { message: 'Not Found' }, remaining: 100, reset: null };
      return ok({ login: user[1], avatar_url: '', html_url: `https://github.com/${user[1]}`, type: 'User', followers: 0, following: 0 });
    }
    const batch = path.match(/^\/api\/repos\?users=(.+)$/);
    if (batch) {
      const users = {};
      for (const login of batch[1].split(',')) {
        users[login] = (lists.get(login) ?? []).map((name) => ({
          nameWithOwner: name, stargazerCount: repos[name].stars ?? 10, isFork: Boolean(repos[name].fork), isArchived: false,
        }));
      }
      return ok({ users });
    }
    const contrib = path.match(/^\/api\/contributors\/(.+)$/);
    if (contrib) {
      const r = repos[contrib[1]];
      if (r.status) return { status: r.status, data: null, remaining: 100, reset: null };
      const items = [
        ...Object.entries(r.people ?? {}).map(([login, contributions]) => ({ login, type: 'User', contributions })),
        ...Object.entries(r.bots ?? {}).map(([login, contributions]) => ({ login, type: login.endsWith('[bot]') ? 'User' : 'Bot', contributions })),
      ].map((c) => ({ ...c, avatar_url: '', html_url: `https://github.com/${c.login}` }));
      return ok({ items, more: Boolean(r.more) });
    }
    throw new Error(`unexpected path in mock: ${path}`);
  };
  return { fetchJson, calls };
}

// Runs one expander batch against the fake, the way the search calls it.
async function expand(repos, batch, opts = {}, reposOf = {}) {
  const { fetchJson, calls } = buildCollabFetch(repos, reposOf);
  const expander = createCollabExpander(opts);
  const out = await expander.expand(batch, async (path) => ({ res: await fetchJson(path) }));
  const linked = (login) => (out.neighbours.get(login) ?? []).map((n) => n.login).sort();
  return { ...out, linked, calls, skipped: expander.skipped };
}

// ---- The collaboration expander ----

test('expander: two people who committed to the same repo are linked through it', async () => {
  const { neighbours, linked } = await expand({ 'pallets/flask': { people: { alice: 14, bob: 5 } } }, ['alice']);
  assert.deepEqual(linked('alice'), ['bob']);
  assert.deepEqual(neighbours.get('alice')[0].via, { repo: 'pallets/flask', aCommits: 14, bCommits: 5 });
});

test('expander: both people need at least minCommits in the repo', async () => {
  const repos = { 'a/tools': { people: { alice: 3, bob: 2, carol: 1 } }, 'b/typo': { people: { alice: 1, dave: 40 } } };
  assert.deepEqual((await expand(repos, ['alice'])).linked('alice'), ['bob']);
  assert.deepEqual((await expand(repos, ['alice'], { minCommits: 1 })).linked('alice'), ['bob', 'carol', 'dave']);
  assert.deepEqual((await expand(repos, ['alice'], { minCommits: 3 })).linked('alice'), []);
});

test('expander: bots are never linked, by type or by a [bot] login', async () => {
  const { linked, skipped } = await expand(
    { 'a/app': { people: { alice: 9, bob: 4 }, bots: { 'dependabot[bot]': 50, 'ci-helper': 30 } } },
    ['alice'],
  );
  assert.deepEqual(linked('alice'), ['bob']);
  assert.deepEqual([...skipped.bots].sort(), ['ci-helper', 'dependabot[bot]']);
});

test('expander: forks and repos over the star limit are skipped without a request', async () => {
  const repos = {
    'alice/flask': { fork: true, people: { alice: 3, upstream: 900 } },
    'big/framework': { stars: 9000, people: { alice: 5, star: 80 } },
    'a/small': { stars: 12, people: { alice: 5, bob: 3 } },
  };
  const { linked, calls, skipped } = await expand(repos, ['alice']);
  assert.deepEqual(linked('alice'), ['bob']);
  assert.deepEqual(calls.filter((c) => c.startsWith('/api/contributors/')), ['/api/contributors/a/small']);
  assert.deepEqual([...skipped.forks], ['alice/flask']);
  assert.deepEqual([...skipped.hubs], ['big/framework']);
  assert.deepEqual((await expand(repos, ['alice'], { maxStars: 10000 })).linked('alice'), ['bob', 'star']);
});

test('expander: repos with too many contributors, or a next page, are hubs', async () => {
  const crowd = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`dev${i}`, 5]));
  const repos = {
    'a/crowded': { people: { alice: 5, ...crowd } },
    'a/paged': { people: { alice: 5, paul: 5 }, more: true },
    'a/cosy': { people: { alice: 5, bob: 5 } },
  };
  const { linked, skipped } = await expand(repos, ['alice'], { maxContributors: 25 });
  assert.deepEqual(linked('alice'), ['bob']);
  assert.deepEqual([...skipped.hubs].sort(), ['a/crowded', 'a/paged']);
  assert.equal((await expand(repos, ['alice'], { maxContributors: 50 })).linked('alice').length, 31);
});

test('expander: keeps at most maxRepos per person, the ones with the fewest stars', async () => {
  const repos = {
    'a/mid': { stars: 500, people: { alice: 5, mid: 5 } },
    'a/tiny': { stars: 5, people: { alice: 5, tiny: 5 } },
    'a/small': { stars: 10, people: { alice: 5, small: 5 } },
  };
  const { linked, units } = await expand(repos, ['alice'], { maxRepos: 2 });
  assert.deepEqual(linked('alice'), ['small', 'tiny']);
  assert.equal(units, 2);
});

test('expander: an empty list or a 204 just means no one to link', async () => {
  const repos = { 'a/empty': { status: 204 }, 'a/blank': { people: {} }, 'a/gone': { status: 404 } };
  const { neighbours, linked, stop } = await expand(repos, ['alice'], {}, { alice: ['a/empty', 'a/blank', 'a/gone'] });
  assert.equal(stop, null);
  assert.deepEqual(linked('alice'), []);
  assert.ok(neighbours.has('alice'));
});

test('expander: one GraphQL request covers the whole batch, and a repo is fetched once', async () => {
  const { calls, linked } = await expand({ 'a/shared': { people: { alice: 5, bob: 5, carol: 5 } } }, ['alice', 'bob']);
  assert.deepEqual(calls, ['/api/repos?users=alice,bob', '/api/contributors/a/shared']);
  assert.deepEqual(linked('bob'), ['alice', 'carol']);
});

// ---- The search in collaboration mode ----

// alice -[a/one]- bob -[b/two]- carol -[c/three]- dave, and a 4-step detour
// through p1..p3 that the search must not prefer.
const chainRepos = {
  'a/one': { people: { alice: 14, bob: 5 } },
  'b/two': { people: { bob: 30, carol: 3 } },
  'c/three': { people: { carol: 8, dave: 21 } },
  'x/1': { people: { alice: 4, p1: 4 } },
  'x/2': { people: { p1: 4, p2: 4 } },
  'x/3': { people: { p2: 4, p3: 4 } },
  'x/4': { people: { p3: 4, dave: 4 } },
};

test('collaboration search finds the shortest chain with the repo on every link', async () => {
  const { fetchJson } = buildCollabFetch(chainRepos);
  const result = await findConnection('alice', 'dave', { fetchJson, link: 'collab' });
  assert.equal(result.status, 'found');
  assert.equal(result.link, 'collab');
  assert.equal(result.degrees, 3);
  assert.deepEqual(result.path, ['alice', 'bob', 'carol', 'dave']);
  assert.deepEqual(result.hops, [
    { from: 'alice', to: 'bob', direction: 'collab', via: { repo: 'a/one', aCommits: 14, bCommits: 5 } },
    { from: 'bob', to: 'carol', direction: 'collab', via: { repo: 'b/two', aCommits: 30, bCommits: 3 } },
    { from: 'carol', to: 'dave', direction: 'collab', via: { repo: 'c/three', aCommits: 8, bCommits: 21 } },
  ]);
  const pathEvent = result.timeline.find((e) => e.type === 'path');
  assert.deepEqual(pathEvent.edges, result.hops);
  for (const ev of result.timeline.filter((e) => e.type === 'discover' && e.depth > 0)) {
    assert.ok(chainRepos[ev.edge.repo].people[ev.login], `${ev.login} is a contributor to ${ev.edge.repo}`);
  }
});

test('collaboration search defaults to 4 degrees and stops there', async () => {
  const { fetchJson } = buildCollabFetch({
    'r/1': { people: { a: 3, b: 3 } }, 'r/2': { people: { b: 3, c: 3 } }, 'r/3': { people: { c: 3, d: 3 } },
    'r/4': { people: { d: 3, e: 3 } }, 'r/5': { people: { e: 3, f: 3 } },
  });
  const result = await findConnection('a', 'f', { fetchJson, link: 'collab' });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'max_degrees');
  assert.equal(result.timeline[0].maxDegrees, 4);
  assert.equal(result.timeline[0].link, 'collab');
  assert.equal((await findConnection('a', 'f', { fetchJson, link: 'collab', maxDegrees: 5 })).degrees, 5);
});

test('collaboration search stops at the request budget', async () => {
  const { fetchJson } = buildCollabFetch(chainRepos);
  const result = await findConnection('alice', 'dave', { fetchJson, link: 'collab', maxRequests: 2 });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'budget');
});

test('a collaboration miss names the settings that bound it, never "no connection"', async () => {
  const { fetchJson } = buildCollabFetch(chainRepos);
  const result = await findConnection('alice', 'dave', { fetchJson, link: 'collab', maxDegrees: 2, maxContributors: 25, minCommits: 3 });
  assert.equal(result.reason, 'max_degrees');
  assert.deepEqual(result.limits, { maxDegrees: 2, minCommits: 3, maxContributors: 25, maxRepos: 30 });
  assert.match(result.hint, /more than 25 contributors/);
  assert.match(result.hint, /fewer than 3 commits/);
  assert.match(result.hint, /stops at 2 steps/);
  assert.match(result.hint, /rate limit/);
  assert.match(result.hint, /may still exist/);
  assert.doesNotMatch(result.hint, /no connection exists|not connected/i);
});

test('the side to expand is the one with less estimated work, not the smaller frontier', async () => {
  // src's one repo brings 5 people (1 repo per person seen: cost 5); tgt is
  // unexplored (1 person x 20 assumed repos: cost 20). Counting people alone
  // would pick tgt (1 < 5).
  const peers = Object.fromEntries(['p1', 'p2', 'p3', 'p4', 'p5'].map((p) => [p, 3]));
  const { fetchJson } = buildCollabFetch({ 's/r': { people: { src: 3, ...peers } }, 't/r': { people: { tgt: 3, q: 3 } } });
  const result = await findConnection('src', 'tgt', { fetchJson, link: 'collab', maxDegrees: 2 });
  const rounds = result.timeline.filter((e) => e.type === 'round');
  assert.deepEqual(rounds.map((r) => [r.side, r.frontierSize, r.estimatedCost, r.otherSideCost]), [
    ['source', 1, 20, 20],
    ['source', 5, 5, 20],
  ]);
});

test('hubs first: inside a frontier, people linked through more repos are expanded first', async () => {
  const { fetchJson } = buildCollabFetch({
    'r/1': { people: { s: 3, weak: 3, strong: 3 } },
    'r/2': { people: { s: 3, strong: 3 } },
    'r/3': { people: { t: 3, z: 3 } },
  });
  const result = await findConnection('s', 't', { fetchJson, link: 'collab', maxDegrees: 3 });
  const expanded = result.timeline.filter((e) => e.type === 'expand' && e.side === 'source' && e.depth === 1).map((e) => e.login);
  assert.deepEqual(expanded, ['strong', 'weak']);
});

// ---- Follows mode is unchanged ----

// Recorded on the demo network before collaboration mode existed.
const FOLLOWS_BEFORE = {
  'long/either': ['yara-larsen>gia-banerjee>milo-kim>amir-marin>cruz-lindqvist>mara-costa', 159, 6, 120],
  'long/chain': ['yara-larsen>gus-haddad>gia-nguyen>rosa-bauer>uma-iyer>mara-costa', 6, 4, 53],
  'gatekeeper/either': ['ola-brook>pim-brook>nora-quill>ada-marin>iris-berg>cruz-berg', 14, 1, 28],
  'gatekeeper/chain': ['ola-brook>pim-brook>nora-quill>ada-marin>iris-berg>cruz-berg', 8, 1, 17],
  'routes/either': ['yara-larsen>gus-haddad>gia-nguyen>rosa-bauer>uma-iyer', 50, 5, 54],
  'routes/chain': ['yara-larsen>gus-haddad>gia-nguyen>rosa-bauer>uma-iyer', 6, 3, 28],
};

test('follows mode finds exactly what it found before, at the same cost', async () => {
  for (const [key, [path, total, routes, requests]] of Object.entries(FOLLOWS_BEFORE)) {
    const [pair, mode] = key.split('/');
    const { source, target } = DEMO_PAIRS[pair];
    const r = await findConnection(source, target, { fetchJson: createDemoFetch({ delayMs: 0 }), mode, maxPages: 3 });
    assert.deepEqual([r.path.join('>'), r.totalShortestChains, r.disjointRouteCount, r.stats.requests], [path, total, routes, requests], key);
    assert.ok(r.hops.every((h) => h.direction !== 'collab' && !h.via), key);
  }
});

// ---- The demo network ----

test('demo graph: about 400 repos of 3-30 people, plus hubs, forks, bots and empty repos', () => {
  const all = [...demoGraph.repos.values()];
  const normal = all.filter((r) => !r.isFork && r.contributors.length && r.contributors.length < 300);
  assert.ok(normal.length >= 400);
  assert.ok(normal.every((r) => r.contributors.filter((c) => !c.bot).length >= 3 && r.contributors.filter((c) => !c.bot).length <= 30));
  assert.ok(all.filter((r) => r.contributors.length >= 300).length >= 3);
  assert.ok(all.some((r) => r.isFork));
  assert.ok(all.some((r) => !r.contributors.length));
  assert.ok(DEMO_BOTS.every((bot) => all.some((r) => r.contributors.some((c) => c.login === bot && c.bot))));
});

test('demo: the Collaboration pair is found, skipping hub repos and filtering bots', async () => {
  const pair = DEMO_PAIRS.collab;
  const r = await findConnection(pair.source, pair.target, { fetchJson: createDemoFetch({ delayMs: 0 }), link: 'collab' });
  assert.equal(r.status, 'found');
  assert.equal(r.degrees, pair.degrees);
  assert.ok(pair.degrees >= 3);
  assert.ok(r.stats.skipped.hubs > 0, 'hub repos were ignored');
  assert.ok(r.stats.skipped.bots > 0, 'bots were filtered');
  for (const hop of r.hops) {
    const repo = demoGraph.repos.get(hop.via.repo);
    const commits = (login) => repo.contributors.find((c) => c.login === login)?.commits;
    assert.deepEqual([commits(hop.from), commits(hop.to)], [hop.via.aCommits, hop.via.bCommits]);
  }
});
