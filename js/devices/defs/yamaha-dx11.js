// Yamaha DX11: the TX81Z's voice, additional data and performance formats (its v1.x firmware, 64 KB,
// holds the same bulk headers "LM  8976AE/PE/PM/S0/S1", "LM  MCRTE0/1", the same maximum tables at
// 05E6 and the TX81Z INIT VOICE at 009E), plus its own aftertouch data "LM  8023AE" and system
// "LM  8023S0". Built on yamaha-tx81z.js. Not yet checked on a DX11.
//
//   F0 43 0n 7E 00 14 "LM  8023AE" <10> cs F7   the voice edit buffer's aftertouch settings: RAM 2C29-2C2C
//                                               (after the voice at 2BB5 and its TX81Z additional data at
//                                               2C12), then six zeros (sender EE02 in the upper bank;
//                                               receiver DE17 keeps the first four); INIT DFF0: 0, 0, 50, 0.
//   Screen texts (lower bank 4572-4588, with the word tokens A4h "Pitch" and 9Ah "Amplitude" of the word
//   list 4290): "AT Pitch", "AT Amplitude", "AT P. Bias", "AT EG Bias".

import { buildTX81Z } from './yamaha-tx81z.js';
import { parseBulk, bulkHeader, dumpRequestHeader } from './yamaha-dx-sysex.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';

const AE = 'LM  8023AE';
const AE_SIZE = 10;
const isDx11 = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 0x7e && /^LM {2}8023/.test(b.header || '')); };
const isAe = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.header === AE && b.body.length === AE_SIZE); };
const initAe = () => Uint8Array.from([0, 0, 50, 0, 0, 0, 0, 0, 0, 0]);

// Maxima: the DX11's maximum table 05E6 continues after the TX81Z's additional data with 99, 99, 100, 99 (061A).
const aeParams = () => [
  { key: 'atp', label: 'AT Pitch', offset: 0, min: 0, max: 99, group: 'After touch', help: 'Aftertouch to pitch.' },
  { key: 'ata', label: 'AT Amplitude', offset: 1, min: 0, max: 99, group: 'After touch' },
  { key: 'atpb', label: 'AT P. Bias', offset: 2, min: 0, max: 100, group: 'After touch', format: (v) => `${v > 50 ? '+' : ''}${v - 50}`, help: 'Pitch bias: 50 = none (INIT DFF0).' },
  { key: 'ateb', label: 'AT EG Bias', offset: 3, min: 0, max: 99, group: 'After touch' },
  ...Array.from({ length: 6 }, (_, i) => ({ key: `atx${i}`, label: `Byte ${4 + i}`, offset: 4 + i, min: 0, max: 127, group: 'Not used', readOnly: true, help: 'Sent as 0 by the DX11 (EE5A), ignored when received (DE17).' })),
];

const def = buildTX81Z({
  id: 'yamaha-dx11', name: 'DX11',
  deviceIds: ['yamaha-tx81z'],
  recognise: isDx11,
  prefer: (msgs) => (msgs.some(isDx11) ? 3 : 1.1),
  libraryItem: (m, k) => {
    if (isAe(m)) return [{ key: `ae${k}`, label: 'After touch data (LM  8023AE)', name: '', object: 'aftertouch', data: Uint8Array.from(parseBulk(m).body), msgs: [m] }];
    return isDx11(m) ? [{ key: `x${k}`, label: `${parseBulk(m).header.trim()} (DX11 data, kept as it is)`, name: '', msgs: [m] }] : null;
  },
  moreRequests: [{ label: 'DX11 after touch data (LM  8023AE)', bytes: (ctx) => dumpRequestHeader(ctx?.channel ?? 0, AE) }],
  extend(def2, { ch }) {
    def2.objects.push({
      key: 'aftertouch', page: 'After touch', icon: '◇', label: 'After touch', size: AE_SIZE,
      init: initAe, params: aeParams(), cols: 4,
      request: (ctx) => dumpRequestHeader(ch(ctx), AE),
      match: isAe,
      decode: (raw) => Uint8Array.from(parseBulk(raw).body),
      note: 'The aftertouch settings of the voice being edited, a message of their own ("LM  8023AE"); no parameter change for them is known, so every change sends the whole message.',
      sendParam: (_p, _v, d, ctx) => bulkHeader(ch(ctx), AE, d),
      sendAll: { label: 'Send', title: 'Send the after touch data ("LM  8023AE")', build: (d, ctx) => bulkHeader(ch(ctx), AE, d) },
      toSyx: (d, ctx) => bulkHeader(ch(ctx), AE, d),
      fromSyx: (msgs) => { const m = msgs.find(isAe); return m ? Uint8Array.from(parseBulk(m).body) : null; },
      receive: (raw) => (isAe(raw) ? Uint8Array.from(parseBulk(raw).body) : null),
      toCommon: (d) => ({ model: COMMON_MODEL, kind: 'aftertouch', extra: { family: 'yamaha-dx', model: 'DX11', ae: toBase64(Uint8Array.from(d)), match: toBase64(Uint8Array.from(d)) } }),
      fromCommon: (c) => {
        const report = emptyReport();
        if (c?.extra?.ae && fromBase64(c.extra.ae).length === AE_SIZE) { report.mapped.push('the whole after touch data (DX11)'); return { data: fromBase64(c.extra.ae), report }; }
        report.dropped.push('after touch data of another model');
        return { data: initAe(), report };
      },
    });
  },
  coverage: 'The TX81Z definition (voice with additional data, 32 voices, performance with MIDI channels page), which the DX11 shares (same headers and maximum tables in its firmware), and its own after touch data ("LM  8023AE": AT Pitch, AT Amplitude, AT P. Bias, AT EG Bias, from its sender, receiver and screens). Not yet checked on a DX11.',
});

export default def;
