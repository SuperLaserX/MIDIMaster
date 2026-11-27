// Alesis Quadraverb Plus: the Quadraverb with the v2 software (v2.03, "QUADRAVERB Plus"; the EPROM also
// runs in a v1 Quadraverb). Same SysEx as the Quadraverb (F0 00 00 0E 02, opcodes 01-04, receiver BC2F)
// and the same 128-byte program, with three more configurations (RING→DL→REVERB, RESONATOR→DL→REV,
// SAMPLING), a fourth delay type (multi-tap: eight taps kept in 40 program bytes, TAP_MAP) and more mix
// pages; bytes the v1 left spare hold the new pages. See docs/devices/alesis-quadraverb-plus.md.

import * as FW from './alesis-quadraverb-plus-fw.js';
import { makeQuadraverb } from './alesis-quadraverb-common.js';

export { FIRMWARE, CONFIGS, DESCS, FORMATS, PAGES, TARGETS, PRESETS, TAP_MAP } from './alesis-quadraverb-plus-fw.js';
export { SIZE, PACKED, EDIT, ALL, USER_COUNT, FUNCS, pack, unpack, valueBytes, valueOf } from './alesis-quadraverb-common.js';

const Q = makeQuadraverb(FW, {
  id: 'alesis-quadraverb-plus', name: 'Quadraverb Plus', model: 0x02, family: 'alesis-quadraverb',
  has: { reverb: [0, 1, 4, 5, 6], delay: [0, 1, 2, 3, 5, 6], pitch: [0, 3], lezlie: [1] },
});
export const { msg, isQuadraverb, cfgOf, pageList, locate, formatValue, targetName, fitProgram, nameOf, setName, presetData, initMidi, SLOTS, SPARE, _test } = Q;
export default Q.def;
