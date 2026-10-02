// Share-URL helpers used by both the browser and the server, so they agree on
// what a valid link looks like. Pure: no DOM, no fetch.

// GitHub usernames: 1-39 chars, alphanumeric, single hyphens, no leading/trailing hyphen.
const LOGIN_RE = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

export function isValidLogin(login) {
  return typeof login === 'string' && LOGIN_RE.test(login);
}

// Repository names: an owner (same rules as a username), then 1-100 letters,
// digits, dots, dashes or underscores, but not "." or "..".
const REPO_NAME_RE = /^[A-Za-z\d._-]{1,100}$/;

export function isValidRepo(repo) {
  if (typeof repo !== 'string') return false;
  const [owner, name, ...rest] = repo.split('/');
  return !rest.length && isValidLogin(owner) && REPO_NAME_RE.test(name ?? '') && name !== '.' && name !== '..';
}

export const MAX_VIA = 6;

// searchParams -> { from, to, via: string[] | null, mode: 'either' | 'follow', gk?, link?, repos? },
// or null when the link should be ignored (missing/invalid input). `gk` is the
// person every route went through; it's dropped unless it's one of `via`.
// `link: 'collab'` links people by a shared repo; `repos` names the repo of
// each link in order, so it has one more entry than `via`.
export function parseShareQuery(params) {
  const from = params.get('from');
  const to = params.get('to');
  if (!isValidLogin(from) || !isValidLogin(to)) return null;

  const mode = params.get('mode') ?? 'either';
  if (mode !== 'either' && mode !== 'follow') return null;
  const link = params.get('link') ?? 'follows';
  if (link !== 'follows' && link !== 'collab') return null;

  let via = null;
  if (params.has('via')) {
    const raw = params.get('via');
    via = raw === '' ? [] : raw.split(',');
    if (via.length > MAX_VIA || !via.every(isValidLogin)) return null;
  }
  const q = { from, to, via, mode };
  if (link === 'collab') {
    q.link = link;
    if (via) {
      const repos = (params.get('repos') ?? '').split(',');
      if (repos.length !== via.length + 1 || !repos.every(isValidRepo)) return null;
      q.repos = repos;
    }
  }
  const gk = params.get('gk');
  if (via && isValidLogin(gk) && via.some((v) => v.toLowerCase() === gk.toLowerCase())) q.gk = gk;
  return q;
}

// Inverse of parseShareQuery. Also used as the normalised cache key for images.
// A path with more than MAX_VIA middle people can't be shared, so `via` is dropped.
export function buildShareQuery({ from, to, via, mode, gk, link, repos }) {
  const p = new URLSearchParams({ from, to });
  const viaOk = via && via.length <= MAX_VIA;
  if (viaOk) p.set('via', via.join(','));
  if (mode === 'follow' && link !== 'collab') p.set('mode', 'follow');
  if (link === 'collab') {
    p.set('link', 'collab');
    if (viaOk) p.set('repos', repos.join(','));
  }
  if (viaOk && gk && via.includes(gk)) p.set('gk', gk);
  return `?${p.toString().replaceAll('%2C', ',').replaceAll('%2F', '/')}`;
}
