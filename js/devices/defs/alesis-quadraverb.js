// Alesis Quadraverb (1989 rack multi-effect): MIDI implementation taken from the v1.07 firmware
// (8031 code; the EPROM's low address lines are wired in reverse, tools/alesis/qv_unscramble.py).
// See docs/devices/alesis-quadraverb.md.
//
// SysEx F0 00 00 0E 02 <op> ... F7, no channel byte; received and sent only while the MIDI page's
// SYSEX ENABLE is ON (bit 2C.1). Receiver A44B:
//   01 <function> <page> <b1> <b2> <b3>   set the value of a page (A611): the page is looked up in the
//        current configuration's list for that front-panel function, the value (lo = b1<<1 | b2>>6,
//        hi = (b2 & 3Fh)<<2 | b3>>5; 16 bits when the page's maximum is above 255) is limited to the
//        page's range, stored and applied, and the LCD shows the page. Function 5 writes the MIDI
//        settings (8500), function 0 page 0 recalls a program.
//   02 <n> <data>   program n 0-99 (CE00 + 80h n), 100 = edit buffer (8300, applied at once), 101 = all
//        100 programs. A program is 128 bytes sent as one MSB-first bit stream cut into 7-bit bytes
//        (147 bytes; the all-data message packs each program on its own).
//   03 <n>          request: answered with 02 <n> (A7C9).
//   04 <n> <pairs>  writes DSP registers 4n..181h directly (A502): a factory tool, not offered.
// The Quadraverb sends 01 itself when a value is edited on the panel (A73D) and 02 for the MIDI page's
// SEND MIDI PROG.
// Program (128 bytes): see the PAGES/DESCS tables in alesis-quadraverb-fw.js; 44h = configuration,
// 6Ah-77h = name (14 characters). Bytes 18, 19, 1F, 26, 30, 31, 33, 42, 43, 4B-4F, 68, 69, 78-7F are
// on no page, read by no routine and 0 in every factory program.

import * as FW from './alesis-quadraverb-fw.js';
import { makeQuadraverb } from './alesis-quadraverb-common.js';

export { FIRMWARE, CONFIGS, DESCS, FORMATS, PAGES, TARGETS, PRESETS } from './alesis-quadraverb-fw.js';
export { SIZE, PACKED, EDIT, ALL, USER_COUNT, FUNCS, pack, unpack, valueBytes, valueOf } from './alesis-quadraverb-common.js';

const Q = makeQuadraverb(FW, { id: 'alesis-quadraverb', name: 'Quadraverb', model: 0x02 });
export const { msg, isQuadraverb, cfgOf, pageList, locate, formatValue, targetName, fitProgram, nameOf, setName, presetData, initMidi, SLOTS, SPARE, _test } = Q;
export default Q.def;
