import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set before the server module loads, since it reads this once at import.
process.env.RATE_LIMIT_PER_IP_HOUR = '3';
const { app, cache, saveCache, loadCache } = await import('../server.js');

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
