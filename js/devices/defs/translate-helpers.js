// Small helpers shared by the translators written for the definitions made before translators were
// required (Matrix-1000, M1/M1R, JV-2080, K2000). Every value goes through the definition's own
// parameter (writeParam clamps to its range), so a translated sound always holds valid values.

import { readParam, writeParam } from '../../core/model/memmap.js';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));

/** Read/write helpers over a parameter list, by key. A write records `what` in the report. */
export function paramIO(params, report) {
  const byKey = new Map(params.map((p) => [p.key, p]));
  const get = (d, key) => readParam(d, byKey.get(key));
  const set = (d, key, v, what) => {
    if (v === undefined || v === null || Number.isNaN(v)) return;
    const p = byKey.get(key);
    if (!p) throw new Error(`no parameter ${key}`);
    writeParam(d, p, Math.round(v));
    if (what && report) report.mapped.push(what);
  };
  return { get, set, param: (key) => byKey.get(key) };
}

/** A report without repeated lines. */
export function tidy(r) {
  r.mapped = [...new Set(r.mapped)];
  r.approximated = [...new Set(r.approximated)];
  r.dropped = [...new Set(r.dropped)];
  return r;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => norm(s).replace(/\d+/g, ' ').split(' ').filter((w) => w.length > 1);

/**
 * The index of the name in `names` nearest to `wanted` (a ROM wave or multisound name from another
 * instrument): the same name, else the one sharing the most words (digits ignored), else -1.
 */
export function nearestName(wanted, names) {
  const w = norm(wanted);
  let i = names.findIndex((n) => norm(n) === w);
  if (i >= 0) return i;
  const ww = new Set(words(wanted));
  if (!ww.size) return -1;
  let best = -1;
  let score = 0;
  names.forEach((n, k) => {
    const s = words(n).filter((x) => ww.has(x)).length;
    if (s > score) { score = s; best = k; }
  });
  return best;
}

/** What kind of effect a type name is (any maker's naming): reverb, delay, chorus, flanger... */
export function effectKind(name = '') {
  const n = String(name).toUpperCase();
  if (/HALL|ROOM|REVERB|PLATE|STAGE|E\.?\s?R(EF)?\b|EARLY|AMBIEN|GATE/.test(n)) return 'reverb';
  if (/DELAY|ECHO|DLY/.test(n)) return 'delay';
  if (/FLANG/.test(n)) return 'flanger';
  if (/PHAS/.test(n)) return 'phaser';
  if (/TREM|PAN/.test(n)) return 'tremolo';
  if (/ROTAR|LESLIE|ROTARY/.test(n)) return 'rotary';
  if (/DIST|OVER|DRIVE|FUZZ|AMP/.test(n)) return 'distortion';
  if (/EQ|ENHAN|EXCIT|FILTER|WAH/.test(n)) return 'eq';
  if (/CHORUS|ENSEMBLE|SYMPH|DIMENS|SPACE/.test(n)) return 'chorus';
  return 'other';
}

/** A short hash of bytes, equal for the same data (Head Library duplicate search). */
export function hashBytes(d) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const x of d) { h1 = Math.imul(h1 ^ x, 16777619) >>> 0; h2 = Math.imul(h2 + x, 2246822507) >>> 0; }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

/** ADSR (0..1) from a multi-stage envelope's times and levels (each 0..max). */
export const adsr = (attack, decay, sustain, release) => ({
  attack: Math.max(0, Math.min(1, attack)), decay: Math.max(0, Math.min(1, decay)),
  sustain: Math.max(0, Math.min(1, sustain)), release: Math.max(0, Math.min(1, release)),
});
