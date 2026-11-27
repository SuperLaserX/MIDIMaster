// Device picker families (js/devices/families.js): what each instrument fundamentally is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deviceFamily, FAMILIES } from '../js/devices/families.js';
import { DEVICES } from '../js/devices/registry.js';

test('families: grooveboxes whatever their synthesis; a multi-purpose device by its main feature', () => {
  const fam = (id, type = 'syn') => deviceFamily({ id, type });
  assert.equal(fam('yamaha-dx200'), 'groovebox', 'a groovebox, not a DX-family synthesizer');
  assert.equal(fam('roland-mc-303'), 'groovebox');
  assert.equal(fam('roland-mc-505'), 'groovebox');
  assert.equal(fam('roland-mc-500', 'seq'), 'seq', 'the MC-500 is a sequencer');
  assert.equal(fam('korg-opsix'), 'fm', 'subtractive too, but fundamentally FM');
  assert.equal(fam('yamaha-dx7'), 'fm');
  assert.equal(fam('yamaha-tx16w', 'smp'), 'sampler', 'a Yamaha sampler, not FM');
  assert.equal(fam('access-virus-ti2'), 'va');
  assert.equal(fam('oberheim-matrix1000'), 'analog');
  assert.equal(fam('roland-jv2080'), 'rompler');
  assert.equal(fam('korg-m1'), 'rompler');
  assert.equal(fam('kurzweil-k2000'), 'sampler', 'a sampler, not a ROMpler');
  assert.equal(fam('sequential-prophet2000', 'smp'), 'sampler', 'a Sequential sampler, not analog');
  assert.equal(fam('roland-dj70mk2', 'smp'), 'groovebox');
  assert.equal(fam('alesis-quadraverb', 'fx'), 'fx');
  assert.equal(fam('unknown-thing', 'drm'), 'drum');
});

test('families: every device with an editor is in a specific family (add new synthesizers to families.js)', () => {
  const keys = new Set(FAMILIES.map((f) => f.key));
  const vague = [];
  for (const d of DEVICES.filter((x) => x.hasModule || x.hasDef)) {
    const f = deviceFamily(d);
    assert.ok(keys.has(f), `${d.id}: unknown family ${f}`);
    if (f === 'synth' || f === 'other') vague.push(d.id);
  }
  assert.deepEqual(vague, [], 'synthesizers with an editor need their family in js/devices/families.js');
});
