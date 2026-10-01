// A made-up follow network for Demo mode, so the animation can run in a
// presentation with no network and no token. It is a Watts–Strogatz
// small-world graph (a ring where everyone knows their neighbours, with a few
// links rewired to random people) plus a handful of popular hubs, which is
// roughly how real social networks look.

import { toGraph, maxDisjointRoutes } from '../paths.js';

const FIRST = [
  'ada', 'ben', 'cleo', 'dev', 'esme', 'finn', 'gia', 'hugo', 'iris', 'jay',
  'kai', 'lena', 'milo', 'nia', 'omar', 'pia', 'quinn', 'rosa', 'sam', 'tara',
  'uma', 'vik', 'wren', 'xan', 'yara', 'zed', 'amir', 'bea', 'cruz', 'dina',
  'eli', 'faye', 'gus', 'hana', 'ivo', 'june', 'kira', 'leo', 'mara', 'noel',
];
const LAST = [
  'okafor', 'lindqvist', 'moreau', 'tanaka', 'silva', 'novak', 'haddad', 'kowalski', 'reyes', 'ito',
  'fischer', 'adeyemi', 'larsen', 'costa', 'nguyen', 'petrov', 'rossi', 'sato', 'mensah', 'walsh',
  'dubois', 'kim', 'hoffman', 'banerjee', 'ortiz', 'berg', 'yilmaz', 'park', 'owusu', 'marin',
  'keller', 'das', 'fontaine', 'shah', 'kovac', 'mori', 'ncube', 'bauer', 'leroy', 'singh',
  'varga', 'lopez', 'eriksen', 'chen', 'abara', 'weiss', 'duarte', 'hale', 'iyer', 'quint',
];

export const DEMO_SEED = 20260930;
const SIZE = FIRST.length * LAST.length; // 2,000 people
// Tuned so the demo pair is 5 hops apart and the search explores a few hundred
// people: denser rings make the waves fuller but the network smaller.
const RING_NEIGHBOURS = 6; // each person knows 6 people on each side of the ring
const REWIRE = 0.03;
const HUBS = 5;
const HUB_REACH = 0.05; // each hub is linked to ~5% of everyone
const PAGE_SIZE = 100;

// Small, fast, seedable PRNG (mulberry32).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDemoGraph(seed = DEMO_SEED) {
  const rand = mulberry32(seed);
  const pick = (n) => Math.floor(rand() * n);

  const logins = [];
  for (const f of FIRST) for (const l of LAST) logins.push(`${f}-${l}`);
  for (let i = logins.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [logins[i], logins[j]] = [logins[j], logins[i]];
  }

  // Undirected links first, stored as "a,b" with a < b.
  const links = new Set();
  const link = (a, b) => {
    if (a === b) return false;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (links.has(key)) return false;
    links.add(key);
    return true;
  };
  for (let i = 0; i < SIZE; i++) {
    for (let j = 1; j <= RING_NEIGHBOURS; j++) {
      if (rand() < REWIRE) {
        while (!link(i, pick(SIZE)));
      } else {
        link(i, (i + j) % SIZE);
      }
    }
  }
  const hubs = [];
  while (hubs.length < HUBS) {
    const h = pick(SIZE);
    if (!hubs.includes(h)) hubs.push(h);
  }
  for (const h of hubs) {
    for (let k = 0; k < SIZE * HUB_REACH; k++) link(h, pick(SIZE));
  }

  // Then give each link a direction: some are mutual, the rest one-way.
  const following = new Map(logins.map((l) => [l, []]));
  const followers = new Map(logins.map((l) => [l, []]));
  const follow = (a, b) => {
    following.get(logins[a]).push(logins[b]);
    followers.get(logins[b]).push(logins[a]);
  };
  for (const key of links) {
    const [a, b] = key.split(',').map(Number);
    const r = rand();
    if (r < 0.3) { follow(a, b); follow(b, a); } else if (r < 0.65) follow(a, b); else follow(b, a);
  }

  const graph = { logins, following, followers, hubs: hubs.map((h) => logins[h]) };
  addIsland(graph);
  return graph;
}

// A small island whose only way out is one person, @nora-quill, for the
// Gatekeeper demo. She links to three people two steps from the island
// demo's target, each by a different middle person, so she is the only one
// every route has to pass.
export const ISLAND = { source: 'ola-brook', gatekeeper: 'nora-quill' };
function addIsland(graph) {
  const { logins, following, followers } = graph;
  const target = logins.at(-1);
  const both = (a, b) => {
    for (const [x, y] of [[a, b], [b, a]]) {
      following.get(x).push(y);
      followers.get(y).push(x);
    }
  };
  const island = ['ola-brook', 'pim-brook', 'ros-brook', 'tess-brook', ISLAND.gatekeeper];
  for (const l of island) {
    following.set(l, []);
    followers.set(l, []);
  }

  const dist = distances(graph, target);
  const near = (l) => [...following.get(l), ...followers.get(l)].filter((n) => dist.get(n) === 1);
  const anchors = [];
  const middles = new Set();
  for (const l of logins) {
    if (anchors.length === 3) break;
    if (dist.get(l) !== 2 || near(l).some((m) => middles.has(m))) continue;
    anchors.push(l);
    for (const m of near(l)) middles.add(m);
  }

  both('ola-brook', 'pim-brook');
  both('ola-brook', 'ros-brook');
  both('tess-brook', 'ola-brook');
  both('tess-brook', 'pim-brook');
  both('pim-brook', ISLAND.gatekeeper);
  both('ros-brook', ISLAND.gatekeeper);
  for (const a of anchors) both(ISLAND.gatekeeper, a);
  logins.push(...island);
  ISLAND.target = target;
}

// Hops between two people when a follow in either direction counts.
export function distances(graph, from) {
  const dist = new Map([[from, 0]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const next of [...graph.following.get(cur), ...graph.followers.get(cur)]) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(cur) + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

export const demoGraph = buildDemoGraph();

// The demo pair: the first person on the list, and someone 5 hops away
// (or as far as the network allows), so the search has a long way to go.
export const DEMO_PAIR = (() => {
  const source = demoGraph.logins.find((l) => !demoGraph.hubs.includes(l));
  const dist = distances(demoGraph, source);
  const far = Math.min(5, Math.max(...dist.values()));
  const target = demoGraph.logins.find((l) => dist.get(l) === far);
  return { source, target, degrees: far };
})();

// The Three routes demo: someone 4 (or else 3) steps from the demo source
// with at least three shortest chains that share no one in between.
function routesPair(graph) {
  const { source } = DEMO_PAIR;
  const fromS = distances(graph, source);
  for (const len of [4, 3]) {
    for (const target of graph.logins) {
      if (fromS.get(target) !== len) continue;
      const toT = distances(graph, target);
      const links = [];
      for (const [a, list] of graph.following) {
        for (const b of list) {
          if (fromS.get(a) + toT.get(a) !== len || fromS.get(b) + toT.get(b) !== len) continue;
          if (fromS.get(b) === fromS.get(a) + 1) links.push([a, b]);
          else if (fromS.get(a) === fromS.get(b) + 1) links.push([b, a]);
        }
      }
      if (maxDisjointRoutes(toGraph(links, true), source, target).count >= 3) return { source, target, degrees: len };
    }
  }
  return DEMO_PAIR;
}

export const DEMO_PAIRS = {
  long: DEMO_PAIR,
  gatekeeper: { source: ISLAND.source, target: ISLAND.target, degrees: distances(demoGraph, ISLAND.source).get(ISLAND.target) },
  routes: routesPair(demoGraph),
};

const avatars = new Map();
// A coloured circle with the person's initials, as an inline SVG image.
export function demoAvatar(login) {
  if (!avatars.has(login)) {
    let hue = 0;
    for (const ch of login) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    const initials = login.split('-').map((p) => p[0].toUpperCase()).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="hsl(${hue} 55% 48%)"/><text x="40" y="52" font-family="sans-serif" font-size="32" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
    avatars.set(login, `data:image/svg+xml,${encodeURIComponent(svg)}`);
  }
  return avatars.get(login);
}

const abortError = () => new DOMException('Search was stopped', 'AbortError');

// A drop-in for the app's fetchJson that answers from the demo graph, in the
// same shape the server's /api endpoints use. The delay makes each batch of
// answers arrive a little apart, so the waves visibly grow.
export function createDemoFetch({ graph = demoGraph, delayMs = 220 } = {}) {
  return async function fetchJson(path, { signal } = {}) {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
    });
    const ok = (data) => ({ status: 200, data, remaining: null, reset: null, cached: false });

    const user = path.match(/^\/api\/user\/([^/?]+)$/);
    if (user) {
      const login = user[1];
      if (!graph.following.has(login)) return { status: 404, data: { message: 'Not Found' }, remaining: null, reset: null, cached: false };
      return ok({
        login,
        avatar_url: demoAvatar(login),
        html_url: null,
        type: 'User',
        followers: graph.followers.get(login).length,
        following: graph.following.get(login).length,
      });
    }
    const list = path.match(/^\/api\/(following|followers)\/([^/?]+)\?page=(\d+)$/);
    if (list) {
      const [, kind, login, page] = list;
      const all = graph[kind].get(login) ?? [];
      const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      return ok({ items: slice.map((l) => ({ login: l, avatar_url: demoAvatar(l), html_url: null })) });
    }
    return { status: 404, data: { message: 'Not Found' }, remaining: null, reset: null, cached: false };
  };
}
