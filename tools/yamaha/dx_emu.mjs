// The Yamaha DX family boards around the HD6303 core (hd6303.mjs): each model's own operating system
// runs from its reset vector as on the unit, with its RAM, its MIDI port (the CPU's serial port) and
// enough of its I/O (LCD, panel, cartridge, sound chips as write-only latches) that the OS boots, runs
// its main loop and answers MIDI. tools/yamaha/check_editor.mjs sends the editors' own messages to it.
// This stands in for a hardware check (no DX family unit is available).
//
//   const u = await DXUnit.create('dx7'); u.boot(); u.midi([...]); u.settle(); u.sent(); u.ram(a, n)
//
// The memory maps come from each OS's code (docs/devices/yamaha-*.md, "Emulator").

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HD6303 } from './hd6303.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FW = (p) => `${ROOT}re/dx/fw/${p}`;

/** A HD44780 LCD on an 8-bit bus: enough to read the screen the OS writes (2 x 40 characters). */
class Lcd {
  constructor() { this.ddram = new Uint8Array(128).fill(0x20); this.addr = 0; this.inc = 1; }
  command(v) {
    if (v & 0x80) this.addr = v & 0x7f;
    else if (v === 1) { this.ddram.fill(0x20); this.addr = 0; }
    else if (v === 2 || v === 3) this.addr = 0;
    else if ((v & 0xfc) === 4) this.inc = v & 2 ? 1 : -1;
  }
  data(v) { this.ddram[this.addr & 0x7f] = v; this.addr = (this.addr + this.inc) & 0x7f; }
  line(n, w = 40) { return String.fromCharCode(...this.ddram.subarray(n * 0x40, n * 0x40 + w)).replace(/[^\x20-\x7e]/g, '?'); }
  text(w = 40) { return `${this.line(0, w)}\n${this.line(1, w)}`; }
}

// ---------------------------------------------------------------- the models
const MODELS = {
  // DX7 (mark I) v1.8: ROM C000-FFFF; RAM 1000-27FF (1000 the 32 voices, battery backed; 2000 work);
  // 8255 at 2800 (A LCD data, B LCD control, C inputs: bit 7 LCD busy, cartridge and protect switches);
  // 2804/2805 OPS, 280A volume DAC, 280C/280E/280F LEDs and panel; 3000-30FF EGS; 4000-4FFF cartridge.
  dx7: {
    rom: [['dx7/DX7-V1-8.OBJ', 0xc000]],
    ram: [[0x1000, 0x2800]],
    clock: 2357000,
    // MIDI in: the SCI interrupt (E902) fills the ring 23F4-256F at 00EE; the main loop (EB80) takes one
    // byte per pass from 00F0
    busy: (u) => u.cpu.rw(0xee) !== u.cpu.rw(0xf0),
    io(u, a, v) { // v undefined = read
      if (a === 0x2800 || a === 0x2801) {
        if (v === undefined) return 0;
        u.p[a] = v;
        // port B (2801): bit 0 RS, bit 1 R/W, bit 2 E; the LCD latches port A (2800) on E falling (FEC7)
        if (a === 0x2801) {
          const pv = u.prev2801 ?? 0;
          if ((pv & 0x04) && !(v & 0x04) && !(pv & 0x02)) { if (pv & 0x01) u.lcd.data(u.p[0x2800] ?? 0); else u.lcd.command(u.p[0x2800] ?? 0); }
          u.prev2801 = v;
        }
        return;
      }
      if (a === 0x2802) return v === undefined ? (u.inputs ?? 0) : undefined;
      return v === undefined ? 0 : undefined;
    },
  },
};

export class DXUnit {
  constructor(model, cfg, roms) {
    this.model = model;
    this.cfg = cfg;
    this.mem = new Uint8Array(0x10000);
    this.romAt = new Uint8Array(0x10000); // 1 = ROM
    for (const [data, base] of roms) { this.mem.set(data, base); this.romAt.fill(1, base, base + data.length); }
    this.ramAt = new Uint8Array(0x10000);
    for (const [s, e] of cfg.ram) this.ramAt.fill(1, s, e);
    this.p = {};
    this.lcd = new Lcd();
    this.io = new Map(); // unknown I/O seen: address -> count
    this.cpu = new HD6303({
      read: (a) => this.read(a),
      write: (a, v) => this.write(a, v),
    }, { byteCycles: Math.round(cfg.clock * 10 / 31250) });
    this.cfg.setup?.(this);
  }

  static create(model) {
    const cfg = MODELS[model];
    if (!cfg) throw new Error(`no board for ${model}`);
    const roms = cfg.rom.map(([p, base]) => {
      const f = FW(p);
      if (!existsSync(f)) throw new Error(`firmware not found: ${f}`);
      return [readFileSync(f), base];
    });
    return new DXUnit(model, cfg, roms);
  }

  read(a) {
    if (this.romAt[a] || this.ramAt[a]) return this.mem[a];
    const v = this.cfg.io(this, a, undefined);
    this.io.set(a, (this.io.get(a) || 0) + 1);
    return v ?? 0;
  }
  write(a, v) {
    if (this.ramAt[a]) { this.mem[a] = v; return; }
    if (this.romAt[a]) return;
    this.cfg.io(this, a, v);
  }

  boot({ cycles = 4_000_000 } = {}) { this.cpu.reset(); this.run(cycles); }
  run(cycles) { const end = this.cpu.cycles + cycles; while (this.cpu.cycles < end) this.cpu.step(); }
  midi(bytes) { this.cpu.midiIn(bytes); }
  /** Run until the MIDI input is consumed and the OS has been quiet (no byte sent) for `quiet` cycles. */
  settle({ quiet = 200_000, max = 200_000_000 } = {}) {
    const end = this.cpu.cycles + max;
    let lastTx = this.cpu.tx.length, since = this.cpu.cycles;
    while (this.cpu.cycles < end) {
      this.cpu.step();
      if (this.cpu.tx.length !== lastTx) { // active sensing (FE) does not count
        if (this.cpu.tx.slice(lastTx).some(([, b]) => b !== 0xfe)) since = this.cpu.cycles;
        lastTx = this.cpu.tx.length;
      }
      if (!this.cpu.rx.length && this.cpu.cycles - since > quiet && !(this.cpu.trcsr & 0x80) && !this.cfg.busy?.(this)) return;
    }
    throw new Error(`${this.model}: no settle within ${max} cycles (pc ${this.cpu.pc.toString(16)})`);
  }
  ram(a, n) { return this.mem.slice(a, a + n); }
  setRam(a, bytes) { this.mem.set(bytes, a); }
  /** The SysEx messages the OS sent since tx position n. */
  messages(n = 0) {
    const out = [];
    let cur = null;
    for (const b of this.cpu.sent(n)) {
      if (b === 0xf0) cur = [b];
      else if (cur) { cur.push(b); if (b === 0xf7) { out.push(cur); cur = null; } }
      else if (b < 0xf8 && b >= 0x80) out.push([b]);
      else if (out.length && out.at(-1)[0] !== 0xf0 && b < 0x80) out.at(-1).push(b);
    }
    return out;
  }
}

export const models = Object.keys(MODELS);
