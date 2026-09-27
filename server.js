import 'dotenv/config';
import express from 'express';
import { pathToFileURL } from 'node:url';

const token = process.env.GITHUB_TOKEN;
const hasToken = Boolean(token);

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

// ponytail: unbounded Map, add an LRU cap if this ever runs long enough for memory to matter
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function ghGet(path, { cacheable = true } = {}) {
  const cached = cache.get(path);
  if (cacheable && cached && cached.expires > Date.now()) return cached;

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'github-degrees-app',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`https://api.github.com${path}`, { headers });
  } catch (err) {
    return { networkError: true, message: err.message };
  }

  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  let body = null;
  try {
    body = await response.json();
  } catch {
    // no body / not JSON
  }

  const result = { status: response.status, remaining, reset, body };
  if (cacheable && (response.status === 200 || response.status === 404)) {
    cache.set(path, { ...result, expires: Date.now() + CACHE_TTL_MS });
  }
  return result;
}

function setRateHeaders(res, r) {
  if (r.remaining != null) res.set('x-ratelimit-remaining', r.remaining);
  if (r.reset != null) res.set('x-ratelimit-reset', r.reset);
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

function pickListUser(u) {
  return { login: u.login, avatar_url: u.avatar_url, html_url: u.html_url, type: u.type };
}

export const app = express();

app.get('/api/user/:login', async (req, res) => {
  if (!isValidLogin(req.params.login)) return res.status(400).json({ message: 'Invalid username' });

  const r = await ghGet(`/users/${req.params.login}`);
  if (r.networkError) return res.status(502).json({ message: 'Could not reach GitHub', detail: r.message });
  setRateHeaders(res, r);
  if (r.status !== 200) return res.status(r.status).json({ message: r.body?.message ?? 'GitHub error', hasToken });

  res.json({ ...pickUser(r.body), hasToken });
});

function listHandler(kind) {
  return async (req, res) => {
    if (!isValidLogin(req.params.login)) return res.status(400).json({ message: 'Invalid username' });
    const page = parsePage(req.query.page);
    if (page === null) return res.status(400).json({ message: 'Invalid page' });

    const r = await ghGet(`/users/${req.params.login}/${kind}?per_page=100&page=${page}`);
    if (r.networkError) return res.status(502).json({ message: 'Could not reach GitHub', detail: r.message });
    setRateHeaders(res, r);
    if (r.status !== 200) return res.status(r.status).json({ message: r.body?.message ?? 'GitHub error', hasToken });

    res.json({ items: (r.body ?? []).map(pickListUser), hasToken });
  };
}

app.get('/api/following/:login', listHandler('following'));
app.get('/api/followers/:login', listHandler('followers'));

app.get('/api/rate_limit', async (req, res) => {
  const r = await ghGet('/rate_limit', { cacheable: false });
  if (r.networkError) return res.status(502).json({ message: 'Could not reach GitHub', detail: r.message });
  setRateHeaders(res, r);
  if (r.status !== 200) return res.status(r.status).json({ message: r.body?.message ?? 'GitHub error', hasToken });

  res.json({ ...r.body, hasToken });
});

app.use(express.static('public'));

// Only start listening when run directly (`node server.js`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
}
