import test from 'node:test';
import assert from 'node:assert/strict';
import { toGraph, maxDisjointRoutes, findGatekeepers, selectDiverseChains, disjointCount } from '../public/paths.js';

const chain = (s, mutualHops = 0) => ({ logins: s.split('-'), mutualHops });
const disjoint = (paths) => {
  const seen = new Set();
  for (const p of paths) {
    for (const l of p.slice(1, -1)) {
      if (seen.has(l)) return false;
      seen.add(l);
    }
  }
  return true;
};

// s-a-t and s-b-t meet only at the ends; s-c-d-t is a third, longer route.
const three = [['s', 'a', 't'], ['s', 'b', 't'], ['s', 'c', 'd', 't']];

test('maxDisjointRoutes counts 1, 2 and 3 independent routes', () => {
  const one = toGraph([['s', 'a', 'g', 'b', 't'], ['s', 'c', 'g', 'd', 't']], false);
  assert.equal(maxDisjointRoutes(one, 's', 't').count, 1);

  const two = toGraph([['s', 'a', 'b', 't'], ['s', 'c', 'd', 't'], ['a', 'd']], false);
  const r2 = maxDisjointRoutes(two, 's', 't');
  assert.equal(r2.count, 2);
  assert.ok(disjoint(r2.paths));
  for (const p of r2.paths) assert.deepEqual([p[0], p.at(-1)], ['s', 't']);

  const r3 = maxDisjointRoutes(toGraph(three, false), 's', 't');
  assert.equal(r3.count, 3);
  assert.ok(disjoint(r3.paths));
  assert.deepEqual(r3.paths.map((p) => p.length), [3, 3, 4]);
});

test('maxDisjointRoutes respects direction in follow-chain mode', () => {
  // The route through b is only a route if links count both ways.
  const links = [['s', 'a', 't'], ['b', 's'], ['b', 't']];
  assert.equal(maxDisjointRoutes(toGraph(links, true), 's', 't').count, 1);
  assert.equal(maxDisjointRoutes(toGraph(links, false), 's', 't').count, 2);
  // A one-way chain the wrong way round is no route at all.
  assert.equal(maxDisjointRoutes(toGraph([['t', 'a', 's']], true), 's', 't').count, 0);
});

test('maxDisjointRoutes counts a direct link as one route', () => {
  const r = maxDisjointRoutes(toGraph([['s', 't'], ['s', 'a', 't']], false), 's', 't');
  assert.equal(r.count, 2);
  assert.deepEqual(r.paths[0], ['s', 't']);
});

test('findGatekeepers finds a single bottleneck, never the ends', () => {
  const g = toGraph([['s', 'a', 'g', 'b', 't'], ['s', 'c', 'g', 'd', 't']], false);
  assert.deepEqual(findGatekeepers(g, 's', 't'), ['g']);
  // Two people in a row that everyone has to pass.
  const g2 = toGraph([['s', 'a', 'x', 'y', 'b', 't'], ['s', 'c', 'x'], ['y', 'd', 't']], true);
  assert.deepEqual(findGatekeepers(g2, 's', 't'), ['x', 'y']);
});

test('findGatekeepers returns [] with no single bottleneck, a direct link, or no route', () => {
  assert.deepEqual(findGatekeepers(toGraph(three, false), 's', 't'), []);
  assert.deepEqual(findGatekeepers(toGraph([['s', 't']], false), 's', 't'), []);
  assert.deepEqual(findGatekeepers(toGraph([['s', 'a']], false), 's', 't'), []);
});

test('selectDiverseChains returns disjoint chains when they exist', () => {
  const picked = selectDiverseChains([
    chain('s-a-x-t'), chain('s-a-y-t'), chain('s-b-y-t'), chain('s-c-z-t'), chain('s-a-x-w-t'),
  ]);
  assert.deepEqual(picked.map((c) => c.logins.join('-')), ['s-a-x-t', 's-b-y-t', 's-c-z-t']);
  assert.equal(disjointCount(picked), 3);
  // A disjoint longer chain beats an overlapping shorter one.
  const alt = selectDiverseChains([chain('s-a-x-t'), chain('s-a-y-t'), chain('s-p-q-r-t')]);
  assert.deepEqual(alt.map((c) => c.logins.join('-')), ['s-a-x-t', 's-p-q-r-t', 's-a-y-t']);
});

test('selectDiverseChains falls back to the smallest overlap and labels what is shared', () => {
  const picked = selectDiverseChains([chain('s-a-b-t'), chain('s-a-c-t'), chain('s-a-b-d-t')]);
  assert.deepEqual(picked.map((c) => c.logins.join('-')), ['s-a-b-t', 's-a-c-t', 's-a-b-d-t']);
  assert.deepEqual([...picked[0].shared], []);
  assert.deepEqual([...picked[1].shared], [['a', 0]]);
  assert.deepEqual([...picked[2].shared], [['a', 0], ['b', 0]]);
});

test('selectDiverseChains is deterministic: mutual follows, then alphabetical', () => {
  const list = [chain('s-b-t'), chain('s-c-t', 1), chain('s-a-t'), chain('s-d-t')];
  const once = selectDiverseChains(list).map((c) => c.logins.join('-'));
  assert.deepEqual(once, ['s-c-t', 's-a-t', 's-b-t']);
  for (let i = 0; i < 5; i++) {
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    assert.deepEqual(selectDiverseChains(shuffled).map((c) => c.logins.join('-')), once);
  }
});

test('selectDiverseChains starts from seed chains, which fixes a blocking pick', () => {
  // After s-x-t, s-a-d-t (most mutual) goes second and blocks both s-a-b-t and s-c-d-t.
  const list = [chain('s-x-t'), chain('s-a-d-t', 3), chain('s-a-b-t'), chain('s-c-d-t')];
  const greedy = selectDiverseChains(list, 3);
  assert.equal(disjointCount(greedy), 2);
  const around = maxDisjointRoutes(toGraph(list.map((c) => c.logins), true), 's', 't', ['x']);
  assert.equal(around.count, 2);
  const seeded = selectDiverseChains(list, 3, [greedy[0], ...around.paths.map((p) => ({ logins: p }))]);
  assert.deepEqual(seeded.map((c) => c.logins.join('-')), ['s-x-t', 's-a-b-t', 's-c-d-t']);
  assert.equal(disjointCount(seeded), 3);
});
