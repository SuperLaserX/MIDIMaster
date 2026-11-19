// Cross-checks the Matrix-1000 definition against the v1.13 ROM:
// parameter number -> byte offset (table 0xDE13), field widths and signedness (packer.py).
// usage: node check_def.mjs <ROM> <path to js/devices/defs/oberheim-matrix1000.js>
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [rom, def] = process.argv.slice(2);
const d = readFileSync(rom);
const m = await import(pathToFileURL(def).href);
const table = d.subarray(0xde13 - 0x8000, 0xde13 - 0x8000 + 100);
const packer = fileURLToPath(new URL('./packer.py', import.meta.url));
const out = execFileSync('python3', ['-I', packer, rom]).toString();
const widths = {};
for (const line of out.split('\n')) {
  const r = /sysex byte\s+(\d+): (\d+) bits\s*(signed)?/.exec(line);
  if (r) widths[Number(r[1])] = { bits: Number(r[2]), signed: !!r[3] };
}
let bad = 0;
for (const [num, offset, group, label, type] of m._test.PATCH) {
  const fw = 8 + table[num];
  const w = widths[offset];
  const tbits = /^[us]\d$/.test(type) ? Number(type.slice(1)) : type === 'u5x' ? 5 : null;
  const issues = [];
  if (fw !== offset) issues.push(`table says byte ${fw}`);
  if (tbits && w.bits !== tbits) issues.push(`packer stores ${w.bits} bits`);
  if (/^s\d$/.test(type) !== w.signed) issues.push(`signed mismatch (firmware ${w.signed})`);
  const p = m._test.patchParams.find((x) => x.num === num);
  if (p.options && p.options.length > 2 ** w.bits) issues.push(`${p.options.length} options in ${w.bits} bits`);
  if (issues.length) { bad++; console.log(`#${num} ${group} ${label}: ${issues.join(', ')}`); }
}
for (let s = 0; s < 10; s++) {
  const o = 104 + s * 3;
  if (widths[o].bits !== 5 || !widths[o + 1].signed || widths[o + 2].bits !== 5) { bad++; console.log(`matrix slot ${s} layout differs`); }
}
console.log(bad ? `${bad} mismatches` : 'all 96 parameters and 10 matrix slots match the firmware');
process.exit(bad ? 1 : 0);
