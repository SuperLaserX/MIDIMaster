// Write every SYSTEM-8 PLUG-OUT container found on this computer (Roland's plugins: <plugin>/Script/
// Code8_<slot>.Dat) into a Head Library folder as a "PlugOuts" sub-library: one entry per container
// (kind 'plugout', device roland-system8, the container in native.bytes) and a plain copy of each file
// in PlugOuts/files/ that the SYSTEM-8 Branch Library's "Import PLUG-OUT..." takes directly.
// Every file is checked with the editor's own reader (roland-system8-install.js); SYSTEM-1 builds
// (Code.Dat, Code1.Dat) and slot-0 builds are left out. Running it again replaces the sub-library.
//
//   node tools/system8/plugouts_to_library.mjs <library folder> [<plugins folder>...]
//   (default plugins folder: C:\Program Files\Common Files\VST3\Roland)
import fs from 'node:fs';
import path from 'node:path';
import { readContainer } from '../../js/devices/defs/roland-system8-install.js';
import { makePatch, makeSub, indexRow, toBase64, fileName } from '../../js/core/mainlib/format.js';

const [lib, ...roots] = process.argv.slice(2);
if (!lib) { console.error('usage: node tools/system8/plugouts_to_library.mjs <library folder> [<plugins folder>...]'); process.exit(1); }
const sources = roots.length ? roots : ['C:\\Program Files\\Common Files\\VST3\\Roland'];
const SUB = 'PlugOuts';
const device = { id: 'roland-system8', maker: 'Roland', model: 'SYSTEM-8', types: ['plugout'] };

function* containers(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* containers(p);
    else if (/^Code8_\d\.dat$/i.test(e.name)) yield p;
  }
}

const mainPath = path.join(lib, 'mainlibrary.json');
const main = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
const subDir = path.join(lib, SUB);
const old = main.sublibraries.find((s) => s.path === SUB);
const sub = makeSub(SUB, { device: { id: device.id, maker: device.maker, model: device.model }, notes: 'SYSTEM-8 PLUG-OUT containers from the Roland plugins on this computer, one per plug-out and slot. Install one from the SYSTEM-8 Branch Library (Import PLUG-OUT..., the files are in files/).' });
if (old) sub.id = old.id;
fs.rmSync(subDir, { recursive: true, force: true });
fs.mkdirSync(path.join(subDir, 'patches'), { recursive: true });
fs.mkdirSync(path.join(subDir, 'files'), { recursive: true });

const found = [];
for (const root of sources) for (const file of containers(root)) {
  const bytes = fs.readFileSync(file);
  let c;
  try { c = readContainer(bytes); } catch (err) { console.log(`skipped ${file}: ${err.message}`); continue; }
  if (c.slot === 0) { console.log(`skipped ${file}: built for slot 0 (the SYSTEM-8 engine itself)`); continue; }
  const name = `${c.name} ${c.versionText} for PLUG-OUT ${c.slot}`;
  const datName = `${fileName(`${c.name} ${c.versionText} slot ${c.slot}`)}.dat`;
  fs.writeFileSync(path.join(subDir, 'files', datName), bytes);
  const p = makePatch({
    name, kind: 'plugout', device,
    category: { id: 'plugout', label: 'PLUG-OUT', source: 'file' },
    tags: ['PLUG-OUT', c.name, `slot ${c.slot}`],
    source: { file: path.basename(file), plugin: path.basename(path.dirname(path.dirname(file))) },
    settings: { 'PLUG-OUT': { Name: c.name, 'Model id': String(c.model), Version: c.versionText, Slot: `PLUG-OUT ${c.slot}`, Records: String(c.count), File: `files/${datName}` } },
    native: { object: 'plugout-container', bytes: toBase64(bytes) },
    notes: `${c.name} ${c.versionText}, built for PLUG-OUT ${c.slot} (model id ${c.model}); from ${file}. Install it from the SYSTEM-8 Branch Library: Import PLUG-OUT..., then Install.`,
  });
  fs.writeFileSync(path.join(subDir, 'patches', `${p.id}.json`), JSON.stringify(p, null, 1));
  sub.patches.push(indexRow(p));
  found.push(name);
}
sub.patches.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(subDir, 'sublibrary.json'), JSON.stringify(sub, null, 1));
const row = { id: sub.id, name: SUB, path: SUB, device: { id: device.id, maker: device.maker, model: device.model } };
main.sublibraries = [...main.sublibraries.filter((s) => s.path !== SUB), row];
fs.writeFileSync(mainPath, JSON.stringify(main, null, 1));
console.log(`${found.length} PLUG-OUT containers written to ${subDir}`);
for (const n of found.sort()) console.log(`  ${n}`);
