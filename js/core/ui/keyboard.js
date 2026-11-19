// Audition keyboard dock: play notes on the K2000 from the browser so edits can be
// heard without leaving the editor. Computer keys Z..M / Q..U also play notes.
// The test pattern loops a chord, a run of notes and two glides (overlapping notes)
// so parameters can be changed while something is playing.

import { h, clear } from './dom.js';
import { noteName } from '../music.js';

const BLACK = new Set([1, 3, 6, 8, 10]);
const KEYMAP = 'zsxdcvgbhnjmq2w3er5t6y7ui';
const PREFS_KEY = 'midimaster.pattern';

// Times and durations in beats, notes in semitones above C of the keyboard octave.
// One bar per section; the glide section is two bars.
const SECTIONS = {
  chord: { label: 'Chord', beats: 4, notes: [0, 4, 7, 11].map((n) => ({ t: 0, d: 3.5, n: 12 + n, v: 0.9 })) },
  run: {
    label: 'Note run', beats: 4,
    notes: [0, 2, 4, 7, 9, 7, 4, 2].map((n, i) => ({ t: i * 0.5, d: 0.4, n: 12 + n, v: i % 2 ? 0.8 : 1 })),
  },
  glide: {
    label: 'Glide', beats: 8,
    // Each second note starts half a beat before the first one ends, which a mono
    // program with portamento or legato plays as a glide.
    notes: [
      { t: 0, d: 2.5, n: 0, v: 1 }, { t: 2, d: 1.75, n: 7, v: 1 },
      { t: 4, d: 2.5, n: 12, v: 1 }, { t: 6, d: 1.75, n: 0, v: 1 },
    ],
  },
};
const PATTERNS = {
  all: { label: 'Chord + run + glide', parts: ['chord', 'run', 'glide'] },
  chord: { label: 'Chord', parts: ['chord'] },
  run: { label: 'Note run', parts: ['run'] },
  glide: { label: 'Glide', parts: ['glide'] },
};

/** Flatten a pattern into note-on/off events sorted by beat. Exported for tests. */
export function buildPattern(name = 'all') {
  const events = [];
  let offset = 0;
  let id = 0;
  for (const part of (PATTERNS[name] || PATTERNS.all).parts) {
    const sec = SECTIONS[part];
    for (const nt of sec.notes) {
      events.push({ beat: offset + nt.t, on: true, id, n: nt.n, v: nt.v });
      events.push({ beat: offset + nt.t + nt.d, on: false, id, n: nt.n });
      id++;
    }
    offset += sec.beats;
  }
  // Note-offs first when times are equal so repeated notes never hang.
  events.sort((a, b) => a.beat - b.beat || Number(a.on) - Number(b.on));
  return { events, beats: offset };
}

function loadPrefs(bpm = 120) {
  const base = { bpm, pattern: 'all' };
  try { return { ...base, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return base; }
}

export function mountKeyboard(container, app, defaults = {}) {
  const state = { octave: defaults.octave ?? 3, velocity: defaults.velocity ?? 100, channel: defaults.channel ?? 0, held: new Map(), range: null, open: true };
  const prefs = loadPrefs(defaults.patternBpm);
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };
  const kbd = h('div.kbd');
  const chanSel = h('select', { onchange: () => { state.channel = Number(chanSel.value); } },
    Array.from({ length: 16 }, (_, i) => h('option', { value: i }, `Ch ${i + 1}`)));
  const vel = h('input', { type: 'range', min: 1, max: 127, value: state.velocity, oninput: () => { state.velocity = Number(vel.value); velOut.textContent = vel.value; } });
  const velOut = h('span.mono', String(state.velocity));
  const octOut = h('span.mono');
  const toggle = h('button.icon-btn', { onclick: () => { state.open = !state.open; kbd.classList.toggle('hidden', !state.open); toggle.textContent = state.open ? 'Hide' : 'Keyboard'; } }, 'Hide');

  // ------------------------------------------------------------ test pattern
  const LOOKAHEAD_MS = 150;
  const TICK_MS = 25;
  const player = { playing: false, timer: null, flat: null, beats: 16, pos: 0, anchorTime: 0, anchorBeat: 0, sounding: new Map(), timeouts: new Set(), lastAt: 0 };
  const msPerBeat = () => 60000 / prefs.bpm;

  const playBtn = h('button.icon-btn', {
    title: 'Loop a test pattern on the audition channel: a chord, a run of notes and two glides. The glide bars play overlapping notes, so a mono program with portamento or legato slides between them.',
    onclick: () => (player.playing ? stopPattern() : playPattern()),
  }, '▶ Pattern');
  const patSel = h('select', {
    title: 'Which part of the test pattern to loop',
    onchange: () => { prefs.pattern = patSel.value; savePrefs(); if (player.playing) { stopPattern(); playPattern(); } },
  }, Object.entries(PATTERNS).map(([k, p]) => h('option', { value: k, selected: k === prefs.pattern }, p.label)));
  const bpmInp = h('input', {
    type: 'number', min: 30, max: 300, value: prefs.bpm, title: 'Tempo in beats per minute',
    onchange: () => {
      const v = Math.max(30, Math.min(300, Number(bpmInp.value) || 120));
      bpmInp.value = v;
      if (player.playing) {
        // Keep the current position when the tempo changes.
        const now = performance.now();
        player.anchorBeat = player.anchorBeat + (now - player.anchorTime) / msPerBeat();
        player.anchorTime = now;
      }
      prefs.bpm = v; savePrefs();
    },
  });

  function later(fn, at) {
    const id = setTimeout(() => { player.timeouts.delete(id); fn(); }, Math.max(0, at - performance.now()));
    player.timeouts.add(id);
  }

  function fire(ev, at) {
    const ch = state.channel;
    if (ev.on) {
      const note = Math.max(0, Math.min(127, (state.octave + 1) * 12 + ev.n));
      const velocity = Math.max(1, Math.min(127, Math.round(state.velocity * ev.v)));
      player.sounding.set(ev.id, { note, ch });
      app.client.sendAt([0x90 | ch, note, velocity], at);
      later(() => keys[note]?.classList.add('pat'), at);
    } else {
      const s = player.sounding.get(ev.id);
      if (!s) return;
      player.sounding.delete(ev.id);
      app.client.sendAt([0x80 | s.ch, s.note, 0], at);
      later(() => keys[s.note]?.classList.remove('pat'), at);
    }
    player.lastAt = Math.max(player.lastAt, at);
  }

  function tick() {
    const now = performance.now();
    // Background tabs only run timers about once a second, so look further ahead there.
    const horizon = now + (document.hidden ? 1500 : LOOKAHEAD_MS);
    const { flat } = player;
    for (let guard = 0; guard < 512; guard++) {
      const ev = flat[player.pos % flat.length];
      const cycle = Math.floor(player.pos / flat.length);
      const at = player.anchorTime + (cycle * player.beats + ev.beat - player.anchorBeat) * msPerBeat();
      if (at > horizon) break;
      try { fire(ev, Math.max(at, now)); } catch (err) { stopPattern(); app.error(err, 'Pattern'); return; }
      player.pos++;
    }
  }

  function playPattern() {
    if (player.playing) return;
    if (!app.connected) { app.error(new Error('Connect a MIDI output first'), 'Pattern'); return; }
    const { events, beats } = buildPattern(prefs.pattern);
    Object.assign(player, { flat: events, beats, pos: 0, anchorTime: performance.now() + 60, anchorBeat: 0, lastAt: 0, playing: true });
    playBtn.textContent = '■ Stop';
    playBtn.classList.add('playing');
    tick();
    player.timer = setInterval(tick, TICK_MS);
  }

  function stopPattern() {
    if (!player.playing) return;
    player.playing = false;
    clearInterval(player.timer);
    for (const id of player.timeouts) clearTimeout(id);
    player.timeouts.clear();
    const out = app.transport.output;
    try { out?.clear?.(); } catch { /* not supported */ }
    const now = performance.now();
    for (const { note, ch } of player.sounding.values()) {
      try {
        app.client.sendNow([0x80 | ch, note, 0]);
        // A note-on scheduled inside the lookahead window may still be delivered.
        if (player.lastAt > now) app.client.sendAt([0x80 | ch, note, 0], player.lastAt + 2);
      } catch { /* disconnected */ }
    }
    player.sounding.clear();
    for (const k of kbd.querySelectorAll('.pat')) k.classList.remove('pat');
    playBtn.textContent = '▶ Pattern';
    playBtn.classList.remove('playing');
  }

  const bar = h('div.kbd-bar',
    h('strong', 'Audition'), chanSel,
    h('span', 'Vel'), vel, velOut,
    h('button.icon-btn', { onclick: () => shift(-1) }, 'Oct -'), octOut, h('button.icon-btn', { onclick: () => shift(1) }, 'Oct +'),
    h('span.pat-ctl', playBtn, patSel, bpmInp, h('span', 'BPM')),
    h('span.grow'), h('span.small', 'Computer keys: Z-M, Q-U'), toggle);
  clear(container).append(bar, kbd);

  const keys = [];
  function build() {
    clear(kbd);
    keys.length = 0;
    const first = 24;
    const last = 108;
    const whites = [];
    for (let n = first; n <= last; n++) if (!BLACK.has(n % 12)) whites.push(n);
    const ww = 100 / whites.length;
    let wi = 0;
    for (let n = first; n <= last; n++) {
      const black = BLACK.has(n % 12);
      const el = h('div.' + (black ? 'bk' : 'wk'), { title: `${noteName(n)} (${n})`, dataset: { note: n } });
      if (black) { el.style.left = `calc(${wi * ww}% - ${ww * 0.32}%)`; el.style.width = `${ww * 0.64}%`; } else { el.style.left = `${wi * ww}%`; el.style.width = `${ww}%`; wi++; }
      if (state.range && n >= state.range[0] && n <= state.range[1]) el.classList.add('in-range');
      keys[n] = el;
      kbd.appendChild(el);
    }
    octOut.textContent = `C${state.octave}`;
  }

  function noteOn(n) {
    if (state.held.has(n)) return;
    state.held.set(n, state.channel);
    keys[n]?.classList.add('on');
    try { app.client.noteOn(state.channel, n, state.velocity); } catch { /* not connected */ }
  }
  function noteOff(n) {
    if (!state.held.has(n)) return;
    const ch = state.held.get(n);
    state.held.delete(n);
    keys[n]?.classList.remove('on');
    try { app.client.noteOff(ch, n); } catch { /* not connected */ }
  }
  function shift(d) { state.octave = Math.max(0, Math.min(7, state.octave + d)); octOut.textContent = `C${state.octave}`; }

  let dragNote = null;
  kbd.addEventListener('pointerdown', (e) => {
    const n = Number(e.target.dataset.note);
    if (!n) return;
    kbd.setPointerCapture(e.pointerId);
    dragNote = n; noteOn(n);
  });
  kbd.addEventListener('pointermove', (e) => {
    if (dragNote === null) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const n = Number(t?.dataset?.note);
    if (n && n !== dragNote) { noteOff(dragNote); dragNote = n; noteOn(n); }
  });
  const end = () => { if (dragNote !== null) { noteOff(dragNote); dragNote = null; } };
  kbd.addEventListener('pointerup', end);
  kbd.addEventListener('pointercancel', end);

  const typing = (e) => e.target.closest('input, textarea, select, [contenteditable]');
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
    if (app.keyboardSettings && app.keyboardSettings().computerKeys === false) return;
    const i = KEYMAP.indexOf(e.key.toLowerCase());
    if (i >= 0) noteOn((state.octave + 1) * 12 + i);
  });
  window.addEventListener('keyup', (e) => {
    const i = KEYMAP.indexOf(e.key.toLowerCase());
    if (i >= 0) noteOff((state.octave + 1) * 12 + i);
  });
  window.addEventListener('pagehide', stopPattern);

  build();
  return {
    setChannel(ch) { state.channel = ch; chanSel.value = String(ch); },
    highlight(range) { state.range = range; build(); },
    allOff() { stopPattern(); for (const n of [...state.held.keys()]) noteOff(n); },
    playPattern,
    stopPattern,
    get playing() { return player.playing; },
  };
}
