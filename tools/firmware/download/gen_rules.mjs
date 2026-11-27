// Regenerates the download blocks in tools/firmware_checklist.mjs (NEW_DEVICES and RULES) from dl_log.jsonl.
// node gen_rules.mjs   (also.json: { "<Maker dir>/<folder>": ["JSON model", ...] } for folders that serve several devices;
//                      { "factory": false, "devices": [...] } marks a retrofit-kit folder: see README)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = HERE; // the download log and notes live next to the scripts (tools/firmware/download)
const REPO = path.resolve(HERE, '../../..'); // the MIDIMaster folder
const SCRIPT = path.join(REPO, 'tools/firmware_checklist.mjs');
const log = fs.readFileSync(path.join(SCRATCH, 'dl_log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const also = fs.existsSync(path.join(HERE, 'also.json')) ? JSON.parse(fs.readFileSync(path.join(HERE, 'also.json'), 'utf8')) : {};
const db = JSON.parse(fs.readFileSync(path.join(REPO, 'tools/firmware/midi_devices.json'), 'utf8'));
const registry = await import(pathToFileURL(path.join(REPO, 'js/devices/registry.js')).href);
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const CAT = { Synthesizers: 'syn', Workstations: 'syn', Samplers: 'smp', Drum: 'drm', Digital: 'pno', Organs: 'pno', Arranger: 'arr', Effects: 'fx',
  Guitar: 'gtr', Vocal: 'voc', Sequencers: 'seq', Controllers: 'ctl', MIDI: 'if', Mixers: 'mix', Recorders: 'rec', Expansion: 'data', Music: 'cpu', Other: 'oth' };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const folders = new Map(); // dir -> { maker, models:Set, versions:Set }
for (const r of log) {
  const dir = r.file.split('/').slice(0, 2).join('/');
  const f = folders.get(dir) || { maker: r.maker, models: new Set(), versions: [] };
  // also.json entry: ["Model", ...] or { "factory": false, "devices": [...] } (retrofit-kit folder; midi_devices_report.mjs reads the flag)
  const a = also[dir];
  for (const m of (Array.isArray(a) ? a : a?.devices) || [r.model]) f.models.add(m);
  if (r.version && !f.versions.includes(r.version)) f.versions.push(r.version);
  folders.set(dir, f);
}
const newDevices = new Map(); const rules = []; const problems = [];
for (const [dir, f] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) {
  const ids = [];
  for (const model of f.models) {
    // also.json may name another maker's device as "Maker:Model" (retrofit-kit firmware folders serve the host device)
    const cut = model.indexOf(':'); // only when the part before ':' is a maker in the JSON (models such as "Model:Cycles" keep their colon)
    const [mk, md] = cut > 0 && db.makers[model.slice(0, cut)] ? [model.slice(0, cut), model.slice(cut + 1)] : [f.maker, model];
    const dev = db.devices.find((d) => d.maker === mk && norm(d.model) === norm(md));
    if (!dev) { problems.push(`${dir}: no JSON device "${mk} ${md}"`); continue; }
    const cat = registry.DEVICES.find((d) => norm(d.title) === norm(dev.maker + ' ' + dev.model));
    if (cat) { ids.push(cat.id); continue; }
    const id = registry.DEVICES.some((d) => d.id === dev.id) ? dev.id + '-os' : dev.id; // catalog id taken by another entry
    newDevices.set(id, { maker: dev.maker, model: dev.model, type: CAT[dev.category.split(' ')[0]] || 'oth', midi: dev.midi.retrofit ? 'N' : 'Y',
      upgrades: (dev.midiUpgrades || []).map((u) => ({ maker: u.maker, product: u.product, url: u.url })) });
    ids.push(id);
  }
  if (!ids.length) continue;
  const version = f.versions.map((v) => (/^[0-9]/.test(v) ? 'v' + v : v)).join(', ');
  const act = ids.length === 1 ? `id: ${q(ids[0])}` : `ids: [${ids.map((i) => `{ id: ${q(i)} }`).join(', ')}]`;
  rules.push(`  [/^${esc(dir)}$/, { ${act}${version ? `, version: ${q(version)}` : ''} }],`);
}
let s = fs.readFileSync(SCRIPT, 'utf8');
const nl = s.includes('\r\n') ? '\r\n' : '\n';
const put = (begin, end, body) => {
  const a = s.indexOf(begin), b = s.indexOf(end);
  if (a < 0 || b < 0) throw new Error('markers missing: ' + begin);
  s = s.slice(0, a + begin.length) + nl + body.join(nl) + (body.length ? nl : '') + s.slice(b);
};
put('  // --- downloads: devices (generated) ---', '  // --- end downloads: devices ---',
  [...newDevices].sort((a, b) => a[0].localeCompare(b[0])).map(([id, d]) => `  ${q(id)}: { maker: ${q(d.maker)}, model: ${q(d.model)}, type: ${q(d.type)}, midi: ${q(d.midi)}${d.upgrades.length ? `, midiUpgrades: ${JSON.stringify(d.upgrades)}` : ''} },`));
put('  // --- downloads: folders (generated) ---', '  // --- end downloads: folders ---', rules);
fs.writeFileSync(SCRIPT, s);
console.log(`${newDevices.size} new devices, ${rules.length} folder rules`);
for (const p of problems) console.log('! ' + p);
