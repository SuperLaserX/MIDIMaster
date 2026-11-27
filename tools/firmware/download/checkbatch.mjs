// node checkbatch.mjs <batch.jsonl> [--append]: parse a queue batch, check maker/model against midi_devices.json, optionally append it to the queue
import fs from 'node:fs';
const [file, flag] = process.argv.slice(2);
const db = JSON.parse(fs.readFileSync(new URL('../midi_devices.json', import.meta.url), 'utf8'));
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
let bad = 0, jobs = 0;
for (const l of lines) {
  if (!l.trim() || l.startsWith('#')) continue;
  let j; try { j = JSON.parse(l); } catch { console.log('NOT JSON:', l.slice(0, 80)); bad++; continue; }
  jobs++;
  const n = j.note && typeof j.note === 'object' ? j.note : j;
  if (!db.devices.find((d) => d.maker === n.maker && d.model === n.model)) { console.log('NO JSON DEVICE:', n.maker, '|', n.model); bad++; }
}
console.log(`${jobs} jobs, ${bad} problems`);
if (flag === '--append' && !bad) {
  const q = new URL('./queue.jsonl', import.meta.url);
  const cur = fs.readFileSync(q, 'utf8');
  fs.appendFileSync(q, (cur.endsWith('\n') ? '' : '\n') + lines.filter((l) => l.trim()).join('\n') + '\n');
  console.log('appended to queue.jsonl');
}
