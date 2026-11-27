// Yamaha DX5: two DX7 tone generators (channels A and B) with a keyboard, played single, dual or
// split, and the 94-byte performance the TX7 and TF1 also use. From the DX5 v6 firmware (6809, 32 KB
// at 8000h, z:/firmwares/Yamaha DX5 v6.zip; listing re/dx/dx5_v6.lst by tools/yamaha/m6809_dis.py):
// labels from its edit records (8234), the performance names, maxima and value texts through
// yamaha-dx-fn94.js, SysEx receiver A505. See docs/devices/yamaha-dx5.md. Not yet checked on a DX5.
//
//   F0 43 0n ...   n + 1 must be the Source of the current channel (A or B, performance byte 61),
//                  unless that channel is omni (A505)
//   formats 0 (the current channel's voice, 76C7), 1 (performance, 73A2), 2 (performance memories,
//   6000h, 4096 bytes), 9 (32 voices: INT 01-32 when A is current, 33-64 when B); 7Dh "LM  DX5   "
//   group 0: voice parameters (DX7 numbers); group 1 (C919): 0-29 the current channel's bytes (17-25
//   ignored), 30-33 bytes 60-63 (30 key assign, 31 single channel), 34-63 the name

import { buildDX } from './yamaha-dx.js';
import { bulk, parseBulk, paramChange, dumpRequest } from './yamaha-dx-sysex.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { tidy } from './translate-helpers.js';
import { DX7_FW, DX7_LABELS, DX7_HELP } from './yamaha-dx7.js';
import { fn94Params, FN_SIZE, fmemItems, fmemSlots, simulateFmem } from './yamaha-dx-fn94.js';

// The DX5's voice edit labels (records 8234: "RD", "RC", "BP", "LC", "LD", "RS", "AM", "KV", "OPL",
// "Freq", "Detune", "ALG", "FBL", "Wave", "Spd", "Dly", "PMD", "PMS", "AMD", "Sync", "Os K Sync",
// "Transpose") and its LFO wave names (BB74 "TriSaDSaUSqrSinS/H").
const LABELS = {
  ...DX7_LABELS, bp: 'BP', ld: 'LD', rd: 'RD', lc: 'LC', rc: 'RC', rs: 'RS', ams: 'AM', kvs: 'KV', tl: 'OPL', pc: 'Freq (coarse)', pf: 'Freq (fine)',
  pd: 'Detune', als: 'ALG', fbl: 'FBL', lfw: 'Wave', lfs: 'Spd', lfd: 'Dly', lpmd: 'PMD', lpms: 'PMS', lamd: 'AMD', lfks: 'Sync', opi: 'Os K Sync', trnp: 'Transpose',
};
// Its own value displays (table B8A7 by edit index): curves "-L" "-E" "+E" "+L" (B99C), oscillator mode "R" /
// "Hz" (B9CC), Detune "-7".."+0".."+7" (B9B7), Sync and Os K Sync "Off" / "On" (BAE4, texts BAFB), Transpose
// "-24".."+0".."+24" semitones (BB38), BP as a key (E0E2: value + 21, the same names as the DX7's), ALG + 1.
// The frequency (B9E3) and the plain numbers are left as the DX7 shows them.
const FW = {
  ...DX7_FW, WAVES: ['Tri', 'SaD', 'SaU', 'Sqr', 'Sin', 'S/H'], CURVES: ['-L', '-E', '+E', '+L'], OSC_MODES: ['R', 'Hz'], OFFON: ['Off', 'On'],
  DETUNE: Array.from({ length: 15 }, (_, v) => `${v < 7 ? '-' : '+'}${Math.abs(v - 7)}`),
  TRANSPOSE: Array.from({ length: 49 }, (_, v) => `${v < 24 ? '-' : '+'}${Math.abs(v - 24)}`),
};
const HELP = { ...DX7_HELP, trnp: 'Transpose in semitones, as the DX5 shows it: -24..+24 (24 = +0).' };

// ------------------------------------------------------------------ performance (format 1)
const half = (o) => (o < 30 ? 'A' : o < 60 ? 'B' : 'common');
function perfParams() {
  return fn94Params({
    reads: (o) => !((o % 30) >= 17 && (o % 30) <= 25 && o < 60),
    group: (o) => (o < 60 && (o % 30) >= 17 && (o % 30) <= 25 ? 'DX1 bytes' : o < 30 ? 'Channel A' : o < 60 ? 'Channel B' : o < 64 ? 'Key assign' : 'Name'),
  }).map((p) => ({ ...p, section: half(p.offset) }));
}
/** SUBJOB2 "Initialize perform. edit-buff" (D550): bytes 1-29 of each channel from D533, 62 = 0, 63 = 39,
 *  the name blank; it keeps the voices and bytes 60-61 (here INT 01 / INT 33, single, A). */
export function initPerf() {
  const d = new Uint8Array(FN_SIZE);
  const h = [0, 0, 0, 5, 0, 0, 0, 0, 1, 15, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 99, 7, 0, 1, 24];
  d.set(h, 0); d.set(h, 30); d[30] = 32; d[63] = 39;
  d.fill(32, 64);
  return d;
}
const isPerf = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 1 && b.data.length === FN_SIZE); };
const isPmem = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 2 && b.data.length === 4096); };
const isStatus = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0x7d && String.fromCharCode(...b.data.subarray(0, 10)) === 'LM  DX5   '); };
const perfName = (d) => String.fromCharCode(...d.subarray(64, 94)).replace(/[^\x20-\x7e]/g, ' ').trim();

/** Group 1 number of a byte: the current channel's 0-29, then 30-63 for bytes 60-93 (C919, table CA40). */
function sendPerf(p, d, c) {
  const o = p.offset;
  if (o >= 60) return paramChange(c, 1, o - 30, d[o]);
  if ((o % 30) >= 17 && (o % 30) <= 25) return bulk(c, 1, d); // ignored as parameter changes
  if (half(o) === (d[61] ? 'B' : 'A')) return paramChange(c, 1, o % 30, d[o]);
  return bulk(c, 1, d); // the other channel: the DX5 applies parameter changes to the current one only
}

function perfToCommon(d) {
  const part = (b) => ({ on: true, channel: d[b + 1] ? d[b + 1] - 1 : 0, program: d[b], level: 1 - d[b + 26] / 7, transpose: d[b + 29] - 24 });
  const mode = ['single', 'dual', 'split'][d[60]] || 'single';
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: mode === 'dual' ? 'layer' : mode, splitPoint: d[63] + 21,
    parts: mode === 'single' ? [part(d[61] ? 30 : 0)] : [part(0), part(30)],
    voice: { mode: d[2] ? 'mono' : 'poly', bendUp: d[3], bendDown: d[3], portamento: { on: d[5] > 0 && !d[6], time: d[5] / 99 } },
    extra: { family: 'yamaha-dx', model: 'DX5', pced: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d.subarray(0, 64))) },
  };
}
function perfFromCommon(c) {
  const report = emptyReport();
  const d = initPerf();
  if (c?.extra?.family === 'yamaha-dx' && c.extra.pced && fromBase64(c.extra.pced).length === FN_SIZE) {
    d.set(fromBase64(c.extra.pced));
    report.mapped.push(`performance (${c.extra.model})`);
    return { data: d, report };
  }
  const parts = (c?.parts || []).filter((p) => p.on !== false);
  const put = (b, p) => {
    if (Number.isInteger(p.program)) d[b] = Math.max(0, Math.min(127, p.program));
    if (Number.isInteger(p.channel)) d[b + 1] = Math.max(0, Math.min(15, p.channel)) + 1;
    if (p.transpose !== undefined) d[b + 29] = Math.max(0, Math.min(48, 24 + Math.round(p.transpose)));
    if (p.level !== undefined) d[b + 26] = Math.max(0, Math.min(7, Math.round((1 - p.level) * 7)));
  };
  if (parts[0]) { put(0, parts[0]); report.mapped.push('channel A: voice, source channel, key shift, attenuation'); }
  if (parts[1]) {
    put(30, parts[1]);
    d[60] = c.keyMode === 'split' ? 2 : 1;
    if (c.keyMode === 'split' && Number.isInteger(c.splitPoint)) d[63] = Math.max(0, Math.min(96, c.splitPoint - 21));
    report.mapped.push('channel B and the key assign mode');
  }
  if (parts.length > 2) report.dropped.push('parts after the second (the DX5 has channels A and B)');
  const v = c?.voice || {};
  if (v.mode) { d[2] = d[32] = v.mode === 'mono' || v.mode === 'legato' ? 1 : 0; report.mapped.push('poly/mono'); }
  if (v.bendUp !== undefined) { d[3] = d[33] = Math.max(0, Math.min(12, Math.round(v.bendUp))); report.mapped.push('pitch bend range'); }
  return { data: d, report: tidy(report) };
}

// ------------------------------------------------------------------ system status (7Dh)
// Answer to F0 43 2n 7D F7 while SysEx communication is on (F06F -> EFA7): F0 43 0n 7D 00 10 + 16 bytes:
// "LM  DX5   ", ROM bytes 8000-8001 (06 00: version 6), then
//   12: bits 0-4 RAM 76EA bits 3-7 (the play state the panel switches toggle; the DX5 reports 08h, 10h, 20h as
//       group 1 numbers 1Dh-1Fh when they change, CA5E), bit 5 M prot (7401: Internal memory write protect,
//       set at power-on 919E; refuses bulks, A600), bit 6 flag 7720 (set while the routine A92D runs: it
//       turns MIDI and SysEx off, M tune 3Fh, and steps through a note table, B708)
//   13: bit 0 MIDI switch (7402), 1 SUBJOB1 Basic event data output (7403), 2 SUBJOB2 Other event data output
//       (7404), 3 SUBJOB4 System exclu. communication (7405), 4 / 5 SUBJOB5 OMNI mode A / B (7406 / 7407),
//       6 SUBJOB7 Prog. change mode VOICE / PERFORMANCE (7408, D99A)
//   14: bit 0 SUBJOB3 After touch data output (7409), bits 1-4 SUBJOB6 Transmit channel (740A, also the n of
//       every message it sends, F052)
//   15: SUBJOB8 Y/N switch assign (740B 0-32: 0 off, else control number 740B + 3Fh, DA42)
// (MIDI utility pages D6CA-D830, texts DA62-DC9E.) The DX5 takes no 7Dh bulk and no parameter change for any of
// these (its receiver takes formats 0, 1, 2, 9 and groups 0 and 1 only), and M tune (7400h, 0-126 shown -63..+63,
// BBF6) is in no message: the page only reads.
const STATUS_SIZE = 6;
const SUB = (n, t) => `SUBJOB${n}: ${t}`;
function statusParams() {
  const ps = [];
  const onoff = [[0, 'off'], [1, 'on']];
  const P = (offset, label, extra) => ps.push({ key: `st${ps.length}`, label, offset, min: 0, max: 127, group: 'MIDI', readOnly: true, ...extra });
  const B = (offset, shift, label, extra = {}) => P(offset, label, { shift, bits: 1, max: 1, options: onoff, ...extra });
  B(3, 0, 'MIDI switch', { help: 'Off: the DX5 sends and takes no MIDI.' });
  B(3, 1, SUB(1, 'Basic event data output'));
  B(3, 2, SUB(2, 'Other event data output'));
  B(4, 0, SUB(3, 'After touch data output'));
  B(3, 3, SUB(4, 'System exclu. communication'), { help: 'The DX5 answers requests (this one included) and takes SysEx only while it is on.' });
  B(3, 4, `${SUB(5, 'OMNI mode')} A`);
  B(3, 5, `${SUB(5, 'OMNI mode')} B`);
  P(4, SUB(6, 'Transmit channel'), { shift: 1, bits: 4, max: 15, options: Array.from({ length: 16 }, (_, c) => [c, String(c + 1)]) });
  B(3, 6, SUB(7, 'Prog. change mode'), { options: [[0, 'VOICE'], [1, 'PERFORMANCE']], help: 'What a received program change selects.' });
  P(5, SUB(8, 'Y/N switch assign'), { options: [[0, 'off'], ...Array.from({ length: 32 }, (_, i) => [0x40 + i, String(0x40 + i)])], help: 'The control number the panel\'s YES / NO switches send (64-95).' });
  B(2, 5, 'M prot', { group: 'FUNCTION', help: 'Internal memory write protect: the DX5 sets it on at every power-on and then refuses voices and banks sent to it. It cannot be changed over MIDI.' });
  P(2, 'Play state', { group: 'FUNCTION', shift: 0, bits: 5, max: 31, input: 'number', help: 'The play-mode switches of the panel, as one number; shown for information.' });
  B(2, 6, 'Internal routine running', { group: 'FUNCTION', help: 'On while the DX5 runs one of its internal routines (with MIDI and SysEx off and master tune centred); shown for information.' });
  P(0, 'Version', { group: 'FUNCTION', input: 'number', help: 'The software version the DX5 reports (6 for version 6).' });
  P(1, 'Version, second byte', { group: 'FUNCTION', input: 'number' });
  return ps;
}

// ------------------------------------------------------------------ definition
const def = buildDX({
  id: 'yamaha-dx5',
  name: 'DX5',
  fw: FW,
  labels: LABELS,
  help: HELP,
  requests: true,
  deviceIds: ['yamaha-dx7', 'yamaha-tx7', 'yamaha-tx816'],
  functionParams: null,
  formats: [1, 2, 0x7d],
  bankNote: 'Internal memory write protect (FUNCTION, M prot) must be off; the 32 voices go to INT 01-32 when channel A is current, 33-64 when B is.',
  coverage: 'Edits the DX5\'s voices and performances and shows its system settings. The voice of the current channel (the DX7 voice, with the DX5\'s own names and display texts) with the 32-voice Branch Library; the System page (MIDI switch, SUBJOB1-8 settings, M prot: read only, as the DX5 takes none of them over MIDI); and the whole performance (channels A and B, key assign, dual detune, split, name) with the DX5\'s names, ranges and value texts, each change sent as you make it; a MIDI channels page for A and B. The 64 performance memories are read and written back from the Performance page\'s slot list (and the Branch Library). Not yet checked on a DX5.',
  notes: { voice: 'The DX5 takes SysEx on the Source channel of its current channel (A or B: the performance\'s Single channel). The voice page edits that channel\'s voice.' },
  moreRequests: [
    { label: 'Performance', bytes: (ctx) => dumpRequest(ctx?.channel ?? 0, 1) },
    { label: 'Performance memories', bytes: (ctx) => dumpRequest(ctx?.channel ?? 0, 2), timeout: 5000 },
  ],
  recognise: (raw) => isStatus(raw),
  prefer: (msgs) => (msgs.some(isStatus) ? 4 : msgs.some((m) => isPerf(m) && !/ {2}Lo:| YAMAHA {2}TX7/.test(perfName(parseBulk(m).data))) ? 2.5 : 0.8),
  libraryItem: (m, k) => {
    if (isPerf(m)) { const d = parseBulk(m).data; return [{ key: `p${k}`, label: `Performance "${perfName(d)}"`, name: perfName(d), object: 'performance', data: Uint8Array.from(d), msgs: [m] }]; }
    // format 2: the 64 memories at 6000h, unpacked as F999 does
    if (isPmem(m)) return fmemItems(parseBulk(m), k, { name: perfName, build: (c, d) => bulk(c, 1, d) });
    if (isStatus(m)) return [{ key: `s${k}`, label: 'DX5 status', name: '', object: 'system', data: Uint8Array.from(parseBulk(m).data.subarray(10, 16)), msgs: [m] }];
    return null;
  },
  simulateRequest: (unit, d) => {
    if (d[3] === 0x7d) return [bulk(d[2] & 15, 0x7d, [...[...'LM  DX5   '].map((x) => x.charCodeAt(0)), 6, 0, 0x20, 0x09, 0, 0])];
    return d[3] === 1 ? [bulk(d[2] & 15, 1, unit.perf ||= initPerf())] : simulateFmem(unit, d, initPerf) || [];
  },
  simulateBulk: (unit, b, d) => { if (b?.ok && b.format === 1) unit.perf = Uint8Array.from(b.data); else simulateFmem(unit, d, initPerf); return []; },
  extend(def2, { ch }) {
    const v = def2.objects.find((o) => o.key === 'voice');
    v.request = (ctx) => dumpRequest(ch(ctx), 0);
    v.match = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0 && b.data.length === 155); };
    v.decode = (raw) => { const d = new Uint8Array(156); d.set(parseBulk(raw).data); d[155] = 0x3f; return d; };
    def2.objects.push({
      key: 'performance', page: 'Performance', icon: '▦', label: 'Performance', size: FN_SIZE,
      init: initPerf, params: perfParams(), cols: 3,
      sections: [{ key: 'A', label: 'Channel A' }, { key: 'B', label: 'Channel B' }, { key: 'common', label: 'Key assign' }],
      request: (ctx) => dumpRequest(ch(ctx), 1),
      match: isPerf,
      decode: (raw) => Uint8Array.from(parseBulk(raw).data),
      name: perfName,
      setName: (d, n) => { for (let i = 0; i < 30; i++) d[64 + i] = Math.max(32, Math.min(126, String(n ?? '').charCodeAt(i) || 32)); return d; },
      note: 'Channels A and B, the key assign mode and the name. A change to the current channel (Single channel) is sent on its own as you make it; a change to the other channel sends the whole performance.',
      sendParam: (p, _v, d, c2) => sendPerf(p, d, ch(c2)),
      sendAll: { label: 'Send', title: 'Send the performance to the DX5', build: (d, c2) => bulk(ch(c2), 1, d) },
      toSyx: (d, c2) => bulk(ch(c2), 1, d),
      fromSyx: (msgs) => { const m = msgs.find(isPerf); return m ? Uint8Array.from(parseBulk(m).data) : null; },
      actions: [{
        label: 'Rename', run: async (api) => {
          const r = await api.form('Performance name', [{ key: 'name', label: 'Name (30 characters)', value: perfName(api.data), maxlength: 30 }]);
          if (!r) return;
          const d = Uint8Array.from(api.data);
          for (let i = 0; i < 30; i++) d[64 + i] = Math.max(32, Math.min(126, r.name.charCodeAt(i) || 32));
          api.send(Array.from({ length: 30 }, (_, i) => paramChange(ch(api.ctx), 1, 34 + i, d[64 + i])));
          api.setData(d);
        },
      }],
      multi: {
        page: 'MIDI channels', label: 'Channels', count: 2, section: (i) => (i ? 'B' : 'A'), partLabel: (i) => (i ? 'Channel B' : 'Channel A'),
        columns: [
          { label: 'Voice', params: ['Voice'], role: 'patch' },
          { label: 'Source', params: ['Source'], role: 'channel' },
          { label: 'Key shift', params: ['Key sft'] },
          { label: 'Attenuation', params: ['Att'] },
        ],
        on: (i, d) => d[60] > 0 || (d[61] ? 1 : 0) === i,
        channels: Array.from({ length: 16 }, (_, c) => [c + 1, `${c + 1} (MIDI)`]),
        note: 'Source 0 plays a channel from the DX5\'s keyboard, 1-16 from that MIDI channel; in single mode only the Single channel plays.',
      },
      // the 64 performance memories (format 2, RAM 6000h; packed CB27, unpacked F999)
      slots: fmemSlots({ label: 'Performance memories', count: 64, name: (d) => perfName(d) }),
      toCommon: perfToCommon,
      fromCommon: (c) => perfFromCommon(c),
    });
    def2.objects.push({
      key: 'system', page: 'System', icon: '⚙', label: 'System status', size: STATUS_SIZE, cols: 3,
      init: () => Uint8Array.from([6, 0, 0, 0x09, 0, 0]), params: statusParams(),
      request: (ctx) => dumpRequest(ch(ctx), 0x7d),
      match: isStatus,
      decode: (raw) => Uint8Array.from(parseBulk(raw).data.subarray(10, 16)),
      receive: (raw) => (isStatus(raw) ? Uint8Array.from(parseBulk(raw).data.subarray(10, 16)) : null),
      fromSyx: (msgs) => { const m = msgs.find(isStatus); return m ? Uint8Array.from(parseBulk(m).data.subarray(10, 16)) : null; },
      note: 'The DX5\'s FUNCTION / MIDI settings as it reports them; Get from device reads them (while System exclu. communication is on). The DX5 cannot take them over MIDI, so they are shown only: change them on its panel (MIDI switch, SUBJOB1-8, M prot). M tune cannot be read at all. Before Get, the page shows MIDI and System exclu. communication on and M prot off (your usual setting; the DX5 turns it on at power-on).',
    });
  },
});

export const _test = { perfParams, initPerf, sendPerf, perfToCommon, perfFromCommon, isStatus };
export default def;
