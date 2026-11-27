// Yamaha DX21: the 4-operator voice (VCED, 93 bytes) with pitch EG and chorus, 32 internal voices.
// INIT VOICE (in edit form at 3CB6), the coarse frequency ratio table (7587) from the DX21 v1.5
// firmware; message formats as its own parser takes them (v1.5 E20A: formats 3 and 4, requests, parameter
// changes 12h; the same as the DX100's). Its performance memories have no MIDI format (docs/devices/yamaha-dx21.md). Labels and value texts: the DX21's own screens (edit texts F612-F772, function texts
// FECE-FFD9, zero-terminated). The function settings (parameter changes 65h-7Ch) are a send-only
// object, below. Shared code: yamaha-dx4.js. Not yet checked on a DX21.

import { buildDX4, packVoice4 } from './yamaha-dx4.js';
import { TX81Z_TEXTS } from './yamaha-tx81z.js';
import { paramChange, parseParamChange } from './yamaha-dx-sysex.js';

const VCED_INIT = [
  31, 31, 0, 15, 15, 0, 0, 0, 0, 0, 0, 4, 3, 31, 31, 0, 15, 15, 0, 0, 0, 0, 0, 0, 4, 3, 31, 31, 0, 15, 15, 0, 0, 0, 0, 0, 0, 4, 3,
  31, 31, 0, 15, 15, 0, 0, 0, 0, 0, 90, 4, 3, 0, 0, 35, 0, 0, 0, 0, 2, 6, 0, 24, 0, 4, 0, 0, 40, 1, 1, 0, 50, 0, 0, 0, 50, 0,
  73, 78, 73, 84, 32, 86, 79, 73, 67, 69, 99, 99, 99, 50, 50, 50,
];

// The DX21's screen texts (v1.5): edit F614-F750 ("ALGORITHM SELECT", "LFO WAVE:", " EG  AR"...,
// "SAW UP" "SQUARE" "TRIANGL" "S/HOLD"), function FED0-FFCF ("Poly Mode", "Fingered Porta", "Foot
// Sustain:", "MW Pitch", "Middle C = ", "Chorus      :"). AME and the note names have no own text.
export const DX21_TEXTS = {
  ...TX81Z_TEXTS,
  WAVES: ['SAW UP', 'SQUARE', 'TRIANGL', 'S/HOLD'],
  POLYMONO: ['Poly Mode', 'Mono Mode'],
  PORTA: ['Full Time Porta', 'Fingered Porta'],
  L: {
    ...TX81Z_TEXTS.L,
    ar: 'AR', d1r: 'D1R', d1l: 'D1L', d2r: 'D2R', rr: 'RR', out: 'OUTPUT LEVEL', rs: 'RATE SCALE', ls: 'LEVEL SCALE', crs: 'FREQUENCY', det: 'DETUNE',
    ebs: 'E BIAS SENS.', kvs: 'KEY VELOCITY', alg: 'ALGORITHM SELECT', fbl: 'FEEDBACK', lfw: 'LFO WAVE', lfs: 'LFO SPEED', lfd: 'LFO DELAY',
    pmd: 'LFO PMD', amd: 'LFO AMD', sy: 'LFO SYNC', pms: 'P MOD SENS.', ams: 'A MOD SENS.', trps: 'Middle C', mo: 'Poly Mode', pbr: 'P Bend Range',
    pm: 'Porta mode', port: 'Porta Time', su: 'Foot Sustain', po: 'Foot Porta', ch: 'Chorus', fcvol: 'Foot Volume', mwp: 'MW Pitch', mwa: 'MW Amplitude',
    bcp: 'BC Pitch', bca: 'BC Amplitude', bcpb: 'BC Pitch Bias', bceb: 'BC EG Bias', pr: 'PEG RATE', pl: 'PEG LEVEL',
  },
};

// ------------------------------------------------------------------ function settings
// The FUNCTION CONTROL pages and the play-mode settings the DX21 v1.5 takes as parameter changes
// F0 43 1n 12 pp vv F7 (receiver E4AF: RAM address table E5CE, page table E5B6 -> RAM 1C6Ch). Page
// texts FD2F-FFCF (display F7BA-FBC9), maxima per page B653 (data entry B1BD, +1 B2DD, -1 B5A7), value
// pointers FC03. No message reads them, so the editor keeps its own copy. Ranges:
//   67h Master Tune  2758h 0-127, shown -64..+63 (F7C7; cold start 40h, A492)
//   65h Dual Detune  2759h 0-99 (B655; x A5h into the detune, CC49), shown as a number
//   68h Midi Switch  275Bh OFF/ON: off = every MIDI message is ignored (DFD6)
//   6Ah Midi Omni    26BFh = value XOR 1 (on = 26BFh 0, "Midi Omni : ON"; off = receive channel 1)
//   6Ch Midi Recv Ch 26BFh = value + 1 (0-15 = 1-16, "Midi Recv Ch =")
//   6Bh Midi Trns Ch 26C0h 0-15 = 1-16
//   69h Midi Ch Info 275Ch OFF/ON (channel messages), 6Dh Midi Sy Info 275Dh OFF/ON (SysEx; off = all
//       SysEx ignored, E000)
//   77h Mem Protect  53h OFF/ON (set on at every power-on, A998)
//   78h Key Shift    275Ah 0-48 = -24..+24 (FBAD), 7Ch Bend Mode 1EECh 0-2 "Low" "Hi" "Kon" (FBF2)
//   7Ah Key Shift on/off (RAM 57h, the panel switch of page 30h: the screen's first character is "K"
//       while on, AAAB), 79h Bend Mode on/off (RAM 80h, the switch of page 2Fh: pitch bend only to the
//       voice Bend Mode picks, C436 / D55E)
//   66h split point  1EDBh, the MIDI note shown as a number on the "SP:" screen (EF15; set by a key, BE51)
// 65h-78h and 7Ch are taken only while the DX21 shows EDIT or FUNCTION (1C65h = 2 or 4, E4BE); 79h
// not in EDIT, FUNCTION or SPLIT, 7Ah not in EDIT or FUNCTION (E482); 66h only in SPLIT (E4A7).
// 6Eh "Midi Transmit ?" (the 32 voices, B338), 6Fh "Recall Edit ?" (B35D), 70h "Init. Voice ?" (B3A2)
// and 7Bh compare (on 1 / off 0, AC54) are actions; 71h-76h (the tape and group pages) are ignored.
// The DX21 sends 65h, 67h, 78h and 7Ch itself when they are changed on its panel (E867-E883).
const ONOFF = ['OFF', 'ON']; // F34A, F347
export const BEND_MODES = ['Low', 'Hi', 'Kon']; // FBF8, FBFC, FBFF
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']; // FB3A ("Middle C = C3" = note 60)
const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`;
export const FN_SIZE = 13;
// Defaults: cold start (A480, A5BA) and the INIT performance (A5DB: detune 20, split 60, Low); Mem Protect off (the user's setting).
export const FN_INIT = [64, 20, 1, 0, 0, 1, 1, 0, 24, 0, 0, 0, 60];
const PC = (pp) => 0x100 + pp; // group 4 + 2 = 12h
/** The function settings: data offset -> parameter number (pp), label, maximum, group. */
export const FN_PARAMS = [
  { offset: 0, pp: 0x67, key: 'mtune', label: 'Master Tune', max: 127, group: 'FUNCTION CONTROL', format: (v) => String(v - 64), help: 'Shown as -64..+63 (64 = 0).' },
  { offset: 1, pp: 0x65, key: 'ddet', label: 'Dual Detune', max: 99, group: 'FUNCTION CONTROL', help: 'Detune between the two voices of DUAL play (0-99).' },
  { offset: 7, pp: 0x77, key: 'protect', label: 'Mem Protect', max: 1, group: 'FUNCTION CONTROL', options: ONOFF.map((t, i) => [i, t]), help: 'Memory protect. The DX21 turns it ON at every power-on; while on it refuses a 32-voice bulk.' },
  { offset: 2, pp: 0x68, key: 'midi', label: 'Midi Switch', max: 1, group: 'MIDI', options: ONOFF.map((t, i) => [i, t]), help: 'OFF: the DX21 ignores every MIDI message, so it cannot be set back ON over MIDI.' },
  { offset: 3, pp: 0x6c, key: 'rch', label: 'Midi Recv Ch', max: 16, group: 'MIDI', options: [[0, 'Omni : ON'], ...Array.from({ length: 16 }, (_, c) => [c + 1, String(c + 1)])], help: 'Omni ON (sent as 6Ah = 1) or the receive channel (6Ch). The DX21 then takes SysEx only on that channel: set the editor\'s MIDI channel to it.' },
  { offset: 4, pp: 0x6b, key: 'tch', label: 'Midi Trns Ch', max: 15, group: 'MIDI', options: Array.from({ length: 16 }, (_, c) => [c, String(c + 1)]), help: 'Transmit channel, also of the DX21\'s own dumps and parameter changes.' },
  { offset: 5, pp: 0x69, key: 'chinfo', label: 'Midi Ch Info', max: 1, group: 'MIDI', options: ONOFF.map((t, i) => [i, t]), help: 'Channel messages (notes aside: program changes, controllers) received and sent.' },
  { offset: 6, pp: 0x6d, key: 'sysinfo', label: 'Midi Sy Info', max: 1, group: 'MIDI', options: ONOFF.map((t, i) => [i, t]), help: 'System exclusive: OFF = the DX21 ignores every SysEx (it cannot be set back ON over MIDI) and answers no request.' },
  { offset: 8, pp: 0x78, key: 'kshift', label: 'Key Shift', max: 48, group: 'Key Shift and Bend Mode', format: (v) => String(v - 24), help: '-24..+24 semitones (24 = 0); used while the Key Shift switch is on.' },
  { offset: 10, pp: 0x7a, key: 'kson', label: 'Key Shift on/off', max: 1, group: 'Key Shift and Bend Mode', options: ONOFF.map((t, i) => [i, t]), help: 'The panel switch (the screen\'s first character shows K while on). Taken in play modes only, not in EDIT or FUNCTION.' },
  { offset: 9, pp: 0x7c, key: 'bmode', label: 'Bend Mode', max: 2, group: 'Key Shift and Bend Mode', options: BEND_MODES.map((t, i) => [i, t]), help: 'Which voice the pitch bend wheel bends while the Bend Mode switch is on: the lowest note, the highest, or the last key on.' },
  { offset: 11, pp: 0x79, key: 'bmon', label: 'Bend Mode on/off', max: 1, group: 'Key Shift and Bend Mode', options: ONOFF.map((t, i) => [i, t]), help: 'The panel switch. Taken in SINGLE and DUAL play only (not EDIT, FUNCTION or SPLIT).' },
  { offset: 12, pp: 0x66, key: 'split', label: 'Split point', max: 127, group: 'Performance', options: Array.from({ length: 128 }, (_, n) => [n, `${n} (${noteName(n)})`]), help: 'The key where SPLIT play changes voice, shown as its MIDI note number on the "SP:" screen (no label of its own). Taken only while the DX21 plays SPLIT.' },
];
const fnMsgs = (ch, p, d) => (p.pp === 0x6c && !d[p.offset] ? paramChange(ch, 4, PC(0x6a), 1) : paramChange(ch, 4, PC(p.pp), p.pp === 0x6c ? d[p.offset] - 1 : d[p.offset]));
const actionPC = (label, title, pp, v = 1) => ({ label, title, run: (api) => api.send(paramChange(api.ctx?.channel ?? 0, 4, PC(pp), v)) });

const def = buildDX4({
  id: 'yamaha-dx21', name: 'DX21', T: DX21_TEXTS, init: Array.from(packVoice4(Uint8Array.from(VCED_INIT))), aced: false, peg: true, chorus: true, requests: true,
  deviceIds: ['yamaha-dx100', 'yamaha-tx81z', 'yamaha-dx11'],
  coverage: 'Every voice parameter of the 4-operator voice (VCED, with the DX21\'s pitch EG and chorus), 32 internal voices (VMEM), the algorithm diagram and EG graphs; the INIT VOICE, frequency ratios, labels and value texts of the v1.5 firmware\'s own screens; the function settings it takes as parameter changes 65h-7Ch (FUNCTION CONTROL pages, MIDI switches, Key Shift, Bend Mode, split point; sent only). Not yet checked on a DX21.',
  notes: { voice: 'Every change is a parameter change (12h); voices and the 32-voice bank are read by request (formats 3 and 4; the DX21 answers while Sys Info is on). Its performance memories (PMEM) have no MIDI format: they go to tape only.' },
  prefer: () => 0.95,
  // FUNCTION page 1Ch: "BC Pitch Bias" = the plain number (F8C0), 0-99 (maximum B66F)
  bcpbMax: 99, bcpbFormat: (v) => String(v), bcpbHelp: 'Shown 0-99 as the DX21 shows it (50 = no bias).',
  extend(def2, { ch }) {
    const params = FN_PARAMS.map((p) => ({ ...p, min: 0 }));
    def2.objects.push({
      key: 'system', page: 'Function', icon: '⚙', label: 'Function', size: FN_SIZE, cols: 3,
      init: () => Uint8Array.from(FN_INIT), params,
      layout: [{ group: 'FUNCTION CONTROL' }, { group: 'MIDI' }, { group: 'Key Shift and Bend Mode' }, { group: 'Performance' }],
      warning: 'The DX21 takes these settings and the actions (Midi Transmit, Recall Edit, Init. Voice, Compare) only while its screen shows EDIT or FUNCTION: press EDIT or FUNCTION on the DX21 before changing them here. Anything sent in play mode is ignored without a message. The exceptions: the Key Shift and Bend Mode on/off switches are taken only in play (SINGLE or DUAL; Key Shift also SPLIT), the split point only in SPLIT play.',
      note: 'The DX21 cannot send these settings (it has no dump for them), so the values shown are the firmware\'s defaults until you change them here; each change is sent at once as a parameter change (F0 43 1n 12 pp vv F7). The DX21 takes the FUNCTION CONTROL, MIDI, Key Shift and Bend Mode values only while it shows EDIT or FUNCTION (press FUNCTION first); the two on/off switches only in play, the split point only in SPLIT play. It reports Master Tune, Dual Detune, Key Shift and Bend Mode itself when they are changed on its panel. Mem Protect is shown OFF, your usual setting (the DX21 sets it ON at power-on).',
      sendParam: (p, _v, d, ctx) => fnMsgs(ch(ctx), p, d),
      receive: (raw, d, ctx) => {
        const pc = parseParamChange(raw);
        if (!pc || pc.group !== 4 || pc.channel !== ch(ctx)) return null;
        const n = Uint8Array.from(d);
        if (pc.num === PC(0x6a)) { n[3] = pc.value ? 0 : 1; return n; }
        const p = params.find((x) => PC(x.pp) === pc.num);
        if (!p) return null;
        n[p.offset] = p.pp === 0x6c ? Math.min(16, pc.value + 1) : Math.min(p.max, pc.value);
        return n;
      },
      actions: [
        { label: 'Send all', title: 'Send every value shown (the DX21 must show EDIT or FUNCTION; the on/off switches and split point are skipped, they need play modes)', run: (api) => api.send(params.filter((p) => ![0x79, 0x7a, 0x66].includes(p.pp)).map((p) => fnMsgs(ch(api.ctx), p, api.data))) },
        { label: 'Defaults', title: 'The firmware\'s defaults (cold start A480 / A5BA, INIT performance A5DB; Mem Protect OFF), not sent until you press Send all', run: (api) => api.setData(Uint8Array.from(FN_INIT)) },
        actionPC('Midi Transmit', '"Midi Transmit ?": the DX21 sends its 32 voices (6Eh; the DX21 must show EDIT or FUNCTION; needs Midi Switch and Sy Info ON)', 0x6e),
        actionPC('Recall Edit', '"Recall Edit ?": the DX21 brings back the voice being edited before the last voice change (6Fh; the DX21 must show EDIT or FUNCTION); read the voice again afterwards', 0x6f),
        actionPC('Init. Voice', '"Init. Voice ?": the DX21 puts its INIT VOICE into the edit buffer (70h; the DX21 must show EDIT or FUNCTION); read the voice again afterwards', 0x70),
        actionPC('Compare on', 'EDIT COMPARE: the DX21 plays the stored voice instead of the edited one (7Bh = 1, while a voice is edited: the DX21 must show EDIT or FUNCTION)', 0x7b, 1),
        actionPC('Compare off', 'Back to the edited voice (7Bh = 0; EDIT or FUNCTION)', 0x7b, 0),
      ],
    });
  },
  simulateParam: (unit, pc) => {
    if (pc.group !== 4) return [];
    unit.fn = unit.fn || Uint8Array.from(FN_INIT);
    if (pc.num === PC(0x6a)) { unit.fn[3] = pc.value ? 0 : 1; return []; }
    const p = FN_PARAMS.find((x) => PC(x.pp) === pc.num);
    if (p) unit.fn[p.offset] = p.pp === 0x6c ? Math.min(16, pc.value + 1) : pc.value;
    return [];
  },
});

export default def;
