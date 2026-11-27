// External chips of the Novation boards as far as the OS needs them to run (memory map per model,
// from each OS image: tools/novation/h8/novation.mjs MODELS):
// - flash: 512 KB chips with 256-byte page writes (software data protection: AA to 5555, 55 to
//   2AAA, A0 to 5555, then the page; write routine at 9656 in the SuperNova II Rack OS 2.0, 6D80 in
//   the SuperNova OS 4.1). Kept in memory (board.flash), erased (FF) at start. SuperNova II and
//   Nova II: 400000-7FFFFF; SuperNova OS 4.1: 200000-3FFFFF; Nova OS 4.1: 800000-9FFFFF.
// - DSP56k host interfaces (ICR, CVR, ISR, IVR, -, RXH/TXH, RXM/TXM, RXL/TXL): SuperNova II boards
//   10000h apart from 800000 (one DSP per byte address 80000n); SuperNova OS 4.1 one byte apart
//   from 800000; Nova OS 4.1 400h apart from 900000 (its loader at 1E32). They
//   answer "transmit ready", mirror host flags HF0/HF1 as HF3/HF2 and answer a read request word
//   (TXH bit 7, e.g. 803Fh at SuperNova II Rack OS 2.0 40DC) with 000000.
// Everything else reads 0 and is counted in machine.ioLog.

export function novationBoard(extra = {}) {
  const last = new Map();
  const [fs, fe] = extra.flashAt || [0x400000, 0x800000];
  const flash = extra.flash || new Uint8Array(fe - fs).fill(0xff);
  let fstate = 0, fprog = 0;
  const rxPending = new Set();
  const hostBase = extra.hostBase ?? 0x800000;
  const spread = extra.hostSpacing ?? 0x10000;
  const hostReg = (a) => {
    const off = a - hostBase;
    if (spread === 1) return off >= 0 && off < 0x100 ? [off & 7, a & ~7] : null;
    if (off < 0 || off >= 8 * spread || off % spread >= 16) return null;
    return [Math.floor(off / spread), hostBase + (off % spread)];
  };
  const hostAddr = (base, reg) => base + reg * spread;
  return {
    ram: extra.ram || [[0x200000, 0x300000]],
    flash,
    extRead(a, m) {
      if (a >= fs && a < fe) { fprog = 0; return flash[a - fs]; }
      const hr = hostReg(a);
      if (hr) {
        const [reg, base] = hr;
        if (reg === 2) { // ISR: TXDE | TRDY; the DSP answers host flag HF0/HF1 with HF3/HF2
          const icr = last.get(base) ?? 0;
          return 0x06 | (icr & 0x08 ? 0x10 : 0) | (icr & 0x10 ? 0x08 : 0) | (rxPending.has(base) ? 1 : 0);
        }
        if (reg === 7) rxPending.delete(base); // RXL read ends the word
        if (reg === 1) return (last.get(a) ?? 0) & 0x7f; // CVR: host command taken
        if (reg === 0 || reg === 3) return last.get(a) ?? 0;
        return 0;
      }
      return extra.extRead?.(a, m);
    },
    extWrite(a, v, m) {
      if (a >= fs && a < fe) {
        const off = a & 0x7ffff, chip = (a & ~0x7ffff) - fs;
        if (fprog > 0) { flash[a - fs] = v; fprog--; m.flashWrites = (m.flashWrites || 0) + 1; return; }
        if (fstate === 0) fstate = off === 0x5555 && v === 0xaa ? 1 : 0;
        else if (fstate === 1) fstate = off === 0x2aaa && v === 0x55 ? 2 : 0;
        else if (fstate === 2) {
          fstate = 0;
          if (off === 0x5555 && v === 0xa0) fprog = 256;
          else if (off === 0x5555 && v === 0x80) fstate = 3;
        } else if (fstate === 3) fstate = off === 0x5555 && v === 0xaa ? 4 : 0;
        else if (fstate === 4) fstate = off === 0x2aaa && v === 0x55 ? 5 : 0;
        else if (fstate === 5) { // chip erase
          fstate = 0;
          if (off === 0x5555 && v === 0x10) flash.fill(0xff, chip, chip + 0x80000);
        }
        return;
      }
      last.set(a, v);
      const hr = hostReg(a);
      if (hr && hr[0] === 7 && ((last.get(hostAddr(hr[1], 5)) ?? 0) & 0x80)) rxPending.add(hr[1]);
      extra.extWrite?.(a, v, m);
    },
    ...extra.opt,
  };
}
