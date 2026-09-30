import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, JITTER } from '../public/animation/layout.js';
import { createPlayer, CATCH_UP_SECONDS } from '../public/animation/timeline.js';
import { buildDemoGraph, distances, demoGraph, DEMO_PAIR, DEMO_SEED, createDemoFetch } from '../public/animation/demo-graph.js';
import { findConnection } from '../public/search.js';

// ---- Layout ----

let demoTimeline;
async function demoEvents() {
  demoTimeline ??= (await findConnection(DEMO_PAIR.source, DEMO_PAIR.target, {
    fetchJson: createDemoFetch({ delayMs: 0 }),
    maxPages: 3,
  })).timeline;
  return demoTimeline;
}

function layoutFor(events, w = 1200, h = 675) {
  const layout = createLayout(w, h);
  for (const ev of events) if (ev.type === 'discover') layout.place(ev);
  return layout;
}

test('layout: the same search always gives the same picture', async () => {
  const events = (await demoEvents()).filter((e) => e.type === 'discover');
  const a = layoutFor(events);
  const b = layoutFor(events);
  // Order of arrival doesn't matter either, as long as parents come first.
  const byDepth = [...events].sort((x, y) => x.depth - y.depth || y.login.localeCompare(x.login));
  const c = layoutFor(byDepth);
  for (const ev of events) {
    assert.deepEqual(a.pos(ev.side, ev.login), b.pos(ev.side, ev.login));
    assert.deepEqual(a.pos(ev.side, ev.login), c.pos(ev.side, ev.login));
  }
});

test('layout: the source sits at 25% and the target at 75% of the width, vertically centred', async () => {
  const events = await demoEvents();
  const layout = layoutFor(events, 1000, 600);
  assert.deepEqual(layout.origin('source'), { x: 250, y: 300 });
  assert.deepEqual(layout.origin('target'), { x: 750, y: 300 });
  assert.deepEqual(layout.pos('source', DEMO_PAIR.source), { x: 250, y: 300 });
  assert.deepEqual(layout.pos('target', DEMO_PAIR.target), { x: 750, y: 300 });
  // Resizing moves them with the canvas.
  layout.resize(500, 300);
  assert.deepEqual(layout.pos('target', DEMO_PAIR.target), { x: 375, y: 150 });
});

test('layout: nodes at depth d lie on ring d, and children stay in their parent\'s slot', async () => {
  const events = await demoEvents();
  const layout = layoutFor(events);
  const discovers = events.filter((e) => e.type === 'discover' && e.depth > 0);
  assert.ok(discovers.length > 100);
  for (const ev of discovers) {
    const p = layout.pos(ev.side, ev.login);
    const o = layout.origin(ev.side);
    const unit = layout.ring(ev.side, 1); // one ring's radii
    const r = Math.hypot((p.x - o.x) / unit.rx, (p.y - o.y) / unit.ry);
    assert.ok(Math.abs(r - ev.depth) <= JITTER + 1e-9, `${ev.login} at depth ${ev.depth} sits at ring ${r.toFixed(2)}`);
    if (ev.depth > 1) {
      const me = layout.polarOf(ev.side, ev.login);
      const parent = layout.polarOf(ev.side, ev.parent);
      assert.ok(Math.abs(me.angle - parent.angle) <= parent.slot / 2 + 1e-9);
    }
  }
});

// ---- Timeline player ----

function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// A made-up timeline: `rounds` rounds of `perRound` discoveries, 1 s apart.
function sampleTimeline(rounds = 3, perRound = 10) {
  const events = [{ type: 'start', t: 0 }];
  let t = 0;
  for (let r = 1; r <= rounds; r++) {
    t = r * 1000;
    events.push({ type: 'round', round: r, t });
    for (let i = 0; i < perRound; i++) events.push({ type: 'discover', login: `r${r}-${i}`, t: t + i * 10 });
  }
  events.push({ type: 'end', t: t + 500 });
  return events;
}

function setup() {
  const clock = fakeClock();
  const got = [];
  let resets = 0;
  const player = createPlayer({ now: clock.now, onEvent: (e) => got.push(e), onReset: () => { resets += 1; } });
  // Runs `ms` of frames at 60 fps.
  const run = (ms) => {
    for (let t = 0; t < ms; t += 16) {
      clock.advance(16);
      player.tick();
    }
  };
  return { clock, player, got, run, resets: () => resets };
}

test('player: replay plays events by their timestamps, and pause stops it', () => {
  const { player, got, run } = setup();
  player.load(sampleTimeline());
  run(500);
  assert.deepEqual(got.map((e) => e.type), ['start']); // round 1 is at 1 s
  run(700);
  assert.ok(got.some((e) => e.type === 'round'));
  player.pause();
  const count = got.length;
  run(3000);
  assert.equal(got.length, count, 'nothing plays while paused');
  player.play();
  run(6000);
  assert.equal(got.at(-1).type, 'end');
  assert.equal(player.state().done, true);
  assert.equal(player.state().playing, false);
});

test('player: speed scales replay time', () => {
  const slow = setup();
  const fast = setup();
  slow.player.load(sampleTimeline());
  fast.player.load(sampleTimeline());
  fast.player.setSpeed(4);
  slow.run(1200);
  fast.run(1200);
  assert.ok(fast.got.length > slow.got.length);
  fast.run(1000);
  assert.equal(fast.got.at(-1).type, 'end', 'a 3.5 s timeline finishes within ~1.2 s at 4x');
  const half = setup();
  half.player.load(sampleTimeline());
  half.player.setSpeed(0.5);
  half.run(1500);
  assert.deepEqual(half.got.map((e) => e.type), ['start'], 'at 0.5x round 1 (1 s) arrives after 2 s');
});

test('player: step plays to the next round and pauses there', () => {
  const { player, got } = setup();
  player.load(sampleTimeline(), { paused: true });
  player.stepRound();
  assert.deepEqual(got.map((e) => e.type), ['start', 'round']);
  assert.equal(player.state().playing, false);
  player.stepRound();
  assert.equal(got.at(-1).type, 'round');
  assert.equal(got.at(-1).round, 2);
  assert.equal(got.filter((e) => e.type === 'discover').length, 10, 'the rest of round 1 came first');
});

test('player: skip to end delivers everything, and restart replays from the start', () => {
  const { player, got, run, resets } = setup();
  player.load(sampleTimeline());
  player.skipToEnd();
  assert.equal(got.length, sampleTimeline().length);
  assert.equal(player.state().done, true);
  const before = resets();
  player.restart();
  assert.equal(resets(), before + 1);
  run(100);
  assert.equal(got.at(-1).type, 'start');
  assert.equal(player.state().playing, true);
});

test('player: live mode catches up with a burst within about 2 seconds', () => {
  const { player, got, run } = setup();
  player.startLive();
  // One burst of 1,000 events, as when a big page of followers comes back.
  for (let i = 0; i < 1000; i++) player.push({ type: 'discover', login: `u${i}`, t: 0 });
  run(300);
  assert.ok(got.length > 0 && got.length < 1000, 'it is drained smoothly, not all at once');
  run(CATCH_UP_SECONDS * 1000 + 200);
  assert.equal(got.length, 1000, 'the backlog is cleared within the catch-up window');
});

test('player: in live mode a quiet trickle plays at the base pace', () => {
  const { player, got, run } = setup();
  player.startLive();
  player.push({ type: 'discover', login: 'a', t: 0 });
  player.push({ type: 'discover', login: 'b', t: 0 });
  run(200);
  assert.equal(got.length, 2);
  // A step during a live search waits for the next round to arrive.
  player.stepRound();
  player.push({ type: 'discover', login: 'c', t: 0 });
  player.push({ type: 'round', round: 2, t: 0 });
  player.push({ type: 'discover', login: 'd', t: 0 });
  run(100);
  assert.equal(got.at(-1).type, 'round');
  assert.equal(player.state().playing, false);
});

// ---- Demo graph ----

test('demo graph: the same seed builds the same network', () => {
  const again = buildDemoGraph(DEMO_SEED);
  assert.deepEqual(again.logins, demoGraph.logins);
  assert.deepEqual([...again.following], [...demoGraph.following]);
  const other = buildDemoGraph(DEMO_SEED + 1);
  assert.notDeepEqual([...other.following], [...demoGraph.following]);
});

test('demo graph: about 2,000 people, all connected, with a few hubs', () => {
  assert.equal(demoGraph.logins.length, 2000);
  assert.equal(new Set(demoGraph.logins).size, 2000);
  assert.equal(distances(demoGraph, demoGraph.logins[0]).size, 2000);
  const degree = (l) => demoGraph.following.get(l).length + demoGraph.followers.get(l).length;
  const typical = degree(DEMO_PAIR.source);
  for (const hub of demoGraph.hubs) assert.ok(degree(hub) > typical * 4, `${hub} is a hub`);
});

test('demo graph: the demo pair is at least 4 degrees apart', () => {
  const d = distances(demoGraph, DEMO_PAIR.source).get(DEMO_PAIR.target);
  assert.equal(d, DEMO_PAIR.degrees);
  assert.ok(d >= 4 && d <= 5);
});
