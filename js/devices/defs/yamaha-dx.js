// Yamaha DX family editors: the code the models share. buildDX(M) makes a definition from a model
// config (yamaha-dx7.js, yamaha-tx7.js, ...). Voice format, algorithms and value displays:
// yamaha-dx-voice.js; SysEx: yamaha-dx-sysex.js; graphics: yamaha-dx-draw.js; Head Library:
// yamaha-dx-translate.js. Firmware evidence: docs/devices/yamaha-dx7.md.
//
// A model config M:
//   id, name                      catalog id and model name
//   fw                            value texts of the model's firmware (CURVES, WAVES, OFFON, OSC_MODES, NOTES,
//                                 DETUNE, FIXED, INIT (packed init voice)), labels / help per voice field
//   requests                      true when the unit answers dump requests (F0 43 2n ff F7)
//   functionParams                [{num, label, max, options?, bits?...}] group 2 parameters (function object), or null
//   coverage, notes               texts for the Connect page and the voice page
//   extend(def, tools)            adds the model's own objects (performance, ...)
//   libraryItem(m, k, msgs)       Branch Library items for the model's own messages
//   simulateRequest/Bulk/Param    the demo unit's answers to the model's own messages
//   amem                          {format, size, pack(aced), unpack(bytes), fromVoice(vced)}: the additional data
//                                 of the 32 voices (DX7II AMEM, sent before the VMEM); the editor keeps it with
//                                 its bank, sends it first, and makes it the model's way when a bank has none

import { h, toast, downloadBlob, pickFiles, safeFileName } from '../../core/ui/dom.js';
import { sysexMessages } from '../../core/midi/smf.js';
import {
  VCED_SIZE, VOICE_SIZE, VMEM_SIZE, OPON, NAME, ALGORITHMS, opBase, vcedToVmem, vmemToVced, bankVoices, voiceName, vmemName,
  setVoiceName, voiceParams, voiceSections, initVoice, initBank, bpText,
} from './yamaha-dx-voice.js';
import { bulk, parseBulk, paramChange, parseParamChange, dumpRequest, isYamaha, isRequest } from './yamaha-dx-sysex.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { algorithmCard, algorithmGallery, egGraph, scalingGraph } from './yamaha-dx-draw.js';
import { dxTranslator } from './yamaha-dx-translate.js';

export const BANK_KEY = 'voice-bank'; // g.objectData key of the 32-voice bank the editor holds
export const AMEM_KEY = 'voice-amem'; // ... and its additional data (models with M.amem)
const BANK_SIZE = 32 * VMEM_SIZE;

// ------------------------------------------------------------------ messages
export const msg = {
  voice: (ch, d) => bulk(ch, 0, d.subarray ? d.subarray(0, VCED_SIZE) : d.slice(0, VCED_SIZE)),
  bank: (ch, b) => bulk(ch, 9, b),
  voiceParam: (ch, num, v) => paramChange(ch, 0, num, v),
  functionParam: (ch, num, v) => paramChange(ch, 2, num, v),
  request: (ch, format) => dumpRequest(ch, format),
  program: (ch, n) => [0xc0 | (ch & 15), n & 0x7f],
};

const isBulk = (raw, format, size) => { const b = parseBulk(raw); return !!(b && b.ok && b.format === format && b.data.length === size); };
export const isVoiceBulk = (raw) => isBulk(raw, 0, VCED_SIZE);
export const isBankBulk = (raw) => isBulk(raw, 9, BANK_SIZE);
/** Voice edit data from a single-voice bulk (all operators on). */
export function voiceFromBulk(raw) {
  const v = new Uint8Array(VOICE_SIZE);
  v.set(parseBulk(raw).data.subarray(0, VCED_SIZE));
  v[OPON] = 0x3f;
  return v;
}

/** Wait for a message the unit sends by itself (e.g. after MIDI TRANSMIT on its panel). */
export function waitForMessage(g, match, timeout = 60000) {
  return new Promise((resolve, reject) => {
    let off = null;
    const t = setTimeout(() => { off?.(); reject(new Error(`Nothing arrived from the ${g.entry?.model || 'unit'} within ${Math.round(timeout / 1000)} s`)); }, timeout);
    off = g.client.on('unsolicited', (_m, raw) => { if (raw && match(raw)) { clearTimeout(t); off(); resolve(Uint8Array.from(raw)); } });
  });
}

/** A one-line description of a DX family message (SysEx console, Branch Library). */
export function describe(raw, model = 'DX') {
  if (!isYamaha(raw)) return null;
  const n = (raw[2] & 15) + 1;
  const pc = parseParamChange(raw);
  if (pc) return `${model} parameter change ch ${n}: group ${pc.group} parameter ${pc.num} = ${pc.value}`;
  if (isRequest(raw)) return `${model} dump request ch ${n}, format ${raw[3]}${raw[3] === 0x7e ? ` ${String.fromCharCode(...raw.slice(4, 14))}` : ''}`;
  const b = parseBulk(raw);
  if (!b) return null;
  const what = { 0: 'voice (VCED)', 1: 'function data', 2: '32 function memories', 3: '4-operator voice', 4: '32 4-operator voices', 5: 'additional voice data (ACED)', 6: 'additional data of 32 voices (AMEM)', 9: '32 voices (VMEM)' }[b.format] || (b.header ? b.header : `format ${b.format}`);
  const name = b.format === 0 && b.data.length >= VCED_SIZE ? ` "${voiceName(b.data)}"` : '';
  return `${model} bulk ch ${n}: ${what}${name}, ${b.data.length} bytes${b.ok ? '' : ' (checksum or length wrong)'}`;
}

// ------------------------------------------------------------------ simulator (demo mode and tests)
/** A unit that keeps an edit buffer, a voice bank and function values, and answers like the model. */
export function simulator(M, init) {
  // M.voiceBanks: a unit with more voices than a bulk holds (unit.banks[b], unit.amems[b]); unit.bank / unit.amem
  // are bank 0's. VB.simOut(unit) / simIn(unit): the bank a request answers / a bulk goes into.
  const VB = M.voiceBanks || null;
  const unit = { voice: init(), banks: {}, amems: {}, fn: new Uint8Array(16), received: [] };
  for (const [b] of VB ? VB.banks : [[0]]) {
    const n = VB ? VB.count(b) / 32 : 1;
    unit.banks[b] = Uint8Array.from(Array.from({ length: n }, () => Array.from(initBank(M.fw.INIT))).flat());
  }
  Object.defineProperty(unit, 'bank', { get: () => unit.banks[0], set: (v) => { unit.banks[0] = v; } });
  Object.defineProperty(unit, 'amem', { get: () => unit.amems[0], set: (v) => { unit.amems[0] = v; } });
  const amemAt = (b) => (unit.amems[b] ||= amemFromBank(M.amem, unit.banks[b]));
  return {
    unit,
    handle(d) {
      unit.received.push(Uint8Array.from(d));
      if (d[0] === 0xc0) {
        const [b, i] = VB ? VB.slotOf(d[1]) : [0, d[1] & 31];
        const bank = unit.banks[b];
        if (!bank) return [];
        unit.voice.set(vmemToVced(bank.subarray(i * VMEM_SIZE, (i + 1) * VMEM_SIZE)));
        if (M.amem && M.A) {
          const am = bank.length === BANK_SIZE ? amemAt(b) : amemFromBank(M.amem, bank.subarray((i & ~31) * VMEM_SIZE, ((i & ~31) + 32) * VMEM_SIZE));
          unit.voice.set(M.amem.unpack(am.subarray((i & 31) * M.amem.size, ((i & 31) + 1) * M.amem.size)), VOICE_SIZE);
        }
        return [];
      }
      if (!isYamaha(d)) return null;
      const pc = parseParamChange(d);
      if (pc) {
        if (pc.group === 0 && pc.num < VOICE_SIZE) unit.voice[pc.num] = pc.value;
        if (M.A && pc.group === M.A.group && pc.num < M.A.size) unit.voice[VOICE_SIZE + pc.num] = pc.value;
        if (pc.group === 2 && pc.num >= 64 && pc.num < 80) unit.fn[pc.num - 64] = pc.value;
        M.simulateParam?.(unit, pc, d);
        return [];
      }
      if (isRequest(d)) {
        if (!M.requests) return []; // the DX7 ignores requests
        if (d[3] === 0) return [msg.voice(d[2] & 15, unit.voice)];
        if (M.A && d[3] === M.A.format) return [bulk(d[2] & 15, M.A.format, unit.voice.subarray(VOICE_SIZE, VOICE_SIZE + M.A.size))];
        const out = VB?.simOut?.(unit) ?? 0;
        if (d[3] === 9) return [msg.bank(d[2] & 15, unit.banks[out])];
        if (M.amem && d[3] === M.amem.format) return [bulk(d[2] & 15, M.amem.format, amemAt(out))];
        return M.simulateRequest?.(unit, d) ?? [];
      }
      const b = parseBulk(d);
      if (b?.ok && b.format === 0 && b.data.length === VCED_SIZE) { unit.voice.set(b.data); unit.voice[OPON] = 0x3f; return []; }
      if (M.A && b?.ok && b.format === M.A.format && b.data.length === M.A.size) { unit.voice.set(b.data, VOICE_SIZE); return []; }
      if (b?.ok && b.format === 9 && b.data.length === BANK_SIZE) {
        const into = VB?.simIn?.(unit) ?? 0;
        unit.banks[into] = Uint8Array.from(b.data);
        // the DX7II keeps an AMEM received just before; otherwise it makes one from the voices
        if (M.amem) unit.amems[into] = unit.amemNext || amemFromBank(M.amem, unit.banks[into]);
        unit.amemNext = null;
        return [];
      }
      if (M.amem && b?.ok && b.format === M.amem.format && b.data.length === 32 * M.amem.size) { unit.amems[VB?.simIn?.(unit) ?? 0] = Uint8Array.from(b.data); unit.amemNext = Uint8Array.from(b.data); return []; }
      return M.simulateBulk?.(unit, b, d) ?? [];
    },
  };
}

/** The additional data of 32 voices the model makes for a bank that came without it (M.amem.fromVoice). */
export function amemFromBank(AM, bank) {
  const out = new Uint8Array(32 * AM.size);
  for (let i = 0; i < 32; i++) out.set(AM.pack(AM.fromVoice(vmemToVced(bank.subarray(i * VMEM_SIZE, (i + 1) * VMEM_SIZE)))), i * AM.size);
  return out;
}

// ------------------------------------------------------------------ the definition
export function buildDX(M) {
  const FW = M.fw;
  // Models with additional voice data (DX7II ACED): M.aced = {size, format, group, params (offset = aced byte),
  // label}; the voice object is the VCED (156 bytes) followed by it. M.initVoice() gives the whole init voice.
  const A = M.aced || null;
  const SIZE = VOICE_SIZE + (A ? A.size : 0);
  const init = M.initVoice || (() => initVoice(FW.INIT));
  const params = [...voiceParams({ fw: FW, labels: M.labels, help: M.help, stage: M.stage }), ...(A ? A.params.map((p) => ({ ...p, offset: VOICE_SIZE + p.aced })) : [])];
  const isAced = (raw) => { if (!A) return false; const b = parseBulk(raw); return !!(b?.ok && b.format === A.format && b.data.length === A.size); };
  /** Edit data from VCED bytes (155 or 156) and, for an ACED model, its ACED (else the init values). */
  const full = (vced, aced = null) => {
    const d = init();
    d.set(vced.subarray(0, Math.min(VOICE_SIZE, vced.length)));
    if (vced.length < VOICE_SIZE) d[OPON] = 0x3f;
    if (A && aced) d.set(aced.subarray(0, A.size), VOICE_SIZE);
    return d;
  };
  const voiceMsgs = (ch2, d) => [...(A ? [bulk(ch2, A.format, d.subarray(VOICE_SIZE, VOICE_SIZE + A.size))] : []), msg.voice(ch2, d)];
  const TR = dxTranslator({
    model: M.name, params, init, fw: FW,
    ...(A ? {
      extraOf: (d) => ({ aced: toBase64(Uint8Array.from(d.subarray(VOICE_SIZE, SIZE))) }),
      applyExtra: (d, x, report) => {
        if (x.aced) { d.set(fromBase64(x.aced).subarray(0, A.size), VOICE_SIZE); report.mapped.push(`the ${A.label}`); } else report.approximated.push(`${A.label}: the ${M.name}'s initial values (the voice has none)`);
      },
    } : {}),
  });
  const ch = (ctx) => ctx?.channel ?? 0;
  // The voice banks of the slot list. Most models: the 32 voices of the bulk. M.voiceBanks, for a unit with more
  // voices than a bulk holds (the DX7II's 64 internal and the cartridge's): {banks: [[id, label]], internal(b) (a
  // bulk reads and writes it), count(b), program(b, i), slotOf(program) -> [b, i], slotLabel(b, i), read(api, b, go)
  // (wraps a bulk read of bank b, e.g. switching the unit's MIDI out bank), storeMsgs(ctx, b, msgs) (wraps the
  // messages that write bank b), outBank(ctx) (the bank a bulk the unit sends by itself holds), notes,
  // recall(ctx, b, i) (Play, instead of a program change), playNote(b, ctx) (what Play does, for the note)}.
  // M.selectFetch(api, program, {ch, full, isAced, bank, slot}) reads a voice by selecting it on the unit.
  const VB = M.voiceBanks || null;
  const BANKS = VB ? VB.banks : [[0, 'INTERNAL 1-32']];
  const INTERNAL = BANKS.map(([b]) => b).filter((b) => !VB || VB.internal(b));
  const countOf = (b) => (VB ? VB.count(b) : 32);
  const programOf = (b, i) => (VB ? VB.program(b, i) : i);
  const bankKey = (b = 0) => (b ? `${BANK_KEY}-${b + 1}` : BANK_KEY);
  const amemKey = (b = 0) => (b ? `${AMEM_KEY}-${b + 1}` : AMEM_KEY);
  const bankLabel = (b) => BANKS.find(([x]) => x === b)?.[1] ?? '';
  const bankOf = (ctx, b = 0) => ctx?.data?.[bankKey(b)] || null;
  const bankLoaded = (ctx, b = 0) => !!(bankOf(ctx, b) && ctx.loaded?.has?.(bankKey(b)));
  // Additional data of the 32 voices (DX7II AMEM): kept with the bank, sent before it.
  const AM = M.amem || null;
  const isAmemBulk = (raw) => !!AM && isBulk(raw, AM.format, 32 * AM.size);
  let amemPending = false; // an AMEM arrived and the VMEM it belongs to is next
  /** The bank's additional data: the one read with it, or the model's own for a bank that came without. */
  const amemOf = (data, b = 0) => (AM && data?.[bankKey(b)] ? (data[amemKey(b)] ||= amemFromBank(AM, data[bankKey(b)])) : null);
  const acedOf = (amem, i) => (AM && amem ? AM.unpack(amem.subarray(i * AM.size, (i + 1) * AM.size)) : null);
  /** The messages that put a bank (and its additional data) into the unit: AMEM first, then VMEM. */
  const bankMsgs = (c, data, b = 0) => [...(AM ? [bulk(c, AM.format, amemOf(data, b))] : []), msg.bank(c, data[bankKey(b)])];
  /** ... into bank b of the unit (M.voiceBanks: with the messages that point the unit's bulk receive at it). */
  const writeMsgs = (ctx, data, b = 0) => (VB?.storeMsgs ? VB.storeMsgs(ctx, b, bankMsgs(ch(ctx), data, b)) : bankMsgs(ch(ctx), data, b));
  /** Read bank b (and, for AMEM models, its additional data first) into g.objectData. */
  async function readBank(api, b = 0) {
    const g = api.g;
    const go = async () => {
      let amem = null;
      if (AM) amem = Uint8Array.from(parseBulk(await api.request(msg.request(ch(api.ctx), AM.format), isAmemBulk, (r) => r)).data);
      const raw = await api.request(msg.request(ch(api.ctx), 9), isBankBulk, (r) => r);
      return { bank: Uint8Array.from(parseBulk(raw).data), amem };
    };
    const r = VB?.read ? await VB.read(api, b, go) : await go();
    g.objectData[bankKey(b)] = r.bank;
    if (AM) g.objectData[amemKey(b)] = r.amem;
    g.loadedKeys?.add(bankKey(b));
    return r.bank;
  }
  /** Which internal bank a bank action works on: asked when the model has more than one. */
  async function pickBank(api, title, extra = []) {
    if (INTERNAL.length < 2 && !extra.length) return { bank: INTERNAL[0] };
    return api.form(title, [...extra, ...(INTERNAL.length > 1 ? [{ key: 'bank', label: 'Voices', type: 'select', value: String(INTERNAL[0]), options: INTERNAL.map((b) => [String(b), bankLabel(b)]) }] : [])])
      .then((r) => (r ? { ...r, bank: Number(r.bank ?? INTERNAL[0]) } : null));
  }

  const opOn = (d) => (op) => !!(d[OPON] & (1 << (6 - op)));
  const groupInfo = {
    Algorithm: {
      wide: true,
      note: 'The operators and how they connect (the DX7\'s printed algorithm chart): carriers sound on the output line, the others modulate the operator below them; the accent loop is the feedback path FEEDBACK sets.',
      draw: ({ data }) => algorithmCard({
        algorithms: ALGORITHMS, current: data[134] & 31,
        on: opOn(data), level: (op) => data[opBase(op) + 16] / 99,
      }),
    },
    'Pitch EG': {
      draw: ({ data, set, prev }) => egGraph({
        rates: [0, 1, 2, 3].map((i) => data[126 + i]), levels: [0, 1, 2, 3].map((i) => data[130 + i]), center: true, prev, set, label: 'P EG',
        keys: { r: ['pr1', 'pr2', 'pr3', 'pr4'], l: ['pl1', 'pl2', 'pl3', 'pl4'] },
      }),
    },
  };
  // Each operator's EG and keyboard scaling cards draw that operator.
  for (let op = 1; op <= 6; op++) {
    const b = opBase(op);
    groupInfo[`OP${op} EG`] = {
      draw: ({ data, set, prev }) => egGraph({
        rates: [0, 1, 2, 3].map((i) => data[b + i]), levels: [0, 1, 2, 3].map((i) => data[b + 4 + i]), prev, set, label: `OP${op} EG`,
        keys: { r: [1, 2, 3, 4].map((i) => `op${op}_r${i}`), l: [1, 2, 3, 4].map((i) => `op${op}_l${i}`) },
      }),
    };
    groupInfo[`OP${op} Keyboard level scaling`] = {
      draw: ({ data }) => scalingGraph({ bp: data[b + 8], ld: data[b + 9], rd: data[b + 10], lc: data[b + 11], rc: data[b + 12], bpText: (v) => bpText(FW, v) }),
    };
  }
  const opLayout = Array.from({ length: 6 }, (_, i) => [
    { group: `OP${i + 1} Oscillator` },
    { group: `OP${i + 1} EG`, rows: [{ label: 'Rate', keys: [1, 2, 3, 4].map((k) => `op${i + 1}_r${k}`) }, { label: 'Level', keys: [1, 2, 3, 4].map((k) => `op${i + 1}_l${k}`) }] },
    { group: `OP${i + 1} Keyboard level scaling` }, { group: `OP${i + 1} Output and sensitivity` },
  ]).flat();

  const voiceObj = {
    key: 'voice', page: 'Voice', icon: '◆', label: 'Voice', size: SIZE,
    init,
    params,
    sections: voiceSections(),
    sectionLabel: 'Operator',
    layout: [
      { group: 'Algorithm', wide: true }, { group: 'LFO' }, { group: 'Pitch EG', rows: [{ label: 'Rate', keys: ['pr1', 'pr2', 'pr3', 'pr4'] }, { label: 'Level', keys: ['pl1', 'pl2', 'pl3', 'pl4'] }] }, { group: 'Voice' },
      ...opLayout,
    ],
    groupInfo,
    // the Algorithm tab (after Voice): every algorithm's diagram as a button (views/gallery.js)
    galleries: [algorithmGallery({
      algorithms: ALGORITHMS, param: 'als', on: opOn, level: (d, op) => d[opBase(op) + 16] / 99,
      note: 'The operators and how they connect: carriers sound on the output line, the others modulate the operator below them; the accent loop is the feedback path. Shading: the voice\'s output levels; dashed: operator off.',
    })],
    cols: 2,
    name: voiceName,
    setName: (d, name) => setVoiceName(d, name),
    note: M.notes?.voice || null,
    sendParam: (p, _v, d, ctx) => {
      if (p.aced !== undefined) return paramChange(ch(ctx), A.group, p.aced, d[p.offset]);
      return p.vced === OPON ? msg.voiceParam(ch(ctx), OPON, d[OPON]) : msg.voiceParam(ch(ctx), p.vced, d[p.offset]);
    },
    sendAll: {
      label: 'Send to edit buffer', title: `Send the whole voice (${A ? `${A.label}, format ${A.format}, then ` : ''}single-voice bulk, format 0); the operator on/off switches follow as a parameter change`,
      build: (d, ctx) => [...voiceMsgs(ch(ctx), d), ...(d[OPON] !== 0x3f ? [msg.voiceParam(ch(ctx), OPON, d[OPON])] : [])],
    },
    toSyx: (d, ctx) => voiceMsgs(ch(ctx), d),
    fromSyx: (msgs) => {
      const one = msgs.find(isVoiceBulk);
      const ac = msgs.find(isAced);
      if (one) return full(parseBulk(one).data, ac ? parseBulk(ac).data : null);
      const b = msgs.find(isBankBulk);
      return b ? full(vmemToVced(parseBulk(b).data.subarray(0, VMEM_SIZE))) : null;
    },
    // What the unit sends by itself: a voice when one is selected (SYS INFO AVAIL), parameter changes
    // while editing on the panel, and the 32 voices after MIDI TRANSMIT.
    receive: (raw, d, ctx) => {
      if (isVoiceBulk(raw)) { const next = Uint8Array.from(d); next.set(parseBulk(raw).data); next[OPON] = 0x3f; return next; }
      if (isAced(raw)) { const next = Uint8Array.from(d); next.set(parseBulk(raw).data, VOICE_SIZE); return next; }
      const pc = parseParamChange(raw);
      if (pc && pc.group === 0 && pc.num < VOICE_SIZE && pc.channel === ch(ctx)) {
        const next = Uint8Array.from(d);
        next[pc.num] = pc.value;
        return next;
      }
      if (A && pc && pc.group === A.group && pc.num < A.size && pc.channel === ch(ctx)) {
        const next = Uint8Array.from(d);
        next[VOICE_SIZE + pc.num] = pc.value;
        return next;
      }
      if (isBankBulk(raw) && ctx?.data) {
        const b = VB?.outBank?.(ctx) ?? 0; // the bank the unit sends (DX7II: its MIDI out voice bank)
        ctx.data[bankKey(b)] = Uint8Array.from(parseBulk(raw).data);
        if (AM && !amemPending) delete ctx.data[amemKey(b)]; // none came just before: the model makes its own
        amemPending = false;
        ctx.loaded?.add?.(bankKey(b));
        toast(`32 voices received from the ${M.name}${VB ? ` (${bankLabel(b)})` : ''}`, 'good', 2000);
        return Uint8Array.from(d);
      }
      if (isAmemBulk(raw) && ctx?.data) {
        ctx.data[amemKey(VB?.outBank?.(ctx) ?? 0)] = Uint8Array.from(parseBulk(raw).data);
        amemPending = true;
        return Uint8Array.from(d);
      }
      return null;
    },
    actions: [
      { label: 'Init', title: `The ${M.name}'s VOICE INIT (not sent until you change something or press Send)`, run: (api) => api.setData(init()) },
      {
        label: 'Rename', title: 'Change the voice name (sent as parameter changes 145-154)', run: async (api) => {
          const r = await api.form('Voice name', [{ key: 'name', label: 'Name (10 characters)', value: voiceName(api.data), maxlength: 10 }]);
          if (!r) return;
          const d = setVoiceName(Uint8Array.from(api.data), r.name);
          api.send(Array.from({ length: 10 }, (_, i) => msg.voiceParam(ch(api.ctx), NAME + i, d[NAME + i])));
          api.setData(d);
        },
      },
      {
        label: `Get ${INTERNAL.length * 32} voices`, title: M.requests ? `Ask for the internal voices (${AM ? 'their additional data (AMEM), then ' : ''}32-voice bulk${INTERNAL.length > 1 ? `, for each of ${INTERNAL.map(bankLabel).join(' and ')}` : ''})` : `Wait for the ${M.name} to send its 32 voices (FUNCTION, MIDI TRANSMIT)`,
        run: async (api) => {
          const g = api.g;
          try {
            if (M.requests) {
              for (const b of INTERNAL) { g.setBusy?.(1, `Reading ${INTERNAL.length > 1 ? bankLabel(b) : '32 voices'}`); await readBank(api, b); }
            } else {
              g.setBusy?.(1, `Waiting for MIDI TRANSMIT on the ${M.name}`);
              toast(`On the ${M.name}: FUNCTION, button 8 (MIDI CH / SYS INFO / MIDI TRANSMIT) until MIDI TRANSMIT ?, then YES. SYS INFO AVAIL must be on.`, 'info', 12000);
              const raw = await waitForMessage(g, isBankBulk, 90000);
              g.objectData[BANK_KEY] = Uint8Array.from(parseBulk(raw).data);
              g.loadedKeys?.add(BANK_KEY);
            }
          } finally { g.setBusy?.(0); }
          api.toast(`${INTERNAL.length * 32} voices received from the ${M.name}`, 'good', 2000);
          api.setData(Uint8Array.from(api.data));
        },
      },
      {
        label: 'Bank file...', title: 'Open a 32-voice .syx file as the editor\'s bank (nothing is sent), or save the bank',
        run: async (api) => {
          const r = await pickBank(api, '32-voice bank', [{ key: 'what', label: 'Bank', type: 'select', value: 'open', options: [['open', 'Open a .syx file as the bank'], ['save', 'Save the bank as .syx']] }]);
          if (!r) return;
          const g = api.g;
          const bk = r.bank;
          if (r.what === 'save') {
            const data = { [BANK_KEY]: bankOf(api.ctx, bk) || initBank(FW.INIT), [AMEM_KEY]: api.ctx?.data?.[amemKey(bk)] };
            downloadBlob(Uint8Array.from(bankMsgs(ch(api.ctx), data).flat()), `${safeFileName(`${M.name} ${INTERNAL.length > 1 ? bankLabel(bk) : '32 voices'}`)}.syx`, 'application/octet-stream');
            return;
          }
          const files = await pickFiles('.syx,.mid', false);
          if (!files?.length) return;
          const msgs = sysexMessages(new Uint8Array(await files[0].arrayBuffer()));
          const k = msgs.findIndex(isBankBulk);
          if (k < 0) { api.toast('No 32-voice bulk (format 9) in that file.', 'warn'); return; }
          g.objectData[bankKey(bk)] = Uint8Array.from(parseBulk(msgs[k]).data);
          if (AM) {
            const am = [msgs[k - 1], msgs[k + 1]].find(isAmemBulk);
            if (am) g.objectData[amemKey(bk)] = Uint8Array.from(parseBulk(am).data);
            else delete g.objectData[amemKey(bk)]; // made from the voices, as the unit does
          }
          g.loadedKeys?.delete(bankKey(bk)); // from a file: Store must not overwrite the unit's voices with it unasked
          api.toast('Bank opened. Edit loads its voices; Send bank puts all 32 into the unit.', 'info');
          api.setData(Uint8Array.from(api.data));
        },
      },
      {
        label: 'Send bank', title: 'Send the editor\'s 32 voices to the unit (32-voice bulk): replaces every internal voice of the bank',
        run: async (api) => {
          const r = await pickBank(api, 'Send bank');
          if (!r) return;
          const b = bankOf(api.ctx, r.bank);
          if (!b) { api.toast(`The editor holds no ${INTERNAL.length > 1 ? bankLabel(r.bank) : 'bank'} yet: Get the voices or open a bank file first.`, 'warn'); return; }
          if (!(await api.confirm('Send bank', `Replace ${INTERNAL.length > 1 ? `the internal voices ${bankLabel(r.bank).replace(/^INTERNAL /, '')}` : 'all 32 internal voices'} of the ${M.name} with the editor's bank? ${M.bankNote || ''}`, 'Send', true))) return;
          for (const m of writeMsgs(api.ctx, api.g.objectData, r.bank)) api.send(m);
          api.g.loadedKeys?.add(bankKey(r.bank));
        },
      },
    ],
    slots: {
      label: VB ? 'Voices' : 'Internal voices', banks: BANKS, count: VB ? (b) => countOf(b) : 32,
      slotLabel: VB?.slotLabel || ((_b, i) => String(i + 1).padStart(2, '0')),
      names: (bank, ctx) => {
        const b = INTERNAL.includes(bank) ? bankOf(ctx, bank) : null;
        return b ? Array.from({ length: 32 }, (_, i) => vmemName(b.subarray(i * VMEM_SIZE, (i + 1) * VMEM_SIZE))) : null;
      },
      scannable: (bank) => !!M.requests && (INTERNAL.includes(bank) || !!M.selectFetch),
      scanNote: (bank) => (INTERNAL.includes(bank) ? null : `Reads each voice by selecting it on the ${M.name} (program change) and reading its edit buffer: the voice being edited is replaced.`),
      scanBank: async (api, bank, onName, shouldStop) => {
        if (INTERNAL.includes(bank)) {
          const b = await readBank(api, bank);
          for (let i = 0; i < 32; i++) onName(i, vmemName(b.subarray(i * VMEM_SIZE, (i + 1) * VMEM_SIZE)));
          return;
        }
        // a bank no bulk carries (the DX7II's cartridge): select each voice and read the edit buffer
        for (let i = 0; i < countOf(bank); i++) {
          if (shouldStop?.()) break;
          onName(i, voiceName(await M.selectFetch(api, programOf(bank, i), { ch, full, isAced, bank, slot: i })));
        }
      },
      note: (bank, ctx) => {
        const first = programOf(bank, 0) + 1;
        const play = VB?.playNote ? VB.playNote(bank, ctx) : `Play sends program change ${first}-${first + countOf(bank) - 1}.`;
        if (!INTERNAL.includes(bank)) return `${play} ${VB?.notes?.[bank] || ''}`.trim();
        const what = INTERNAL.length > 1 ? `voices ${bankLabel(bank).replace(/^INTERNAL /, '')}` : '32 voices';
        return bankOf(ctx, bank)
          ? `Names and Edit come from the editor's copy of the ${what}${bankLoaded(ctx, bank) ? ' (read from the unit)' : ' (from a file: not known to match the unit)'}. ${play} Store puts the voice into the copy and sends all 32 voices${VB?.storeNote ? ` ${VB.storeNote}` : ''}.`
          : `No bank yet: use Get ${INTERNAL.length * 32} voices${M.requests ? '' : ` (the ${M.name} sends them with MIDI TRANSMIT; it answers no requests)`} or Bank file. ${play}`;
      },
      name: voiceName,
      recall: (bank, i, ctx) => (VB?.recall ? VB.recall(ctx, bank, i) : msg.program(ch(ctx), programOf(bank, i))),
      fetch: async (api, bank, i) => {
        const internal = INTERNAL.includes(bank);
        let b = internal ? bankOf(api.ctx, bank) : null;
        if (internal && !b && M.requests) b = await readBank(api, bank);
        if (M.selectFetch && api.g?.connected) return M.selectFetch(api, programOf(bank, i), { ch, full, isAced, bank, slot: i });
        if (!internal) throw new Error(`Connect the ${M.name}: Edit selects the voice on it and reads the edit buffer.`);
        if (!b) throw new Error('The editor holds no bank yet: Get 32 voices or open a bank file first.');
        return full(vmemToVced(b.subarray(i * VMEM_SIZE, (i + 1) * VMEM_SIZE)), acedOf(amemOf(api.g?.objectData || api.ctx?.data, bank), i));
      },
      // The DX7 has no single-voice write: the voice goes into the editor's copy of the bank and the
      // whole bank is sent (memory protect INTERNAL off). Only offered once the bank was read from the unit.
      // AMEM models: the voice's additional data goes into the copy of the AMEM, sent first.
      writable: (bank, ctx) => INTERNAL.includes(bank) && bankLoaded(ctx, bank),
      store: (bank, i, ctx, d) => {
        const b = bankOf(ctx, bank);
        b.set(vcedToVmem(d), i * VMEM_SIZE);
        if (AM) amemOf(ctx.data, bank).set(AM.pack(d.subarray(VOICE_SIZE, VOICE_SIZE + (A ? A.size : 0))), i * AM.size);
        return writeMsgs(ctx, ctx.data, bank);
      },
    },
    toCommon: (d) => TR.toCommon(d),
    fromCommon: (c, base) => TR.fromCommon(c, base),
  };

  const objects = [voiceObj];
  if (M.functionParams) objects.push(functionObject(M, ch));

  // Branch Library / Head Library: a 32-voice bulk is 32 voices; a single voice is one.
  function libraryItems(msgs) {
    const items = [];
    msgs.forEach((m, k) => {
      if (isAced(m) && msgs[k + 1] && isVoiceBulk(msgs[k + 1])) return; // read with the voice that follows it
      if (isAmemBulk(m) && (isBankBulk(msgs[k + 1]) || isBankBulk(msgs[k - 1]))) return; // read with its bank
      if (isVoiceBulk(m)) {
        const ac = k > 0 && isAced(msgs[k - 1]) ? msgs[k - 1] : null;
        const d = full(parseBulk(m).data, ac ? parseBulk(ac).data : null);
        items.push({ key: `v${k}`, label: `Voice "${voiceName(d)}"`, name: voiceName(d), object: 'voice', data: d, msgs: ac ? [ac, m] : [m] });
      } else if (isBankBulk(m)) {
        const amm = AM ? [msgs[k - 1], msgs[k + 1]].find(isAmemBulk) : null;
        const amem = AM ? (amm ? parseBulk(amm).data : amemFromBank(AM, parseBulk(m).data)) : null;
        bankVoices(parseBulk(m).data).forEach((v, i) => {
          const d = full(v, acedOf(amem, i));
          items.push({ key: `b${k}-${i}`, label: `${String(i + 1).padStart(2, '0')} ${voiceName(d)}`, name: voiceName(d), object: 'voice', data: d, msgs: voiceMsgs(parseBulk(m).channel, d).map((x) => Uint8Array.from(x)) });
        });
      } else {
        const more = M.libraryItem?.(m, k, msgs);
        items.push(...(more || [{ key: `m${k}`, label: describe(m, M.name) || `Message ${k + 1}`, name: '', msgs: [m] }]));
      }
    });
    return items;
  }

  const def = {
    coverage: M.coverage,
    sysex: { manufacturer: [0x43] },
    minGap: 60,
    describe: (raw) => describe(raw, M.name),
    recognise: (raw) => isVoiceBulk(raw) || isBankBulk(raw) || isAced(raw) || !!M.recognise?.(raw),
    isOwn: (raw) => { const b = parseBulk(raw); return !!(b && [0, 9, ...(A ? [A.format] : []), ...(M.formats || [])].includes(b.format)); },
    isRequest,
    prefer: M.prefer || (() => 1),
    deviceIds: M.deviceIds || [],
    simulate: () => simulator({ ...M, A }, init),
    libraryItems,
    objects,
    requests: M.requests ? [
      { label: 'Voice edit buffer', bytes: (ctx) => msg.request(ch(ctx), 0) },
      { label: '32 internal voices', bytes: (ctx) => msg.request(ch(ctx), 9), timeout: 4000 },
      ...(M.moreRequests || []),
    ] : [],
    templates: [
      { label: 'Parameter change: ALGORITHM = 1', bytes: (ctx) => msg.voiceParam(ch(ctx), 134, 0) },
      { label: 'Dump request: 32 voices (not answered by the DX7)', bytes: (ctx) => msg.request(ch(ctx), 9) },
    ],
    midiNotes: M.midiNotes || [],
  };
  M.extend?.(def, { msg, ch, init, TR, full, isAced, voiceMsgs, SIZE });
  return def;
}

// ------------------------------------------------------------------ function object (group 2)
function functionObject(M, ch) {
  const ps = M.functionParams.map((p) => ({ min: 0, group: p.group || 'Function', ...p, key: p.key || `f${p.num}`, offset: p.num - 64 }));
  return {
    key: 'system', page: 'Function', icon: '⚙', label: 'Function', size: 16,
    init: () => Uint8Array.from(M.functionInit || new Uint8Array(16)),
    params: ps,
    cols: 3,
    note: M.notes?.function || null,
    sendParam: (p, _v, d, ctx) => msg.functionParam(ch(ctx), p.num, d[p.offset]),
    // function changes made on the unit's panel (sent while SYS INFO AVAIL is on)
    receive: (raw, d, ctx) => {
      const pc = parseParamChange(raw);
      if (!pc || pc.group !== 2 || pc.channel !== ch(ctx) || !ps.some((p) => p.num === pc.num)) return null;
      const next = Uint8Array.from(d);
      next[pc.num - 64] = pc.value;
      return next;
    },
    sendAll: { label: 'Send all', title: 'Send every function value (parameter changes, group 2)', build: (d, ctx) => ps.filter((p, i) => ps.findIndex((q) => q.num === p.num) === i).map((p) => msg.functionParam(ch(ctx), p.num, d[p.offset])) },
  };
}

export { VCED_SIZE, VOICE_SIZE, VMEM_SIZE, ALGORITHMS, vcedToVmem, vmemToVced, bankVoices, voiceName };
