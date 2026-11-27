// The Matrix-1000 editor's own messages against the Matrix-1000's own receiver and transmitter: the OS
// (v1.11 or v1.13) and the factory patch ROM run in the 6809 emulator (emu.mjs). This is the check that
// stands in for a hardware check (no Matrix-1000 is available): every round trip is compared byte for
// byte, and the master bytes without a Matrix-1000 use are watched while the OS works.
//
//   node tools/matrix1000/check_editor.mjs [os.bin] [patchrom.bin]
// Defaults: re/firmware/Oberheim_M1000-ROM_v113/M1000-CAT27256P-17_v113.BIN and the C2DB patch ROM
// (not in git; docs/devices/oberheim-matrix1000.md).
//
// What it does, through the definition's own functions (request/decode, param.send, sendAll, slots,
// requests, fullDump):
//  1. cold start (the OS's own memory initialisation): identity, master defaults = initMaster()
//  2. every patch parameter set to another value as a live edit (remote edit 06 / matrix slot 0B),
//     the edit buffer read back; the whole patch sent (0D) and read back
//  3. stores (0E) and writes (0A + 01) into RAM banks 0 and 1, read back (0A + 04 01); recall (0A +
//     program change) into the edit buffer; memory protect refusing a store; ROM bank reads
//  4. every master parameter changed and sent (03, the whole table), read back
//  5. the master bytes the 1000 has no use for: values kept through a send and read; every read of
//     them by the OS recorded while it boots, takes notes, controllers, program changes and every
//     SysEx command (only the dump and checksum loops may read them)
//  6. the complete dump (fullDump), each patch decoded in range; a bank restored from its dump

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Matrix1000, MASTER } from './emu.mjs';
import { readParam, writeParam } from '../../js/core/model/memmap.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_OS = `${ROOT}re/firmware/Oberheim_M1000-ROM_v113/M1000-CAT27256P-17_v113.BIN`;
export const DEFAULT_PATCHES = `${ROOT}re/firmware/Oberheim_M1000-IC_C2DB_ORG_RO(Black&White)/M1000-IC_C2DB.BIN`;
const DEF = `${ROOT}js/devices/defs/oberheim-matrix1000.js`;

const hex = (a) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(' ');
const asList = (out) => (out == null ? [] : Array.isArray(out) && typeof out[0] === 'number' ? [out] : Array.from(out, (x) => Array.from(x)));
const diffs = (a, b, skip = () => false) => { const d = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (!skip(i) && a[i] !== b[i]) d.push(`${i}:${a[i]}->${b[i]}`); return d; };

/** Another valid value for a parameter (the next option, or the next number in its range). */
function nextValue(p, d, step = 1) {
  const cur = readParam(d, p);
  if (p.options?.length > 1) { const i = p.options.findIndex(([x]) => x === cur); return p.options[(i + step + p.options.length) % p.options.length][0]; }
  if (p.max !== undefined) { const lo = p.min ?? 0; return lo + ((cur - lo + step) % (p.max - lo + 1) + (p.max - lo + 1)) % (p.max - lo + 1); }
  return null;
}

/** The master bytes the Matrix-1000 keeps for the Matrix-6 / 6R (or as copies) and never uses. */
export const UNUSED_MASTER = [0, 9, 10, 15, 16, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 33, 162, 163];

export async function check({ os = DEFAULT_OS, patches = DEFAULT_PATCHES, log = () => {} } = {}) {
  const mod = await import(pathToFileURL(DEF).href);
  const def = mod.default;
  const { msg, unnibble, initMaster, patchName } = mod;
  const osRom = readFileSync(os);
  const m = new Matrix1000(osRom, readFileSync(patches));
  const version = String.fromCharCode(...osRom.subarray(0, 3));
  const report = [];
  const ok = (label, d = []) => { const line = `${d.length ? 'FAIL' : 'ok  '} ${label}${d.length ? ': ' + d.slice(0, 12).join(' ') + (d.length > 12 ? ` ... (${d.length})` : '') : ''}`; report.push(line); log(line); };

  // MIDI in at the DIN rate; then run until the OS has been quiet for 0.1 s (and, for a request, until
  // the matching reply is complete: up to 10 s)
  const exchange = (bytes, match = null, done = null) => {
    const n = m.tx.length;
    for (const b of asList(bytes)) m.midiIn(b);
    m.settle();
    const got = () => m.messages(n).filter((x) => x[0] === 0xf0 && x.at(-1) === 0xf7);
    for (let t = 0; ((match && !got().some(match)) || (done && !done(got()))) && t < 400; t++) m.settle();
    return got();
  };
  const send = (out) => { exchange(out); };
  const api = {
    send,
    request: async (bytes, match, decode) => { const r = exchange(bytes, match).find((x) => match(x)); if (!r) throw new Error(`no reply to ${hex(bytes)}`); return decode(r); },
  };
  const obj = (key) => def.objects.find((o) => o.key === key);
  const patch = obj('patch');
  const master = obj('master');
  const ctx = { channel: 0, deviceId: 0 };
  const readEdit = () => api.request(patch.request(), patch.match, patch.decode);
  const readMaster = () => api.request(master.request(), master.match, master.decode);
  const body = (i) => i < 8; // patch name bytes: the 1000 keeps no names and sends "BNKb: nn"

  // 1. cold start, identity, master defaults. The OS points its remote-edit target (79ABh) at the edit
  // buffer only when it selects a patch (BC2D): after a memory initialisation, until the first patch
  // change, remote edits (06, 0B) land in the DCO timers. A unit in use has selected one; so here too.
  m.powerOn({ cold: true });
  exchange([0xc0, 0]);
  const id = exchange([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
  ok(`OS ${version}: identity reply ${id[0] ? hex(id[0]) : '(none)'}`, id[0] && id[0][5] === 0x10 && id[0][6] === 0x06 ? [] : ['no Oberheim identity reply']);
  const m0 = await readMaster();
  ok('master after the cold start equals initMaster() (the defaults the editor uses)', diffs(initMaster(), m0));

  // 2. patch: live edits, whole patch. The OS compiles each voice's modulations into a list in the
  // voice's RAM page (from 0EFh); a patch with nearly every modulation active outgrows it (about 290
  // bytes, the factory patches use at most 221) and the OS runs away (doc: "Modulation list"). So the
  // sweeps change the modulation amounts and the other parameters in separate groups.
  {
    const d = await readEdit();
    ok(`edit buffer read: name "${patchName(d)}"`, patchName(d) === 'BNK0: 00' ? [] : ['name']);
    const start = Uint8Array.from(d);
    const amounts = patch.params.filter((p) => p.signed && !p.sendKey);
    const others = patch.params.filter((p) => !amounts.includes(p));
    for (const [label, group] of [['every parameter but the fixed modulation amounts, and the 10 matrix slots', others], ['the 18 fixed modulation amounts', amounts]]) {
      const x = Uint8Array.from(start);
      let n = 0;
      const keys = new Set();
      for (const p of group) {
        const v = nextValue(p, x);
        if (v === null) continue;
        writeParam(x, p, v);
        if (p.sendKey) { keys.add(p.sendKey); continue; } // matrix slots: one message for the three fields, below
        send(p.send(v, ctx, x));
        n++;
      }
      for (const k of keys) { const p = patch.params.find((y) => y.sendKey === k); send(p.send(null, ctx, x)); n++; }
      ok(`patch: ${label}: ${n} live edits (06 remote edit, 0B matrix slot), edit buffer read back`, diffs(x, await readEdit(), body));
      send(patch.sendAll.build(start, ctx));
      // whole patch, two steps on, and the ends of every range
      const y = Uint8Array.from(start);
      for (const p of group) { const v = nextValue(p, y, 2); if (v !== null) writeParam(y, p, v); }
      send(patch.sendAll.build(y, ctx));
      ok(`patch: ${label}: changed again, sent whole (0D, Send to edit buffer), read back`, diffs(y, await readEdit(), body));
      for (const [end, pick] of [['lowest', (p) => p.options ? p.options[0][0] : p.min ?? 0], ['highest', (p) => p.options ? p.options.at(-1)[0] : p.max]]) {
        const z = Uint8Array.from(start);
        for (const p of group) writeParam(z, p, pick(p));
        send(patch.sendAll.build(z, ctx));
        ok(`patch: ${label}: each at its ${end} value, sent whole and read back`, diffs(z, await readEdit(), body));
      }
      send(patch.sendAll.build(start, ctx));
    }
    ok('patch: first edit buffer sent back', diffs(start, await readEdit(), body));
  }

  // 3. memories
  {
    const s = patch.slots;
    const edit = await readEdit();
    const a = Uint8Array.from(edit);
    for (const p of patch.params) { if (p.signed && !p.sendKey) continue; const v = nextValue(p, a, 3); if (v !== null) writeParam(a, p, v); }
    // store the edit buffer (0E) into bank 0 slot 7 and bank 1 slot 99
    send(patch.sendAll.build(a, ctx));
    for (const [bank, i] of [[0, 7], [1, 99]]) {
      send(s.store(bank, i, ctx, a));
      const got = await s.fetch(api, bank, i);
      ok(`store edit buffer into ${s.slotLabel(bank, i)} (0E), read back (0A + 04 01): name "${patchName(got)}"`, [...diffs(a, got, body), ...(patchName(got) === `BNK${bank}: ${String(i).padStart(2, '0')}` ? [] : ['name'])]);
    }
    // write a patch straight into a slot (0A + 01)
    const b = Uint8Array.from(a);
    for (const p of patch.params) { if (p.signed && !p.sendKey) continue; const v = nextValue(p, b, 5); if (v !== null) writeParam(b, p, v); }
    send(s.write(1, 42, b));
    ok(`write into ${s.slotLabel(1, 42)} (0A + 01), read back`, diffs(b, await s.fetch(api, 1, 42), body));
    // recall into the edit buffer
    send(s.recall(0, 3, ctx));
    send(s.recall(1, 42, ctx));
    ok(`recall ${s.slotLabel(1, 42)} (0A + program change 42): edit buffer = the slot`, diffs(b, await readEdit(), body));
    send(s.recall(0, 7, ctx));
    ok(`recall ${s.slotLabel(0, 7)}: edit buffer = the stored patch`, diffs(a, await readEdit(), body));
    // memory protect refuses stores and writes
    const mm = await readMaster();
    const prot = master.params.find((p) => p.key === 'protect');
    writeParam(mm, prot, 1); send(prot.send(1, ctx, mm));
    const before = await s.fetch(api, 1, 42);
    send(s.recall(0, 7, ctx)); send(s.store(1, 42, ctx, a)); send(s.write(1, 42, a));
    ok('memory protect on: store and write into 142 refused (slot unchanged)', diffs(before, await s.fetch(api, 1, 42)));
    writeParam(mm, prot, 0); send(prot.send(0, ctx, mm));
    // group mode: the store's unit byte (0E nn bank unit). The OS (CA41) stores for any unit byte but
    // 7Fh while group mode is on, and always when it is off; the editor sends unit 0.
    {
      const mg = await readMaster();
      const g0 = Uint8Array.from(mg);
      mg[166] = 3; mg[167] = 2; mg[168] = 0x80; send(master.toSyx(mg));
      const c = Uint8Array.from(a); for (const p of patch.params) { if (p.signed && !p.sendKey) continue; const v = nextValue(p, c, 2); if (v !== null) writeParam(c, p, v); }
      send(patch.sendAll.build(c, ctx)); send(s.store(1, 43, ctx, c));
      const st43 = diffs(c, await s.fetch(api, 1, 43), body);
      const keep = await s.fetch(api, 1, 44);
      send(patch.sendAll.build(a, ctx)); send(msg.storeEditBuffer(44, 1, 0x7f));
      ok('group mode on (this unit 2 of 3): the editor store (unit 0) is kept; unit 7Fh is refused', [...st43, ...diffs(keep, await s.fetch(api, 1, 44)).map((x) => `7F stored ${x}`)]);
      send(master.toSyx(g0));
    }
    // the ROM banks
    const rom = [];
    for (const [bank, i] of [[2, 0], [5, 50], [9, 99]]) {
      const got = await s.fetch(api, bank, i);
      rom.push(...inRange(patch, got).map((x) => `${s.slotLabel(bank, i)} ${x}`));
      if (!s.writable(bank)) {
        send(s.recall(bank, i, ctx));
        rom.push(...diffs(got, await readEdit(), body).map((x) => `recall ${s.slotLabel(bank, i)} ${x}`));
      }
    }
    ok('ROM banks: 200, 550, 999 read, in range, recalled into the edit buffer', rom);
    // a store into a ROM bank is not kept
    const r0 = await s.fetch(api, 3, 1);
    send(patch.sendAll.build(a, ctx)); send(msg.storeEditBuffer(1, 3, 0));
    ok('a store into ROM bank 3 changes nothing', diffs(r0, await s.fetch(api, 3, 1)));
    send(msg.unlockBank());
  }

  // 4. master: each parameter changed and sent as the whole table
  {
    const d = await readMaster();
    const start = Uint8Array.from(d);
    const skip = (i) => i === 165; // bank bits are rebuilt from the current patch when the OS sends
    for (const p of master.params) {
      if (p.key === 'bank') continue; // no message selects a bank through the master table (checked below)
      const v = nextValue(p, d);
      if (v === null) continue;
      writeParam(d, p, v);
      send(p.send(v, ctx, d));
    }
    const back = await readMaster();
    ok(`master: ${master.params.length - 1} parameters changed one at a time, each sent whole (03), read back`, diffs(d, back, skip));
    // what the bank field reports
    send(msg.setBank(4));
    const mb = await readMaster();
    ok(`master byte 165 after Set bank 4: ${mb[165].toString(16)}h (bank 4, locked)`, mb[165] === 0x84 ? [] : ['not 84h']);
    send(msg.unlockBank());
    send(master.toSyx(start));
    ok('master: first table sent back', diffs(start, await readMaster(), (i) => i === 165));
  }

  // 5. master bytes without a Matrix-1000 use
  {
    const d = await readMaster();
    const start = Uint8Array.from(d);
    UNUSED_MASTER.forEach((o, k) => { d[o] = 0x11 + k * 3; });
    send(master.toSyx(d));
    ok(`master bytes ${UNUSED_MASTER.join(', ')}: other values sent (03) and read back unchanged`, diffs(d, await readMaster(), (i) => i === 165));
    const addrs = UNUSED_MASTER.map((o) => MASTER + o);
    const w = m.watch([...addrs, MASTER + 32]); // byte 32 (MIDI echo, read for every byte in) shows the watch works
    // exercise: notes with velocity, controllers, NRPN, RPN, program changes, pressure, bend, every SysEx command
    const ch = d[11] & 15;
    const traffic = [
      [0x90 | ch, 60, 100], [0x90 | ch, 64, 1], [0x90 | ch, 67, 127], [0x80 | ch, 60, 40], [0x90 | ch, 64, 0],
      [0xb0 | ch, 1, 64], [0xb0 | ch, 2, 30], [0xb0 | ch, 4, 90], [0xb0 | ch, 64, 127], [0xb0 | ch, 64, 0], [0xb0 | ch, 7, 100],
      [0xb0 | ch, 99, 0], [0xb0 | ch, 98, 21], [0xb0 | ch, 6, 90], [0xb0 | ch, 96, 1], [0xb0 | ch, 97, 1],
      [0xb0 | ch, 101, 0], [0xb0 | ch, 100, 0], [0xb0 | ch, 6, 70], [0xb0 | ch, 31, 64], [0xc0 | ch, 3], [0xb0 | ch, 31, 0],
      [0xc0 | ch, 12], [0xd0 | ch, 50], [0xe0 | ch, 0, 80], [0xb0 | ch, 121, 0], [0xb0 | ch, 123, 0],
      [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7], msg.param(21, 30), msg.matrix(2, 4, -20, 9), msg.request(4), msg.request(1, 3), msg.request(3),
      msg.toEditBuffer(await readEdit()), msg.setBank(1), msg.unlockBank(), msg.groupOn(2, 0), msg.groupOff(), [0xfe],
    ];
    for (const t of traffic) exchange(t);
    m.powerOn();
    exchange(msg.request(3));
    // reads by the dump transmitter and the checksum loops are not uses (the bytes travel as data)
    const SEND_LOOP = [0xcd4c, 0xcd4e, 0xcd55];
    const uses = [];
    const control = w.get(MASTER + 32).filter((e) => !e.write).length;
    w.delete(MASTER + 32);
    for (const [a, list] of w) for (const e of list) if (!e.write && !SEND_LOOP.includes(e.pc)) uses.push(`${a - MASTER}@${e.pc.toString(16)}`);
    if (!control) uses.push('the watch saw no read of byte 32 either');
    const writers = new Set(); for (const [a, list] of w) for (const e of list) if (e.write) writers.add(`${a - MASTER}@${e.pc.toString(16)}`);
    ok(`master bytes ${UNUSED_MASTER.join(', ')}: no read by the OS (boot, notes, controllers, NRPN/RPN, program changes, every SysEx command; byte 32 read ${control} times meanwhile); written by ${[...writers].join(' ') || 'nothing'}`, uses);
    m.watches = null;
    send(master.toSyx(start));
  }

  // 6. complete dump
  {
    const steps = (def.fullDump || []).map((s) => (typeof s === 'string' ? def.requests.find((r) => r.label === s) : s.request ? { ...def.requests.find((r) => r.label === s.request), ...s } : s));
    const dump = [];
    let patchesOk = [];
    for (const st of steps) {
      const out = asList(st.bytes(ctx));
      const got = exchange(out, null, st.expect ? (g) => st.expect(g) : null).filter((x) => !(x[1] === 0x7e && x[3] === 0x06));
      const kept = st.record ? out.filter(st.record) : [];
      dump.push({ label: st.label, messages: [...kept, ...got] });
      for (const r of got.filter((x) => x[3] === 0x01)) patchesOk.push(...inRange(patch, unnibble(r, 5, 134).data).map((e) => `${st.label} ${r[4]} ${e}`));
    }
    const counts = dump.map((x) => `${x.label}: ${x.messages.length}`);
    const patchMsgs = dump.flatMap((x) => x.messages.filter((r) => r[3] === 0x01)).length;
    ok(`complete dump: ${counts.join('; ')} (${patchMsgs} patches; each bank step recorded with its own Set bank first)`, patchMsgs === 1000 && dump.slice(0, 10).every((x) => x.messages[0][3] === 0x0a) ? [] : [`${patchMsgs} patches`]);
    // the Branch Library items of a bank entry
    const items = def.libraryItems(dump[1].messages);
    const pi = items.filter((it) => it.object === 'patch');
    ok(`Branch Library items of "${dump[1].label}": ${items.length} (${pi.length} patches, each "Set bank 1" + its message; ${items.filter((it) => it.object === 'master').length} master; ${items.filter((it) => !it.object).length} Matrix-6 split data)`, pi.length === 100 && pi.every((it) => it.msgs[0][3] === 0x0a && it.msgs[0][4] === 1) ? [] : ['items']);
    ok('complete dump: every patch decodes with every parameter in its range', patchesOk);
    // restore a RAM bank from its own entry, as the Branch Library sends it (the stored messages in order)
    const s = patch.slots;
    const bank1 = dump.find((x) => /Bank 1/.test(x.label));
    const saved = await s.fetch(api, 1, 10);
    const other = Uint8Array.from(saved); for (const p of patch.params) { if (p.signed && !p.sendKey) continue; const v = nextValue(p, other, 7); if (v !== null) writeParam(other, p, v); }
    send(s.write(1, 10, other));
    send(msg.setBank(0)); // the unit on another bank when the entry is sent back
    for (const r of bank1.messages) send(r);
    ok(`restore: "${bank1.label}" sent back with bank 0 selected, slot 110 equals the dump again`, diffs(saved, await s.fetch(api, 1, 10)));
    send(msg.unlockBank());
  }

  const fails = report.filter((l) => l.startsWith('FAIL')).length;
  return { report, fails, overruns: m.overruns || 0 };
}

/** Values outside a parameter's range or option list. */
function inRange(obj, d) {
  const bad = [];
  for (const p of obj.params) {
    const v = readParam(d, p);
    if (p.options ? !p.options.some(([x]) => x === v) : (v < (p.min ?? 0) || v > p.max)) bad.push(`${p.key}=${v}`);
  }
  return bad;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [os, patches] = process.argv.slice(2);
  const r = await check({ os: os || DEFAULT_OS, patches: patches || DEFAULT_PATCHES, log: (l) => console.log(l) });
  console.log(r.fails ? `${r.fails} checks failed` : `all ${r.report.length} checks pass`, r.overruns ? `(${r.overruns} MIDI overruns)` : '');
  process.exit(r.fails ? 1 : 0);
}
