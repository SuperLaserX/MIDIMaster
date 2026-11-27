// Boot a Novation OS image in the H8/300H machine and report where it goes (development tool).
// node tools/novation/h8/boot.mjs IMAGE [cycles]
import { readFileSync } from 'node:fs';
import { Machine } from './machine.mjs';
import { novationBoard } from './board.mjs';

const [img, cyc = '20000000'] = process.argv.slice(2);
const m = new Machine(readFileSync(img), novationBoard());
m.reset();
const pcs = new Map();
let err = null;
try {
  for (let i = 0; i < Number(cyc) / 100000; i++) {
    m.run(100000);
    pcs.set(m.cpu.pc, (pcs.get(m.cpu.pc) || 0) + 1);
  }
} catch (e) { err = e; }
console.log('pc', m.cpu.pc.toString(16), 'cycles', m.cycles, err ? `ERROR ${err.message}` : '');
console.log('hot pcs', [...pcs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, n]) => `${p.toString(16)}:${n}`).join(' '));
console.log('regs', [...m.cpu.r].map((x) => x.toString(16)).join(' '), 'ccr', m.cpu.ccr.toString(16));
console.log(m.ioReport(200).join('\n'));
console.log('midi out', m.midiOut.length, Buffer.from(m.midiOut.slice(0, 64)).toString('hex'));
console.log('lcd', JSON.stringify(m.lcdText?.()));
