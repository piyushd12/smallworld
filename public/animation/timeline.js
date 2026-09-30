// Plays a search's events at a watchable pace.
//
// Live: the search pushes events as its answers come in, in bursts (one page
// of followers at a time). They are handed on at a steady rate, which rises
// with the backlog so the picture never trails the search by more than about
// two seconds.
// Replay: a finished timeline is released by its own timestamps, scaled by the
// speed, and smoothed the same way.
//
// `now` is injectable so tests can drive the player with a fake clock; the
// renderer calls tick() once per frame.

export const BASE_RATE = 40; // events per second at 1x when there is no backlog
export const CATCH_UP_SECONDS = 1.5; // a backlog is always cleared within this
const MAX_FRAME_SECONDS = 0.1; // a long gap (hidden tab) counts as one short frame

export function createPlayer({
  now = () => performance.now(),
  onEvent = () => {},
  onReset = () => {},
  onState = () => {},
} = {}) {
  let events = [];
  let cursor = 0; // next event to hand on
  let arrived = 0; // replay: events whose time has come
  let vt = 0; // replay clock, in timeline milliseconds
  let mode = 'live';
  let speed = 1;
  let playing = false;
  let rush = null; // 'round' or 'end': hand on events immediately until then
  let budget = 0; // events owed at the current rate
  let rate = 0; // events per second while a backlog lasts
  let last = null;

  const done = () => cursor >= events.length && events.at(-1)?.type === 'end';
  const state = () => ({ playing, speed, mode, done: done(), delivered: cursor, total: events.length });
  const changed = () => onState(state());

  function available() {
    if (mode === 'live') return events.length;
    while (arrived < events.length && events[arrived].t <= vt) arrived++;
    return arrived;
  }

  // Hands on one event; returns false when playback should stop here.
  function deliver() {
    const ev = events[cursor++];
    if (mode === 'replay') vt = Math.max(vt, ev.t);
    onEvent(ev);
    if (ev.type === 'round' && rush === 'round') {
      rush = null;
      playing = false;
      return false;
    }
    return true;
  }

  function begin(newMode) {
    onReset();
    mode = newMode;
    cursor = 0;
    arrived = 0;
    vt = 0;
    budget = 0;
    rate = 0;
    rush = null;
    last = now();
  }

  const player = {
    // Start a live search: events follow with push().
    startLive() {
      events = [];
      begin('live');
      playing = true;
      changed();
    },
    push(ev) {
      events.push(ev);
    },
    // Replay a finished timeline from the start.
    load(timeline, { paused = false } = {}) {
      events = [...timeline];
      begin('replay');
      playing = !paused;
      changed();
    },
    tick() {
      const t = now();
      const dt = last == null ? 0 : Math.min((t - last) / 1000, MAX_FRAME_SECONDS);
      last = t;
      if (!playing) return;
      vt += dt * 1000 * speed;

      let backlog = available() - cursor;
      if (rush) {
        while (backlog-- > 0 && deliver());
      } else if (backlog > 0) {
        // The rate only goes up while a backlog lasts: recomputing it from the
        // shrinking backlog would slow down forever and never catch up.
        rate = Math.max(rate, BASE_RATE * speed, backlog / CATCH_UP_SECONDS);
        budget += dt * rate;
        let n = Math.min(Math.floor(budget), backlog);
        budget -= n;
        while (n-- > 0 && deliver());
      } else {
        budget = 0; // don't save up for the next burst
        rate = 0;
      }
      if (done()) playing = false;
      changed();
    },
    play() {
      if (done()) return player.restart();
      playing = true;
      last = now();
      changed();
    },
    pause() {
      playing = false;
      changed();
    },
    toggle() {
      return playing ? player.pause() : player.play();
    },
    setSpeed(x) {
      speed = x;
      changed();
    },
    // Finish the current round and start the next one, then pause. In a live
    // search the next round may not have happened yet; it plays up to it.
    stepRound() {
      if (done()) return;
      rush = 'round';
      if (mode === 'replay') arrived = events.length;
      while (cursor < events.length && deliver());
      if (rush && !done()) playing = true; // still waiting for the next round
      else {
        rush = null;
        playing = false;
      }
      changed();
    },
    skipToEnd() {
      if (mode === 'replay') arrived = events.length;
      while (cursor < events.length) deliver();
      rush = done() ? null : 'end'; // live: keep up instantly until the end arrives
      playing = !done();
      changed();
    },
    restart() {
      begin('replay');
      playing = true;
      changed();
    },
    state,
  };
  return player;
}
