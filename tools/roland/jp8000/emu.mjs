// Run the Roland JP-8000's own operating system (OS v1.05, Hitachi H8/3002, the same core as the
// Novation boards: tools/novation/h8) so that the editor's messages can be checked against the
// JP-8000's receiver and transmitter where no unit is available (docs/devices/roland-jp8000.md,
// "Emulator").
//
//   import { boot, exchange, press, lcd } from './emu.mjs';
//   const m = boot();                          // restores re/jp8080/emu/jp8000.snap if present
//   const replies = exchange(m, [0xf0, 0x41, 0x10, 0x00, 0x06, 0x11, ...]);
//
// The board, as far as the OS needs it (from the image, re/jp8080/fw/jp8000_v1.05.bin, not in git):
// - 000000-07FFFF the image (a boot block, reset 200h, then the OS from 4000h); RAM from 200000h
//   (stack 20F000h); the battery-backed memory starts at 210000h with the 16-byte signature
//   "JD-4 VER1.00 '96" (compared with 68924h by 13056h, written again at 21B5D0h).
// - SCI0 = MIDI (31250 baud, BRR 0Fh at 16 MHz: 5120 cycles a byte). Receive interrupt 4204h puts
//   the bytes into a 2 KB ring at 20042Eh (write index 200C30h); the MIDI task reads it (55AAh)
//   and the SysEx dispatcher at 5880h takes F0 41 dev 00 06 11|12 (device ID at 210085h, Rx
//   Exclusive switch at 210086h, tested at 5964h).
// - LCD: an HD44780 type, instruction register 600004h, data 600005h (2 lines of 16).
// - Panel switches: a 16-row matrix scanned by the ITU1 interrupt (3873Eh): the row index is at
//   20C0BEh, the row is read from port B (FFFFD6h, 0 = pressed) into 20C45Eh + row; switch
//   number = row * 8 + bit.
// - Four DSPs at 400000h, 404000h, 408000h, 40C000h (control at +2000h) are written and never read
//   back except their status, which reads 0 here.
//
// The first boot finds the memory unformatted ("Memory Damaged!"), so the OS's own Initialize
// routine (13422h, the routine behind SHIFT + INIT/UTIL, here with type 0Dh FACTORY PRESET) is
// run inside the OS's message task, and the unit is then switched off and on again.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Machine } from '../../novation/h8/machine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const IMAGE = join(ROOT, 're', 'jp8080', 'fw', 'jp8000_v1.05.bin');
const SNAP = join(ROOT, 're', 'jp8080', 'emu');

export const RAM = {
  signature: 0x210000,
  system: 0x210010, // system internal id A0h + n: SysEx system bytes 00-16h are ids A0h-B6h
  deviceId: 0x210085,
  rxExclusive: 0x210086,
  switchRow: 0x20c0be,
  switchBits: 0x20c45e,
};
const BOOT_CYCLES = 60e6;
const INIT_ROUTINE = 0x13422;
const MESSAGE_TASK_WAIT = 0x3833a; // the popup message task, about to wait for its next event

/** A JP-8000 machine (not booted). */
export function machine() {
  const lcdChip = { ddram: new Uint8Array(128).fill(0x20), ac: 0, inc: 1 };
  const buttons = new Set();
  const m = new Machine(readFileSync(IMAGE), {
    byteGap: 5120,
    extDefault: 0,
    extWrite(a, v) {
      if (a === 0x600004) { // instruction
        if (v & 0x80) lcdChip.ac = v & 0x7f;
        else if (v === 1) { lcdChip.ddram.fill(0x20); lcdChip.ac = 0; }
        else if ((v & 0xfe) === 2) lcdChip.ac = 0;
        else if ((v & 0xfc) === 4) lcdChip.inc = v & 2 ? 1 : -1;
      } else if (a === 0x600005) { // data
        lcdChip.ddram[lcdChip.ac & 0x7f] = v;
        lcdChip.ac = (lcdChip.ac + lcdChip.inc) & 0x7f;
      }
    },
    ioRead(a, mm) {
      if (a !== 0xffffd6) return undefined;
      const row = mm.mem[RAM.switchRow] & 15;
      let v = 0xff;
      for (const b of buttons) if (b >> 3 === row) v &= ~(1 << (b & 7));
      return v;
    },
  });
  m.lcdChip = lcdChip;
  m.buttons = buttons;
  return m;
}

/** Run the OS's Initialize routine for list entry `type` (0-0Dh, list "Initialze[WRITE]") in its message task. */
export function initialize(m, type) {
  let done = false;
  const saved = m.breakpoints;
  m.breakpoints = new Map([[MESSAGE_TASK_WAIT, (mm) => {
    if (done) return;
    done = true;
    const c = mm.cpu;
    c.sp -= 4;
    c.w32(c.sp, MESSAGE_TASK_WAIT);
    c.setW(0, type);
    c.pc = INIT_ROUTINE;
  }]]);
  m.send([0xfe]); // any byte: the task wakes on events
  for (let i = 0; i < 40 && !done; i++) m.run(2e6);
  m.run(30e6);
  m.breakpoints = saved;
  if (!done) throw new Error('initialize: the message task was not reached');
}

/** Switch off and on again: the CPU restarts, the battery-backed RAM keeps its contents. */
export function powerCycle(m) {
  m.reset();
  m.midiIn = [];
  m.midiOut = [];
  m.run(BOOT_CYCLES);
  m.midiOut = [];
}

/** A booted JP-8000 with formatted memory (FACTORY PRESET), from the snapshot or booted now. */
export function boot({ fresh = false, save = true } = {}) {
  const m = machine();
  const file = join(SNAP, 'jp8000.snap');
  if (!fresh && existsSync(file)) { m.restore(readFileSync(file)); return m; }
  m.reset();
  m.run(BOOT_CYCLES);
  initialize(m, 0x0d);
  const sig = Buffer.from(m.mem.subarray(RAM.signature, RAM.signature + 16)).toString('latin1');
  if (sig !== "JD-4 VER1.00 '96") throw new Error(`boot: memory not formatted (${JSON.stringify(sig)})`);
  powerCycle(m);
  if (save) { mkdirSync(SNAP, { recursive: true }); writeFileSync(file, m.snapshot()); }
  return m;
}

/**
 * Send bytes and run until the OS has taken them and been quiet for `quiet` cycles; returns the
 * SysEx messages it sent.
 */
export function exchange(m, bytes, { quiet = 8e6, max = 2e9, step = 1e6 } = {}) {
  m.takeSysex();
  m.midiOut = [];
  m.send(bytes);
  const start = m.cycles;
  // active sensing (FEh, about every 300 ms) and clock bytes do not count as output
  const busy = () => { let n = 0; for (const b of m.midiOut) if (b < 0xf8) n++; return n; };
  let lastLen = 0, lastChange = m.cycles;
  while (m.cycles - start < max) {
    m.run(step);
    const n = busy();
    if (n !== lastLen || m.midiIn.length) { lastLen = n; lastChange = m.cycles; }
    else if (m.cycles - lastChange >= quiet) break;
  }
  return m.takeSysex();
}

/** Send messages one after another, with the pause Roland asks for between DT1 messages (20 ms+). */
export function stream(m, msgs, opt = {}) {
  const out = [];
  for (const x of msgs) out.push(...exchange(m, Array.from(x), { quiet: 1.6e6, ...opt }));
  return out;
}

/**
 * Front-panel switches (row * 8 + bit), found by pressing each in the emulator: SHIFT doubles as
 * EXIT; the number keys are [1] 25, [2] 17, [3] 9, [4] 26, [5] 18, [6] 10, [7] 27 (INIT/UTIL),
 * [8] 19.
 */
export const SW = { SHIFT: 3, EXIT: 3, WRITE: 11, UP: 16, DOWN: 24, INIT_UTIL: 27, PLUS_OCT: 97, MINUS_OCT: 105, RIBBON_RELATIVE: 113, RIBBON_HOLD: 121 };

/**
 * Initialize through the panel, as the owner's manual describes it: SHIFT + INIT/UTIL opens
 * "Initialze[WRITE]", UP `type` times (0 PATCH: TEMP ... 0Dh FACTORY PRESET), WRITE. Returns the
 * page line chosen and the display after WRITE ("Completed").
 */
export function panelInitialize(m, type) {
  m.buttons.add(SW.SHIFT); m.run(4e6);
  press(m, SW.INIT_UTIL);
  m.buttons.delete(SW.SHIFT); m.run(4e6);
  // INIT/UTIL steps through the utility pages and the OS reopens the last one used: go to Initialize
  for (let i = 0; i < 4 && !/^Initialze/.test(lcd(m)[0]); i++) press(m, SW.INIT_UTIL);
  if (!/^Initialze/.test(lcd(m)[0])) throw new Error(`panelInitialize: no Initialize page (${lcd(m).join(' / ')})`);
  for (let i = 0; i < 16 && lcd(m)[1] !== 'PATCH:      TEMP'; i++) press(m, SW.DOWN); // back to the first entry
  for (let i = 0; i < type; i++) press(m, SW.UP);
  const page = lcd(m);
  press(m, SW.WRITE);
  for (let i = 0; i < 100 && !/Completed/.test(lcd(m)[0]); i++) m.run(5e6);
  const done = lcd(m);
  m.run(60e6);
  return { page, done };
}

/** Hold front-panel switches (row * 8 + bit) together, then release them. */
export function press(m, ...sw) {
  const opt = typeof sw[sw.length - 1] === 'object' ? sw.pop() : {};
  for (const n of sw) m.buttons.add(n);
  m.run(opt.hold ?? 4e6);
  for (const n of sw.slice().reverse()) m.buttons.delete(n);
  m.run(opt.after ?? 6e6);
}

/** The two display lines. */
export function lcd(m) {
  const t = (o) => Buffer.from(m.lcdChip.ddram.subarray(o, o + 16)).toString('latin1').replace(/[\x00-\x1f]/g, '.');
  return [t(0), t(0x40)];
}

/** System bytes 00-16h as the OS holds them. */
export const systemBytes = (m) => Uint8Array.from(m.mem.subarray(RAM.system, RAM.system + 0x17));

/** Record reads/writes of the given [start, end) ranges: returns the hit list. */
export function watch(m, ranges) {
  const hits = [];
  m.setWatch(ranges);
  m.watch = (a, w, v, pc) => hits.push({ a, w, v, pc });
  return hits;
}

export const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)(?=.)/g, '$1 ');
