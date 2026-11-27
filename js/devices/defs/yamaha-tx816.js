// Yamaha TX816: a rack of eight TF1 modules, each a DX7 tone generator with its own MIDI IN, its
// channel and 32 voices. From the TF1 firmware (HD6303, 16 KB at C000h, Yamaha_TF1_iN0104-2.zip;
// listing re/dx/tf1.lst): SysEx receiver CFC0, senders D238-D524, parameter changes EA8E (group 1),
// ED7C (group 4). The TF1 has only a two-digit LED display, so the voice labels are the DX7's and the
// function data's the DX5's (yamaha-dx-fn94.js). See docs/devices/yamaha-tx816.md. Not yet checked
// on a TX816.
//
//   formats 0 (voice), 1 (function data, 94 bytes), 2 (function memories, 4096 bytes), 9 (32 voices);
//   requests for each and 7Dh, which answers "LM  8950  " 01 01, flags, channel... (D49F)
//   group 1: 1 MIDI channel (1-16), 2-16 and 26 the function data, 64 master tune (DX7 function 64)
//   group 4 (+128): 5 / 6 key limit low / high, 7 memory protect (0 / 7Fh), 8 = 7Fh initialise
// Each module listens on its own channel (unless omni), so the editor reaches a module by its channel.

import { buildDX } from './yamaha-dx.js';
import { bulk, parseBulk, paramChange, dumpRequest } from './yamaha-dx-sysex.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { tidy } from './translate-helpers.js';
import { DX7_FW, DX7_LABELS, DX7_HELP } from './yamaha-dx7.js';
import { fn94Params, FIXED, FN_SIZE, fmemItems, fmemSlots, simulateFmem } from './yamaha-dx-fn94.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = (l) => l.map((t, i) => [i, t]);
const HDR = 'LM  8950  ';

// ------------------------------------------------------------------ key limits in the name (D826 / D980)
// The TF1 writes "NN VOICENAME  Lo:C -2 Hi:G 8 " into the function data's name and reads the limits back
// from it: note names "C C#D D#..." (D8BD) and octaves "-2-10 1 2 ..." (D8D5), two characters each.
const NOTE2 = ['C ', 'C#', 'D ', 'D#', 'E ', 'F ', 'F#', 'G ', 'G#', 'A ', 'A#', 'B '];
const OCT2 = ['-2', '-1', '0 ', '1 ', '2 ', '3 ', '4 ', '5 ', '6 ', '7 ', '8 '];
const NAME = 64;
const LO = NAME + 18; // note at 18-19, octave 20-21; high at 26-29
const HI = NAME + 26;
const str = (d, at, n) => String.fromCharCode(...d.subarray(at, at + n));
export function readLimit(d, at, fallback) {
  const n = NOTE2.indexOf(str(d, at, 2));
  const o = OCT2.indexOf(str(d, at + 2, 2));
  return n < 0 || o < 0 ? fallback : Math.min(127, o * 12 + n);
}
export function writeLimit(d, at, v) {
  const t = NOTE2[v % 12] + OCT2[Math.floor(v / 12)];
  for (let i = 0; i < 4; i++) d[at + i] = t.charCodeAt(i);
}
const noteText = (v) => `${NOTE2[v % 12].trim()}${OCT2[Math.floor(v / 12)].trim()}`;
const noteOpts = Array.from({ length: 128 }, (_, n) => [n, noteText(n)]);

// ------------------------------------------------------------------ function data (format 1)
// What the TF1 reads: group 1 numbers 2-16 and 26 (EB69 maxima), channel B instead of A when byte 61 is B
// (D1A8), and the key limits in the name.
const READS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 26, 61, ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 26].map((o) => o + 30)]);
const SENT = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 26]);
function fnParams() {
  const ps = fn94Params({
    reads: (o) => READS.has(o),
    extra: (o) => (o === 0 || o === 30 ? { options: Array.from({ length: 128 }, (_, i) => [i, i < 32 ? `I${String(i + 1).padStart(2, '0')}` : String(i)]), help: 'The voice this function data belongs to (I01-I32); the TF1 selects voices by program change.' } : {}),
    group: (o) => (o < 30 ? (READS.has(o) ? 'Channel A' : 'Channel A (sent, not read)') : o < 60 ? 'Channel B (read when Single channel is B)' : o < 64 ? 'Key assign' : 'Name'),
    readOnlyHelp: (o) => (o >= 64 ? 'The TF1 writes the voice number and name here.' : o >= 30 && o < 60 ? 'The TF1 sends channel A again here and reads it only as noted.' : `The TF1 sends ${FIXED[o] ?? 0} here and does not use it.`),
  });
  ps.push(
    { key: 'lo', label: 'Key limit low', offset: LO, size: 4, min: 0, max: 127, group: 'Key limits', options: noteOpts, get: (d) => readLimit(d, LO, 0), set: (d, v) => writeLimit(d, LO, v), help: 'Kept in the name as "Lo:" text, where the TF1 reads it back; also sent to the module as you change it.', send: (v, ctx) => paramChange(ctx?.channel ?? 0, 4, 133, v) },
    { key: 'hi', label: 'Key limit high', offset: HI, size: 4, min: 0, max: 127, group: 'Key limits', options: noteOpts, get: (d) => readLimit(d, HI, 127), set: (d, v) => writeLimit(d, HI, v), help: 'Kept in the name as "Hi:" text; also sent to the module as you change it.', send: (v, ctx) => paramChange(ctx?.channel ?? 0, 4, 134, v) },
  );
  return ps;
}
export function initFn(voice = 0, voiceName = 'INIT VOICE') {
  const d = new Uint8Array(FN_SIZE);
  const half = [voice, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 99, 0, 0, 1, 24];
  d.set(half, 0); d.set(half, 30); d[63] = 39;
  const name = `${String(voice + 1).padStart(2, '0')} ${voiceName.padEnd(10).slice(0, 10)}  Lo:C -2 Hi:G 8 `; // D826: 30 characters
  d.set([...name].map((c) => c.charCodeAt(0)), NAME);
  return d;
}
const isFn = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 1 && b.data.length === FN_SIZE); };
const isFmem = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 2 && b.data.length === 4096); };
const isStatus = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0x7d && b.data.length === 16 && String.fromCharCode(...b.data.subarray(0, 10)) === HDR); };
/** Function data a TF1 sent: its name holds the "Lo: / Hi:" key limits. */
const isTf1Fn = (raw) => isFn(raw) && / {2}Lo:/.test(String.fromCharCode(...parseBulk(raw).data.subarray(NAME)));
/** {channel, omni, protect} of a module's 7Dh answer (D49F). */
export function parseStatus(raw) {
  if (!isStatus(raw)) return null;
  const d = parseBulk(raw).data;
  return { channel: d[13] & 15, omni: !!(d[12] & 0x10), protect: !!(d[12] & 0x20), raw: Array.from(d.subarray(10)) };
}

function fnToCommon(d) {
  const b = d[61] ? 30 : 0;
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: 'single',
    parts: [{ on: true, channel: 0, program: d[b] & 31, level: 1 - d[b + 26] / 7, low: readLimit(d, LO, 0), high: readLimit(d, HI, 127) }],
    voice: { mode: d[b + 2] ? 'mono' : 'poly', portamento: { on: d[b + 5] > 0 && !d[b + 6], time: d[b + 5] / 99 }, bendUp: d[b + 3], bendDown: d[b + 3] },
    extra: { family: 'yamaha-dx', model: 'TX816', pced: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d.subarray(0, 64))) },
  };
}
function fnFromCommon(c) {
  const report = emptyReport();
  const d = initFn();
  if (c?.extra?.family === 'yamaha-dx' && c.extra.pced && fromBase64(c.extra.pced).length === FN_SIZE) {
    d.set(fromBase64(c.extra.pced));
    if (c.extra.model !== 'TX816' && c.extra.model !== 'DX5') d.set(initFn(d[0]).subarray(NAME), NAME); // a TX7 name holds no key limits
    report.mapped.push(`function data (${c.extra.model})`);
    return { data: d, report };
  }
  const p = c?.parts?.find((x) => x.on !== false) || c?.parts?.[0];
  if (Number.isInteger(p?.program)) { d[0] = d[30] = Math.max(0, Math.min(31, p.program)); report.mapped.push('voice number'); }
  if (p?.level !== undefined) d[26] = d[56] = Math.max(0, Math.min(7, Math.round((1 - p.level) * 7)));
  if (Number.isInteger(p?.low)) writeLimit(d, LO, p.low);
  if (Number.isInteger(p?.high)) writeLimit(d, HI, p.high);
  const v = c?.voice || {};
  if (v.mode) { d[2] = d[32] = v.mode === 'mono' || v.mode === 'legato' ? 1 : 0; report.mapped.push('poly/mono'); }
  if (v.bendUp !== undefined) { d[3] = d[33] = Math.max(0, Math.min(12, Math.round(v.bendUp))); report.mapped.push('pitch bend range'); }
  if (v.portamento) { d[5] = d[35] = v.portamento.on ? Math.max(1, Math.round((v.portamento.time ?? 0.3) * 99)) : 0; report.approximated.push('portamento time'); }
  if ((c?.parts || []).length > 1) report.dropped.push('parts after the first (a TF1 plays one voice: use the Modules page for the rack)');
  return { data: d, report: tidy(report) };
}

// ------------------------------------------------------------------ the rack (Modules page)
// Per module (8 bytes): channel, voice, key limit low, high, master tune, attenuation, memory protect, and
// the channel the module was last told (where the next channel change goes).
const MOD = 8;
function moduleParams() {
  const ps = [];
  for (let m = 0; m < 8; m++) {
    const b = m * MOD;
    const s = `m${m}`;
    const P = (o, label, max, extra) => ps.push({ key: `m${m}_${o}`, label, offset: b + o, min: 0, max, group: `Module ${m + 1}`, section: s, ...extra });
    P(0, 'MIDI channel', 15, {
      options: Array.from({ length: 16 }, (_, c) => [c, String(c + 1)]),
      set: (d, v) => { d[b + 7] = d[b]; d[b] = v; },
      send: (v, _ctx, d) => paramChange(d[b + 7], 1, 1, v + 1),
      help: 'The channel the module listens on (its panel MIDI CH). A change is sent to the module on its old channel.',
    });
    P(1, 'Voice', 31, { options: Array.from({ length: 32 }, (_, i) => [i, `I${String(i + 1).padStart(2, '0')}`]), send: (v, _ctx, d) => [0xc0 | d[b], v], help: 'Selects voice 1-32 (by program change), which also recalls the voice\'s function memory.' });
    P(2, 'Key limit low', 127, { options: noteOpts, send: (v, _ctx, d) => paramChange(d[b], 4, 133, v) });
    P(3, 'Key limit high', 127, { options: noteOpts, send: (v, _ctx, d) => paramChange(d[b], 4, 134, v) });
    P(4, 'Master tune', 127, { format: (v) => `${v > 64 ? '+' : ''}${v - 64}`, send: (v, _ctx, d) => paramChange(d[b], 1, 64, v), help: 'Master tune of the module: 64 = 0.' });
    P(5, 'Attenuation', 7, { send: (v, _ctx, d) => paramChange(d[b], 1, 26, v), help: 'The module\'s output attenuation (also on the Function data page).' });
    P(6, 'Memory protect', 1, { options: opts(['off', 'on']), send: (v, _ctx, d) => paramChange(d[b], 4, 135, v ? 127 : 0), help: 'Memory protect of the module. Keep it off to send voices.' });
    P(7, 'Last channel sent', 15, { hidden: true });
  }
  return ps;
}
export function initRack() {
  const d = new Uint8Array(8 * MOD);
  for (let m = 0; m < 8; m++) d.set([m, 0, 0, 127, 64, 0, 0, m], m * MOD);
  return d;
}
function rackToCommon(d) {
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: 'multi',
    parts: Array.from({ length: 8 }, (_, m) => ({ on: true, channel: d[m * MOD], program: d[m * MOD + 1], low: d[m * MOD + 2], high: d[m * MOD + 3], level: 1 - d[m * MOD + 5] / 7 })),
    extra: { family: 'yamaha-dx', model: 'TX816', rack: toBase64(Uint8Array.from(d)) },
  };
}
function rackFromCommon(c) {
  const report = emptyReport();
  const d = initRack();
  if (c?.extra?.rack && fromBase64(c.extra.rack).length === 8 * MOD) { d.set(fromBase64(c.extra.rack)); report.mapped.push('the whole rack (TX816)'); return { data: d, report }; }
  (c?.parts || []).filter((p) => p.on !== false).slice(0, 8).forEach((p, m) => {
    const b = m * MOD;
    d[b] = d[b + 7] = Math.max(0, Math.min(15, p.channel ?? m));
    d[b + 1] = Number.isInteger(p.program) ? Math.max(0, Math.min(31, p.program)) : 0;
    d[b + 2] = Math.max(0, Math.min(127, p.low ?? 0));
    d[b + 3] = Math.max(0, Math.min(127, p.high ?? 127));
    d[b + 5] = Math.max(0, Math.min(7, Math.round((1 - (p.level ?? 1)) * 7)));
  });
  report.mapped.push('parts: channel, voice 1-32, key limits, level as attenuation');
  report.approximated.push('one module per part (the modules\' channels are set on them as sent)');
  if ((c?.parts || []).length > 8) report.dropped.push('parts after the eighth');
  return { data: d, report: tidy(report) };
}

// ------------------------------------------------------------------ definition
const def = buildDX({
  id: 'yamaha-tx816',
  name: 'TX816',
  fw: DX7_FW, // the TF1's INIT VOICE (D641) is the DX7's
  labels: DX7_LABELS,
  help: DX7_HELP,
  requests: true,
  deviceIds: ['yamaha-tx7', 'yamaha-dx7'],
  functionParams: null,
  formats: [1, 2, 0x7d],
  bankNote: 'The module\'s memory protect must be off (Modules page).',
  coverage: 'Edits each of the TX816\'s TF1 modules: voices, function data and module settings. Each module is reached on its own MIDI channel: the DX7 voice (with the DX7\'s names, as the TF1 has no display), its 32 voices, the function data (with the DX5\'s names; the settings the TF1 uses are editable, key limits kept in the name as the TF1 does) and the Modules page (channel, voice, key limits, master tune, attenuation, memory protect per module) with a MIDI channels page; Find modules looks for a module on each channel. The function memories are read and written back per module from the Function data page\'s slot list (and the Branch Library). Not yet checked on a TX816.',
  notes: { voice: 'Each TF1 module answers on its own channel: set the channel (top bar) to the module you edit, or use the Modules page.' },
  moreRequests: [
    { label: 'Function data', bytes: (ctx) => dumpRequest(ctx?.channel ?? 0, 1) },
    { label: 'Function memories', bytes: (ctx) => dumpRequest(ctx?.channel ?? 0, 2), timeout: 5000 },
    { label: 'Module status (7Dh)', bytes: (ctx) => dumpRequest(ctx?.channel ?? 0, 0x7d) },
  ],
  recognise: (raw) => isStatus(raw) || isTf1Fn(raw),
  prefer: (msgs) => (msgs.some((m) => isStatus(m) || isTf1Fn(m)) ? 4 : 0.85),
  libraryItem: (m, k) => {
    if (isFn(m)) { const d = parseBulk(m).data; return [{ key: `f${k}`, label: `Function data ${String.fromCharCode(...d.subarray(NAME, NAME + 13)).trim()}`, name: String.fromCharCode(...d.subarray(NAME + 3, NAME + 13)).trim(), object: 'performance', data: Uint8Array.from(d), msgs: [m] }]; }
    // format 2: the 32 function memories in the DX5's 64-byte form, sent twice (D347)
    if (isFmem(m)) return fmemItems(parseBulk(m), k, { twice: true, name: (d) => `voice ${(d[0] & 31) + 1}`, build: (c, d) => bulk(c, 1, d) });
    if (isStatus(m)) { const s = parseStatus(m); return [{ key: `s${k}`, label: `Module status: channel ${s.channel + 1}${s.omni ? ', omni' : ''}${s.protect ? ', protected' : ''}`, name: '', msgs: [m] }]; }
    return null;
  },
  simulateRequest: (unit, d) => {
    const c = d[2] & 15;
    if (d[3] === 1) return [bulk(0, 1, unit.fn ||= initFn())];
    if (d[3] === 0x7d) return [bulk(0, 0x7d, [...[...HDR].map((x) => x.charCodeAt(0)), 1, 1, 0x0a, c, 0, 0])];
    return simulateFmem(unit, d, initFn) || [];
  },
  simulateBulk: (unit, b, d) => { if (b?.ok && b.format === 1) unit.fn = Uint8Array.from(b.data); else simulateFmem(unit, d, initFn); return []; },
  extend(def2, { ch }) {
    const v = def2.objects.find((o) => o.key === 'voice');
    v.request = (ctx) => dumpRequest(ch(ctx), 0);
    v.match = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0 && b.data.length === 155); };
    v.decode = (raw) => { const d = new Uint8Array(156); d.set(parseBulk(raw).data); d[155] = 0x3f; return d; };
    def2.objects.push({
      key: 'performance', page: 'Function data', icon: '▦', label: 'Function data', size: FN_SIZE,
      init: () => initFn(), params: fnParams(), cols: 3,
      request: (ctx) => dumpRequest(ch(ctx), 1),
      match: isFn,
      decode: (raw) => Uint8Array.from(parseBulk(raw).data),
      name: (d) => String.fromCharCode(...d.subarray(NAME + 3, NAME + 13)).trim(),
      note: 'The module\'s function data for its current voice (laid out like a DX1/DX5 performance). Each change is sent as you make it; the key limits are kept in the name as "Lo: / Hi:" text.',
      sendParam: (p, _v, d, ctx) => (SENT.has(p.offset) ? paramChange(ch(ctx), 1, p.offset, d[p.offset]) : bulk(ch(ctx), 1, d)),
      sendAll: { label: 'Send', title: 'Send the function data to the module', build: (d, ctx) => bulk(ch(ctx), 1, d) },
      toSyx: (d, ctx) => bulk(ch(ctx), 1, d),
      fromSyx: (msgs) => { const m = msgs.find(isFn); return m ? Uint8Array.from(parseBulk(m).data) : null; },
      // the module's 32 function memories (format 2, D347; received by D151: half A, or B in single mode on B)
      slots: fmemSlots({ label: 'Function memories', count: 32, twice: true, perVoice: true, perChannel: true, name: (d) => `${d[2] ? 'Mono' : 'Poly'}, PB rng ${d[3]}`, recall: (c, i) => [0xc0 | c, i], note: 'memory n belongs to voice n (Play selects the voice, which recalls its function memory); one copy per module (channel)' }),
      toCommon: fnToCommon,
      fromCommon: (c) => fnFromCommon(c),
    });
    def2.objects.push({
      key: 'modules', page: 'Modules', icon: '▤', label: 'Modules', size: 8 * MOD,
      init: initRack, params: moduleParams(), cols: 3,
      sections: Array.from({ length: 8 }, (_, m) => ({ key: `m${m}`, label: `Module ${m + 1}` })),
      note: 'The eight TF1 modules: each listens on its own MIDI channel. Find modules asks every channel for a module; with the modules\' MIDI OUTs merged, each one answers. Changes go to each module on its own channel.',
      actions: [
        {
          label: 'Find modules', title: 'Ask channels 1-16 for a TF1 module and fill in the module channels in the order they answer',
          run: async (api) => {
            const g = api.g;
            const found = [];
            const off = g.client?.on?.('unsolicited', (_m, raw) => { const s = raw && parseStatus(raw); if (s && !found.some((f) => f.channel === s.channel)) found.push(s); });
            try {
              g.setBusy?.(1, 'Asking channels 1-16');
              for (let c = 0; c < 16; c++) { api.send(dumpRequest(c, 0x7d)); await sleep(120); }
              await sleep(600);
            } finally { off?.(); g.setBusy?.(0); }
            if (!found.length) { api.toast('No TF1 answered (connect a module\'s MIDI OUT).', 'warn'); return; }
            const d = Uint8Array.from(api.data);
            found.slice(0, 8).forEach((s, m) => { d[m * MOD] = d[m * MOD + 7] = s.channel; d[m * MOD + 6] = s.protect ? 1 : 0; });
            api.setData(d);
            api.toast(`${found.length} module${found.length > 1 ? 's' : ''} answered: channel ${found.map((s) => s.channel + 1).join(', ')}`, 'good');
          },
        },
        {
          label: 'Send all', title: 'Send every module its voice, key limits, master tune, attenuation and memory protect (on its channel)',
          run: (api) => {
            const d = api.data;
            const out = [];
            for (let m = 0; m < 8; m++) {
              const b = m * MOD;
              out.push([0xc0 | d[b], d[b + 1]], paramChange(d[b], 4, 133, d[b + 2]), paramChange(d[b], 4, 134, d[b + 3]), paramChange(d[b], 1, 64, d[b + 4]), paramChange(d[b], 1, 26, d[b + 5]), paramChange(d[b], 4, 135, d[b + 6] ? 127 : 0));
            }
            api.send(out);
          },
        },
      ],
      receive: (raw, d) => {
        const s = parseStatus(raw);
        if (!s) return null;
        const next = Uint8Array.from(d);
        const m = Array.from({ length: 8 }, (_, i) => i).find((i) => next[i * MOD] === s.channel);
        if (m === undefined) return null;
        next[m * MOD + 6] = s.protect ? 1 : 0;
        return next;
      },
      multi: {
        page: 'MIDI channels', label: 'Modules', count: 8, section: (m) => `m${m}`, partLabel: (m) => `Module ${m + 1}`,
        columns: [
          { label: 'Voice', params: ['Voice'], role: 'patch' },
          { label: 'MIDI channel', params: ['MIDI channel'], role: 'channel' },
          { label: 'Key limits', params: ['Key limit low', 'Key limit high'] },
          { label: 'Attenuation', params: ['Attenuation'] },
          { label: 'Master tune', params: ['Master tune'] },
        ],
        note: 'Each module is a separate TF1 on its own channel; "Channels in order" gives modules 1-8 channels 1-8 (each change goes to the module on its old channel).',
      },
      toCommon: rackToCommon,
      fromCommon: (c) => rackFromCommon(c),
    });
  },
});

export const _test = { fnParams, initFn, readLimit, writeLimit, moduleParams, initRack, parseStatus, isFn, rackToCommon, rackFromCommon, fnToCommon, fnFromCommon, HDR };
export default def;
