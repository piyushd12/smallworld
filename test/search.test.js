import test from 'node:test';
import assert from 'node:assert/strict';
import { findConnection, SearchError } from '../public/search.js';

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
        data: { login, avatar_url: '', html_url: `https://github.com/${login}`, type: 'User', followers: 0, following: 0 },
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
