// The DX family editors' own messages against each model's own receiver and transmitter: the model's
// OS runs in the HD6303 emulator (dx_emu.mjs) and every round trip is compared byte for byte. This is
// the check that stands in for a hardware check (no DX family unit is available).
//
//   node tools/yamaha/check_editor.mjs [model ...]      (default: every model with a plan)
// Firmware: re/dx/fw/<model>/ (not in git; docs/devices/yamaha-<model>.md, "Sources").
//
// Models done: dx7 (v1.8). The plan of each model says what it checks.

import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { DXUnit } from './dx_emu.mjs';
import { readParam, writeParam } from '../../js/core/model/memmap.js';
import { vmemToVced, VCED_SIZE, OPON, VMEM_SIZE, voiceName } from '../../js/devices/defs/yamaha-dx-voice.js';
import { parseBulk, bulk, paramChange } from '../../js/devices/defs/yamaha-dx-sysex.js';
import { BANK_KEY } from '../../js/devices/defs/yamaha-dx.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hex = (a) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(' ');
const asList = (out) => (out == null ? [] : Array.isArray(out) && typeof out[0] === 'number' ? [out] : Array.from(out, (x) => Array.from(x)));
const diffs = (a, b, skip = () => false) => { const d = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (!skip(i) && a[i] !== b[i]) d.push(`${i}:${a[i]}->${b[i]}`); return d; };

/** Another valid value for a parameter (the next option, or the next number in its range). */
function nextValue(p, d, step = 1) {
  const cur = readParam(d, p);
  if (p.options?.length > 1) { const i = p.options.findIndex(([x]) => x === cur); return p.options[(Math.max(i, 0) + step + p.options.length) % p.options.length][0]; }
  if (p.max !== undefined) { const lo = p.min ?? 0; const n = p.max - lo + 1; return lo + ((((cur - lo + step) % n) + n) % n); }
  return null;
}

function harness(model, def, log) {
  const u = DXUnit.create(model);
  const report = [];
  const ok = (label, d = []) => { const line = `${d.length ? 'FAIL' : 'ok  '} ${label}${d.length ? ': ' + d.slice(0, 12).join(' ') + (d.length > 12 ? ` ... (${d.length})` : '') : ''}`; report.push(line); log(line); };
  /** MIDI in at the DIN rate, run until the OS is quiet; the messages it sent meanwhile. */
  const exchange = (out, opts) => { const n = u.cpu.tx.length; for (const m of asList(out)) u.midi(m); u.settle(opts); return u.messages(n).filter((m) => m[0] !== 0xfe); };
  const obj = (key) => def.objects.find((o) => o.key === key);
  return { u, ok, report, exchange, obj, ctx: { channel: 0, deviceId: 0, data: {}, loaded: new Set() } };
}

// ---------------------------------------------------------------- DX7 (mark I) v1.8
// RAM: edit buffer 2000h (155 bytes + operator on/off at 209Bh), internal voices 1000h (32 x 128),
// function values at the addresses of table F028, SYS INFO AVAIL 00F8, MEMORY PROTECT INTERNAL bit 6
// of 0088h. Panel buttons over MIDI (group 2, 0-41: 39 FUNCTION, 7 button 8, 41 YES) drive MIDI TRANSMIT.
async function dx7(t) {
  const { u, ok, exchange, obj, ctx } = t;
  const voice = obj('voice'), fn = obj('system');
  u.boot({ cycles: 8_000_000 });
  ok(`DX7 v1.8 boots: "${u.lcd.line(0, 16).trim()}"`, /VOICE/.test(u.lcd.line(0, 16)) ? [] : ['no voice screen']);
  const edit = () => u.ram(0x2000, 156);
  const sysInfo = (on) => { u.cpu.ram[0xf8 - 0x80] = on ? 1 : 0; };
  const protect = (on) => { if (on) u.cpu.ram[0x88 - 0x80] |= 0x40; else u.cpu.ram[0x88 - 0x80] &= ~0x40; };

  // SYS INFO AVAIL off: the DX7 takes no parameter change and no bulk
  sysInfo(false); protect(false);
  {
    const before = edit();
    const p = voice.params.find((q) => q.offset === 134);
    exchange(paramChange(0, 0, 134, (before[134] + 3) % 32));
    exchange(voice.sendAll.build(voice.init(), ctx));
    ok('SYS INFO AVAIL off: a parameter change and a voice bulk are ignored', diffs(before, edit()));
    void p;
  }
  sysInfo(true);
  // memory protect on: the voice bulk refused (MEMORY PROTECTED)
  protect(true);
  {
    const before = edit();
    exchange(voice.sendAll.build(voice.init(), ctx));
    ok(`MEMORY PROTECT INTERNAL on: the voice bulk is refused ("${u.lcd.line(1, 16).trim()}")`, diffs(before, edit()));
  }
  protect(false);

  // 1. whole voice: Send to edit buffer (format 0 and the operator switches)
  const start = voice.init();
  exchange(voice.sendAll.build(start, ctx));
  ok('voice: INIT VOICE sent whole (format 0), edit buffer 2000h equal (operator switches 209Bh)', diffs(start, edit()));

  // 2. every voice parameter as a live edit (two passes: next value, then two on)
  for (const step of [1, 2]) {
    const x = edit();
    let n = 0;
    for (const p of voice.params) {
      const v = nextValue(p, x, step);
      if (v === null) continue;
      writeParam(x, p, v);
      exchange(voice.sendParam(p, v, x, ctx), { quiet: 30_000 });
      n++;
    }
    ok(`voice: every parameter changed as a live edit (${n} parameter changes, step ${step}), edit buffer equal`, diffs(x, edit()));
  }
  // the name as the editor renames it
  {
    const x = edit();
    voice.setName(x, 'EMU CHECK!');
    for (let i = 145; i < 155; i++) exchange(paramChange(0, 0, i, x[i]), { quiet: 30_000 });
    ok(`voice: renamed "${voiceName(edit())}" by parameter changes 145-154`, diffs(x, edit()));
  }
  // ends of every range, sent whole
  for (const end of ['max', 'min']) {
    const x = voice.init();
    for (const p of voice.params) {
      if (p.offset >= 145 && p.offset < 155) continue;
      const v = p.options?.length ? p.options[end === 'max' ? p.options.length - 1 : 0][0] : end === 'max' ? p.max : (p.min ?? 0);
      if (v !== undefined) writeParam(x, p, v);
    }
    x[OPON] = 0x3f;
    exchange(voice.sendAll.build(x, ctx));
    ok(`voice: every parameter at its ${end}imum, sent whole, edit buffer equal`, diffs(x, edit()));
  }

  // 3. the 32 voices: the editor's copy (factory ROM1 A), a Store into slot 5, the DX7's unpacking
  const romPath = `${ROOT}re/dx/fw/dx7carts/yamaha_dx7_voicerom1_bank-a.bin`;
  const bank = existsSync(romPath) ? new Uint8Array(readFileSync(romPath)) : null;
  if (bank) {
    ctx.data[BANK_KEY] = Uint8Array.from(bank);
    ctx.loaded.add(BANK_KEY);
    const mine = voice.init(); mine[134] = 20; voice.setName(mine, 'STORE TEST');
    const msgs = voice.slots.store(0, 4, ctx, mine);
    exchange(msgs, { quiet: 400_000 });
    ok('internal voices: Store into 05 sends the 32 voices (format 9), memory 1000h equal to the editor copy', diffs(ctx.data[BANK_KEY], u.ram(0x1000, 4096)));
    // each voice selected by program change: the DX7 unpacks it into its edit buffer and sends it
    const bad = [], badTx = [];
    for (let i = 0; i < 32; i++) {
      const got = exchange(voice.slots.recall(0, i, ctx));
      const want = vmemToVced(ctx.data[BANK_KEY].subarray(i * VMEM_SIZE, (i + 1) * VMEM_SIZE)).subarray(0, VCED_SIZE);
      const d = diffs(want, edit().subarray(0, VCED_SIZE));
      if (d.length) bad.push(`voice ${i + 1}: ${d.slice(0, 4).join(' ')}`);
      const sent = got.find((m) => m[0] === 0xf0);
      const r = sent && voice.receive(Uint8Array.from(sent), voice.init(), ctx);
      if (!r || diffs(want, r.subarray(0, VCED_SIZE)).length) badTx.push(`voice ${i + 1}${sent ? '' : ' (nothing sent)'}`);
    }
    ok('internal voices: all 32 selected by program change, the DX7 edit buffer equals the editor\'s unpacking (vmemToVced)', bad);
    ok('internal voices: the voice the DX7 sends on each program change (SYS INFO AVAIL) reads back equal in the editor', badTx);
    // MIDI TRANSMIT from the panel (buttons over MIDI): FUNCTION, button 8 until MIDI TRANSMIT ?, YES
    const press = (b) => exchange([paramChange(0, 2, b, 127), paramChange(0, 2, b, 0)], { quiet: 100_000 });
    press(39);
    let got = [];
    for (let k = 0; k < 4 && !/TRANSMIT/.test(u.lcd.text()); k++) press(7);
    const screen = u.lcd.text().replace(/\s+/g, ' ').trim();
    const n0 = u.cpu.tx.length;
    exchange([paramChange(0, 2, 41, 127), paramChange(0, 2, 41, 0)], { quiet: 1_000_000 });
    got = u.messages(n0).filter((m) => m[0] === 0xf0);
    const b = got.map((m) => parseBulk(m)).find((x) => x?.format === 9);
    const before = ctx.data[BANK_KEY];
    delete ctx.data[BANK_KEY];
    if (b) voice.receive(Uint8Array.from(got.find((m) => parseBulk(m)?.format === 9)), voice.init(), ctx);
    ok(`MIDI TRANSMIT ("${screen}", YES): the 32 voices sent, received by the editor equal to its copy`, b && ctx.data[BANK_KEY] ? diffs(before, ctx.data[BANK_KEY]) : ['no 32-voice bulk']);
    press(36); // EDIT
    // an edit on the panel (YES on the selected parameter): the DX7 sends a parameter change, the editor
    // takes it, and its voice equals the DX7 edit buffer
    {
      const d = Uint8Array.from(edit());
      const n1 = u.cpu.tx.length;
      press(41);
      const pcs = u.messages(n1).filter((m) => m[0] === 0xf0);
      let x = d;
      for (const m of pcs) x = voice.receive(Uint8Array.from(m), x, ctx) ?? x;
      ok(`panel edit (YES): the DX7 sends ${pcs.map((m) => hex(m)).join(', ') || 'nothing'}, the editor's voice equals the edit buffer`, pcs.length ? diffs(x, edit()) : ['nothing sent']);
    }
  } else ok('internal voices: factory bank re/dx/fw/dx7carts/yamaha_dx7_voicerom1_bank-a.bin not found', ['skipped']);

  // 4. function parameters (group 2, 64-77) into the RAM table F028
  {
    const f = fn.init();
    const addr = (num) => u.cpu.rw(0xf028 + (num - 64) * 2);
    const bad = [];
    for (const step of [1, 2]) {
      const seen = new Set();
      for (const p of fn.params) {
        const v = nextValue(p, f, step);
        if (v === null) continue;
        writeParam(f, p, v);
        exchange(fn.sendParam(p, v, f, ctx), { quiet: 30_000 });
        seen.add(p.num);
      }
      for (const num of seen) { const want = f[num - 64], got = u.mem[addr(num)] ?? u.cpu.read(addr(num)); if (want !== got) bad.push(`${num}@${addr(num).toString(16)}:${want}->${got}`); }
    }
    ok('function: every parameter (64-77) as a parameter change, each in its RAM place (table F028)', bad);
  }
  // 5. a bulk with a wrong checksum: the DX7 v1.8 stores each byte as it arrives (EEFD voice, EF64 bank)
  // and only shows CHECK SUM ERROR! at the end (EF3E), so the edit buffer / internal memory hold the
  // damaged data anyway (a device behaviour: docs/devices/yamaha-dx7.md)
  {
    const x = voice.init(); x[134] = 7;
    const m = bulk(0, 0, x.subarray(0, VCED_SIZE));
    m[m.length - 2] ^= 1;
    exchange(m);
    const screen = u.lcd.text().replace(/\s+/g, ' ').trim();
    ok(`a voice bulk with a wrong checksum: "${screen}", the bytes are in the edit buffer all the same`, /CHECK SUM ERROR/.test(screen) ? diffs(x.subarray(0, VCED_SIZE), edit().subarray(0, VCED_SIZE)) : ['no CHECK SUM ERROR!']);
    if (bank) {
      const b = Uint8Array.from(bank); b[0] ^= 1;
      const mb = bulk(0, 9, b);
      mb[mb.length - 2] ^= 1;
      exchange(mb, { quiet: 400_000 });
      const s2 = u.lcd.text().replace(/\s+/g, ' ').trim();
      ok(`a 32-voice bulk with a wrong checksum: "${s2}", the bytes are in the internal memory all the same`, /CHECK SUM ERROR/.test(s2) ? diffs(b, u.ram(0x1000, 4096)) : ['no CHECK SUM ERROR!']);
    }
  }
  // 6. other channels are ignored
  {
    const before = edit();
    exchange(paramChange(3, 0, 134, (before[134] + 1) % 32));
    ok('a parameter change on another channel is ignored', diffs(before, edit()));
  }
}

const PLANS = { dx7: ['yamaha-dx7', dx7] };

export async function check(model, { log = () => {} } = {}) {
  const [id, plan] = PLANS[model];
  const def = (await import(pathToFileURL(`${ROOT}js/devices/defs/${id}.js`).href)).default;
  const t = harness(model, def, log);
  await plan(t);
  return t.report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const models = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PLANS);
  let fails = 0;
  for (const m of models) {
    console.log(`== ${m}`);
    const r = await check(m, { log: (l) => console.log(l) });
    fails += r.filter((l) => l.startsWith('FAIL')).length;
  }
  console.log(fails ? `${fails} checks failed` : 'all checks passed');
  process.exit(fails ? 1 : 0);
}
