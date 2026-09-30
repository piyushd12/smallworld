import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_URL = 'https://smallworld.example/';
const { app, cache, metaTags, setStore, createMemoryStore } = await import('../server.js');
const { parseShareQuery, buildShareQuery } = await import('../public/share.js');
setStore(createMemoryStore()); // never a real Redis, even if .env has credentials

// Stubs GitHub: the follow relation, and avatar downloads (a real 1x1 PNG).
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const realFetch = globalThis.fetch;
let follows = new Set(); // "a>b"
let avatarsFail = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const rel = u.match(/^https:\/\/api\.github\.com\/users\/([^/]+)\/following\/([^/?]+)$/);
  if (rel) return new Response(null, { status: follows.has(`${rel[1]}>${rel[2]}`) ? 204 : 404 });
  if (u.startsWith('https://github.com/') && u.includes('.png')) {
    if (avatarsFail) throw new Error('avatar download failed');
    return new Response(ONE_PX_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  if (u.startsWith('https://api.github.com')) return new Response('{}', { status: 500 });
  return realFetch(url, opts);
};

function setFollows(...pairs) {
  follows = new Set(pairs);
  cache.clear(); // verification results are cached per pair
}

async function withServer(fn) {
  const server = app.listen(0);
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    server.close();
  }
}

const params = (qs) => new URLSearchParams(qs);

test('parseShareQuery reads valid params and defaults the mode', () => {
  assert.deepEqual(parseShareQuery(params('from=alice&to=torvalds')), { from: 'alice', to: 'torvalds', via: null, mode: 'either' });
  assert.deepEqual(parseShareQuery(params('from=alice&to=torvalds&via=bob,carol&mode=follow')), {
    from: 'alice', to: 'torvalds', via: ['bob', 'carol'], mode: 'follow',
  });
  assert.deepEqual(parseShareQuery(params('from=alice&to=bob&via='))?.via, []);
});

test('parseShareQuery rejects bad usernames, too many via names and unknown modes', () => {
  assert.equal(parseShareQuery(params('from=alice')), null);
  assert.equal(parseShareQuery(params('from=-bad&to=torvalds')), null);
  assert.equal(parseShareQuery(params('from=alice&to=torvalds&via=bob,a--b')), null);
  assert.equal(parseShareQuery(params('from=alice&to=torvalds&mode=sideways')), null);
  const six = 'a,b,c,d,e,f';
  assert.deepEqual(parseShareQuery(params(`from=x&to=y&via=${six}`))?.via.length, 6);
  assert.equal(parseShareQuery(params(`from=x&to=y&via=${six},g`)), null);
});

test('a share URL built from a result parses back to the same values', () => {
  const original = { from: 'alice', to: 'torvalds', via: ['bob', 'carol'], mode: 'follow' };
  assert.deepEqual(parseShareQuery(params(buildShareQuery(original))), original);
  const plain = { from: 'alice', to: 'torvalds', via: null, mode: 'either' };
  assert.equal(buildShareQuery(plain), '?from=alice&to=torvalds');
  assert.deepEqual(parseShareQuery(params(buildShareQuery(plain))), plain);
});

test('metaTags covers the chain, question and default cases', () => {
  const q = { from: 'alice', to: 'torvalds', via: ['bob', 'carol'], mode: 'either' };
  const verified = { valid: true, edges: [], users: ['alice', 'bob', 'carol', 'torvalds'].map((login) => ({ login })) };

  const chain = metaTags(q, verified, 'https://x.test');
  assert.match(chain, /<title>@alice is 3 degrees from @torvalds \| smallworld<\/title>/);
  assert.match(chain, /alice → bob → carol → torvalds/);
  assert.match(chain, /property="og:image" content="https:\/\/x\.test\/og\.png\?from=alice&amp;to=torvalds&amp;via=bob,carol"/);
  assert.match(chain, /property="og:url" content="https:\/\/x\.test\/\?from=alice/);
  assert.match(chain, /og:image:width" content="1200"/);
  assert.match(chain, /og:image:height" content="630"/);
  assert.match(chain, /twitter:card" content="summary_large_image"/);

  const question = metaTags({ ...q, via: null }, null, 'https://x.test');
  assert.match(question, /<title>How many follows between @alice and @torvalds\? \| smallworld<\/title>/);
  assert.match(metaTags(q, null, 'https://x.test'), /How many follows between/); // failed verification

  const plain = metaTags(null, null, 'https://x.test');
  assert.match(plain, /<title>smallworld<\/title>/);
  assert.match(plain, /content="https:\/\/x\.test\/og\.png"/);
});

test('metaTags HTML-escapes every inserted value', () => {
  const tags = metaTags({ from: 'a"><script>', to: 'b', via: null, mode: 'either' }, null, 'https://x.test/"><i');
  assert.ok(!tags.includes('<script>'));
  assert.ok(!tags.includes('"><i'));
  assert.match(tags, /&lt;script&gt;/);
  assert.match(tags, /&quot;/);
});

test('GET / injects tags server-side, with absolute URLs from PUBLIC_URL', async () => {
  setFollows('alice>bob', 'bob>torvalds');
  await withServer(async (base) => {
    const html = await (await realFetch(`${base}/?from=alice&to=torvalds&via=bob`)).text();
    assert.match(html, /<title>@alice is 2 degrees from @torvalds \| smallworld<\/title>/);
    assert.match(html, /og:image" content="https:\/\/smallworld\.example\/og\.png\?from=alice&amp;to=torvalds&amp;via=bob"/);

    const broken = await (await realFetch(`${base}/?from=alice&to=torvalds&via=nobody`)).text();
    assert.match(broken, /How many follows between @alice and @torvalds\?/);

    const invalid = await (await realFetch(`${base}/?from=../x&to=y`)).text();
    assert.match(invalid, /<title>smallworld<\/title>/);
  });
});

async function verify(base, users, mode = 'either') {
  const res = await realFetch(`${base}/api/verify-path?users=${users}&mode=${mode}`);
  return { status: res.status, body: await res.json() };
}

test('verify-path accepts a chain linked by follows and reports each direction', async () => {
  setFollows('alice>bob', 'bob>alice', 'carol>bob', 'carol>torvalds');
  await withServer(async (base) => {
    const { body } = await verify(base, 'alice,bob,carol,torvalds');
    assert.equal(body.valid, true);
    assert.deepEqual(body.edges.map((e) => [e.aFollowsB, e.bFollowsA]), [[true, true], [false, true], [true, false]]);
    assert.deepEqual(body.users[0], { login: 'alice', avatarUrl: 'https://github.com/alice.png', url: 'https://github.com/alice' });
  });
});

test('verify-path rejects a chain with a broken link', async () => {
  setFollows('alice>bob', 'carol>torvalds');
  await withServer(async (base) => {
    const { body } = await verify(base, 'alice,bob,carol,torvalds');
    assert.equal(body.valid, false);
    assert.deepEqual(body.edges[1], { from: 'bob', to: 'carol', aFollowsB: false, bFollowsA: false });
  });
});

test('verify-path in follow mode needs every follow to point forward', async () => {
  setFollows('alice>bob', 'carol>bob');
  await withServer(async (base) => {
    assert.equal((await verify(base, 'alice,bob,carol', 'either')).body.valid, true);
    assert.equal((await verify(base, 'alice,bob,carol', 'follow')).body.valid, false);
  });
});

test('verify-path rejects invalid input with 400', async () => {
  await withServer(async (base) => {
    assert.equal((await verify(base, 'alice')).status, 400);
    assert.equal((await verify(base, 'alice,a--b')).status, 400);
    assert.equal((await verify(base, 'alice,bob', 'sideways')).status, 400);
  });
});

function assertPng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(buf.readUInt32BE(16), 1200); // IHDR width
  assert.equal(buf.readUInt32BE(20), 630); // IHDR height
}

async function getPng(base, qs) {
  const res = await realFetch(`${base}/og.png${qs}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  return Buffer.from(await res.arrayBuffer());
}

test('og.png renders the chain, question and default cards at 1200x630', async () => {
  setFollows('alice>bob', 'bob>carol', 'carol>torvalds');
  avatarsFail = false;
  await withServer(async (base) => {
    assertPng(await getPng(base, '?from=alice&to=torvalds&via=bob,carol'));
    assertPng(await getPng(base, '?from=alice&to=torvalds'));
    assertPng(await getPng(base, ''));
    assertPng(await getPng(base, '?from=-bad&to=x')); // invalid input falls back to the default card
  });
});

test('og.png still returns a card (initials) when avatars fail to load', async () => {
  setFollows('dan>erin');
  avatarsFail = true;
  try {
    await withServer(async (base) => {
      assertPng(await getPng(base, '?from=dan&to=erin&via='));
      assertPng(await getPng(base, '?from=dan&to=frank'));
    });
  } finally {
    avatarsFail = false;
  }
});
