// Novation SuperNova (the first model, 1998; rack): MIDI implementation from its own OS 4.1 image
// (snvos41.mid from Novation, decoded with tools/novation/os_mid.py), built with the Nova on one
// builder (novation-os4.js). Model byte 20. Not checked on a unit. See docs/devices/novation-supernova.md.
//
//   00 pp <286> program edit buffer      02 bb nn <286> program in memory (banks 5-12 A-H)
//   05 <372> performance (8 parts)       07 bb nn <372> performance in memory (banks 1-4 A-D)
//   0F <272> + 15 <288> global           03 / 08 / 10 / 13 bb nn requests
// No vocoder (no 1B/1C messages: the receiver accepts types 00-16 only).

import { buildOS4, SUPERNOVA } from './novation-os4.js';

const B = buildOS4(SUPERNOVA);
export const msg = B.msg;
export const isSN1 = (raw) => B.isMine(raw) && raw[5] === 0x20;
export const nameOf = B.nameOf;
const obj = (k) => B.def.objects.find((o) => o.key === k);
export const _test = { typeOf: B.typeOf, dataOf: B.dataOf, programParams: obj('program').params, performanceParams: obj('performance').params, globalParams: obj('global').params };
export default B.def;
