// Audition patterns: chord progressions, arpeggios, bass lines, melodies, scale runs, glides and a
// GM drum beat, generated in any key and scale so a sound can be heard in a musical context while it
// is edited. Pure functions (no DOM, no MIDI); js/core/ui/keyboard.js plays the result.
//
// buildPattern(name, {key, scale, progression}) -> {events, beats}
//   events: [{beat, on: true, id, n, v, abs, drum, part} | {beat, on: false, id, n}] sorted by beat
//   part: chords, arp, bass, melody, run, glide or drums
//   n: semitones above C of the keyboard octave (abs: an absolute note number, drums)
//   drum: play on the drum channel; v: velocity factor 0..1

export const KEYS = ['C', 'C#/Db', 'D', 'D#/Eb', 'E', 'F', 'F#/Gb', 'G', 'G#/Ab', 'A', 'A#/Bb', 'B'];

// Melody notes, and the seven-note scale chords are built from (pentatonic and blues scales borrow
// the chords of their parent mode).
export const SCALES = {
  major: { label: 'Major', notes: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Natural minor', notes: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: 'Dorian', notes: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { label: 'Mixolydian', notes: [0, 2, 4, 5, 7, 9, 10] },
  lydian: { label: 'Lydian', notes: [0, 2, 4, 6, 7, 9, 11] },
  phrygian: { label: 'Phrygian', notes: [0, 1, 3, 5, 7, 8, 10] },
  harmonicMinor: { label: 'Harmonic minor', notes: [0, 2, 3, 5, 7, 8, 11] },
  melodicMinor: { label: 'Melodic minor', notes: [0, 2, 3, 5, 7, 9, 11] },
  majorPentatonic: { label: 'Major pentatonic', notes: [0, 2, 4, 7, 9], parent: 'major' },
  minorPentatonic: { label: 'Minor pentatonic', notes: [0, 3, 5, 7, 10], parent: 'minor' },
  blues: { label: 'Blues', notes: [0, 3, 5, 6, 7, 10], parent: 'minor' },
};

// Chords as scale degrees (0 = the key's first degree). {d, s} adds the seventh; {d, q} forces a
// quality: '7' dominant seventh, 'maj' major, 'min' minor (e.g. the Andalusian cadence's major V).
const c = (d, extra = {}) => ({ d, ...extra });
export const PROGRESSIONS = {
  pop: { label: '1-5-6-4 (pop)', chords: [c(0), c(4), c(5), c(3)] },
  fifties: { label: '1-6-4-5 (fifties)', chords: [c(0), c(5), c(3), c(4)] },
  sensitive: { label: '6-4-1-5', chords: [c(5), c(3), c(0), c(4)] },
  jazz: { label: '2-5-1-6 (sevenths)', chords: [c(1, { s: true }), c(4, { s: true }), c(0, { s: true }), c(5, { s: true })] },
  canon: { label: 'Canon (8 chords)', chords: [c(0), c(4), c(5), c(2), c(3), c(0), c(3), c(4)] },
  andalusian: { label: 'Andalusian (1-7-6-5)', chords: [c(0), c(6), c(5), c(4, { q: 'maj' })] },
  circle: { label: 'Circle of fifths (sevenths)', chords: [0, 3, 6, 2, 5, 1, 4, 0].map((d) => c(d, { s: true })) },
  blues: { label: '12-bar blues', chords: [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4].map((d) => c(d, { q: '7' })) },
  vamp: { label: '1-4 vamp', chords: [c(0, { s: true }), c(3, { s: true }), c(0, { s: true }), c(3, { s: true })] },
  tour: { label: 'Tour (several progressions)', chords: null },
};
const TOUR = ['pop', 'jazz', 'andalusian', 'fifties'];

export const PATTERNS = {
  all: { label: 'Progression + run + glide' },
  chords: { label: 'Chord progression' },
  arp: { label: 'Arpeggio' },
  bass: { label: 'Bass line' },
  melody: { label: 'Melody over chords' },
  band: { label: 'Band: chords, bass, melody' },
  bandDrums: { label: 'Band with GM drums', drums: true },
  run: { label: 'Scale run' },
  glide: { label: 'Glide' },
  drums: { label: 'Drum beat (GM drums)', drums: true, atonal: true },
};

// General MIDI drum notes (absolute note numbers).
export const DRUM_NOTES = { kick: 36, rim: 37, snare: 38, clap: 39, lowTom: 45, midTom: 47, highTom: 50, closedHat: 42, openHat: 46, crash: 49, ride: 51 };

// ------------------------------------------------------------------ helpers
/** A small seeded random generator (mulberry32), so a setting always plays the same melody. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

function scaleOf(name) { return SCALES[name] || SCALES.major; }
function parentNotes(scale) { return (scale.parent ? SCALES[scale.parent] : scale).notes; }

/** Pitch classes of a chord (semitones above the key's root, rising). */
export function chordTones(chord, scaleName = 'major') {
  const p = parentNotes(scaleOf(scaleName));
  const at = (i) => p[i % 7] + 12 * Math.floor(i / 7);
  const root = at(chord.d);
  if (chord.q === '7') return [root, root + 4, root + 7, root + 10];
  if (chord.q === 'maj') return [root, root + 4, root + 7];
  if (chord.q === 'min') return [root, root + 3, root + 7];
  const tones = [root, at(chord.d + 2), at(chord.d + 4)];
  if (chord.s) tones.push(at(chord.d + 6));
  return tones;
}

/** The chords of a progression; "tour" strings several together. */
export function progressionChords(name) {
  if (name === 'tour') return TOUR.flatMap((k) => PROGRESSIONS[k].chords);
  return (PROGRESSIONS[name] || PROGRESSIONS.pop).chords;
}

/** Voice a chord near `center`, moving as little as possible from the previous voicing. */
function voice(tones, prev, center) {
  const cands = [];
  for (let inv = 0; inv < tones.length; inv++) {
    const v = tones.map((t, i) => t + (i < inv ? 12 : 0)).sort((a, b) => a - b);
    for (const shift of [-24, -12, 0, 12]) {
      const w = v.map((x) => x + shift);
      if (w[0] < center - 7 || w[0] > center + 6) continue;
      cands.push(w);
    }
  }
  const cost = (w) => (prev
    ? w.reduce((s, x, i) => s + Math.abs(x - (prev[Math.min(i, prev.length - 1)])), 0)
    : Math.abs(w[0] - center));
  cands.sort((a, b) => cost(a) - cost(b));
  return cands[0] || tones;
}

// ------------------------------------------------------------------ parts (one note list each)
// note: {t, d, n, v} in beats; parts are laid out bar by bar over the chords.

const RHYTHMS = [
  [[0, 3.8, 0.85]], // whole
  [[0, 1.9, 0.9], [2, 1.9, 0.75]], // half notes
  [[0, 1.4, 0.95], [1.5, 0.9, 0.7], [3, 0.9, 0.75]], // Charleston
  [[0, 0.4, 0.95], [0.5, 0.35, 0.6], [1.5, 0.35, 0.7], [2.5, 0.4, 0.8], [3.5, 0.35, 0.65]], // stabs
  [[0, 0.85, 0.9], [1, 0.85, 0.65], [2, 0.85, 0.8], [3, 0.85, 0.65]], // quarters
  [[0, 2.4, 0.9], [2.5, 0.4, 0.7], [3, 0.9, 0.75]], // long-short-short
];

function chordPart(chords, key, scale, { rhythms, center = 12, vel = 1 }) {
  const out = [];
  let prev = null;
  chords.forEach((ch, bar) => {
    const v = voice(chordTones(ch, scale).map((t) => t + key), prev, center + key);
    prev = v;
    const r = RHYTHMS[rhythms[bar % rhythms.length]];
    for (const [t, d, vv] of r) for (const n of v) out.push({ t: bar * 4 + t, d, n, v: vv * vel });
  });
  return out;
}

function arpPart(chords, key, scale, { center = 12 } = {}) {
  const out = [];
  let prev = null;
  chords.forEach((ch, bar) => {
    const v = voice(chordTones(ch, scale).map((t) => t + key), prev, center + key);
    prev = v;
    const up = [...v, v[0] + 12, v[1] + 12];
    const seq = [...up, ...up.slice(1, -1).reverse()];
    for (let k = 0; k < 16; k++) out.push({ t: bar * 4 + k * 0.25, d: 0.22, n: seq[k % seq.length], v: k % 4 === 0 ? 1 : 0.7 });
  });
  return out;
}

function bassPart(chords, key, scale, { busy = false } = {}) {
  const out = [];
  const p = parentNotes(scaleOf(scale));
  chords.forEach((ch, bar) => {
    const tones = chordTones(ch, scale);
    const root = ((tones[0] + key) % 12) - 12; // the octave below the keyboard octave's C
    const fifth = root + (tones[2] - tones[0]);
    const next = progressionNext(chords, bar);
    const nextRoot = ((chordTones(next, scale)[0] + key) % 12) - 12;
    const nr = nextRoot < root - 6 ? nextRoot + 12 : nextRoot > root + 6 ? nextRoot - 12 : nextRoot;
    // approach the next root from a scale step above or below
    const step = p.map((x) => ((x + key) % 12) - 12).flatMap((x) => [x, x + 12, x - 12]);
    const approach = step.filter((x) => x !== nr && Math.abs(x - nr) <= 2).sort((a, b) => Math.abs(a - nr) - Math.abs(b - nr))[0] ?? nr + 1;
    const b = bar * 4;
    if (busy) {
      out.push({ t: b, d: 0.45, n: root, v: 1 }, { t: b + 0.75, d: 0.2, n: root, v: 0.6 }, { t: b + 1, d: 0.45, n: root + 12, v: 0.8 },
        { t: b + 2, d: 0.45, n: fifth, v: 0.9 }, { t: b + 2.75, d: 0.2, n: fifth, v: 0.6 }, { t: b + 3, d: 0.4, n: root, v: 0.8 }, { t: b + 3.5, d: 0.4, n: approach, v: 0.75 });
    } else {
      out.push({ t: b, d: 1.8, n: root, v: 1 }, { t: b + 2, d: 1.2, n: fifth, v: 0.85 }, { t: b + 3.5, d: 0.45, n: approach, v: 0.7 });
    }
  });
  return out;
}
function progressionNext(chords, bar) { return chords[(bar + 1) % chords.length]; }

function melodyPart(chords, key, scaleName, seed, { center = 26 } = {}) {
  const r = rng(seed);
  const scale = scaleOf(scaleName);
  // every pitch of the melody scale within two octaves around the center
  const pool = [];
  for (let o = -2; o <= 3; o++) for (const x of scale.notes) pool.push(x + key + 12 * o);
  const range = pool.filter((x) => x >= center - 7 && x <= center + 12).sort((a, b) => a - b);
  const nearest = (target, cands) => cands.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  const out = [];
  let cur = nearest(center, range);
  chords.forEach((ch, bar) => {
    const tones = chordTones(ch, scaleName).map((t) => (t + key) % 12);
    const chordNotes = range.filter((x) => tones.includes(((x % 12) + 12) % 12));
    const last = bar === chords.length - 1;
    let k = 0;
    while (k < 8) {
      const strong = k % 4 === 0;
      if (!strong && r() < 0.14) { k++; continue; } // a rest
      let n;
      if (last && k >= 4) n = nearest(cur, range.filter((x) => (((x - key) % 12) + 12) % 12 === 0)); // home
      else if (strong || r() < 0.35) n = nearest(cur + (r() < 0.5 ? -2 : 2), chordNotes.length ? chordNotes : range);
      else {
        const i = range.indexOf(nearest(cur, range));
        const move = r() < 0.7 ? (r() < 0.5 ? -1 : 1) : (r() < 0.5 ? -2 : 2);
        n = range[Math.max(0, Math.min(range.length - 1, i + move))];
      }
      const len = last && k >= 4 ? 8 - k : r() < 0.3 && k < 7 ? 2 : 1; // eighths, some quarters
      out.push({ t: bar * 4 + k * 0.5, d: len * 0.5 - 0.06, n, v: strong ? 0.95 : 0.75 + r() * 0.15 });
      cur = n;
      k += len;
    }
  });
  return out;
}

function runPart(key, scaleName) {
  const notes = scaleOf(scaleName).notes;
  const up = [];
  for (let o = 0; o < 2; o++) for (const x of notes) up.push(12 + key + x + 12 * o);
  up.push(12 + key + 24);
  const seq = [...up, ...up.slice(1, -1).reverse()];
  const steps = Math.min(seq.length, 32);
  return seq.slice(0, steps).map((n, i) => ({ t: i * 0.25, d: 0.22, n, v: i % 4 === 0 ? 1 : 0.75 }));
}

function glidePart(key, scaleName) {
  const p = parentNotes(scaleOf(scaleName));
  const root = key, fifth = key + p[4], third = key + 12 + p[2];
  // each second note starts half a beat before the first one ends: a mono sound with portamento
  // or legato slides between them
  return [
    { t: 0, d: 2.5, n: root, v: 1 }, { t: 2, d: 1.75, n: fifth, v: 1 },
    { t: 4, d: 2.5, n: root + 12, v: 1 }, { t: 6, d: 1.75, n: third, v: 1 },
  ];
}

const hit = (t, n, v = 1) => ({ t, d: 0.25, n, v });
function drumBar(b, n, fill) {
  const G = DRUM_NOTES;
  const out = [];
  if (n % 2 === 0) {
    out.push(hit(b, G.crash, n === 0 ? 1 : 0.6), hit(b, G.kick), hit(b + 2, G.kick, 0.9), hit(b + 2.5, G.kick, 0.8),
      hit(b + 1, G.snare), hit(b + 3, G.snare), hit(b + 3, G.clap, 0.8), hit(b + 1.75, G.rim, 0.5),
      ...[0, 0.5, 1, 1.5, 2, 2.5, 3].map((t, i) => hit(b + t, G.closedHat, i % 2 ? 0.6 : 0.9)), hit(b + 3.5, G.openHat, 0.8));
  } else {
    out.push(...[0, 0.5, 1, 1.5, 2, 2.5].map((t, i) => hit(b + t, G.ride, i % 2 ? 0.7 : 0.9)),
      hit(b, G.kick), hit(b + 1.5, G.kick, 0.8), hit(b + 2, G.kick, 0.9), hit(b + 1, G.snare), hit(b + 2.5, G.rim, 0.7));
    if (fill) out.push(hit(b + 3, G.highTom), hit(b + 3.25, G.highTom, 0.8), hit(b + 3.5, G.midTom, 0.9), hit(b + 3.75, G.lowTom));
    else out.push(hit(b + 3, G.snare, 0.9), hit(b + 3.5, G.closedHat, 0.7));
  }
  return out;
}
function drumPart(bars) {
  const out = [];
  for (let n = 0; n < bars; n++) out.push(...drumBar(n * 4, n, n === bars - 1 || n % 4 === 3));
  return out;
}

// ------------------------------------------------------------------ patterns
/** Flatten a pattern into note-on/off events sorted by beat. */
export function buildPattern(name = 'all', opts = {}) {
  const key = Math.max(0, Math.min(11, opts.key ?? 0));
  const scale = SCALES[opts.scale] ? opts.scale : 'major';
  const prog = PROGRESSIONS[opts.progression] ? opts.progression : 'pop';
  const chords = progressionChords(prog);
  const bars = chords.length;
  const seed = hash(`${key}:${scale}:${prog}`);
  const sections = []; // [{beats, notes, abs, drum}]
  const add = (beats, notes, extra = {}) => sections.push({ beats, notes, ...extra });
  const layer = (beats, parts) => sections.push({ beats, layers: parts });
  switch (PATTERNS[name] ? name : 'all') {
    case 'chords':
      // twice round: sustained, then comping rhythms
      add(bars * 4, chordPart(chords, key, scale, { rhythms: [0, 1] }), { part: 'chords' });
      add(bars * 4, chordPart(chords, key, scale, { rhythms: [2, 3, 5, 4] }), { part: 'chords' });
      break;
    case 'arp':
      add(bars * 4, arpPart(chords, key, scale), { part: 'arp' });
      break;
    case 'bass':
      add(bars * 4, bassPart(chords, key, scale), { part: 'bass' });
      add(bars * 4, bassPart(chords, key, scale, { busy: true }), { part: 'bass' });
      break;
    case 'melody':
      layer(bars * 4, [{ notes: chordPart(chords, key, scale, { rhythms: [0], vel: 0.6 }), part: 'chords' }, { notes: melodyPart(chords, key, scale, seed), part: 'melody' }]);
      layer(bars * 4, [{ notes: chordPart(chords, key, scale, { rhythms: [1], vel: 0.6 }), part: 'chords' }, { notes: melodyPart(chords, key, scale, seed + 1), part: 'melody' }]);
      break;
    case 'band':
    case 'bandDrums': {
      const drums = name === 'bandDrums';
      for (const pass of [0, 1]) {
        layer(bars * 4, [
          { notes: chordPart(chords, key, scale, { rhythms: pass ? [3, 2] : [1, 5], vel: 0.65 }), part: 'chords' },
          { notes: bassPart(chords, key, scale, { busy: pass === 1 }), part: 'bass' },
          { notes: melodyPart(chords, key, scale, seed + pass), part: 'melody' },
          ...(drums ? [{ notes: drumPart(bars), abs: true, drum: true, part: 'drums' }] : []),
        ]);
      }
      break;
    }
    case 'run':
      add(8, runPart(key, scale), { part: 'run' });
      break;
    case 'glide':
      add(8, glidePart(key, scale), { part: 'glide' });
      break;
    case 'drums':
      add(8, drumPart(2), { abs: true, drum: true, part: 'drums' });
      break;
    default: // 'all': the progression once, then a scale run and a glide
      add(bars * 4, chordPart(chords, key, scale, { rhythms: [0] }), { part: 'chords' });
      add(8, runPart(key, scale), { part: 'run' });
      add(8, glidePart(key, scale), { part: 'glide' });
  }
  const events = [];
  let offset = 0;
  let id = 0;
  for (const sec of sections) {
    for (const l of sec.layers || [{ notes: sec.notes, abs: sec.abs, drum: sec.drum, part: sec.part }]) {
      for (const nt of l.notes) {
        events.push({ beat: offset + nt.t, on: true, id, n: nt.n, v: Math.max(0.05, Math.min(1, nt.v)), abs: !!l.abs, drum: !!l.drum, part: l.part });
        events.push({ beat: offset + nt.t + nt.d, on: false, id, n: nt.n });
        id++;
      }
    }
    offset += sec.beats;
  }
  // note-offs first when times are equal, so repeated notes never hang
  events.sort((a, b) => a.beat - b.beat || Number(a.on) - Number(b.on));
  return { events, beats: offset };
}
