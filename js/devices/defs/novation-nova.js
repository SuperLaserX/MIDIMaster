// Novation Nova (desktop/rack, and the Nova "Laptop" keyboard): MIDI implementation from the Nova
// OS 4.1 image (novaos41.mid from Novation, decoded with tools/novation/os_mid.py). One OS serves
// both: the image ("NOVATION NOVA") has no keyboard/desktop check, so there is one editor. Built
// with the SuperNova on one builder (novation-os4.js). Model byte 21. Not checked on a unit.
// See docs/devices/novation-nova.md.
//
//   00 pp <286> program edit buffer      02 bb nn <286> program in memory (banks 5-6 A-B)
//   05 <372> + 1B <16> performance (6 parts, vocoder)   07 bb nn <372> + 1C bb nn <16> in memory (bank 1 A)
//   0F <272> + 15 <288> global           03 / 08 / 10 / 13 bb nn requests

import { buildOS4, NOVA } from './novation-os4.js';

const B = buildOS4(NOVA);
export const msg = B.msg;
export const isNova = (raw) => B.isMine(raw) && raw[5] === 0x21;
export const nameOf = B.nameOf;
const obj = (k) => B.def.objects.find((o) => o.key === k);
export const _test = { typeOf: B.typeOf, dataOf: B.dataOf, programParams: obj('program').params, performanceParams: obj('performance').params, globalParams: obj('global').params };
export default B.def;
