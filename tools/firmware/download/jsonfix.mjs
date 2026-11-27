// Applies corrections to tools/firmware/midi_devices.json and saves it in the format midi_devices_report.mjs writes.
//   node tools/firmware/download/jsonfix.mjs <fixes.json> [--dry-run]
// fixes.json: [{ "id": "device-id", "set": { "firmware.officialDownload": false, "firmware.where": "..." }, "unset": ["path"] }, ...]
// Paths are dot-separated; "set" values replace whatever is there. Afterwards run
// `node tools/firmware/midi_devices_report.mjs --match` to rebuild the docs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const JSON_PATH = path.join(REPO, 'tools/firmware/midi_devices.json');
const [fixFile, ...rest] = process.argv.slice(2);
const dry = rest.includes('--dry-run');
const db = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const fixes = JSON.parse(fs.readFileSync(fixFile, 'utf8'));
let n = 0;
for (const f of fixes) {
  if (f.top) { // { "top": { "about": "..." } } sets top-level fields of the JSON
    for (const [k, v] of Object.entries(f.top)) if (JSON.stringify(db[k]) !== JSON.stringify(v)) { db[k] = v; n++; console.log(`top: ${k} changed`); }
    continue;
  }
  const d = db.devices.find((x) => x.id === f.id);
  if (!d) { console.log(`! no device ${f.id}`); continue; }
  for (const [p, v] of Object.entries(f.set || {})) {
    const keys = p.split('.'); let o = d;
    for (const k of keys.slice(0, -1)) o = (o[k] ||= {});
    const old = JSON.stringify(o[keys.at(-1)]);
    if (old === JSON.stringify(v)) continue;
    o[keys.at(-1)] = v; n++;
    console.log(`${f.id}: ${p} ${old ?? '(none)'} -> ${JSON.stringify(v)}`);
  }
  for (const p of f.unset || []) {
    const keys = p.split('.'); let o = d;
    for (const k of keys.slice(0, -1)) o = o?.[k];
    if (o && keys.at(-1) in o) { delete o[keys.at(-1)]; n++; console.log(`${f.id}: ${p} removed`); }
  }
}
if (!dry && n) {
  // same layout as midi_devices_report.mjs save(): header pretty-printed, one device per line, sorted
  db.devices.sort((a, b) => a.maker.localeCompare(b.maker) || a.model.localeCompare(b.model, 'en', { numeric: true }));
  db.updated = new Date().toISOString().slice(0, 10);
  const lines = db.devices.map((d) => '    ' + JSON.stringify(d));
  const head = { ...db }; delete head.devices;
  fs.writeFileSync(JSON_PATH, JSON.stringify(head, null, 2).replace(/\n}$/, ',\n  "devices": [\n' + lines.join(',\n') + '\n  ]\n}\n'));
}
console.log(`${n} change(s)${dry ? ' (dry run, not saved)' : n ? ' saved' : ''}`);
