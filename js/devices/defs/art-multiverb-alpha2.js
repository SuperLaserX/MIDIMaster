// ART Multiverb Alpha 2 (1992 rack multi-effect, 2 x 16 LCD): MIDI implementation taken from the v2.02
// EPROM (27C512, Z80 code, "ART Jul 15, 1992"). See docs/devices/art-multiverb-alpha2.md; the editor is
// shared with the Alpha 2 SE (art-multiverb-alpha2-common.js, which describes the edit buffer).
//
// Stored presets are packed (6CDB): byte 0, bytes 1-6, the EQ and A.E.S. bytes when in use, the bytes
// of the effects in use, the title in 7 bits a character (14 bytes), byte 49 and 4 bytes per assignment
// in use: 22-80 bytes. Presets 1-115 are the factory presets in ROM until overwritten.
//
// SysEx F0 1A <ch> 11 <id> ... F7 (receiver 5C65): <ch> = MIDI CHANNEL - 1, which must match (no OMNI
// for SysEx; with the channel OFF nothing is received). Numbers and data bytes travel as pairs (bits 0-6,
// then bit 7). Received: 03 s v (a setting; 03 40 n n the preset shown), 05 <98> (edit buffer),
// 06 n n L <L> (preset n; 06 n n 02 n n: factory preset n, or empty from 116 on), 08 c n n (program
// table entry), 09 n n (recall preset n; 09 n 4x: recall factory preset n into the edit buffer),
// 0A n n (store the edit buffer as preset n, not checked against the lock), 0B (all presets: 6DC7 clears
// the memory first), 0C <128> (program table). Requests (40h + id): 41 (answer 01), 43 s, 45, 46 n n,
// 48 c, 4B, 4C, 4D (0D: bit 0 = the last store fitted in memory), 4F (0F: all presets expanded, 62h +
// 98 bytes each; the unit takes no 0F). MIDI page SEND A PRESET sends 05, SEND ENTIRE MPT 0C, SEND ALL
// PRESETS 0B. Task 0E (a memory dump) is never started in v2.02.

import * as FW from './art-multiverb-alpha2-fw.js';
import { makeAlpha } from './art-multiverb-alpha2-common.js';

export { TYPES, CONFIGS, TEXTS, UTIL, PAGES, PM_TITLES, FX_STATUS, CTRL, X15, DEFAULTS, FACTORY, FACTORY_TITLES, EMPTY, FIRMWARE } from './art-multiverb-alpha2-fw.js';
export { SIZE, E, FX_SIZE, TITLE_LEN, N_PRESETS, T, SWITCH_OF_BIT, isAlpha } from './art-multiverb-alpha2-common.js';

// firmware addresses the help texts name (v2.02)
export const AT = {
  addEffect: '1C50', delEffect: '13A4', pmNew: '1158', pmRange: '1195', pmPick: '1DD9', cfgPick: '15B0', tuner: '32DC',
  pmEnable: '5ACA', progEnable: '5A93', pending: '5B56', pendingApply: '5B92', store: '6AEE', recallValue: '6BC6',
  samplerState: 'C14D', same: '69A3', sameRam: 'C15D', configs: '1788', records: '20BA', reset: '0305', defaults: '04C7',
  apply: '5DB6', receiver: '5C65', statusBits: '6E78', pack: '6CDB', unpack: '69C2',
};

const A = makeAlpha(FW, { id: 'art-multiverb-alpha2', name: 'Alpha 2', se: false, AT });
export const N_FACTORY = A.N_FACTORY;
export const {
  sizeOf, cfgOf, textsOf, labelOf, valueText, switchOf, fxOffset, inUse, paramList, paramName, CONFIG_NAMES, summary,
  initEdit, titleOf, nameOf, setName, isEmptyPreset, fitEdit, prepare, pack, unpack, packedLength,
  factoryEdit, emptyEdit, romPreset, msg, presetsFrom, presetFrom, storeMessage,
  S, SYS, ADDR, SETTINGS, initSystem, systemMessages, setConfig, _test,
} = A;
export default A.def;
