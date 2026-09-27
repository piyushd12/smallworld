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
- The search stops once the hourly rate limit runs out.

No result means none was found within those limits — not that no connection exists.

## Tests

```
npm test
```

Runs the search algorithm's unit tests (against a mocked API, on a small fake graph) and the server's
username/page validation tests.
