// Kurzweil K2000 programs: the complete segment set the K2000 needs (programs from .KRZ files), the
// algorithm flow table against the OS's block functions, and the functions set when the algorithm changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readKrz, completeProgram, missingSegments, LAYER_ORDER, PROGRAM_GLOBALS } from '../js/devices/kurzweil-k2000/disk/krz.js';
import { Program } from '../js/devices/kurzweil-k2000/model/program.js';
import { ProgramMap, algorithmSelectors, blocksForAlgorithm, paramValues, DSP_FUNCTIONS, ALGORITHMS } from '../js/devices/kurzweil-k2000/model/fwmodel.js';
import { ALG_FLOW, describeAlgorithm } from '../js/devices/kurzweil-k2000/model/algorithms.js';
import { DEFAULT_PROGRAM } from '../js/devices/kurzweil-k2000/model/fwparams.js';

const FARM = 'D:/midi/K2000/K2KFARM/ANALEADS.KRZ';
const fileSource = (path) => { const b = fs.readFileSync(path); return { name: path, size: b.length, read: async (o, n) => new Uint8Array(b.subarray(o, o + n)) }; };
const hex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));

test('K2000: the OS default program has every layer segment', () => {
  const p = new Program(hex(DEFAULT_PROGRAM));
  assert.deepEqual(p.layers[0].segments.map((s) => s.tag), LAYER_ORDER);
  assert.equal(p.segment(0, 0x40).length, 32);
});

test('K2000: programs completed with the segments the K2000 needs (nothing present changes)', () => {
  // a one-layer program with only some layer segments, as program files have them
  const full = new Program(hex(DEFAULT_PROGRAM));
  const keep = [0x09, 0x18, 0x14, 0x15, 0x20, 0x21, 0x22, 0x40, 0x50, 0x51, 0x52, 0x53];
  const parts = [full.data.slice(0, 16), full.data.slice(16, 24)]; // program, effect
  for (const s of full.layers[0].segments) if (keep.includes(s.tag)) parts.push(full.data.slice(s.offset, s.offset + s.length));
  const sparse = Uint8Array.from([...parts.flatMap((x) => [...x]), 0, 0]);
  sparse[sparse.indexOf(0x50) + 1] = 50; // F1: 4POLE LOPASS
  const miss = missingSegments(sparse);
  assert.deepEqual(miss.global, PROGRAM_GLOBALS);
  assert.deepEqual(miss.layers[0], [0x10, 0x11, 0x19, 0x1a, 0x1b, 0x23]);
  const c = completeProgram(sparse);
  assert.equal(c.added, 10);
  const p = new Program(c.data);
  assert.deepEqual(p.common.map((s) => s.tag), [0x08, ...PROGRAM_GLOBALS, 0x0f], 'the order the K2000 keeps');
  assert.deepEqual(p.layers[0].segments.map((s) => s.tag), LAYER_ORDER);
  assert.equal(new ProgramMap(p).blockCode(0, 1), 50, 'the program\'s own values stay');
  assert.deepEqual(missingSegments(c.data), { global: [], layers: [[]] });
  assert.equal(completeProgram(c.data).added, 0, 'a complete program stays as it is');
});

test('K2000: programs from a .KRZ file (D:/midi, skipped when absent)', { skip: !fs.existsSync(FARM) }, async () => {
  const krz = await readKrz(fileSource(FARM));
  for (const o of krz.objects.filter((x) => x.type === 132)) {
    const before = new ProgramMap(new Program(o.data));
    const c = completeProgram(o.data);
    const after = new Program(c.data);
    const m = new ProgramMap(after);
    assert.ok(c.added > 0, `${o.name}: file programs leave segments out`);
    assert.deepEqual(missingSegments(c.data).layers.flat(), [], o.name);
    for (let L = 0; L < after.layers.length; L++) {
      assert.equal(m.algorithm(L), before.algorithm(L), `${o.name} layer ${L + 1}: algorithm`);
      assert.deepEqual(m.dspBlocks(L).map((b) => b.code), before.dspBlocks(L).map((b) => b.code), `${o.name}: DSP functions`);
    }
  }
});

test('K2000: algorithm flows match the blocks and widths the OS offers', () => {
  assert.equal(Object.keys(ALG_FLOW).length, 31);
  for (let alg = 1; alg <= 31; alg++) {
    const f = ALG_FLOW[alg];
    const sel = algorithmSelectors(alg);
    assert.deepEqual(sel.map((s) => s.block), Object.keys(f.widths).map(Number), `${alg} ${ALGORITHMS[alg]}: blocks`);
    for (const { block, p } of sel) {
      for (const code of paramValues(p)) assert.equal(DSP_FUNCTIONS[code]?.width || 1, f.widths[block], `${alg}: F${block} ${DSP_FUNCTIONS[code]?.name}`);
    }
    // every block is reached and leads to the output
    const nodes = [...Object.keys(f.widths).map(Number)];
    const sync = f.edges.some(([, , r]) => r === 'sync');
    for (const n of nodes) {
      if (!(sync && n === 1)) assert.ok(f.edges.some(([, b]) => b === n), `${alg}: F${n} has an input`); // the master oscillator has none
      assert.ok(f.edges.some(([a]) => a === n), `${alg}: F${n} has an output`);
    }
    assert.ok(f.edges.some(([, b]) => b === 'O'), `${alg}: an output`);
    assert.match(describeAlgorithm(alg), /output/);
  }
  assert.match(describeAlgorithm(6), /F4 combines F3 and PITCH \(bypassing/);
  assert.match(describeAlgorithm(2), /two outputs/);
  assert.match(describeAlgorithm(27), /hard-synced/);
});

test('K2000: a new algorithm gets functions it takes, keeping those it can', () => {
  const p = new Program(hex(DEFAULT_PROGRAM));
  const map = new ProgramMap(p);
  map.write(algorithmSelectors(8)[0].p, 0, null, 1); // make sure the program is on algorithm 1 first
  // algorithm 8 (1-1-1-A): F1-F3 single-block functions, F4 AMP
  const changes = blocksForAlgorithm(map, 0, 8);
  for (const { block, p: q, value } of changes) assert.ok(paramValues(q).includes(value), `F${block}`);
  for (const c of changes) map.write(c.p, 0, c.block, c.value);
  for (const { block, p: q } of algorithmSelectors(8)) assert.ok(paramValues(q).includes(map.read(q, 0, block)), `F${block} is one algorithm 8 takes`);
  assert.deepEqual(blocksForAlgorithm(map, 0, 8), [], 'nothing left to change');
});
