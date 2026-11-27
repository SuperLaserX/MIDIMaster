// Audition patterns (js/core/patterns.js): progressions, voicings, keys and scales, drums.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPattern, PATTERNS, SCALES, PROGRESSIONS, chordTones, progressionChords } from '../js/core/patterns.js';

const ons = (p) => p.events.filter((e) => e.on);
const pc = (n) => ((n % 12) + 12) % 12;
const mel0 = () => buildPattern('melody', { key: 0, scale: 'major', progression: 'pop' });

test('Patterns: every pattern in every key builds a clean loop', () => {
  for (const name of Object.keys(PATTERNS)) {
    for (const key of [0, 5, 11]) {
      const p = buildPattern(name, { key, scale: 'minor', progression: 'canon' });
      assert.ok(p.beats > 0 && ons(p).length > 0, name);
      for (let i = 1; i < p.events.length; i++) assert.ok(p.events[i].beat >= p.events[i - 1].beat, `${name}: sorted`);
      const open = new Map();
      for (const e of p.events) { if (e.on) open.set(e.id, e.beat); else { assert.ok(e.beat > open.get(e.id), `${name}: off after on`); open.delete(e.id); } }
      assert.equal(open.size, 0, `${name}: every note ends`);
      assert.ok(p.events.every((e) => e.beat <= p.beats + 0.001), `${name}: inside the loop`);
    }
  }
});

test('Patterns: chord progressions change chords and lead voices smoothly', () => {
  const p = buildPattern('chords', { key: 0, scale: 'major', progression: 'pop' });
  const chordAt = (t) => ons(p).filter((e) => e.beat === t).map((e) => e.n).sort((a, b) => a - b);
  const bars = [0, 4, 8, 12].map(chordAt);
  assert.deepEqual(bars.map((c) => c.map(pc).sort((a, b) => a - b)), [[0, 4, 7], [2, 7, 11], [0, 4, 9], [0, 5, 9]], 'C G Am F');
  for (let i = 1; i < bars.length; i++) {
    const move = bars[i].reduce((s, x, k) => s + Math.abs(x - bars[i - 1][k]), 0);
    assert.ok(move <= 6, `voice leading from bar ${i}: ${move} semitones`);
  }
  assert.ok(new Set(ons(p).map((e) => e.beat % 4)).size > 2, 'the second pass has rhythm');
  // sevenths, forced qualities, a 12-bar blues, the tour
  assert.deepEqual(chordTones({ d: 1, s: true }, 'major'), [2, 5, 9, 12], 'Dm7');
  assert.deepEqual(chordTones({ d: 4, q: 'maj' }, 'minor'), [7, 11, 14], 'major V in minor');
  assert.equal(progressionChords('blues').length, 12);
  assert.equal(progressionChords('tour').length, 16);
  assert.ok(Object.keys(PROGRESSIONS).length >= 8);
});

test('Patterns: melodies, runs and bass stay in the key and scale', () => {
  for (const [scale, key] of [['majorPentatonic', 7], ['blues', 9], ['harmonicMinor', 2]]) {
    const allowed = new Set(SCALES[scale].notes.map((x) => (x + key) % 12));
    for (const name of ['run']) assert.ok(ons(buildPattern(name, { key, scale })).every((e) => allowed.has(pc(e.n))), `${name} ${scale}`);
    const mel = buildPattern('melody', { key, scale, progression: 'pop' });
    const lead = ons(mel).filter((e) => e.part === 'melody');
    assert.ok(lead.length > 10 && lead.every((e) => allowed.has(pc(e.n))), `melody ${scale}`);
  }
  assert.ok(ons(mel0()).some((e) => e.part === 'chords'), 'chords under the melody');
  const bass = ons(buildPattern('bass', { key: 0, progression: 'pop' }));
  assert.ok(bass.every((e) => e.n < 12), 'bass below the chords');
  assert.equal(pc(bass[0].n), 0, 'starts on the root');
  // the same setting always plays the same melody; another key another one
  const a = JSON.stringify(buildPattern('melody', { key: 0 }).events);
  assert.equal(JSON.stringify(buildPattern('melody', { key: 0 }).events), a);
  assert.notEqual(JSON.stringify(buildPattern('melody', { key: 3 }).events), a);
});

test('Patterns: drums on the drum channel, the band with drums plays both', () => {
  const d = ons(buildPattern('drums'));
  assert.ok(d.every((e) => e.drum && e.abs && e.n >= 35 && e.n <= 81));
  const band = ons(buildPattern('bandDrums', { progression: 'jazz' }));
  assert.ok(band.some((e) => e.drum) && band.some((e) => !e.drum));
  assert.ok(ons(buildPattern('band')).every((e) => !e.drum));
});
