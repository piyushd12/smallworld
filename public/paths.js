// Graph helpers for "how many different ways are these two connected?".
// Pure: no DOM, no fetch. A graph is a Map from login to the Set of logins it
// links to; in "either" mode every link is stored both ways.

// Builds a graph from chains (arrays of logins; a single link is a chain of two).
export function toGraph(chains, directed) {
  const graph = new Map();
  const add = (a, b) => {
    if (!graph.has(a)) graph.set(a, new Set());
    graph.get(a).add(b);
  };
  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      add(chain[i], chain[i + 1]);
      if (!directed) add(chain[i + 1], chain[i]);
    }
  }
  return graph;
}

// Shortest path from s to t as a list of logins, or null. `skip` is treated
// as removed from the graph.
function bfsPath(graph, s, t, skip = null) {
  const prev = new Map([[s, null]]);
  const queue = [s];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (cur === t) {
      const path = [];
      for (let n = t; n != null; n = prev.get(n)) path.unshift(n);
      return path;
    }
    for (const next of graph.get(cur) ?? []) {
      if (next === skip || prev.has(next)) continue;
      prev.set(next, cur);
      queue.push(next);
    }
  }
  return null;
}

// The most routes from s to t that share no one in between (vertex-disjoint),
// by max-flow (Edmonds–Karp) with every person split into in -> out with
// capacity 1, so each can carry one route. By Menger's theorem this is also
// the fewest people whose removal would cut s off from t.
// Returns { count, paths }. People in `avoid` are left out.
export function maxDisjointRoutes(graph, s, t, avoid = []) {
  const skip = new Set(avoid);
  if (s === t) return { count: 0, paths: [] };
  const IN = (x) => `i:${x}`;
  const OUT = (x) => `o:${x}`;
  const cap = new Map(); // node -> Map(node -> residual capacity)
  const used = new Set(); // original edges, "u|v", that carry flow
  const original = new Set();
  const edge = (u, v) => {
    if (!cap.has(u)) cap.set(u, new Map());
    if (!cap.has(v)) cap.set(v, new Map());
    if (!original.has(`${u}|${v}`)) {
      original.add(`${u}|${v}`);
      cap.get(u).set(v, (cap.get(u).get(v) ?? 0) + 1);
    }
    if (!cap.get(v).has(u)) cap.get(v).set(u, 0);
  };
  for (const [a, links] of graph) {
    if (skip.has(a)) continue;
    if (a !== s && a !== t) edge(IN(a), OUT(a));
    for (const b of links) {
      if (skip.has(b)) continue;
      if (b !== s && b !== t) edge(IN(b), OUT(b));
      // s is entered at its out side and t left at its in side, so neither is split.
      edge(a === s ? OUT(s) : OUT(a), b === t ? IN(t) : IN(b));
    }
  }
  const source = OUT(s);
  const sink = IN(t);
  if (!cap.has(source) || !cap.has(sink)) return { count: 0, paths: [] };

  let count = 0;
  for (;;) {
    const prev = new Map([[source, null]]);
    const queue = [source];
    for (let i = 0; i < queue.length && !prev.has(sink); i++) {
      for (const [next, c] of cap.get(queue[i])) {
        if (c > 0 && !prev.has(next)) {
          prev.set(next, queue[i]);
          queue.push(next);
        }
      }
    }
    if (!prev.has(sink)) break;
    for (let v = sink; v !== source; v = prev.get(v)) {
      const u = prev.get(v);
      cap.get(u).set(v, cap.get(u).get(v) - 1);
      cap.get(v).set(u, cap.get(v).get(u) + 1);
    }
    count += 1;
  }

  // Walk the edges that carry flow to spell out the routes.
  for (const key of original) {
    const [u, v] = key.split('|');
    if (cap.get(u).get(v) === 0) used.add(key);
  }
  const paths = [];
  for (let n = 0; n < count; n++) {
    const path = [s];
    let cur = source;
    while (cur !== sink) {
      const next = [...cap.get(cur).keys()].find((v) => used.has(`${cur}|${v}`));
      used.delete(`${cur}|${next}`);
      cur = next;
      if (cur === sink) path.push(t);
      else if (cur.startsWith('o:')) path.push(cur.slice(2));
    }
    paths.push(path);
  }
  paths.sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
  return { count, paths };
}

// The people every route from s to t goes through: removing any one of them
// disconnects s from t. Each one must be on every path, so only the people on
// one path need checking.
// ponytail: O(L·(V+E)); fine on the chains graph, a dominator tree if it ever runs on the whole crawl.
export function findGatekeepers(graph, s, t) {
  const path = bfsPath(graph, s, t);
  if (!path) return [];
  return path.slice(1, -1).filter((v) => !bfsPath(graph, s, t, v));
}

const middle = (chain) => chain.logins.slice(1, -1);
const key = (chain) => chain.logins.join(',');

// Shortest first, then more mutual follows, then alphabetical, so the same
// candidates always give the same choice.
export function compareChains(a, b) {
  return a.logins.length - b.logins.length
    || (b.mutualHops ?? 0) - (a.mutualHops ?? 0)
    || key(a).localeCompare(key(b));
}

// Picks up to k chains that are as different as possible: each next one is
// the shortest that shares no one in between with those already picked, or,
// failing that, the one that shares the fewest. `seed` chains are taken
// first, in the order given.
// Each result gets `shared`: Map(login -> index of the earlier chain it's in).
// candidates: [{ logins, mutualHops }].
export function selectDiverseChains(candidates, k = 3, seed = []) {
  const chosen = [];
  const owner = new Map(); // login in between -> first chain it appears in
  const keys = new Set();
  const take = (chain) => {
    const shared = new Map();
    for (const login of middle(chain)) {
      if (owner.has(login)) shared.set(login, owner.get(login));
      else owner.set(login, chosen.length);
    }
    keys.add(key(chain));
    chosen.push({ ...chain, shared });
  };

  for (const chain of seed) {
    if (chosen.length < k && !keys.has(key(chain))) take(chain);
  }
  const pool = [...candidates].sort(compareChains);
  while (chosen.length < k) {
    let best = null;
    let bestOverlap = Infinity;
    for (const chain of pool) {
      if (keys.has(key(chain))) continue;
      const overlap = middle(chain).filter((l) => owner.has(l)).length;
      if (overlap < bestOverlap) {
        best = chain;
        bestOverlap = overlap;
        if (!overlap) break;
      }
    }
    if (!best) break;
    take(best);
  }
  return chosen;
}

// How many of the chosen chains share no one with an earlier one.
export const disjointCount = (chosen) => chosen.filter((c) => !c.shared.size).length;
