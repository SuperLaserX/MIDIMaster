// Oberheim Matrix-1000: every master byte named, the Matrix-6 names of the bytes the 1000 only keeps,
// the two remote edits sent whole, the complete dump and its Branch Library items, and (when the OS and
// patch ROM images are present, re/firmware: not in git) the editor's messages against the 1000's own
// software run in the 6809 emulator (tools/matrix1000/check_editor.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import m1000, { msg, initPatch, initMaster, _test } from '../js/devices/defs/oberheim-matrix1000.js';
import { readParam } from '../js/core/model/memmap.js';

const master = m1000.objects.find((o) => o.key === 'master');
const patch = m1000.objects.find((o) => o.key === 'patch');

test('Matrix-1000: every master byte is a named parameter', () => {
  const covered = new Set(master.params.map((p) => p.offset));
  for (let i = 0; i < 172; i++) assert.ok(covered.has(i), `master byte ${i}`);
  for (const p of master.params) assert.ok(p.label && !/unknown|spare/i.test(p.label), p.key);
  // the 125 group mode bytes: one bit per patch, 000-999
  const gb = master.params.filter((p) => p.section === 'groupBits');
  assert.equal(gb.length, 125);
  assert.equal(gb.at(-1).label, 'Patches 992-999');
  assert.equal(gb[0].format(0b101), '000 002');
});

test('Matrix-1000: the bytes it only keeps carry the Matrix-6 screen names', () => {
  const by = (o) => master.params.find((p) => p.offset === o);
  assert.deepEqual(by(9).options.map(([, l]) => l).slice(0, 3), ['LIN', 'EXP1', 'EXP2'], 'VEL SCALE list (Matrix-6R menu EE58)');
  const names = { 9: 'VEL SCALE', 10: 'VEL SENS', 15: 'SYSTEMX', 16: 'LOCAL CTL', 21: 'PED2 INV', 22: 'LEVS INV', 23: 'SET DISP', 24: 'SQUICK', 25: 'PMAP ECHO', 26: 'STEREO', 27: 'BASIC CHAN', 28: 'STANDOFF', 29: 'SPILLOVER', 33: 'PATCH MAP' };
  for (const [o, n] of Object.entries(names)) assert.equal(by(Number(o)).label, n);
  // the cold start values (0xB1A8 copy and 0xDC41) are in range of every master parameter
  const d = initMaster();
  for (const p of master.params) {
    const v = readParam(d, p);
    if (p.options) assert.ok(p.options.some(([x]) => x === v), `${p.key}=${v}`);
    else assert.ok(v >= (p.min ?? 0) && v <= p.max, `${p.key}=${v}`);
  }
  assert.equal(master.params.find((p) => p.key === 'bank').readOnly, true, 'the bank bits are a report: the 1000 rebuilds them when it sends');
});

test('Matrix-1000: Env 1 sustain and VCA 2 by Env 2 go out as the whole edit buffer (broken remote edits in OS 1.11)', () => {
  const d = initPatch();
  for (const n of [29, 53]) {
    const p = patch.params.find((x) => x.num === n);
    const out = p.send(1, {}, d);
    assert.equal(out[3], 0x0d, `parameter ${n}`);
    assert.equal(out.length, 5 + 268 + 2);
  }
  assert.deepEqual(patch.params.find((x) => x.num === 21).send(64, {}, d), msg.param(21, 64));
});

test('Matrix-1000: complete dump keeps each bank select; library items rebuild Set bank + patch', () => {
  assert.ok(!m1000.fullDump.includes('Edit buffer'), 'the edit buffer reply (01 nn) would overwrite a stored patch if sent back');
  const banks = m1000.fullDump.filter((s) => s.request);
  assert.equal(banks.length, 10);
  for (const s of banks) assert.ok(s.record(msg.setBank(3)) && !s.record(msg.request(0)));
  // a bank as the 1000 sends it (the simulator names patches "BNKb: nn" as the OS does)
  const sim = m1000.simulate();
  sim.handle(Uint8Array.from(msg.setBank(1)));
  const reply = sim.handle(Uint8Array.from(msg.request(0)));
  const items = m1000.libraryItems(reply.map((r) => Uint8Array.from(r)));
  const patches = items.filter((it) => it.object === 'patch');
  assert.equal(patches.length, 100);
  assert.equal(patches[7].label, 'Patch 107');
  assert.deepEqual(Array.from(patches[7].msgs[0]), msg.setBank(1));
  assert.equal(items.filter((it) => it.object === 'master').length, 1);
});

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OS = `${ROOT}re/firmware/Oberheim_M1000-ROM_v113/M1000-CAT27256P-17_v113.BIN`;
const PATCHES = `${ROOT}re/firmware/Oberheim_M1000-IC_C2DB_ORG_RO(Black&White)/M1000-IC_C2DB.BIN`;
const OS111 = `${ROOT}re/firmware/Oberheim_M1000-ROM_v111/M1000-CAT27256P-17_v111.BIN`;

test('6809 core self test', () => {
  const r = spawnSync(process.execPath, [`${ROOT}tools/m6809/selftest.mjs`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

for (const os of [OS, OS111]) {
  test(`Matrix-1000 editor against its own software in the emulator (${os.match(/v1\d\d/)[0]})`, { skip: !(existsSync(os) && existsSync(PATCHES)) && 'Matrix-1000 ROM images not present' }, async () => {
    const { check } = await import('../tools/matrix1000/check_editor.mjs');
    const r = await check({ os, patches: PATCHES });
    assert.equal(r.fails, 0, r.report.filter((l) => l.startsWith('FAIL')).join('\n'));
    assert.ok(r.report.length >= 30);
  });
}
