// Share-URL helpers used by both the browser and the server, so they agree on
// what a valid link looks like. Pure: no DOM, no fetch.

// GitHub usernames: 1-39 chars, alphanumeric, single hyphens, no leading/trailing hyphen.
const LOGIN_RE = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

export function isValidLogin(login) {
  return typeof login === 'string' && LOGIN_RE.test(login);
}

export const MAX_VIA = 6;

// searchParams -> { from, to, via: string[] | null, mode: 'either' | 'follow' },
// or null when the link should be ignored (missing/invalid input).
export function parseShareQuery(params) {
  const from = params.get('from');
  const to = params.get('to');
  if (!isValidLogin(from) || !isValidLogin(to)) return null;

  const mode = params.get('mode') ?? 'either';
  if (mode !== 'either' && mode !== 'follow') return null;

  let via = null;
  if (params.has('via')) {
    const raw = params.get('via');
    via = raw === '' ? [] : raw.split(',');
    if (via.length > MAX_VIA || !via.every(isValidLogin)) return null;
  }
  return { from, to, via, mode };
}

// Inverse of parseShareQuery. Also used as the normalised cache key for images.
// A path with more than MAX_VIA middle people can't be shared, so `via` is dropped.
export function buildShareQuery({ from, to, via, mode }) {
  const p = new URLSearchParams({ from, to });
  if (via && via.length <= MAX_VIA) p.set('via', via.join(','));
  if (mode === 'follow') p.set('mode', 'follow');
  return `?${p.toString().replaceAll('%2C', ',')}`;
}
