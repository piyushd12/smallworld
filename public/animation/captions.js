// Narrates the search in plain words under the animation, and keeps the live
// counters for each side. Captions go to an aria-live region, so they are
// spaced at least a second apart; if they pile up, the newest ones win.

const MIN_GAP_MS = 1000;
const QUEUE = 2;

const fmt = (n) => n.toLocaleString('en-US');
const people = (n) => `${fmt(n)} ${n === 1 ? 'person' : 'people'}`;

export function createCaptions({ caption, names, counters, now = () => performance.now() }) {
  let queue = [];
  let timer = null;
  let lastAt = -Infinity;
  let state;

  function reset() {
    queue = [];
    clearTimeout(timer);
    timer = null;
    caption.textContent = '';
    state = {
      names: { source: '', target: '' },
      perDepth: { source: new Map(), target: new Map() },
      // Collaboration mode: "side:depth" -> Map(repo -> people found through it).
      reposAt: new Map(),
      collab: false,
      total: { source: 0, target: 0 },
      depth: { source: 0, target: 0 },
      round: null, // the round being built, summarised when the next one starts
      maxDegrees: 6,
    };
    for (const side of ['source', 'target']) updateCounter(side);
  }

  function pump() {
    if (timer || !queue.length) return;
    timer = setTimeout(() => {
      timer = null;
      caption.textContent = queue.shift();
      lastAt = now();
      pump();
    }, Math.max(0, lastAt + MIN_GAP_MS - now()));
  }

  function say(text) {
    queue.push(text);
    if (queue.length > QUEUE) queue.shift();
    pump();
  }

  function updateCounter(side) {
    counters[side].textContent = `${people(state.total[side])} found · depth ${state.depth[side]}`;
  }

  const who = (side) => `@${state.names[side]}`;

  function summariseRound() {
    const r = state.round;
    if (!r) return;
    state.round = null;
    const n = state.perDepth[r.side].get(r.depth) ?? 0;
    const steps = `${r.depth} step${r.depth === 1 ? '' : 's'}`;
    say(n ? `Found ${fmt(n)} new ${n === 1 ? 'person' : 'people'} at ${steps} from ${who(r.side)}${throughRepos(r)}.`
      : `No one new at ${steps} from ${who(r.side)}.`);
  }

  // " through pallets/flask", or " through pallets/flask and 3 other repos", naming the busiest repo.
  function throughRepos(r) {
    const repos = state.reposAt.get(`${r.side}:${r.depth}`);
    if (!repos?.size) return '';
    const [top] = [...repos].sort((a, b) => b[1] - a[1])[0];
    const others = repos.size - 1;
    return ` through ${top}${others ? ` and ${fmt(others)} other ${others === 1 ? 'repo' : 'repos'}` : ''}`;
  }

  function apply(ev) {
    switch (ev.type) {
      case 'start':
        reset();
        state.names = { source: ev.source, target: ev.target };
        state.maxDegrees = ev.maxDegrees ?? 6;
        state.collab = ev.link === 'collab';
        say(`Two searches start at once, one from @${ev.source} and one from @${ev.target}. Each round, one of them takes a step outward.`);
        break;
      case 'discover': {
        const { side, depth } = ev;
        if (depth === 0) {
          state.names[side] = ev.login;
          names[side].textContent = `@${ev.login}`;
        } else {
          state.total[side] += 1;
          state.perDepth[side].set(depth, (state.perDepth[side].get(depth) ?? 0) + 1);
          if (ev.edge?.repo) {
            const key = `${side}:${depth}`;
            if (!state.reposAt.has(key)) state.reposAt.set(key, new Map());
            const repos = state.reposAt.get(key);
            repos.set(ev.edge.repo, (repos.get(ev.edge.repo) ?? 0) + 1);
          }
        }
        state.depth[side] = Math.max(state.depth[side], depth);
        updateCounter(side);
        break;
      }
      case 'round': {
        summariseRound();
        state.round = { side: ev.side, depth: ev.depth };
        if (ev.extra) {
          say('Fewer than 3 independent routes so far, so the search looks one degree further for alternative routes.');
          break;
        }
        const mine = ev.estimatedCost;
        const theirs = ev.otherSideCost;
        const name = who(ev.side);
        const whose = name.endsWith('s') ? `${name}'` : `${name}'s`;
        // In collaboration mode the cost is an estimate of repos, not people.
        const work = (n) => (state.collab ? `about ${fmt(n)} ${n === 1 ? 'repo' : 'repos'}` : people(n));
        say(mine === theirs
          ? `Round ${ev.round}: expanding ${whose} side. Both sides have ${work(mine)} to check, so the source goes first.`
          : `Round ${ev.round}: expanding ${whose} side, because it's cheaper (${work(mine)} to check vs ${fmt(theirs)}).`);
        break;
      }
      case 'meet':
        summariseRound();
        say(`The waves met at @${ev.login}, so the chain is ${ev.sourceDepth + ev.targetDepth} ${state.collab ? 'collaboration steps' : 'degrees'} long.`);
        break;
      case 'chains':
        summariseRound();
        if (ev.gatekeepers.length) say(`Every route goes through @${ev.gatekeepers[0]}.`);
        else if (ev.chains.length > 1) say(`Here are ${ev.chains.length} different chains, drawn one after the other.`);
        break;
      case 'end':
        if (ev.found) break; // the meeting and chains captions say it best
        summariseRound();
        say(endCaption(ev));
        break;
      default:
        break;
    }
  }

  function endCaption(ev) {
    switch (ev.reason) {
      case 'max-degrees':
        return `The waves didn't meet within ${state.maxDegrees} degrees, so the search stopped.`;
      case 'rate-limit':
        return 'The search ran out of GitHub requests before the waves met.';
      case 'stopped':
        return 'Search stopped before the waves met.';
      case 'dead-end':
        return 'One side ran out of people to check before the waves could meet.';
      default:
        return 'The search hit an error before the waves met.';
    }
  }

  reset();
  return { apply, reset };
}
