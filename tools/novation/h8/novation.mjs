// Run Novation's own operating systems (H8/300H) in the emulator: boot (or restore a saved boot),
// exchange MIDI, read the display buffer, watch memory. Used to check the editor's messages against
// the device's own receiver and to find what reads a byte (docs/devices/novation-supernova2.md,
// "Emulator").
//
//   import { boot, exchange, lcd } from './novation.mjs';
//   const m = boot('sn2rack');                      // restores re/novwork/h8/sn2rack.snap if present
//   const replies = exchange(m, [0xf0, ...]);       // SysEx replies (Uint8Array[])

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Machine } from './machine.mjs';
import { novationBoard } from './board.mjs';
import { sysexMessages } from '../../../js/core/midi/smf.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SNAP = join(ROOT, 're', 'novwork', 'h8');

/** OS images (decoded with tools/novation/os_mid.py or read from the EPROMs; not in git). */
export const MODELS = {
  sn2rack: { image: 're/sn2/work/rack20.bin', model: 0x24, lcd: 0x27f000, knobQ: 0x335aa, boot: 3e9, label: 'SuperNova II Rack OS 2.0' },
  sn2kbd: { image: 're/novfw/snii_kbd_os20.bin', model: 0x22, lcd: 0x27f000, knobQ: 0x3a1c8, boot: 3e9, label: 'SuperNova II Keyboard OS 2.0' },
  nova2: { image: 're/novfw/novaii_kbd_os2.bin', model: 0x23, lcd: 0x27f000, knobQ: 0x39438, boot: 3e9, label: 'Nova II Keyboard OS 2' },
  sn1: { image: 're/novfw/sn1_os41.bin', model: 0x20, rowMask: 0x0f, factory: ['re/novfw/supernova-os2/SNV4.1 Folder/total.mid'], hd44780: true, hostSpacing: 1, flashAt: [0x200000, 0x400000], ram: [[0x400000, 0x440000]], knobQ: 0x22608, boot: 3e9, label: 'SuperNova OS 4.1' },
  nova: { image: 're/novfw/nova_os41.bin', model: 0x21, rowMask: 0x0f, factory: ['re/novfw/nova-laptop-os3/nova4.1/total.mid'], hd44780: true, hostSpacing: 0x400, hostBase: 0x900000, flashAt: [0x800000, 0x900000], ram: [[0xa00000, 0xa40000]], knobQ: 0x26942, boot: 3e9, label: 'Nova OS 4.1' },
};

export function machine(name, extra = {}) {
  const cfg = MODELS[name];
  const board = novationBoard({ hostSpacing: cfg.hostSpacing, hostBase: cfg.hostBase, flashAt: cfg.flashAt, ram: cfg.ram, ...extra });
  // front-panel switch matrix: port B selects row C0h + r (strobe bit 6), port A reads 8 switches
  // (0 = pressed): SuperNova II Rack OS 2.0 scan at 92C2 (12 rows; Keyboard OS 2.0 17, Nova II 16),
  // switch number = row * 8 + bit
  const buttons = new Set();
  board.portA = (mm) => { const row = mm.reg[0xd6] & (cfg.rowMask ?? 0x1f); let v = 0xff; for (const b of buttons) if (b >> 3 === row) v &= ~(1 << (b & 7)); return v; };
  // OS 4.1 boards: an HD44780 display on port A (data) and port 6 (FFFFCB: bit 0 RS, bit 1 E,
  // bit 2 R/W; SuperNova OS 4.1 routines at 6E48 / 6E94 / 6E6A); kept as 2 x 40 characters
  let lcdChip = null;
  if (cfg.hd44780) {
    lcdChip = { ddram: new Uint8Array(128).fill(0x20), ac: 0, inc: 1, cg: false, p6: 0 };
    const pa = board.portA;
    board.portA = (mm) => {
      const p6 = lcdChip.p6;
      if ((p6 & 6) === 6) { if (p6 & 1) { const v = lcdChip.ddram[lcdChip.ac & 0x7f]; lcdChip.ac = (lcdChip.ac + lcdChip.inc) & 0x7f; return v; } return lcdChip.ac & 0x7f; }
      return pa(mm);
    };
    board.ioWrite = (a, v, mm) => {
      if (a !== 0xffffcb) return;
      const old = lcdChip.p6;
      lcdChip.p6 = v;
      if ((old & 2) && !(v & 2) && !(old & 4)) { // E falls on a write
        const d = mm.reg[0xd3];
        if (old & 1) { if (!lcdChip.cg) { lcdChip.ddram[lcdChip.ac & 0x7f] = d; lcdChip.ac = (lcdChip.ac + lcdChip.inc) & 0x7f; } }
        else if (d & 0x80) { lcdChip.ac = d & 0x7f; lcdChip.cg = false; }
        else if (d & 0x40) lcdChip.cg = true;
        else if (d === 1) { lcdChip.ddram.fill(0x20); lcdChip.ac = 0; lcdChip.cg = false; }
        else if ((d & 0xfe) === 2) { lcdChip.ac = 0; }
        else if ((d & 0xfc) === 4) lcdChip.inc = d & 2 ? 1 : -1;
      }
    };
  }
  // SCI0 at 31250 baud with a 16 MHz clock (BRR 0Fh, SMR 0): 512 cycles a bit, 5120 a byte
  const m = new Machine(readFileSync(join(ROOT, cfg.image)), { byteGap: 5120, ...board });
  m.cfg = cfg;
  m.name = name;
  m.buttons = buttons;
  m.lcdChip = lcdChip;
  return m;
}

/** A booted machine: from the saved snapshot, or booted now (and saved) when there is none or fresh is set. */
export function boot(name, { fresh = false, save = true, extra = {} } = {}) {
  const m = machine(name, extra);
  const file = join(SNAP, `${name}.snap`);
  if (!fresh && existsSync(file)) { m.restore(readFileSync(file)); return m; }
  m.reset();
  m.run(m.cfg.boot);
  if (save) { mkdirSync(SNAP, { recursive: true }); writeFileSync(file, m.snapshot()); }
  return m;
}

/**
 * Send bytes and run until the OS has taken them and been quiet for `quiet` cycles; returns the
 * SysEx messages it sent (other output stays in m.midiOut until the next takeSysex).
 */
export function exchange(m, bytes, { quiet = 60e6, max = 3e9, step = 5e6 } = {}) {
  m.takeSysex();
  m.midiOut = [];
  m.send(bytes);
  const start = m.cycles;
  let lastLen = 0, lastChange = m.cycles;
  while (m.cycles - start < max) {
    m.run(step);
    if (m.midiOut.length !== lastLen || m.midiIn.length) { lastLen = m.midiOut.length; lastChange = m.cycles; }
    else if (m.cycles - lastChange >= quiet) break;
  }
  return m.takeSysex();
}

/** Press and release front-panel switch n (row * 8 + bit), letting the OS see each. */
export function press(m, n, { hold = 40e6, after = 60e6 } = {}) {
  m.buttons.add(n);
  m.run(hold);
  m.buttons.delete(n);
  m.run(after);
}

/**
 * Put a knob / encoder event into the OS's panel event queue (the A/D and encoder interrupts' queue:
 * write index at cfg.knobQ, 256 words after it, word = value << 8 | knob code; Rack OS 2.0 06DE).
 */
export function knob(m, code, value, { after = 30e6 } = {}) {
  const q = m.cfg.knobQ;
  const wr = (m.mem[q] << 8) | m.mem[q + 1];
  m.mem[q + 4 + wr] = value & 0xff;
  m.mem[q + 5 + wr] = code & 0xff;
  const n = (wr + 2) & 0x1fe;
  m.mem[q] = n >> 8; m.mem[q + 1] = n & 0xff;
  m.run(after);
}

/** The display buffer (2 x 40 characters) where the model's OS keeps it. */
export function lcd(m) {
  if (m.lcdChip) { const t = (o) => Buffer.from(m.lcdChip.ddram.subarray(o, o + 40)).toString('latin1').replace(/[\x00-\x1f]/g, '.'); return [t(0), t(0x40)]; }
  const a = m.cfg.lcd;
  if (!a) return null;
  const t = (o) => Buffer.from(m.mem.subarray(a + o, a + o + 40)).toString('latin1').replace(/[\x00-\x1f]/g, '.');
  return [t(0), t(40)];
}

/** Record reads/writes of the given [start, end) ranges: returns the hit list (cleared by the caller). */
export function watch(m, ranges) {
  const hits = [];
  m.setWatch(ranges);
  m.watch = (a, w, v, pc) => hits.push({ a, w, v, pc });
  return hits;
}

/**
 * Factory sounds into the emulated unit's memories, the way a user would load them: Memory protect
 * off (packed NRPN 1 = 121 on the global channel), then Novation's factory files (the SuperNova II
 * Keyboard OS 2 package: program banks A-H, drum maps, performance banks A-B, arpeggio patterns),
 * then the captured global settings, then performance B000 selected (bank select 2, program change 0).
 * Saved as <name>-factory.snap.
 */
export function factory(name, { fresh = false, files } = {}) {
  const file = join(SNAP, `${name}-factory.snap`);
  if (!fresh && existsSync(file)) { const m = machine(name); m.restore(readFileSync(file)); return m; }
  const m = boot(name);
  const ch = globalChannel(m);
  exchange(m, [0xb0 | ch, 99, 0, 0xb0 | ch, 98, 1, 0xb0 | ch, 6, 121]);
  const dir = join(ROOT, 're/novfw/supernova-ii-keyboard-os-2/snv2kos2');
  const list = files || m.cfg.factory || ['pbanka', 'pbankb', 'pbankc', 'pbankd', 'pbanke', 'pbankf', 'pbankg', 'pbankh', 'drum a', 'drum b', 'drum c', 'drum d', 'drum h', 'perfa', 'perfb', 'arp data'].map((f) => join(dir, `${f}.mid`));
  // device byte 7F (any unit): the OS 4.1 files carry device 0, which a unit on another global channel refuses
  for (const f of list) stream(m, sysexMessages(readFileSync(f.startsWith('re/') ? join(ROOT, f) : f)).map((x) => { const y = Uint8Array.from(x); y[6] = 0x7f; return y; }));
  // SuperNova II models: global settings as captured from the SuperNova II Rack used for the live
  // checks (global channel 16, power-up performance B000), so that program changes select sounds
  const cap = join(ROOT, 're/sn2/live/s2/cap_global.syx');
  if (!m.cfg.factory && existsSync(cap)) stream(m, messages(readFileSync(cap)).map((x) => { const y = Uint8Array.from(x); y[5] = m.cfg.model; return y; }));
  const pch = globalChannel(m);
  exchange(m, [0xb0 | pch, 0, 0, 0xb0 | pch, 32, m.cfg.factory ? 1 : 2, 0xc0 | pch, 0]);
  writeFileSync(file, m.snapshot());
  return m;
}

/** The global MIDI channel (0-15) the OS answers on (the device byte of its global dump). */
export function globalChannel(m) {
  const r = exchange(m, [0xf0, 0, 0x20, 0x29, 1, m.cfg.model, 0x7f, 0x10, 0xf7]);
  return r.length ? r[0][6] & 15 : 15;
}

/** Send many messages at MIDI speed and run until the OS has taken them all and is quiet. */
export function stream(m, msgs, opt = {}) {
  const all = [];
  for (const x of msgs) all.push(...x);
  return exchange(m, all, { quiet: 30e6, max: 1e11, step: 20e6, ...opt });
}

export const hex = (b) => Buffer.from(b).toString('hex');
export const syx = (s) => Uint8Array.from(Buffer.from(s.replace(/[^0-9a-fA-F]/g, ''), 'hex'));
/** Split a .syx file into messages. */
export function messages(buf) {
  const out = [];
  let cur = null;
  for (const b of buf) {
    if (b === 0xf0) cur = [b];
    else if (cur) { cur.push(b); if (b === 0xf7) { out.push(Uint8Array.from(cur)); cur = null; } }
  }
  return out;
}
