// Alesis Quadraverb GT (1991 guitar multi-effect): the Quadraverb Plus software with a preamp, from the
// v1.03 firmware (8031; dump with the low address lines reversed, tools/alesis/qv_unscramble.py). See
// docs/devices/alesis-quadraverb-gt.md.
//
// SysEx F0 00 00 0E 07 <op> ... F7 (receiver B78D), the Quadraverb's opcodes 01-04 and 128-byte program
// (147 bytes on the wire). The header F0 00 00 0E 02 02 is taken too: a Quadraverb (or Plus) program,
// converted on receipt (B92D, flag 8668; see fromQuadraverb below).
// The preamp (function 10: COMPRESSION, OVERDRIVE, DISTORTION, PREAMP TONE, BASS BOOST, CAB SIMULATOR,
// EFFECT LOOP, NOISE GATE, PREAMP OUT LEVEL) and a few more values (EQ MODE, EQ PRESET, MODULATION, DIRECT
// LEVEL, resonator 4 and 5 AMP) are edited in work bytes 83A8h-83C9h and kept in program bytes 7C-7E and
// the high bits of 1B, 1C, 28, 45 (PACK in alesis-quadraverb-gt-fw.js, packed by 1476 for a store or dump).
// Preamp page 6 (CAB SIMULATOR PROGRAM / GLOBAL) and the global cabinet are settings (8590, 8591).

import * as FW from './alesis-quadraverb-gt-fw.js';
import { makeQuadraverb, FUNCS } from './alesis-quadraverb-common.js';

export { FIRMWARE, CONFIGS, DESCS, FORMATS, PAGES, TARGETS, PRESETS, TAP_MAP, PACK, INDEXED, GLOBAL, EFFECTS } from './alesis-quadraverb-gt-fw.js';
export { SIZE, PACKED, EDIT, ALL, USER_COUNT, pack, unpack, valueBytes, valueOf } from './alesis-quadraverb-common.js';

/** A Quadraverb / Quadraverb Plus program as the GT stores it when one arrives with the Quadraverb header
 *  (B92D): preamp bytes 7C-7E cleared (NOISE GATE OFF), PREAMP OUT LEVEL 99; a PRE-EQ direct signal
 *  (byte 45 bit 0 clear) becomes DIRECT LEVEL (45 bits 7-1 = the old byte 46) with byte 46 cleared. */
export function fromQuadraverb(src) {
  const d = Uint8Array.from(src);
  d[0x7f] = 99; d[0x7e] = 1; d[0x7d] = 0; d[0x7c] = 0;
  if (d[0x45] & 1) d[0x45] = 1;
  else { d[0x45] = (d[0x46] << 1) & 0xff; d[0x46] = 0; }
  return d;
}

const Q = makeQuadraverb(FW, {
  id: 'alesis-quadraverb-gt', name: 'Quadraverb GT', model: 0x07, family: 'alesis-quadraverb-gt',
  funcs: [...FUNCS.slice(0, 9), 'Name / modulation', 'Preamp'],
  programFuncs: [7, 10, 4, 3, 2, 1, 8, 9],
  has: { reverb: [0, 1, 4, 5, 6], delay: [0, 1, 2, 3, 5, 6], pitch: [0, 3], lezlie: [1] },
  fromFamily: { family: 'alesis-quadraverb', convert: fromQuadraverb, note: 'Quadraverb program converted as the GT converts one it receives: preamp off, PREAMP OUT LEVEL 99, the direct signal level moved' },
  // the preamp as effects.distortion: drive = the larger of OVERDRIVE (0-7) and DISTORTION (0-8)
  moreEffects: (d, fx, get) => {
    const od = get(0xad) / 7; const dist = get(0xa9) / 8;
    if (od || dist) fx.distortion = { type: dist >= od ? 'DISTORTION' : 'OVERDRIVE', drive: Math.max(od, dist), level: d[0x7f] / 99 };
  },
});
export const { msg, isQuadraverb, cfgOf, pageList, locate, formatValue, targetName, fitProgram, nameOf, setName, presetData, initMidi, SLOTS, SPARE, _test } = Q;
export default Q.def;
