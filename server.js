import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rateLimit } from 'express-rate-limit';
import { isValidLogin, parseShareQuery, buildShareQuery } from './public/share.js';
import { renderOg, renderDefault } from './og.js';

export { isValidLogin };

const token = process.env.GITHUB_TOKEN;
const hasToken = Boolean(token);

// Hosting knobs. One shared token serves every visitor, so cap how many
// GitHub calls a single IP can cause per hour, and keep the cache on disk.
const PER_IP_HOURLY = Number(process.env.RATE_LIMIT_PER_IP_HOUR) || 1000;
const CACHE_FILE = process.env.CACHE_FILE ?? '.cache/github-cache.json';

// Absolute origin used in og:url / og:image, since crawlers need full URLs.
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');

export function parsePage(raw) {
  if (raw === undefined) return 1;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 10 ? n : null;
}

// Follow graphs change slowly and hub accounts turn up in many different
// people's searches, so responses are kept for days. Within FRESH_MS they're
// served as-is; after that they're revalidated with the stored ETag, and
// GitHub's 304 reply doesn't count against the rate limit (checked live).
const FRESH_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20000;
export const cache = new Map(); // api path -> { status, body, etag, fetchedAt }

let persistTo = null; // set only when run as the real server, never in tests
let saveTimer = null;

function scheduleSave() {
  if (!persistTo || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCache(persistTo);
  }, 5000);
  saveTimer.unref();
}

// Drops entries past MAX_AGE_MS (and the oldest beyond MAX_ENTRIES), then
// writes atomically so a crash mid-write can't leave a corrupt file.
// ponytail: whole-file JSON rewrite, move to SQLite if the cache outgrows ~50MB.
export function saveCache(file) {
  const now = Date.now();
  const keep = [...cache]
    .filter(([, e]) => now - e.fetchedAt < MAX_AGE_MS)
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, MAX_ENTRIES);
  cache.clear();
  for (const [k, v] of keep) cache.set(k, v);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(keep));
  fs.renameSync(`${file}.tmp`, file);
}

export function loadCache(file) {
  try {
    for (const [k, v] of JSON.parse(fs.readFileSync(file, 'utf8'))) cache.set(k, v);
  } catch {
    // missing or unreadable: start with an empty cache
  }
}

const HOUR_MS = 60 * 60 * 1000;

// Where cached responses and per-IP counters live. Two interchangeable
// backends with the same async get / set / takeSlot:
//  - memory (+ the disk file above): local `npm start` and tests
//  - Redis: Vercel, where the disk is temporary and several instances run at once
export function createMemoryStore() {
  const ipWindows = new Map(); // ip -> { start, count }
  return {
    async get(key) {
      return cache.get(key) ?? null;
    },
    async set(key, entry) {
      cache.set(key, entry);
      scheduleSave();
    },
    // ponytail: fixed hourly window per IP, per process; resets on restart.
    async takeSlot(ip) {
      const now = Date.now();
      let w = ipWindows.get(ip);
      if (!w || now - w.start >= HOUR_MS) {
        w = { start: now, count: 0 };
        ipWindows.set(ip, w);
        if (ipWindows.size > 10000) {
          for (const [k, v] of ipWindows) if (now - v.start >= HOUR_MS) ipWindows.delete(k);
        }
      }
      if (w.count >= PER_IP_HOURLY) return { ok: false, retryAfter: Math.ceil((w.start + HOUR_MS - now) / 1000) };
      w.count += 1;
      return { ok: true };
    },
  };
}

export function createRedisStore(redis) {
  return {
    async get(key) {
      return (await redis.get(`gh:${key}`)) ?? null;
    },
    async set(key, entry) {
      await redis.set(`gh:${key}`, entry, { px: MAX_AGE_MS }); // Redis expiry replaces the file's pruning
    },
    // Fixed clock-hour window, one counter shared by every instance.
    async takeSlot(ip) {
      const now = Date.now();
      const windowEnd = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
      const key = `ip:${ip}:${windowEnd}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, HOUR_MS);
      if (count > PER_IP_HOURLY) return { ok: false, retryAfter: Math.ceil((windowEnd - now) / 1000) };
      return { ok: true };
    },
  };
}

let store = createMemoryStore();
export function setStore(s) {
  store = s;
}

// Vercel's Upstash integration injects these (either naming style).
const usingRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
if (usingRedis) {
  const { Redis } = await import('@upstash/redis');
  store = createRedisStore(Redis.fromEnv());
}

// Returns { status, body, remaining, reset, cacheStatus } where cacheStatus is
// hit | revalidated | stale | miss, or { networkError } / { limited, retryAfter }.
// `compact` shrinks a 200 body before it's cached.
async function ghGet(apiPath, { ip, compact = (b) => b, cacheable = true } = {}) {
  // If the store is down, carry on uncached (and unmetered) rather than fail every request.
  const cached = cacheable ? await store.get(apiPath).catch(() => null) : null;
  if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return { ...cached, cacheStatus: 'hit' };

  if (ip !== undefined) {
    const slot = await store.takeSlot(ip).catch(() => ({ ok: true }));
    if (!slot.ok) return cached ? { ...cached, cacheStatus: 'stale' } : { limited: true, retryAfter: slot.retryAfter };
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'smallworld',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cached?.etag) headers['If-None-Match'] = cached.etag;

  let response;
  try {
    response = await fetch(`https://api.github.com${apiPath}`, { headers });
  } catch (err) {
    if (cached) return { ...cached, cacheStatus: 'stale' };
    return { networkError: true, message: err.message };
  }

  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');

  if (response.status === 304 && cached) {
    const refreshed = { ...cached, fetchedAt: Date.now() };
    await store.set(apiPath, refreshed).catch(() => {});
    return { ...refreshed, remaining, reset, cacheStatus: 'revalidated' };
  }
  // Out of quota: an old answer beats no answer.
  if ((response.status === 403 || response.status === 429) && cached) {
    return { ...cached, remaining, reset, cacheStatus: 'stale' };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // no body / not JSON
  }

  const entry = {
    status: response.status,
    body: response.status === 200 ? compact(body) : { message: body?.message },
    etag: response.headers.get('etag'),
    fetchedAt: Date.now(),
  };
  if (cacheable && [200, 204, 404].includes(response.status)) {
    await store.set(apiPath, entry).catch(() => {});
  }
  return { ...entry, remaining, reset, cacheStatus: 'miss' };
}

function pickUser(u) {
  return {
    login: u.login,
    avatar_url: u.avatar_url,
    html_url: u.html_url,
    type: u.type,
    followers: u.followers,
    following: u.following,
  };
}

// List pages are stored as [login, id] pairs (~6x smaller on disk) and the
// URLs are rebuilt on the way out; the frontend only needs these three fields.
const compactList = (users) => (users ?? []).map((u) => [u.login, u.id]);
const expandListUser = ([login, id]) => ({
  login,
  avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
  html_url: `https://github.com/${login}`,
});

function reply(res, r, toJson) {
  if (r.limited) {
    res.set('retry-after', String(r.retryAfter));
    return res.status(429).json({
      message: 'Too many GitHub lookups from your network. Try again later.',
      limit: 'per_ip',
      retryAfter: r.retryAfter,
    });
  }
  if (r.networkError) return res.status(502).json({ message: 'Could not reach GitHub', detail: r.message });
  if (r.remaining != null) res.set('x-ratelimit-remaining', r.remaining);
  if (r.reset != null) res.set('x-ratelimit-reset', r.reset);
  if (r.cacheStatus) res.set('x-cache', r.cacheStatus);
  if (r.status !== 200) return res.status(r.status).json({ message: r.body?.message ?? 'GitHub error', hasToken });
  res.json({ ...toJson(r.body), hasToken });
}

export const app = express();

// Behind a reverse proxy (most hosts), set TRUST_PROXY (usually 1) so req.ip
// is the visitor, not the proxy. Leave it unset otherwise, or clients could
// spoof X-Forwarded-For to dodge the per-IP limit.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

app.get('/api/user/:login', async (req, res) => {
  if (!isValidLogin(req.params.login)) return res.status(400).json({ message: 'Invalid username' });
  const r = await ghGet(`/users/${req.params.login.toLowerCase()}`, { ip: req.ip, compact: pickUser });
  reply(res, r, (body) => body);
});

function listHandler(kind) {
  return async (req, res) => {
    if (!isValidLogin(req.params.login)) return res.status(400).json({ message: 'Invalid username' });
    const page = parsePage(req.query.page);
    if (page === null) return res.status(400).json({ message: 'Invalid page' });

    const apiPath = `/users/${req.params.login.toLowerCase()}/${kind}?per_page=100&page=${page}`;
    const r = await ghGet(apiPath, { ip: req.ip, compact: compactList });
    reply(res, r, (body) => ({ items: body.map(expandListUser) }));
  };
}

app.get('/api/following/:login', listHandler('following'));
app.get('/api/followers/:login', listHandler('followers'));

// /rate_limit itself doesn't count against the limit, so it isn't metered.
app.get('/api/rate_limit', async (req, res) => {
  const r = await ghGet('/rate_limit', { cacheable: false });
  reply(res, r, (body) => body);
});

// ---- Sharing: verified chains, link-preview meta tags and preview images ----

const SITE_DESC = 'Find the shortest follow chain between two GitHub users.';

// Does a follow relation exist? 204 = yes, 404 = no; anything else is a failure.
async function follows(a, b, ip) {
  const r = await ghGet(`/users/${a.toLowerCase()}/following/${b.toLowerCase()}`, { ip });
  if (r.limited || r.networkError) throw new Error('GitHub unavailable');
  if (r.status === 204) return true;
  if (r.status === 404) return false;
  throw new Error(`GitHub answered ${r.status}`);
}

// Checks every consecutive pair in both directions. `valid` means each pair is
// linked by a follow (forward only in follow mode).
export async function verifyPath(logins, mode, ip) {
  const edges = await Promise.all(
    logins.slice(0, -1).map(async (from, i) => {
      const to = logins[i + 1];
      const [aFollowsB, bFollowsA] = await Promise.all([follows(from, to, ip), follows(to, from, ip)]);
      return { from, to, aFollowsB, bFollowsA };
    }),
  );
  return {
    valid: edges.every((e) => e.aFollowsB || (mode !== 'follow' && e.bFollowsA)),
    edges,
    users: logins.map((login) => ({ login, avatarUrl: `https://github.com/${login}.png`, url: `https://github.com/${login}` })),
  };
}

// Crawlers give up after a few seconds, so never let verification outlast that.
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms, null))]);
const verifyQuietly = (q, ip) =>
  withTimeout(verifyPath([q.from, ...q.via, q.to], q.mode, ip).catch(() => null), 2500);

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The <head> tags for a link preview. q: parsed share query or null;
// verified: verifyPath result or null.
export function metaTags(q, verified, publicUrl = PUBLIC_URL) {
  let title = 'smallworld';
  let desc = SITE_DESC;
  let query = '';
  if (q) {
    query = buildShareQuery(q);
    if (verified?.valid) {
      const n = verified.users.length - 1;
      title = `@${q.from} is ${n} ${n === 1 ? 'degree' : 'degrees'} from @${q.to} | smallworld`;
      desc = `${verified.users.map((u) => u.login).join(' → ')}: the shortest follow chain found on GitHub. Trace your own chain.`;
    } else {
      title = `How many follows between @${q.from} and @${q.to}? | smallworld`;
      desc = `Find the shortest chain of follows between @${q.from} and @${q.to} on GitHub.`;
    }
  }
  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  const url = escapeHtml(`${publicUrl}/${query}`);
  const image = escapeHtml(`${publicUrl}/og.png${query}`);
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:image" content="${image}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:url" content="${url}">`,
    '<meta property="og:type" content="website">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${image}">`,
  ].join('\n');
}

const searchParamsOf = (req) => new URL(req.url, 'http://x').searchParams;

// Both can cause GitHub calls, so cap them per IP.
const shareLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

app.get('/api/verify-path', shareLimiter, async (req, res) => {
  const logins = typeof req.query.users === 'string' ? req.query.users.split(',') : [];
  const mode = req.query.mode ?? 'either';
  if (logins.length < 2 || logins.length > 8 || !logins.every(isValidLogin) || !['either', 'follow'].includes(mode)) {
    return res.status(400).json({ message: 'Invalid users or mode' });
  }
  // On a GitHub failure, say "not valid" and let the page run a normal search.
  const result = await verifyPath(logins, mode, req.ip).catch(() => ({ valid: false, edges: [], users: [] }));
  res.json(result);
});

// index.html is a template (not in public/) so Express, not the CDN, serves it.
const indexHtml = fs.readFileSync(new URL('./views/index.html', import.meta.url), 'utf8');

app.get('/', async (req, res) => {
  const q = parseShareQuery(searchParamsOf(req));
  const verified = q?.via ? await verifyQuietly(q, req.ip) : null;
  res.type('html').send(indexHtml.replace('<!--meta-->', () => metaTags(q, verified)));
});

// ponytail: per-process LRU of the last 200 images; shared cache if instances multiply.
const imageCache = new Map();
const IMAGE_CACHE_MAX = 200;

app.get('/og.png', shareLimiter, async (req, res) => {
  const q = parseShareQuery(searchParamsOf(req));
  const key = q ? buildShareQuery(q) : '';
  let png = imageCache.get(key);
  if (png) {
    imageCache.delete(key);
    imageCache.set(key, png);
  } else {
    try {
      const verified = q?.via ? await verifyQuietly(q, req.ip) : null;
      png = await renderOg(q, verified, PUBLIC_URL);
      // An unverified path may only be a GitHub hiccup, so don't remember it.
      if (!q?.via || verified?.valid) {
        imageCache.set(key, png);
        if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
      }
    } catch {
      png = await renderDefault(PUBLIC_URL); // never show a crawler an error
    }
  }
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).send(png);
});

// Local only: on Vercel, files in public/ are served by the CDN instead.
app.use(express.static('public'));

// Vercel imports this default export; locally `npm start` runs the block below.
export default app;

// Only start listening when run directly (`node server.js`), not when imported by tests or Vercel.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (CACHE_FILE && !usingRedis) {
    loadCache(CACHE_FILE);
    persistTo = CACHE_FILE;
    const flushAndExit = () => {
      saveCache(CACHE_FILE);
      process.exit(0);
    };
    process.on('SIGINT', flushAndExit);
    process.on('SIGTERM', flushAndExit);
  }
  const port = process.env.PORT || 3000;
  const cacheInfo = usingRedis ? 'cache: Redis' : `cache: ${cache.size} responses on disk`;
  app.listen(port, () => console.log(`Listening on http://localhost:${port} (${cacheInfo})`));
}
