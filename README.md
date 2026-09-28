# GitHub Degrees of Separation

Find the shortest follow chain between two GitHub users — "six degrees of separation" for GitHub.

## Setup

1. **(Optional but recommended) Create a GitHub token.** Without one you're limited to 60 requests/hour,
   which caps how far the search can look. Go to
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   and create a **fine-grained token** with **read-only access to public repositories** — it needs no
   other permissions, since it's only used to read public profiles and follower lists.
2. Copy `.env.example` to `.env` and paste the token in:
   ```
   cp .env.example .env
   ```
3. Install dependencies and start the server:
   ```
   npm install
   npm start
   ```
4. Open <http://localhost:3000>. Set `PORT` to run on a different port.

The token lives only in `.env` on the server and is never sent to the browser.

## How the search works

The app runs a bidirectional breadth-first search: one search grows outward from your account, another
grows outward from the target's, and each round it expands whichever side currently has fewer people
left to check. As soon as the two sides meet, it has found the shortest chain. Within a round it checks
accounts that many others already point to first, since those tend to be hubs that connect to more of
the graph.

Two link modes are available: "either person follows the other" treats a follow in either direction as
a link, while "follow chains only" requires a directed chain (A follows B follows C).

A chain can be missed even when one exists, because:
- GitHub's follower/following lists are paginated, and only a limited number of pages per account are checked.
- The search stops at a configurable maximum number of degrees.
- A single search may spend at most 400 GitHub requests (cached answers don't count).
- The search stops once the hourly rate limit runs out.

No result means none was found within those limits — not that no connection exists.

## Hosting on one shared token

Every visitor's searches spend the same token's 5,000 requests per hour, so the server protects it:

- **Disk cache.** Every GitHub response is kept in `.cache/github-cache.json` for up to 7 days and
  survives restarts. For the first hour it's served as-is; after that it's revalidated with its ETag, and
  GitHub doesn't charge for the `304 Not Modified` reply. Hub accounts show up in many different searches,
  so each is fetched once rather than once per search. A second identical search costs no requests.
- **Per-search budget.** One search stops after 400 real GitHub requests.
- **Per-IP limit.** One visitor IP can cause at most 1,000 GitHub requests per hour (`429` after that),
  and cached answers stay available to them.
- If GitHub itself runs out of quota or is unreachable, stale cached answers are served instead of errors.

Optional settings in `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_PER_IP_HOUR` | `1000` | GitHub requests one visitor IP may cause per hour |
| `CACHE_FILE` | `.cache/github-cache.json` | Where the cache is saved; set empty to keep it in memory only |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy so the per-IP limit sees the real visitor IP. Leave unset otherwise, or visitors could fake their IP. |

## Tests

```
npm test
```

Runs the search algorithm's unit tests (against a mocked API, on a small fake graph), the server's
username/page validation tests, and the cache, ETag-revalidation and per-IP-limit tests (GitHub stubbed).
