// Audition keyboard dock: play notes on the device from the browser so edits can be heard
// without leaving the editor. Computer keys Z..M / Q..U also play notes. The test patterns
// (../patterns.js) loop chord progressions, arpeggios, bass lines, melodies, runs, glides or a
// drum beat in the chosen key and scale, so parameters can be changed while something plays.

import { icon } from './icons.js';
import { h, clear } from './dom.js';
import { noteName } from '../music.js';
import { buildPattern, PATTERNS, KEYS, SCALES, PROGRESSIONS } from '../patterns.js';

const BLACK = new Set([1, 3, 6, 8, 10]);
const KEYMAP = 'zsxdcvgbhnjmq2w3er5t6y7ui';
const PREFS_KEY = 'midimaster.pattern';

// The patterns themselves (chord progressions, arpeggios, bass, melody, runs, glides, drums in any
// key and scale) come from ../patterns.js.
export { buildPattern, DRUM_NOTES } from '../patterns.js';

function loadPrefs(bpm = 120) {
  const base = { bpm, pattern: 'all', drumChannel: 9, key: 0, scale: 'major', progression: 'pop' };
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
    title: 'Loop a test pattern on the audition channel: a chord progression, arpeggio, bass line, melody, a band of all three, a scale run or glides (overlapping notes, so a mono sound with portamento or legato slides between them), in the key and scale chosen; or a drum beat on the General MIDI drum notes (drum channel).',
    onclick: () => (player.playing ? stopPattern() : playPattern()),
  }, icon('play'), h('span', 'Pattern'));
  const patSel = h('select', {
    title: 'Which part of the test pattern to loop',
    onchange: () => { prefs.pattern = patSel.value; savePrefs(); showDrumCh(); restart(); },
  }, Object.entries(PATTERNS).map(([k, p]) => h('option', { value: k, selected: k === prefs.pattern }, p.label)));
  // key, scale and chord progression of the tonal patterns
  const restart = () => { if (player.playing) { stopPattern(); playPattern(); } };
  const keySel = h('select', { title: 'Key of the pattern', onchange: () => { prefs.key = Number(keySel.value); savePrefs(); restart(); } },
    KEYS.map((k, i) => h('option', { value: i, selected: i === prefs.key }, k)));
  const scaleSel = h('select', { title: 'Scale: the melody, runs and the chords built on it', onchange: () => { prefs.scale = scaleSel.value; savePrefs(); restart(); } },
    Object.entries(SCALES).map(([k, x]) => h('option', { value: k, selected: k === prefs.scale }, x.label)));
  const progSel = h('select', { title: 'Chord progression (scale degrees)', onchange: () => { prefs.progression = progSel.value; savePrefs(); restart(); } },
    Object.entries(PROGRESSIONS).map(([k, x]) => h('option', { value: k, selected: k === prefs.progression }, x.label)));
  // The drum beat plays on its own channel (10 by default), whatever the audition channel is.
  const drumChSel = h('select', {
    title: 'MIDI channel for the drum beat (General MIDI drums are on channel 10)',
    onchange: () => { prefs.drumChannel = Number(drumChSel.value); savePrefs(); player.drumChannel = prefs.drumChannel; },
  }, Array.from({ length: 16 }, (_, i) => h('option', { value: i, selected: i === prefs.drumChannel }, `Drums ch ${i + 1}`)));
  const showDrumCh = () => {
    drumChSel.hidden = !PATTERNS[prefs.pattern]?.drums;
    const atonal = !!PATTERNS[prefs.pattern]?.atonal;
    keySel.hidden = atonal; scaleSel.hidden = atonal;
    progSel.hidden = atonal || ['run', 'glide'].includes(prefs.pattern);
  };
  showDrumCh();
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
    const ch = ev.drum ? player.drumChannel : player.channel;
    if (ev.on) {
      const note = Math.max(0, Math.min(127, ev.abs ? ev.n : (state.octave + 1) * 12 + ev.n));
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

  /** Start the pattern; `name` picks one (e.g. 'drums'), `opts.channel` the drum beat's channel. */
  function playPattern(name, opts = {}) {
    if (typeof name === 'string' && PATTERNS[name]) {
      if (player.playing) stopPattern();
      prefs.pattern = name; patSel.value = name;
      if (PATTERNS[name].drums && opts.channel !== undefined) { prefs.drumChannel = opts.channel; drumChSel.value = String(opts.channel); }
      savePrefs(); showDrumCh();
    }
    if (player.playing) return;
    if (!app.connected) { app.error(new Error('Connect a MIDI output first'), 'Pattern'); return; }
    const { events, beats } = buildPattern(prefs.pattern, { key: prefs.key, scale: prefs.scale, progression: prefs.progression });
    Object.assign(player, { flat: events, beats, channel: state.channel, drumChannel: prefs.drumChannel, pos: 0, anchorTime: performance.now() + 60, anchorBeat: 0, lastAt: 0, playing: true });
    playBtn.replaceChildren(icon('stop'), h('span', 'Stop'));
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
    playBtn.replaceChildren(icon('play'), h('span', 'Pattern'));
    playBtn.classList.remove('playing');
  }

  const bar = h('div.kbd-bar',
    h('strong', 'Audition'), chanSel,
    h('span', 'Vel'), vel, velOut,
    h('button.icon-btn', { onclick: () => shift(-1) }, 'Oct -'), octOut, h('button.icon-btn', { onclick: () => shift(1) }, 'Oct +'),
    h('span.pat-ctl', playBtn, patSel, keySel, scaleSel, progSel, drumChSel, bpmInp, h('span', 'BPM')),
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
    /** Play the drum beat on `channel` (0-15); a second call with the same channel stops it. */
    toggleDrums(channel) {
      if (player.playing && prefs.pattern === 'drums' && player.drumChannel === channel) { stopPattern(); return false; }
      playPattern('drums', { channel });
      return true;
    },
    get playing() { return player.playing; },
  };
}
