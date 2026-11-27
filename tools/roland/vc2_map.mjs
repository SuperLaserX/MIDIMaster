// Generate js/devices/defs/roland-vsynthxt-vc2-map.js: for every VC-2 patch parameter (model 00 00 0D
// address) its firmware parameter, algorithm group and place in a .p02 patch file, and the
// per-algorithm tables.
//
// Inputs (re/vsynthxt/live, made on the unit and in the emulator; see docs/devices/roland-vsynth-xt-vc2.md):
//   vc2_descriptors.json   the VC-2's 40-byte address descriptors, built by FUN_89316A40 run in Ghidra's
//                          p-code emulator after the start-up data copy (tools/roland/ghidra/VsEmuCall.java:
//                          VsEmuCall.java <out> 89316a40 8c700000 0 0 0 pre:89300040:8930005e 8992e000:7000 899343c0:40)
//   vc2_u001-016.json      U001-U016 read from the unit (SysEx layout), = factory files 001-016
//   vc2p02/001..016.p02    the same patches as files on the factory drive
//   vc2_algo_probe.json    the unit's answers per algorithm (values taken, wave numbers taken, and the
//                          patch the unit holds after the algorithm is chosen)
//   vc2_alg0_init.json     the same for algorithm 0 (chosen after algorithm 1 and after 3: the same)
//   vc2_wave_names.json    the VC-2's wave names (model 00 24)
// usage: node tools/roland/vc2_map.mjs [re/vsynthxt/live] [out.js]

import fs from 'node:fs';
import { patchBuilt } from '../../js/devices/defs/roland-vsynthxt-vc2.js';
import { P, PACK } from '../../js/devices/defs/roland-vsynthxt-vc2-fw.js';

const L = (process.argv[2] || 're/vsynthxt/live').replace(/\/?$/, '/');
const OUT = process.argv[3] || 'js/devices/defs/roland-vsynthxt-vc2-map.js';
const desc = JSON.parse(fs.readFileSync(L + 'vc2_descriptors.json', 'utf8'));
const users = JSON.parse(fs.readFileSync(L + 'vc2_u001-016.json', 'utf8'));
const probe = JSON.parse(fs.readFileSync(L + 'vc2_algo_probe.json', 'utf8'));
const files = Object.keys(users).map((n) => fs.readFileSync(`${L}vc2p02/${String(n).padStart(3, '0')}.p02`));
const pays = files.map((f) => f.subarray(0x20));
const datas = Object.values(users).map((a) => Uint8Array.from(a));
const bits = (pay, pos, bp, w) => { let v = 0; for (let j = 0; j < w; j++) { const b = pos * 8 + bp + j; v = v * 2 + ((pay[b >> 3] >> (7 - (b & 7))) & 1); } return v; };

// framework blocks of the VC-2's table (offsets restart at 0) and where each lies in a .p02 payload:
// the V-Synth's packed patch with 8 zones; the VC-2's additions to the common and tone blocks lie in
// extension areas (found by matching the 16 files against the unit's answers)
const blockOf = new Map();
{ let bi = -1, last = -1; PACK.forEach((pk, i) => { if (!pk) return; if (bi < 0 || pk[0] < last - 2 || (pk[0] === 0 && pk[2] === 0 && last > 0)) bi = i; blockOf.set(i, bi); last = pk[0]; }); }
const ZONE = { 11: 0, 10: 0, 12: 0, 14: 1 }; // descriptor kind -> zone (11/10/12: carrier tone, envelopes, COSM; 14: modulator tone)
function place(kind, id) {
  const [off] = PACK[id];
  const blk = P[blockOf.get(id)][0];
  const z = ZONE[kind] ?? 0;
  if (id === 0x389) return 4996; // OSC 1 Wave Number (16 bits): tone extension 2
  if (id === 0x38d) return 4998; // OSC 2 Wave Number
  switch (blk) {
    case 'Patch Name 1': return off < 84 ? off : 4888 + off;
    case 'Activity': return 84 + off;
    case 'Chorus Type': return 152 + off;
    case 'Reverb Type': return 180 + off;
    case 'Structure Type': return off < 78 ? 230 + 78 * z + off : 4526 + off;
    case 'Env 1 Attack Time': return 854 + 112 * z + off;
    case 'COSM Switch': case 'COSM Parameter 1': return 2966 + off;
    case 'Beam Type': return 4054 + off;
    default: return -1;
  }
}
// value encodings (the unit's SysEx value -> the stored bits)
const ENC = {
  raw: (v) => v,
  shift: (v, s) => v - s,
  oct12: (v) => (v - 64) * 12 + 64, // carrier "Pitch Octave Shift" is stored as the coarse tune in semitones
  p32768: (v) => v + 32768, // COSM parameters
  mod46: (v) => (v + 46) % 128, // modulator wave: the VC-2's numbering, 46 places on (checked on 0, 82, 83)
};
const special = { 'ca|OSC1 Pitch Octave Shift': 'oct12', 'ca|Growl Intensity': 'p32768', 'ca|Growl Speed': 'p32768', 'mo|OSC Wave': 'mod46' };

const map = {};
let verified = 0;
const failed = [];
for (const x0 of desc.filter((x) => ['c', 'ca', 'mo', 'vo'].includes(x.block) && x.nib === 0)) {
  const id = x0.id + (x0.size > 1 ? x0.size - 1 : 0); // a value of n nibbles: the named id is its last
  const part = patchBuilt.parts.find((p) => p.key === x0.block);
  const p = patchBuilt.params.find((q) => q.block === x0.block && q.offset === part.offset + x0.addr);
  if (!p || !PACK[id]) { failed.push(`${x0.block}:${x0.addr} no parameter`); continue; }
  const [, w, bp] = PACK[id];
  const shift = P[id][7] || 0;
  const pos = place(x0.kind, id);
  const vals = datas.map((d) => { let v = 0; for (let k = 0; k < (p.nibbles || 1); k++) v = (p.nibbles > 1 ? v * 16 : 0) + d[p.offset + k]; return v; });
  const tries = special[`${x0.block}|${p.name}`] ? [special[`${x0.block}|${p.name}`]] : shift ? ['shift', 'raw'] : ['raw'];
  const enc = tries.find((e) => pays.every((pay, k) => bits(pay, pos, bp, w) === (ENC[e](vals[k], shift) & ((1 << w) - 1))));
  if (!enc) { failed.push(`${p.key} ${p.name}`); continue; }
  verified++;
  map[p.key] = { addr: x0.addr, size: x0.size, group: x0.group, kind: x0.kind, id, fw: P[id][0], pos, bp, w, enc, ...(enc === 'shift' ? { shift } : {}) };
}
if (failed.length) throw new Error(`not placed: ${failed.join(', ')}`);

// per-algorithm: the address groups each algorithm takes (FUN_8931C5D0; group 0 always), checked on the
// unit (1407 of 1416 tries agree; the rest are value limits), and the wave numbers each takes
const ALG_GROUPS = [[1, 2, 6, 7, 8, 9], [1, 2, 6, 7, 8, 9], [1, 2, 3, 6, 7, 8, 9], [1, 2, 7, 8, 10], [1, 2, 7, 8, 10], [1, 2, 3, 7, 8, 10], [1, 4, 7, 9], [1, 2, 5, 6, 8, 9], [1, 2, 5, 6, 8, 9], [1, 2, 3, 5, 6, 8, 9], [6, 8, 9], [8, 10]];
const range = (w) => (Array.isArray(w) && w.length ? [w[0], w[w.length - 1]] : null);
const ALG_WAVES = Object.keys(probe.algos).sort((a, b) => a - b).map((a) => {
  const wv = probe.algos[a].waves;
  const osc2 = Array.isArray(wv.ca_1b) ? range(wv.ca_1b) : [0, 0];
  const mod = Array.isArray(wv.mo_1) ? [0, 127] : null; // 0-127 when taken (checked to 127 under algorithm 7)
  return { osc1: range(wv.ca_b), osc2, mod };
});
// choosing an algorithm makes the VC-2 load its "INIT PATCH" (the same whatever patch it held):
// algorithm 0's whole, the others as the bytes that differ from it
const init0 = JSON.parse(fs.readFileSync(L + 'vc2_alg0_init.json', 'utf8')).loads[0];
const loads = Object.keys(probe.algos).sort((a, b) => a - b).map((a) => (Number(a) === 0 ? init0 : probe.algos[a].base));
const ALG_INIT_DIFF = loads.map((b) => b.map((x, i) => (x !== init0[i] ? [i, x] : null)).filter(Boolean));
// the VC-2's factory waves (read on the unit, model 00 24): 1-54; higher numbers are waves added later
// (55-58 on this unit: "080 MakeGrv+" ..., named after V-Synth waves)
const waveNames = JSON.parse(fs.readFileSync(L + 'vc2_wave_names.json', 'utf8')).filter(([n]) => n <= 54);
const header = files[0].subarray(0, 0x20);
const template = pays[0];
const js = [
  '// Generated by tools/roland/vc2_map.mjs from the VC-2 application\'s address descriptors (run in the',
  '// emulator), its parameter table, 16 factory patch files matched against the unit\'s SysEx answers and',
  '// a per-algorithm probe on the unit. VC2_MAP[editor key]: addr, size (nibbles), group (algorithm',
  '// group, 0 = every algorithm), kind and id (firmware object and parameter), fw (the firmware\'s name),',
  '// pos, bp, w (byte, bit from the MSB, bits in a .p02 payload) and enc (how the value is stored).',
  `export const VC2_MAP = ${JSON.stringify(map)};`,
  '// ALG_GROUPS[algorithm]: the groups it takes. ALG_WAVES[algorithm]: [first, last] wave each oscillator takes (null: locked).',
  `export const ALG_GROUPS = ${JSON.stringify(ALG_GROUPS)};`,
  `export const ALG_WAVES = ${JSON.stringify(ALG_WAVES)};`,
  '// The patch (SysEx layout) the VC-2 loads when an algorithm is chosen: ALG_INIT (algorithm 0) with',
  '// ALG_INIT_DIFF[algorithm] ([offset, value]) applied. Read on the unit.',
  `export const ALG_INIT = ${JSON.stringify(init0)};`,
  `export const ALG_INIT_DIFF = ${JSON.stringify(ALG_INIT_DIFF)};`,
  '// The VC-2\'s factory wave names (1-54, as the unit reads them; Read wave names replaces them with the unit\'s).',
  `export const FACTORY_WAVES = ${JSON.stringify(waveNames)};`,
  `export const P02_HEADER = ${JSON.stringify(Array.from(header))};`,
  '// The factory patch 001 "LargeChoir 1" as stored: the base a written file starts from (other zones).',
  `export const P02_TEMPLATE = '${Buffer.from(template).toString('base64')}';`,
];
fs.writeFileSync(OUT, js.join('\n') + '\n');
console.log(`${verified} parameters placed and verified on 16 files; written ${OUT}`);
