// Small checks of the 6809 core (tools/m6809/cpu.mjs) against results worked out from the data sheet.
//   node tools/m6809/selftest.mjs
import { M6809 } from './cpu.mjs';

let fails = 0;
function run(bytes, setup = {}, steps = 50) {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, 0x1000);
  mem[0xfffe] = 0x10; mem[0xffff] = 0x00;
  const cpu = new M6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset();
  Object.assign(cpu, setup);
  for (let i = 0; i < steps && cpu.pc !== 0x1000 + bytes.length; i++) cpu.step();
  return { cpu, mem };
}
function eq(name, got, want) {
  if (got !== want) { fails++; console.log(`FAIL ${name}: got ${got.toString(16)} want ${want.toString(16)}`); }
}

// ADDA with half carry and overflow: 0x7F + 0x01 = 0x80, V N H set
{ const { cpu } = run([0x86, 0x7f, 0x8b, 0x01]); eq('adda', cpu.a, 0x80); eq('adda cc', cpu.cc & 0x2f, 0x20 | 0x08 | 0x02); }
// SUBA borrow: 0x00 - 0x01 = 0xFF, N C set
{ const { cpu } = run([0x86, 0x00, 0x80, 0x01]); eq('suba', cpu.a, 0xff); eq('suba cc', cpu.cc & 0x0f, 0x08 | 0x01); }
// CMPX equal -> Z
{ const { cpu } = run([0x8e, 0x12, 0x34, 0x8c, 0x12, 0x34]); eq('cmpx', cpu.cc & 0x0f, 0x04); }
// MUL 0x10 * 0x10 = 0x0100, C = bit 7 of B = 0
{ const { cpu } = run([0x86, 0x10, 0xc6, 0x10, 0x3d]); eq('mul', cpu.d, 0x100); eq('mul c', cpu.cc & 1, 0); }
// DAA: 0x19 + 0x28 = 0x41 -> 0x47
{ const { cpu } = run([0x86, 0x19, 0x8b, 0x28, 0x19]); eq('daa', cpu.a, 0x47); }
// Indexed: LDX #$2000, STA ,X+ twice, then LDB -1,X
{ const { cpu, mem } = run([0x8e, 0x20, 0x00, 0x86, 0x55, 0xa7, 0x80, 0x86, 0x66, 0xa7, 0x80, 0xe6, 0x1f]); eq('sta ,x+', mem[0x2000], 0x55); eq('ldb -1,x', cpu.b, 0x66); eq('x', cpu.x, 0x2002); }
// Indirect: LDX #$2000; [$2000] = $3000; LDA [,X] reads $3000
{ const mem0 = [0x8e, 0x20, 0x00, 0xa6, 0x94]; const r = run(mem0, {}, 0); r.mem[0x2000] = 0x30; r.mem[0x2001] = 0x00; r.mem[0x3000] = 0x99; r.cpu.step(); r.cpu.step(); eq('lda [,x]', r.cpu.a, 0x99); }
// PSHS/PULS order: push A,B,X then pull into other order
{ const { cpu } = run([0x10, 0xce, 0x80, 0x00, 0x86, 0x11, 0xc6, 0x22, 0x8e, 0x33, 0x44, 0x34, 0x16, 0x4f, 0x5f, 0x8e, 0, 0, 0x35, 0x16]); eq('puls a', cpu.a, 0x11); eq('puls b', cpu.b, 0x22); eq('puls x', cpu.x, 0x3344); eq('s', cpu.s, 0x8000); }
// BSR / RTS
{ const { cpu } = run([0x10, 0xce, 0x80, 0x00, 0x8d, 0x02, 0x20, 0x03, 0x86, 0x42, 0x39]); eq('bsr/rts', cpu.a, 0x42); eq('s after rts', cpu.s, 0x8000); }
// Signed branches: LDA #$80; CMPA #$01 -> BLT taken (N != V)
{ const { cpu } = run([0x86, 0x80, 0x81, 0x01, 0x2d, 0x02, 0x86, 0x00, 0xc6, 0x07]); eq('blt', cpu.a, 0x80); eq('blt b', cpu.b, 0x07); }
// ROL / ASL flags: LDA #$C0, ASLA -> 0x80, C=1, V=0
{ const { cpu } = run([0x86, 0xc0, 0x48]); eq('asla', cpu.a, 0x80); eq('asla cc', cpu.cc & 0x0f, 0x08 | 0x01); }
// TFR A->DP, EXG X,Y
{ const { cpu } = run([0x86, 0x60, 0x1f, 0x8b, 0x8e, 0x12, 0x34, 0x10, 0x8e, 0x56, 0x78, 0x1e, 0x12]); eq('tfr dp', cpu.dp, 0x60); eq('exg x', cpu.x, 0x5678); eq('exg y', cpu.y, 0x1234); }
// IRQ: CLI then the IRQ vector runs and RTI returns
{
  const mem = new Uint8Array(0x10000);
  mem.set([0x10, 0xce, 0x80, 0x00, 0x1c, 0xef, 0x12, 0x12, 0x12], 0x1000);
  mem.set([0x86, 0x77, 0x3b], 0x2000);
  mem[0xfffe] = 0x10; mem[0xffff] = 0; mem[0xfff8] = 0x20; mem[0xfff9] = 0;
  const cpu = new M6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset(); cpu.step(); cpu.step(); cpu.irq = true; cpu.step(); cpu.irq = false; cpu.step();
  eq('irq a', cpu.a, 0x77); cpu.step();
  eq('rti restores a', cpu.a, 0); eq('irq return', cpu.pc, 0x1006); eq('irq s', cpu.s, 0x8000);
}
console.log(fails ? `${fails} failures` : 'm6809 self test: all checks pass');
process.exit(fails ? 1 : 0);
