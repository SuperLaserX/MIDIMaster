// ART Multiverb Alpha 2 SE (1993-94): the Alpha 2's software with four ROM preset banks, a bit-packed
// preset format and other SysEx for presets and the program table. Taken from the v1.03 EPROM (27C1001,
// Z80, "ART Jul 15, 1993"; v1.04 "May 23, 1994" differs only in its factory BANK). See
// docs/devices/art-multiverb-alpha2-se.md; the editor is shared with the Alpha 2
// (art-multiverb-alpha2-common.js, which describes the 98-byte edit buffer, the same in both).
//
// Presets: 200 slots; the directory (C6B9) holds per slot a packed preset in user RAM or a ROM reference
// (preset l of bank h - 1, h = 0 "OPEN": of the selected BANK, 03 09). Banks A "CLASSIC" (112), B
// "STUDIO" (103), C "PERFORMANCE" (103), D "PRODUCTION" (86). After a factory reset every slot is OPEN
// with its own number.
//
// SysEx F0 1A <ch> 11 <id> ... F7 (receiver 5EC7), numbers and data bytes as pairs (bits 0-6, bit 7).
// Received: 03 s v (settings; 09 = BANK 0-3), 05 <98> (edit buffer), 09 n n (recall; 09 n 4x: the
// selected bank's preset n into the edit buffer, n < 112), 0A n n (STORE the edit buffer as preset n),
// 0B (all presets in the Alpha 2's packed form, converted; 02 n n = OPEN n), 0C <128> (program table
// 0-127), 11 c c n n (program table entry), 12 (all presets: per slot L <L pairs> in user RAM, or 02 l l
// h h a ROM reference), 13 <200> (program table). Requests: 41 (01), 43 s (03), 45 (05), 4D (0D), 4F
// (0F: user RAM presets expanded, 02 n n for the others), 51 c (11), 52 (12), 53 (13). No single-preset
// message (06 / 46 are gone; a 10 answer exists but nothing asks for it). MIDI page PRESS ENTER TO: SEND
// A PRESET 05, SEND ENTIRE MPT 13, SEND ALL PRESETS 12.

import * as FW from './art-multiverb-alpha2-se-fw.js';
import { makeAlpha } from './art-multiverb-alpha2-common.js';

export { TYPES, CONFIGS, TEXTS, UTIL, PAGES, PM_TITLES, FX_STATUS, CTRL, X15, DEFAULTS, BANKS, EMPTY, BANK_UTIL, SLOT_PAGE, BROKEN, FIRMWARE } from './art-multiverb-alpha2-se-fw.js';
export { SIZE, E, FX_SIZE, TITLE_LEN, N_PRESETS, T, SWITCH_OF_BIT, isAlpha } from './art-multiverb-alpha2-common.js';

// firmware addresses the help texts name (v1.03; v1.04 has them one byte later from 0517 on)
export const AT = {
  addEffect: '1C9C', delEffect: '13DC', pmNew: '1190', pmRange: '11CD', pmPick: '1E25', cfgPick: '15E8', tuner: '3362',
  pmEnable: '5D2C', progEnable: '5CD2', pending: '5DB8', pendingApply: '5DF4', store: '70A6', recallValue: '6EE0',
  samplerState: 'C150', same: '704E', sameRam: 'C160', configs: '17C0', records: '2106', reset: '0319', defaults: '04EE',
  apply: '6035', receiver: '5EC7', statusBits: '73DF', pack: '6C27', unpack: '6C8A', widths: '6D71', settle: '1B76 / 1B88',
};

const A = makeAlpha(FW, { id: 'art-multiverb-alpha2-se', name: 'Alpha 2 SE', se: true, AT });
export const { N_FACTORY, N_MAP, DEFAULT_BANK } = A;
export const {
  sizeOf, cfgOf, textsOf, labelOf, valueText, switchOf, fxOffset, inUse, paramList, paramName, CONFIG_NAMES, summary,
  initEdit, titleOf, nameOf, setName, isEmptyPreset, fitEdit, prepare, pack, unpack, packedLength, unpackA2, packA2,
  bankEdit, factoryEdit, emptyEdit, romPreset, slotText, msg, presetsFrom, storeMessage,
  S, SYS, ADDR, SETTINGS, initSystem, systemMessages, setConfig, _test,
} = A;
export default A.def;
