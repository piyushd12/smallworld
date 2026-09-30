// The "Watch the search" panel: wires the player, the canvas and the captions
// to the buttons and keyboard shortcuts in index.html.

import { createPlayer } from './timeline.js';
import { createRenderer } from './renderer.js';
import { createCaptions } from './captions.js';

const PAUSE_AFTER_END_MS = 700;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountWatch(section) {
  const $ = (id) => section.querySelector(`#${id}`);
  const stage = $('watch-stage');
  const playBtn = $('watch-play');
  const stepBtn = $('watch-step');
  const speedSelect = $('watch-speed');
  const restartBtn = $('watch-restart');
  const skipBtn = $('watch-skip');
  const fullscreenBtn = $('watch-fullscreen');
  const hubsToggle = $('watch-hubs');

  let onDone = null;
  let doneTimer = null;
  let finished = false; // the last animation has played out

  const captions = createCaptions({
    caption: $('watch-caption'),
    names: { source: $('watch-name-source'), target: $('watch-name-target') },
    counters: { source: $('watch-count-source'), target: $('watch-count-target') },
  });

  let player;
  const renderer = createRenderer($('watch-canvas'), {
    tooltip: $('watch-tooltip'),
    tick: () => player.tick(),
  });

  player = createPlayer({
    onEvent(ev) {
      renderer.apply(ev);
      captions.apply(ev);
      if (ev.type === 'end') {
        // Let the chain finish drawing before handing back to the page.
        clearTimeout(doneTimer);
        doneTimer = setTimeout(() => {
          finished = true;
          const cb = onDone;
          onDone = null;
          cb?.();
        }, renderer.settleMs() + (reducedMotion() ? 0 : PAUSE_AFTER_END_MS));
      }
    },
    onReset() {
      clearTimeout(doneTimer);
      finished = false;
      renderer.reset();
      captions.reset();
    },
    onState({ playing, done }) {
      playBtn.textContent = playing ? '❚❚ Pause' : done ? '↺ Play again' : '▶ Play';
      playBtn.setAttribute('aria-pressed', String(playing));
      stepBtn.disabled = done;
      skipBtn.disabled = done;
    },
  });

  function show({ linkProfiles = true } = {}) {
    section.hidden = false;
    renderer.setLinkProfiles(linkProfiles);
    renderer.refreshColors();
    renderer.start();
  }

  playBtn.addEventListener('click', () => player.toggle());
  stepBtn.addEventListener('click', () => player.stepRound());
  restartBtn.addEventListener('click', () => player.restart());
  skipBtn.addEventListener('click', () => player.skipToEnd());
  speedSelect.addEventListener('change', () => player.setSpeed(Number(speedSelect.value)));
  hubsToggle.addEventListener('change', () => renderer.setHubLabels(hubsToggle.checked));
  const zoomIn = () => renderer.zoomBy(1.4);
  const zoomOut = () => renderer.zoomBy(1 / 1.4);
  $('watch-zoom-in').addEventListener('click', zoomIn);
  $('watch-zoom-out').addEventListener('click', zoomOut);
  $('watch-fit').addEventListener('click', () => renderer.fit());

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.().catch(() => {});
  }
  fullscreenBtn.hidden = !document.fullscreenEnabled;
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.textContent = document.fullscreenElement === stage ? '⤡ Exit fullscreen' : '⤢ Fullscreen';
  });

  document.addEventListener('keydown', (e) => {
    if (section.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    // Leave keys alone while the user is typing or on a control that uses them.
    if (e.target.closest?.('input, textarea, select, button, summary, a')) return;
    const actions = {
      ' ': () => player.toggle(),
      ArrowRight: () => player.stepRound(),
      r: () => player.restart(),
      f: toggleFullscreen,
      '+': zoomIn,
      '=': zoomIn,
      '-': zoomOut,
      0: () => renderer.fit(),
      Escape: () => document.fullscreenElement && document.exitFullscreen(),
    };
    const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!action) return;
    e.preventDefault();
    action();
  });

  return {
    // A search is starting; its events follow through push().
    startLive({ linkProfiles = true } = {}) {
      onDone = null;
      show({ linkProfiles });
      player.startLive();
      // Reduced motion: no animation, each step is drawn as soon as it happens.
      if (reducedMotion()) player.skipToEnd();
    },
    push: (ev) => player.push(ev),
    // Plays a finished search again. With reduced motion it waits at the
    // start, so it can be stepped through one round at a time.
    replay(timeline, { linkProfiles = true } = {}) {
      onDone = null;
      show({ linkProfiles });
      player.load(timeline, { paused: reducedMotion() });
    },
    // Called once the current animation has finished (including the chain).
    whenDone(cb) {
      if (finished) cb();
      else onDone = cb;
    },
    hide() {
      onDone = null;
      clearTimeout(doneTimer);
      player.pause();
      renderer.stop();
      section.hidden = true;
    },
  };
}
