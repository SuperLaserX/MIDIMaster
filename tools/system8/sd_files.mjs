// SYSTEM-8 SD-card test files from a backup (tools/system8/backup.py), written the way the editor's "Save to SD
// card..." writes them (js/devices/defs/roland-system8-sd.js), into a card (or folder) laid out like the unit's:
//   ROLAND/SYSTEM-8/EXPORT/PATCH/MMSDTEST.s8p   SYSTEM-8 H-8 renamed "MM SD TEST"
//   ROLAND/SYSTEM-8/EXPORT/PATCH/MMSDJUNO.s8p   PLUG-OUT 3 H-8 renamed "MM SD JUNO" (the engine of slot 3)
//   ROLAND/SYSTEM-8/EXPORT/PATCH/MMSDBANK.s8p   the 64 SYSTEM-8 patches as they are
//   ROLAND/SYSTEM-8/EXPORT/PERFORM/MMSDPERF.s8f performance H-8 renamed "MM SD PERF", with its two patches
//   ROLAND/SYSTEM-8/BACKUP/MMRESTST.bin         (--restore) every patch and performance, SYSTEM-8 H-8 renamed
//                                               "MM RESTORE TEST" (RESTORE only with the user's OK)
//   ROLAND/SYSTEM-8/BACKUP/MMBACKUP.bin         (--restore) every patch and performance exactly as backed up
// Each file is checked with the OS's own checks (osCheck) and read back before it is written.
//
//   node tools/system8/sd_files.mjs <backup dir with perf.syx, slot0-2.syx> <slot3 dir> <card root> [--restore]
//   e.g. node tools/system8/sd_files.mjs re/system8/backup/20261127-flag0-after re/system8/backup/20261127-phase4-final E:\ --restore
import fs from 'node:fs';
import path from 'node:path';
import * as SD from '../../js/devices/defs/roland-system8-sd.js';
import { bankOf, _test as IT } from '../../js/devices/defs/roland-system8-install.js';
import { _test as T, setName, nameOf, setPerfName, perfNameOf } from '../../js/devices/defs/roland-system8.js';

const args = process.argv.slice(2);
const restore = args.includes('--restore');
const [dir, dir3, card] = args.filter((a) => !a.startsWith('--'));
if (!dir || !dir3 || !card) { console.error('usage: node tools/system8/sd_files.mjs <backup dir> <slot3 dir> <card root> [--restore]'); process.exit(1); }

const read = (d, f) => IT.splitter(fs.readFileSync(path.join(d, f)));
const banks = [0, 1, 2].map((s) => bankOf(read(dir, `slot${s}.syx`)));
banks.push(bankOf(read(dir3, 'slot3.syx')));
banks.forEach((b, s) => { if (!b || b.slot !== s) throw new Error(`slot ${s}: the backup does not hold its 64 complete patches`); });
const perfs = SD.perfsOf(read(dir, 'perf.syx'), T.initPerf());
if (!perfs) throw new Error('perf.syx does not hold the 64 complete performances');
const sounds = banks.flatMap((b) => b.patches);
const SLOT3 = { model: 7, version: 0x107, name: 'JUNO-106' }; // the unit's PLUG-OUT 3 (slot record, 2026-11-27)

const renamed = (d, name) => { const x = Uint8Array.from(d); setName(x, name); return x; };
const files = [];
const add = (kind, name, bytes, what) => {
  const problems = SD.osCheck(bytes, kind);
  if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
  files.push({ kind, name, bytes, what });
};

add('patch', 'MMSDTEST.s8p', SD.patchFile([{ data: renamed(sounds[63], 'MM SD TEST'), engine: SD.MODEL_SYSTEM8 }]), 'SYSTEM-8 H-8 renamed "MM SD TEST"');
add('patch', 'MMSDJUNO.s8p', SD.patchFile([{ data: renamed(sounds[3 * 64 + 63], 'MM SD JUNO'), engine: SLOT3 }]), 'PLUG-OUT 3 (JUNO-106) H-8 renamed "MM SD JUNO"');
add('patch', 'MMSDBANK.s8p', SD.patchFile(sounds.slice(0, 64).map((data) => ({ data, engine: SD.MODEL_SYSTEM8 }))), 'the 64 SYSTEM-8 patches as they are');
const perf = Uint8Array.from(perfs[63]);
setPerfName(perf, 'MM SD PERF');
const [u, l] = SD.partsOf(perf);
add('perform', 'MMSDPERF.s8f', SD.perfFile([{ perf, upper: sounds[u.slot * 64 + u.patch], lower: sounds[l.slot * 64 + l.patch] }]), `performance H-8 renamed "MM SD PERF" (was "${perfNameOf(perfs[63])}"), parts ${['SYSTEM-8', 'PLUG-OUT 1', 'PLUG-OUT 2', 'PLUG-OUT 3'][u.slot]} ${u.patch + 1} / ${['SYSTEM-8', 'PLUG-OUT 1', 'PLUG-OUT 2', 'PLUG-OUT 3'][l.slot]} ${l.patch + 1}`);
if (restore) {
  const test = sounds.map((d, i) => (i === 63 ? renamed(d, 'MM RESTORE TEST') : d));
  add('backup', 'MMRESTST.bin', SD.backupFile({ sounds: test, perfs }), 'every patch and performance, SYSTEM-8 H-8 renamed "MM RESTORE TEST"');
  add('backup', 'MMBACKUP.bin', SD.backupFile({ sounds, perfs }), 'every patch and performance exactly as backed up');
}
// read back: the names as the unit's lists will show them
for (const f of files) {
  if (f.kind === 'patch') { const r = SD.readPatchFile(f.bytes); f.check = `${r.length} patch(es), first "${r[0].name}" for ${r[0].engine.name} (model ${r[0].engine.model})`; }
  if (f.kind === 'perform') { const r = SD.readPerfFile(f.bytes)[0]; f.check = `"${r.name}", parts "${nameOf(r.upper)}" / "${nameOf(r.lower)}"`; }
  if (f.kind === 'backup') { const r = SD.readBackupFile(f.bytes); f.check = `${r.tags.join(',')}; SYSTEM-8 H-8 "${nameOf(r.sounds[63])}"`; }
}
for (const f of files) {
  const out = path.join(card, ...SD.FOLDER[f.kind], f.name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, f.bytes);
  console.log(`${path.join(...SD.FOLDER[f.kind], f.name)}  ${f.bytes.length} bytes  ${f.what}; reads back: ${f.check}`);
}
