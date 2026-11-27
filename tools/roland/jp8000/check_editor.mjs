// The JP-8000 editor's own messages against the JP-8000's own receiver and transmitter: OS v1.05 run
// in the H8/300H emulator (emu.mjs), with a fake MIDI client that answers from it. This is the check
// that stands in for a hardware check (no JP-8000 is available): every round trip is compared byte
// for byte.
//
//   node tools/roland/jp8000/check_editor.mjs [--fresh]
// Needs the OS image (not in git): re/jp8080/fw/jp8000_v1.05.bin. The first run boots the OS and
// formats its memory (about 3 s), later runs restore re/jp8080/emu/jp8000.snap.
//
// What it does, through the definition's own functions (fetch, sendAll, param.send, slots, requests):
//  1. identity request; system, performance and both temporary patches read (RQ1)
//  2. every parameter of each object set to another of its values one at a time, sent as the editor
//     sends a live edit (one DT1 per parameter), read back from the unit
//  3. each object edited as a whole (every parameter changed), sent with Send to JP-8000, read back
//  4. patch and performance stored into user memory and read back; recalled with bank select and
//     program change and the temporary data read back; preset recall gives the ROM preset's name
//  5. motions and RPS patterns: read, written to another slot, read back
//  6. the Branch Library's complete dump: taken, the unit changed (FACTORY PRESET), the dump sent
//     back, a second dump compared with the first

import { boot, exchange, stream, panelInitialize, powerCycle, press, lcd, SW, hex, systemBytes } from './emu.mjs';
import { readParam, writeParam } from '../../../js/core/model/memmap.js';
import { parseDt1, addrToInt, intToAddr, rq1 } from '../../../js/core/midi/roland.js';

const DEF = '../../../js/devices/defs/roland-jp8000.js';
const DEV = 0x10;

/** A MIDI client that sends to the emulated OS and collects its replies (DeviceClient.request's shape). */
function emulatedClient(m) {
  return {
    s: { timeout: 2500, bytesPerSecond: 3000 },
    async request(bytes, opts = {}) {
      const replies = exchange(m, Array.from(bytes), { max: 4e9 });
      const messages = replies.filter((raw) => (opts.collect ? opts.collect(null, raw) : true)).map((raw) => ({ raw }));
      if (!messages.length) throw new Error('no reply');
      return { messages };
    },
    send(bytes) { stream(m, [bytes]); },
  };
}
const asList = (out) => (out == null ? [] : Array.isArray(out) && typeof out[0] === 'number' ? [out] : Array.from(out, (x) => Array.from(x)));
const diffs = (a, b, skip = new Set()) => { const d = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (!skip.has(i) && a[i] !== b[i]) d.push(`${i.toString(16)}h:${a[i]}->${b[i]}`); return d; };

/** Another valid value for a parameter (the next option, or the next number in its range). */
function nextValue(p, d, ctx, step = 1) {
  const dyn = p.dynamic?.(d, ctx);
  const opts = dyn?.options ?? p.options;
  const cur = readParam(d, p);
  if (opts?.length > 1) return opts[(opts.findIndex(([x]) => x === cur) + step) % opts.length][0];
  if (p.max !== undefined) { const lo = p.min ?? 0; return lo + ((cur - lo + step) % (p.max - lo + 1)); }
  return null;
}

export async function check({ fresh = false, log = () => {}, onStage = () => {} } = {}) {
  const def = (await import(new URL(DEF, import.meta.url))).default;
  const { _test: T } = await import(new URL(DEF, import.meta.url));
  const m = boot({ fresh });
  onStage('start', m);
  const obj = (key) => def.objects.find((o) => o.key === key);
  const client = emulatedClient(m);
  const ctx = { deviceId: DEV, channel: 0, data: {}, loaded: new Set(), names: {}, entry: { id: def.id } };
  const api = { ctx, g: { client }, send: (out) => stream(m, asList(out)), toast: () => {} };
  const send = (out) => stream(m, asList(out));
  const report = [];
  const ok = (label, d = []) => { const line = `${d.length ? 'FAIL' : 'ok  '} ${label}${d.length ? ': ' + d.slice(0, 16).join(' ') + (d.length > 16 ? ` ... (${d.length})` : '') : ''}`; report.push(line); log(line); };

  // 1. identity and first reads
  const id = exchange(m, [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
  ok(`identity reply ${id[0] ? hex(id[0]) : '(none)'}`, id.length === 1 && def.isIdentity(id[0]) ? [] : ['no JP identity reply']);
  const sys0 = await obj('system').fetch(api);
  ctx.data.system = sys0; ctx.loaded.add('system');
  ok('system read: bytes 00-16h equal the OS\'s system memory (210010h)', diffs(sys0.slice(0, 0x17), systemBytes(m)));
  const perf0 = await obj('performance').fetch(api);
  ctx.data.performance = perf0; ctx.loaded.add('performance');
  ok(`performance read: "${obj('performance').name(perf0)}"`);
  const target = obj('patch').target;

  // the bytes the OS sets itself: patch ECh-EEh (active indicators, from the depths)
  const PATCH_SKIP = new Set([0xec, 0xed, 0xee]);

  // 2. one parameter at a time, as live edits
  for (const [key, setup] of [['system', null], ['performance', null], ['patch', 'upper'], ['patch', 'lower']]) {
    const o = obj(key);
    if (setup) target.set(setup);
    const d = await o.fetch(api);
    const start = Uint8Array.from(d);
    const bad = [];
    let n = 0;
    for (const p of o.params) {
      if (p.readOnly || p.hidden || p.get && !p.set || !p.send) continue;
      // selection bytes that load other data (performance / patch number and bank) are checked in 4
      if (key === 'system' && p.offset <= 2) continue;
      if (key === 'performance' && p.part !== undefined && /Patch (bank|number|group)/.test(p.label)) continue;
      let v = nextValue(p, d, ctx);
      if (v === null) continue;
      // EXCLUSIVE (96) on a Tx/Rx slot trips an OS 1.05 bug with MODE2 + Edit SW ON (step 7): not in the sweep
      if (key === 'system' && p.group?.startsWith('Tx/Rx') && v === 96) v = 1;
      writeParam(d, p, v);
      send(p.send(v, ctx, d));
      n++;
    }
    const back = await o.fetch(api);
    const skip = key === 'patch' ? PATCH_SKIP : new Set();
    ok(`${key}${setup ? ` (${setup})` : ''}: ${n} parameters sent one at a time (DT1 each) and read back`, diffs(d, back, skip));
    // put it back as it was (whole object)
    send(o.sendAll.build(start, ctx));
    const again = await o.fetch(api);
    ok(`${key}${setup ? ` (${setup})` : ''}: restored with Send to JP-8000`, diffs(start, again, skip));
    if (bad.length) ok(`${key}: refused`, bad);
  }

  // 3. whole objects edited and sent
  for (const [key, setup, step] of [['performance', null, 2], ['patch', 'upper', 3], ['patch', 'lower', 2]]) {
    const o = obj(key);
    if (setup) target.set(setup);
    const d = await o.fetch(api);
    let n = 0;
    for (const p of o.params) {
      if (p.readOnly || p.hidden || !p.send) continue;
      if (key === 'performance' && p.part !== undefined && /Patch (bank|number|group)/.test(p.label)) continue;
      const v = nextValue(p, d, ctx, step);
      if (v !== null && writeParam(d, p, v)) n++;
    }
    send(o.sendAll.build(d, ctx));
    const back = await o.fetch(api);
    ok(`${key}${setup ? ` (${setup})` : ''}: ${n} parameters changed, Send to JP-8000, read back`, diffs(d, back, key === 'patch' ? PATCH_SKIP : new Set()));
    if (key === 'performance') { ctx.data.performance = back; }
  }

  // 4. memories: store, read back, recall
  {
    const o = obj('patch');
    for (const [part, slot] of [['upper', 127], ['lower', 5]]) {
      target.set(part);
      const d = await o.fetch(api);
      for (let i = 0; i < 16; i++) d[i] = `EMU ${part.toUpperCase()} ${slot}`.padEnd(16).charCodeAt(i);
      send(o.slots.store(0, slot, ctx, d));
      const stored = await o.slots.fetch(api, 0, slot);
      ok(`patch: stored into USER ${T.PATCH_BANKS[0].label} slot ${slot} and read back`, diffs(d, stored, PATCH_SKIP));
      ok(`patch: user name read "${await o.slots.fetchName(api, 0, slot)}"`, (await o.slots.fetchName(api, 0, slot)).trim() === `EMU ${part.toUpperCase()} ${slot}` ? [] : ['name']);
      send(o.slots.recall(0, slot === 127 ? 3 : 4, ctx)); // another patch first
      send(o.slots.recall(0, slot, ctx));
      const rec = await o.fetch(api);
      ok(`patch: recalled (bank select 50h + program change ${slot} on the ${part} part's channel) into the temporary patch`, diffs(d, rec, PATCH_SKIP));
    }
    target.set('upper');
    for (const n of [0, 77, 127]) {
      const got = await o.slots.fetch(api, 1, n);
      const want = o.slots.names(1)[n];
      ok(`patch: PRESET ${n} recalled, name "${o.name(got).trim()}"`, o.name(got).trim() === want.trim() ? [] : [`expected ${want}`]);
    }
  }
  {
    const o = obj('performance');
    const d = await o.fetch(api);
    for (let i = 0; i < 16; i++) d[i] = 'EMU PERFORMANCE '.charCodeAt(i);
    send(o.slots.store(0, 63, ctx, d));
    const stored = await o.slots.fetch(api, 0, 63);
    ok('performance: stored into USER 88 and read back', diffs(d, stored));
    ok(`performance: user name read "${await o.slots.fetchName(api, 0, 63)}"`);
    send(o.slots.recall(0, 0, ctx));
    send(o.slots.recall(0, 63, ctx));
    const rec = await o.fetch(api);
    ok('performance: recalled (bank select 50h + program change 63 on the Perform Ctrl channel) into the temporary performance', diffs(d, rec));
    for (const n of [0, 40, 63]) {
      const got = await o.slots.fetch(api, 1, n);
      const name = o.slots.names(1)[n];
      ok(`performance: PRESET ${n} recalled, name "${o.name(got).trim()}"`, o.name(got).trim() === name.trim() ? [] : [`expected ${name}`]);
    }
  }

  // 5. motions and patterns (7-in-8 packed event lists)
  {
    const { readMotion, motionMessages, motionAddr } = await import(new URL('../../../js/devices/defs/roland-jp.js', import.meta.url));
    const a = await readMotion(client, DEV, 0);
    const b = await readMotion(client, DEV, 3);
    send(motionMessages(DEV, 0, b));
    const back = await readMotion(client, DEV, 0);
    ok(`motion: B[2] (${b.length} bytes) written as A[1] (was ${a.length}) and read back`, diffs(b, back));
    send(motionMessages(DEV, 0, a));
    ok('motion: A[1] restored', diffs(a, await readMotion(client, DEV, 0)));
    if (T.readPattern) {
      const p1 = await T.readPattern(client, DEV, 0);
      const p2 = await T.readPattern(client, DEV, 1);
      send(T.patternMessages(DEV, 0, p2));
      ok(`RPS pattern: C#2's events (${p2.length} bytes) written to pattern C#2... D2 and read back`, diffs(p2, await T.readPattern(client, DEV, 0)));
      send(T.patternMessages(DEV, 0, p1));
      ok('RPS pattern: restored', diffs(p1, await T.readPattern(client, DEV, 0)));
    }
  }

  // 5b. two-byte value ranges (firmware per-id table): the ends are taken, one past them refused
  {
    const o = obj('performance');
    for (const p of o.params.filter((x) => x.two)) {
      const d = await o.fetch(api);
      const res = [];
      for (const [v, take] of [[p.min, true], [p.max, true], [p.max + 1, false], ...(p.min > 0 ? [[p.min - 1, false]] : [])]) {
        const before = p.get(await o.fetch(api));
        const x = Uint8Array.from(d); p.set(x, v);
        send(p.send(v, ctx, x));
        const got = p.get(await o.fetch(api));
        if (take ? got !== v : got !== before) res.push(`${v}: ${got}`);
      }
      ok(`performance: ${p.label} takes ${p.min}-${p.max} and refuses values outside`, res);
      send(o.sendAll.build(d, ctx));
    }
  }
  // 5c. system 12h-16h (named from Roland's JP-8000 address map)
  onStage('5c', m);
  {
    const sysObj = obj('system');
    const s0 = await sysObj.fetch(api);
    const p12 = sysObj.params.find((p) => p.offset === 0x12), p13 = sysObj.params.find((p) => p.offset === 0x13);
    const x = Uint8Array.from(s0); writeParam(x, p12, 5); writeParam(x, p13, 7);
    send(p12.send(5, ctx, x)); send(p13.send(7, ctx, x));
    const s1 = await sysObj.fetch(api);
    m.buttons.add(SW.SHIFT); m.run(4e6); press(m, SW.INIT_UTIL); m.buttons.delete(SW.SHIFT); m.run(4e6);
    const initPage = lcd(m).join(' / ');
    press(m, SW.INIT_UTIL);
    const bulkPage = lcd(m).join(' / ');
    press(m, SW.EXIT);
    ok(`system 12h/13h: Factory Preset Menu = ${p12.options[5][1]}, Bulk Dump Menu = ${p13.options[7][1]} stored and read back; the pages still open at "${initPage}" and "${bulkPage}" (OS 1.05 does not read them)`, [s1[0x12] === 5 && s1[0x13] === 7 ? null : 'not stored', /PATCH: +TEMP/.test(initPage) && /ALL/.test(bulkPage) ? null : 'pages'].filter(Boolean));
    const shiftOf = () => systemBytes(m)[0x14];
    const trace = [];
    const t = (what) => trace.push(`${what}: ${lcd(m).join('/')} [${Array.from(systemBytes(m).slice(0x14)).join(',')}]`);
    t('after EXIT');
    m.buttons.add(SW.SHIFT); m.run(4e6); press(m, SW.PLUS_OCT); m.buttons.delete(SW.SHIFT); m.run(4e6); // OCT buttons -> Keyboard Shift
    t('SHIFT + +OCT');
    press(m, SW.PLUS_OCT); const up = shiftOf(); t('+OCT');
    press(m, SW.MINUS_OCT); press(m, SW.MINUS_OCT); const down = shiftOf(); t('-OCT x2');
    press(m, SW.RIBBON_RELATIVE); press(m, SW.RIBBON_HOLD); t('RELATIVE, HOLD');
    for (const line of trace) log(`  panel ${line}`);
    const s2 = await sysObj.fetch(api);
    const k = sysObj.params.find((p) => p.offset === 0x14);
    ok(`system 14h-16h from the panel: Keyboard Shift +OCT ${k.options[up][1]}, then -OCT twice ${k.options[down][1]}; RIBBON RELATIVE and HOLD on: 15h=${s2[0x15]} 16h=${s2[0x16]} (read by RQ1)`, [up === 3 && down === 1 ? null : `shift ${up} ${down}`, s2[0x14] === 1 && s2[0x15] === 1 && s2[0x16] === 1 ? null : 'RQ1'].filter(Boolean));
    send(sysObj.sendAll.build(s0, ctx));
    ok('system: restored', diffs(s0, await sysObj.fetch(api)));
  }

  // 6. the complete dump, sent back after the unit has been changed
  {
    const dump = async () => {
      const msgs = [];
      for (const r of def.requests.filter((x) => (def.fullDump || []).some((f) => (typeof f === 'string' ? f : f.request) === x.label))) {
        for (const q of asList(r.bytes(ctx))) msgs.push(...exchange(m, q, { max: 4e9 }));
      }
      return msgs;
    };
    const flat = (msgs) => { const mem = new Map(); for (const x of msgs) { const p = parseDt1(x, [0, 6]); if (p?.ok) p.data.forEach((v, i) => mem.set(addrToInt(p.addr) + i, v)); } return mem; };
    const first = await dump();
    const items = def.libraryItems(first);
    ok(`complete dump: ${first.length} messages, ${items.length} Branch Library items (${[...new Set(items.map((i) => i.key.replace(/\d+$/, '')))].join(', ')})`);
    const fp = panelInitialize(m, 0x0d); // FACTORY PRESET: user patches, performances, patterns, motions, system
    const changed = flat(await dump());
    const before = flat(first);
    let nd = 0;
    for (const [k, v] of before) if (changed.get(k) !== v) nd++;
    ok(`complete dump: the unit initialized from its panel ("${fp.page.join(' / ')}", WRITE: "${fp.done[0].trim()}"); ${nd} bytes now differ from the dump`, [/FACTORY PRESET/.test(fp.page[1]) ? null : 'wrong entry', /Completed/.test(fp.done[0]) ? null : 'not completed', nd ? null : 'nothing changed'].filter(Boolean));
    send(first);
    const second = await dump();
    const a = flat(first), b = flat(second);
    const d = [];
    for (const [k, v] of a) if (b.get(k) !== v) d.push(`${hex(intToAddr(k))}:${v}->${b.get(k)}`);
    for (const k of b.keys()) if (!a.has(k)) d.push(`${hex(intToAddr(k))}: extra`);
    ok(`complete dump: sent back after FACTORY PRESET, a second dump equal byte for byte (${a.size} bytes)`, d);
  }
  // 7. OS 1.05 bug (12A60): EXCLUSIVE on a Tx/Rx slot in MODE2 with Edit SW ON writes past the 96-entry
  // CC table at 21B450h over the memory signature copy at 21B5D0h; the next power-on says "Memory Damaged!"
  {
    const b = boot();
    const bc = emulatedClient(b);
    const bapi = { ctx, g: { client: bc } };
    const p = obj('patch');
    const name = 'EXCLUSIVE TEST  ';
    const pd = await p.slots.fetch(bapi, 0, 0);
    for (let i = 0; i < 16; i++) pd[i] = name.charCodeAt(i);
    stream(b, asList(p.slots.store(0, 0, ctx, pd)));
    const sysObj = obj('system');
    const s0 = await sysObj.fetch(bapi);
    const x = Uint8Array.from(s0);
    const slot = sysObj.params.find((q) => q.group?.startsWith('Tx/Rx') && q.label === 'FLT CUTOFF FREQ');
    for (const [q, v] of [[slot, 96], [sysObj.params.find((q) => q.offset === 6), 1], [sysObj.params.find((q) => q.offset === 7), 1]]) { writeParam(x, q, v); stream(b, asList(q.send(v, ctx, x))); }
    const sig = Buffer.from(b.mem.subarray(0x21b5d0, 0x21b5e0)).toString('latin1');
    powerCycle(b);
    const shown = lcd(b)[0].trim();
    const kept = p.name(await p.slots.fetch(bapi, 0, 0));
    ok(`OS 1.05 bug: FLT CUTOFF FREQ Tx/Rx = EXCLUSIVE with MODE2 and Edit SW ON overwrites the signature copy (${JSON.stringify(sig.slice(0, 8))}); power-on shows "${shown}"; user patch A11 kept ("${kept.trim()}")`, [/Damaged/.test(shown) ? null : 'no message', kept.trim() === name.trim() ? null : 'data lost'].filter(Boolean));
  }
  return report;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('check_editor.mjs')) {
  const fresh = process.argv.includes('--fresh');
  const t0 = Date.now();
  const r = await check({ fresh, log: (l) => console.log(l) });
  console.log(`${r.filter((l) => l.startsWith('FAIL')).length} failed of ${r.length} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
