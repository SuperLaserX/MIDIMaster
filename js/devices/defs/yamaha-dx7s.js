// Yamaha DX7s: the DX7II-D's voice (VCED + ACED) and performance formats with one voice per
// performance. Built on the DX7II definition (yamaha-dx7ii.js): the DX7s v1.3 firmware
// (z:/firmwares/Yamaha DX7S V1.3 ...zip, 32 KB at 8000h) has the same bulk headers ("LM  8973PE",
// "LM  8973PM", "LM  8973S ", "LM  MCRYE"...), and its receiver (C273) takes the DX7II's parameter-change
// groups and numbers (18h 0-49h, 19h performance 0-34h and system 40h-53h).
//
// Labels, value texts and ranges are the DX7s's own (docs/devices/yamaha-dx7s.md): each edit page has a
// list of the bytes it edits (table 9B1C, by page number RAM 36A1h; resolved to the voice 28C6h, additional
// data 2961h, performance 2FF2h or system 3058h at 99A5), the maxima of the same entries (tables 9BCD /
// 9BED) and the label texts (0-terminated, each group followed by its pointer table: DEA9, DEF3, DF14,
// DF76, DFDD, E041, E0C3, E21A, E2F1, E399, E4C9, E517, E537, E69E, E76E). Every maximum there is
// the DX7II's, except the micro tuning table (4Bh: CRT 1-63). Not yet checked on a DX7s.

import { buildDX7II } from './yamaha-dx7ii.js';
import { MICRO_NAMES_DX7S, dx7sSysParams, dx7sPced, SYS_INIT_DX7S } from './yamaha-dx7s-data.js';

const def = buildDX7II({
  id: 'yamaha-dx7s',
  name: 'DX7s',
  single: true,
  banks64: true,
  preferBonus: -0.5,
  deviceIds: ['yamaha-dx7ii'],
  // voice pages 6-0Ch (labels DEA9-E0C3, entries 9B44-9B61)
  labels: {
    als: 'Algorithm select', fbl: 'Feedback', opi: 'Osc key sync', trnp: 'Middle C', // DEA9 (+ "Name :")
    pm: 'Frequency', pc: 'F-coarse', pf: 'F-fine', pd: 'Osc detune', // DEF3 and "Frequency(Ratio)" / "Fixed freq (Hz)" (D1B0)
    r: 'EG-R', l: 'EG-L', rs: 'Rate scaling', // DF14
    tl: 'Output level', bp: 'Break point', lc: 'L-curve', rc: 'R-curve', ld: 'L-depth', rd: 'R-depth', // DF76 ("Scal. mode:" first)
    kvs: 'Key velocity', lpms: 'P mod sens.', // DFDD ("A mod sens." edits the additional data's Ams, 9A0F)
    lfks: 'LFO key sync', lfw: 'LFO wave', lfs: 'LFO speed', lfd: 'LFO delay', lpmd: 'LFO PM depth', lamd: 'LFO AM depth', // E041
    pr: 'PEGR', pl: 'PEGL', // E0C3
    ams: 'Ams (DX7 voice)',
  },
  help: {
    ams: 'The DX7 voice\'s amplitude modulation sensitivity (0-3), kept for DX7 compatibility: the DX7s has no page for it (its "A mod sens." page edits the additional data\'s Ams 0-7, 99F1).',
    trnp: 'Middle C: the note middle C plays (C3 = none).',
  },
  texts: {
    CURVES: ['-LIN', '-EXP', '+EXP', '+LIN'], // DF98 -> DF84..DF93
    WAVES: ['Triangl', 'Saw dwn', 'Saw up', 'Square', 'Sine', 'S/Hold'], // E079
    OFFON: ['off', 'on'], // DBB5 / DBB2
    OSC_MODES: ['Ratio', 'Fixed (Hz)'], // "Frequency(Ratio)" DEB3, "Fixed freq (Hz)" DEC4
    PORTA: [['Sus-key p retain', 'Sus-key p follow'], ['Fingerd porta', 'Full time porta']], // E284 + E2BB; E2CF (D8A3)
  },
  // additional data (pages 9, 0Ah, 0Bh, 0Ch, 16h-19h: entries 9B50-9B7A, labels as above and E21A, E2F1, E2F9, E399, the FC page E3BA..)
  aced: {
    op_scm: { label: 'Scal. mode', options: [[0, 'nomal'], [1, 'frac.']], help: 'Scal. mode: normal ("nomal" on the DX7s), or fractional scaling (D26C).' },
    op_ams7: { label: 'A mod sens.', help: 'A mod sens. (0-7): the DX7s edits this byte of the additional data on its sensitivity page (99F1).' },
    pegr: { label: 'PEG range', options: [[0, '8oct'], [1, '2oct'], [2, '1oct'], [3, '1/2oct']] }, // E0E9
    vpsw: { label: 'PEG velocity', options: [[0, 'off'], [1, 'on']] },
    pgrs: { label: 'PEG scaling' },
    ltrg: { label: 'LFO mode', options: [[0, 'Single'], [1, 'Multi']] }, // D39B
    pmod: { label: 'KeyMode', options: [[0, 'Poly'], [1, 'Mono'], [2, 'Uni Poly'], [3, 'Uni Mono']] }, // E230
    udtn: { label: 'Unison detune' },
    rndp: { label: 'Random pitch' },
    pbr: { label: 'P-bend range' },
    pbs: { label: 'P-bend step' },
    pbm: { label: 'PB mode', options: [[0, 'Normal'], [1, 'Lowest'], [2, 'Highest'], [3, 'Key-on']] }, // E25F
    porm: { label: 'Porta mode', help: 'Poly: "Sus-key p" retain or follow; mono: Fingerd porta or Full time porta (D8A3; no label of its own on the DX7s).' },
    pqnt: { label: 'Porta step' },
    pos: { label: 'Porta time' },
    ...Object.fromEntries([['mw', 'MW'], ['fc1', 'FC1'], ['bc', 'BC'], ['at', 'AT'], ['fc2', 'FC2'], ['mc', 'MC']].flatMap(([k, t]) => [
      [`${k}_pmod`, { label: `${t} PM depth` }], [`${k}_amod`, { label: `${t} AM depth` }], [`${k}_egbias`, { label: `${t} EG-bias` }],
      [`${k}_pbias`, { label: `${t} P-bias`, format: (v) => `${v > 50 ? '+' : ''}${v - 50}` }], [`${k}_vol`, { label: `${t} volume` }],
    ])),
    fccs1: { label: 'FC1 -> CS1', options: [[0, 'off'], [1, 'on']], help: 'The page "FC1 -> CS1 :" (E3BA): foot controller 1 acts as continuous slider 1.' },
  },
  pced: dx7sPced(MICRO_NAMES_DX7S),
  sysParams: dx7sSysParams,
  sysInit: SYS_INIT_DX7S,
  coverage: 'The DX7II formats (voice with its additional data, performance, system setup, micro tuning, fractional scaling, Branch Library) with the DX7s v1.3 firmware\'s own page labels, value texts and ranges (the edit-page tables 9B1C / 9BCD and their screen texts); a performance plays voice A only, and the bytes the DX7s neither shows nor reads are kept read-only; its system setup as its MIDI and exclusive pages show it; 64 internal voices and the cartridge\'s in the slot list. Not yet checked on a DX7s.',
});

export default def;
