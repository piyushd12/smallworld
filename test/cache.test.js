import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set before the server module loads, since it reads this once at import.
process.env.RATE_LIMIT_PER_IP_HOUR = '3';
const { app, cache, saveCache, loadCache, setStore, createMemoryStore, createRedisStore } = await import('../server.js');
setStore(createMemoryStore()); // never a real Redis, even if .env has credentials

// Stubs GitHub (and only GitHub): a followers page with an ETag, answering
// 304 when the client sends that ETag back.
const realFetch = globalThis.fetch;
const upstream = [];
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.github.com')) return realFetch(url, opts);
  upstream.push({ url: String(url), ifNoneMatch: opts.headers?.['If-None-Match'] });
  const headers = { etag: 'W/"v1"', 'x-ratelimit-remaining': '4999', 'content-type': 'application/json' };
  if (opts.headers?.['If-None-Match'] === 'W/"v1"') return new Response(null, { status: 304, headers });
  return new Response(JSON.stringify([{ login: 'bob', id: 42 }]), { status: 200, headers });
};

async function get(server, p) {
  const res = await realFetch(`http://localhost:${server.address().port}${p}`);
  return { status: res.status, cache: res.headers.get('x-cache'), body: await res.json() };
}

test('serves a repeat lookup from cache, then revalidates with the ETag once stale', async () => {
  cache.clear();
  upstream.length = 0;
  const server = app.listen(0);
  try {
    const first = await get(server, '/api/followers/alice?page=1');
    assert.equal(first.cache, 'miss');
    assert.deepEqual(first.body.items, [
      { login: 'bob', avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4', html_url: 'https://github.com/bob' },
    ]);

    const second = await get(server, '/api/followers/alice?page=1');
    assert.equal(second.cache, 'hit');
    assert.equal(upstream.length, 1, 'a fresh cache hit must not call GitHub');

    for (const entry of cache.values()) entry.fetchedAt -= 2 * 60 * 60 * 1000; // age it past freshness
    const third = await get(server, '/api/followers/alice?page=1');
    assert.equal(third.cache, 'revalidated');
    assert.equal(upstream.at(-1).ifNoneMatch, 'W/"v1"');
    assert.deepEqual(third.body.items, first.body.items);
  } finally {
    server.close();
  }
});

test('caps GitHub calls per IP, but still serves what is already cached', async () => {
  // The previous test's lookups already counted against this IP's budget of 3.
  const server = app.listen(0);
  try {
    let res;
    for (let i = 0; i < 5 && (!res || res.status !== 429); i++) res = await get(server, `/api/followers/user${i}?page=1`);
    assert.equal(res.status, 429);
    assert.equal(res.body.limit, 'per_ip');
    assert.ok(res.body.retryAfter > 0);

    const cached = await get(server, '/api/followers/alice?page=1');
    assert.equal(cached.status, 200, 'cached answers stay available when over the limit');
  } finally {
    server.close();
  }
});

test('cache survives a save/load round trip and drops expired entries', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'degrees-')), 'cache.json');
  cache.clear();
  cache.set('/fresh', { status: 200, body: [], etag: null, fetchedAt: Date.now() });
  cache.set('/ancient', { status: 200, body: [], etag: null, fetchedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 });
  saveCache(file);

  cache.clear();
  loadCache(file);
  assert.deepEqual([...cache.keys()], ['/fresh']);
});

// Stands in for Upstash: values round-trip through JSON like the real client,
// and keys with an expiry are tracked so tests can check one gets set.
function fakeRedis() {
  const data = new Map();
  const expiries = new Map();
  return {
    data,
    expiries,
    async get(k) {
      return data.has(k) ? JSON.parse(data.get(k)) : null;
    },
    async set(k, v, opts) {
      data.set(k, JSON.stringify(v));
      if (opts?.px) expiries.set(k, opts.px);
    },
    async incr(k) {
      const n = (data.has(k) ? JSON.parse(data.get(k)) : 0) + 1;
      data.set(k, JSON.stringify(n));
      return n;
    },
    async pexpire(k, ms) {
      expiries.set(k, ms);
    },
  };
}

test('Redis store: same cache and ETag behaviour, with entries set to expire', async () => {
  const redis = fakeRedis();
  setStore(createRedisStore(redis));
  upstream.length = 0;
  const server = app.listen(0);
  try {
    assert.equal((await get(server, '/api/followers/carol?page=1')).cache, 'miss');
    assert.equal((await get(server, '/api/followers/carol?page=1')).cache, 'hit');
    assert.equal(upstream.length, 1);

    const key = 'gh:/users/carol/followers?per_page=100&page=1';
    assert.ok(redis.expiries.get(key) > 0, 'cache entries must expire on their own in Redis');

    const entry = await redis.get(key);
    entry.fetchedAt -= 2 * 60 * 60 * 1000;
    await redis.set(key, entry, { px: 1 });
    assert.equal((await get(server, '/api/followers/carol?page=1')).cache, 'revalidated');
  } finally {
    server.close();
    setStore(createMemoryStore());
  }
});

test('Redis store: the per-IP limit is one counter shared by every instance', async () => {
  const redis = fakeRedis();
  const instanceA = createRedisStore(redis);
  const instanceB = createRedisStore(redis);
  assert.equal((await instanceA.takeSlot('1.2.3.4')).ok, true);
  assert.equal((await instanceB.takeSlot('1.2.3.4')).ok, true);
  assert.equal((await instanceA.takeSlot('1.2.3.4')).ok, true);
  const fourth = await instanceB.takeSlot('1.2.3.4');
  assert.equal(fourth.ok, false, 'limit is 3 across both instances, not 3 each');
  assert.ok(fourth.retryAfter > 0);
  assert.equal((await instanceA.takeSlot('5.6.7.8')).ok, true, 'other IPs are unaffected');
});
