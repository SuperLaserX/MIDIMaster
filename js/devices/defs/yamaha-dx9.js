// Yamaha DX9: a 4-operator instrument that speaks the DX7's voice formats. Its firmware (YA3128,
// z:/firmwares/Yamaha-DX9-IG11470-YA3128.zip, Intel HEX, 16 KB at C000h) sends a voice as the DX7's
// single-voice bulk (F262: F0 43 00 00 01 1B + 155 bytes built at 0DCA) and its memory as the DX7's
// 32-voice bulk (F27A: F0 43 00 09 20 00 + 4096 bytes, 20 voices used), always on channel 1, and maps
// each of its parameters to a DX7 parameter number (table F0B9). Those are the DX7's operators 6 to 3
// (EG, R SCALE DEPTH, RATE SCALING, A MOD SENS., OUTPUT LEVEL, F COARSE, F FINE, OSC DETUNE) and
// ALGORITHM, FEEDBACK, OSC KEY SYNC, the LFO (no LFO KEY SYNC), P MOD SENS. and MIDDLE C. Everything
// else in the DX7 voice is kept but not used by the DX9. Built on the DX7 definition (yamaha-dx.js).
// Not yet checked on a DX9 (docs/devices/yamaha-dx9.md).

import { buildDX } from './yamaha-dx.js';
import { DX7_FW, DX7_LABELS, DX7_HELP } from './yamaha-dx7.js';

// DX7 parameter numbers the DX9 uses (firmware table F0B9)
export const DX9_PARAMS = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 10, 13, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 31, 34, 35, 37, 39, 40, 41,
  42, 43, 44, 45, 46, 47, 48, 49, 52, 55, 56, 58, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 73, 76, 77, 79, 81, 82, 83,
  134, 135, 136, 137, 138, 139, 140, 142, 143, 144,
]);

const def = buildDX({
  id: 'yamaha-dx9',
  name: 'DX9',
  fw: DX7_FW,
  labels: DX7_LABELS,
  help: DX7_HELP,
  requests: false,
  functionParams: null,
  deviceIds: ['yamaha-dx7', 'yamaha-tx7'],
  prefer: () => 0.7,
  bankNote: 'The DX9 uses voices 1-20 of the 32.',
  coverage: 'Edits the DX9\'s voices and its 32-voice bank. The voices are in the DX7 voice format it uses over MIDI (single voices and the 32-voice bank, on MIDI channel 1), with the settings the DX9 has marked (DX7 operators 6-3, algorithm, feedback, LFO, sensitivities, transpose); the other DX7 settings are kept. Names and displays are the DX7\'s (the DX9 uses the same words); its ALGORITHM 1-8 are shown as the DX7 algorithms they are. The DX9 takes voices, banks and single changes on its MIDI CH with SYS INFO AVAIL on; it cannot be asked for its data. Not yet checked on a DX9.',
  notes: { voice: 'The DX9 keeps its four operators in the DX7 voice\'s OP6-OP3 and leaves the rest unused; parameters it does not use are marked in their help. It sends and receives voices on MIDI channel 1.' },
});

for (const p of def.objects[0].params) {
  if (p.vced !== undefined && p.vced < 145 && !DX9_PARAMS.has(p.vced)) p.help = `Not used by the DX9 (kept as it is). ${p.help || ''}`.trim();
}

// The DX9's ALGORITHM 1-8 are these DX7 algorithms (table D0D4: the sender F34A converts, the receivers
// F576 / F6B2 look the received number up in it; a DX7 voice on another algorithm has no DX9 algorithm).
export const DX9_ALGS = [0, 13, 7, 6, 4, 21, 30, 31];
{
  const v = def.objects[0];
  const als = v.params.find((p) => p.key === 'als');
  als.options = [...DX9_ALGS.map((a, i) => [a, `${i + 1} (DX7 ${a + 1})`]),
    ...Array.from({ length: 32 }, (_, a) => a).filter((a) => !DX9_ALGS.includes(a)).map((a) => [a, `DX7 ${a + 1} (no DX9 algorithm)`])];
  als.help = 'ALGORITHM 1-8: the DX9 keeps its algorithm as one of eight DX7 algorithms; the others are DX7-only.';
  const card = v.groupInfo.Algorithm;
  card.note = `${card.note} The DX9 has eight of them: DX7 ${DX9_ALGS.map((a) => a + 1).join(', ')} are its ALGORITHM 1-8.`;
  // the Algorithm tab offers its eight, by the DX9's numbers
  v.galleries = v.galleries.map((gal) => ({
    ...gal, choosable: (a) => DX9_ALGS.includes(a), label: (a) => `Algorithm ${DX9_ALGS.indexOf(a) + 1} (DX7 ${a + 1})`,
    note: `${gal.note} The DX9's ALGORITHM 1-8 are these eight DX7 algorithms.`,
  }));
}

export default def;
