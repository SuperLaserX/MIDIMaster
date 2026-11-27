// Yamaha DX100 and DX27: the 4-operator voice (VCED, 93 bytes) without the pitch EG and chorus,
// 32 internal voices (VMEM). From the DX100 v1.1 firmware (32 KB at 8000h: SysEx parser B0D5 answers
// dump requests for formats 3 and 4 and takes voice parameter changes 12h; maximum table 186B;
// INIT VOICE 2205) and Yamaha's 4-op data format. Labels: the DX100's own short screen texts (label table
// AB9A pointing into AC5E-AE51), with its display tokens expanded: bytes 80h and up print the text at
// AD7E + token (print routine A5AA): 80h "LF", 83h "PM", 86h "AM", AAh "MW ", AEh "BC ", B2h " Bias ",
// B9h "Ampli ", C0h "Pitch ", A4h "Range", 9Eh "Porta". Shared code: yamaha-dx4.js. Not yet checked on a DX100/DX27.

import { buildDX4 } from './yamaha-dx4.js';
import { TX81Z_TEXTS } from './yamaha-tx81z.js';

const INIT = [
  31, 31, 0, 15, 15, 0, 0, 0, 4, 3, 31, 31, 0, 15, 15, 0, 0, 0, 4, 3, 31, 31, 0, 15, 15, 0, 0, 0, 4, 3, 31, 31, 0, 15, 15, 0, 0, 90, 4, 3,
  0, 35, 0, 0, 0, 98, 24, 4, 4, 0, 99, 50, 0, 0, 0, 50, 0, 73, 78, 73, 84, 32, 86, 79, 73, 67, 69, ...new Array(61).fill(0),
];

export const DX100_TEXTS = {
  ...TX81Z_TEXTS,
  WAVES: ['saw up', 'square', 'triangl', 'S/Hold'], // ADD2-ADE8 (table AB9A)
  POLYMONO: ['Poly', 'Mono'], // AD55, AD5C
  PORTA: ['Full T.', 'Fingered'], // AD6C, AD76
  L: {
    ...TX81Z_TEXTS.L,
    alg: 'ALG', fbl: 'FBL', lfw: 'LW', sy: 'L SYNC', ebs: 'EBS', kvs: 'KVS', crs: 'F', det: 'DET', ar: 'AR', d1r: 'D1R', d1l: 'D1L', d2r: 'D2R',
    rr: 'RR', out: 'OUT', rs: 'RS', ls: 'LS', trps: 'MID.C', mo: 'Poly/Mono', pbr: 'PBend Range', pm: 'Porta Mode', port: 'Porta Time',
    su: 'Foot Sw Sus', po: 'Foot Sw Por', // composed from AD89 "Foot Sw", AE51 " Sus", AE4C " Por"
    lfs: 'LFS', lfd: 'LFD', pmd: 'PMD', amd: 'AMD', pms: 'PMS', ams: 'AMS', // AC69-AC7F: {LF}S, {LF}D, {PM}D, {AM}D, {PM}S, {AM}S
    mwp: 'MW Pitch', mwa: 'MW Ampli', bcp: 'BC Pitch', bca: 'BC Ampli', bcpb: 'BC P Bias', bceb: 'BC E Bias', // AD92-ADA2
    // FC Volume (byte 67, maximum 99) has no DX100 screen: it keeps the TX81Z's word
  },
};

const def = buildDX4({
  id: 'yamaha-dx100', name: 'DX100', T: DX100_TEXTS, init: INIT, aced: false, peg: false, chorus: false, requests: true,
  bcpbMax: 99, // maximum table 186B (the TX81Z allows 100)
  deviceIds: ['yamaha-dx21', 'yamaha-tx81z', 'yamaha-dx11'],
  coverage: 'Edits the voices of the DX100 and DX27 and their 32-voice bank. Every voice parameter of the 4-operator voice (the pitch EG and chorus settings are kept; the DX100 and DX27 do not use them), the 32 internal voices read from the unit, the algorithm diagram and envelope graphs. Ranges and names are the DX100\'s own (its short screen names written out: LFS, LFD, PMD, AMD, PMS, AMS, MW Pitch, BC E Bias...). Not yet checked on a DX100 or DX27.',
  notes: { voice: 'The voice and the 32-voice bank can be read from the DX100 or DX27; each change is sent as you make it.' },
  prefer: () => 0.9,
});

export default def;
