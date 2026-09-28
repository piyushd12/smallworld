import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const token = process.env.GITHUB_TOKEN;
const hasToken = Boolean(token);

// Hosting knobs. One shared token serves every visitor, so cap how many
// GitHub calls a single IP can cause per hour, and keep the cache on disk.
const PER_IP_HOURLY = Number(process.env.RATE_LIMIT_PER_IP_HOUR) || 1000;
const CACHE_FILE = process.env.CACHE_FILE ?? '.cache/github-cache.json';

// GitHub usernames: 1-39 chars, alphanumeric, single hyphens, no leading/trailing hyphen.
const LOGIN_RE = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

export function isValidLogin(login) {
  return typeof login === 'string' && LOGIN_RE.test(login);
}

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

// ponytail: fixed hourly window per IP, in memory; resets on restart.
const ipWindows = new Map(); // ip -> { start, count }
const HOUR_MS = 60 * 60 * 1000;

function takeUpstreamSlot(ip) {
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
}

// Returns { status, body, remaining, reset, cacheStatus } where cacheStatus is
// hit | revalidated | stale | miss, or { networkError } / { limited, retryAfter }.
// `compact` shrinks a 200 body before it's cached.
async function ghGet(apiPath, { ip, compact = (b) => b, cacheable = true } = {}) {
  const cached = cacheable ? cache.get(apiPath) : null;
  if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return { ...cached, cacheStatus: 'hit' };

  if (ip !== undefined) {
    const slot = takeUpstreamSlot(ip);
    if (!slot.ok) return cached ? { ...cached, cacheStatus: 'stale' } : { limited: true, retryAfter: slot.retryAfter };
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'github-degrees-app',
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
    cached.fetchedAt = Date.now();
    scheduleSave();
    return { ...cached, remaining, reset, cacheStatus: 'revalidated' };
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
  if (cacheable && (response.status === 200 || response.status === 404)) {
    cache.set(apiPath, entry);
    scheduleSave();
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

app.use(express.static('public'));

// Only start listening when run directly (`node server.js`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (CACHE_FILE) {
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
  app.listen(port, () => console.log(`Listening on http://localhost:${port} (${cache.size} cached responses)`));
}
