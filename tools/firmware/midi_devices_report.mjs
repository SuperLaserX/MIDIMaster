// Rebuilds docs/MIDI_DEVICE_LIST.md and docs/FIRMWARE_WANTED.md from tools/firmware/midi_devices.json.
//
// Usage: node tools/firmware/midi_devices_report.mjs [--match] [--add list.txt ...]
//   (no options)  rebuild the two docs from the JSON
//   --match       also re-check every device's `inCollection` against docs/FIRMWARE_CHECKLIST.md
//                 (run it after `node tools/firmware_checklist.mjs` when firmware was added); files from
//                 retrofit-kit folders (also.json entries with "factory": false) do not count as a host device's
//                 own firmware: such a device gets `kitInCollection` and stays in the wanted list
//   --add FILE    merge a compact maker list (format below) into the JSON, then --match and rebuild
//
// Compact list format (one maker block per `@maker` line; `#` starts a comment line):
//   @maker Roland | sysex 41 | src https://... https://...
//   model | years | cat | midi | fw | versions | variants | where/what to look for | =Checklist name; =Other (=- for no match)
//   cat:  syn wks smp drm pno org arr fx gtr voc seq ctl int mix rec exp pc oth
//   midi: letters I(n) O(ut) T(hru) U(SB-MIDI) R(etrofit kit only), - none, ? unknown; empty = IOT
//         (name the kits in the device's `midiUpgrades` in the JSON: [{maker, product, url, firmware}])
//   fw:   E EPROM, M mask ROM, P MCU-internal ROM, F flash, D OS loaded from disk/card at boot,
//         X update by SysEx/MIDI file, B update by USB/computer updater, C update by ROM card,
//         S sound/wave ROMs, K retrofit-kit firmware, ! official download from the maker, ? unknown
//   Write a literal pipe in a name as "\|". A device already in the JSON (same maker + model) is replaced.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_PATH = path.join(ROOT, 'tools/firmware/midi_devices.json');
const CHECKLIST = path.join(ROOT, 'docs/FIRMWARE_CHECKLIST.md');
const LIST_MD = path.join(ROOT, 'docs/MIDI_DEVICE_LIST.md');
const WANTED_MD = path.join(ROOT, 'docs/FIRMWARE_WANTED.md');

export const CATS = {
  syn: 'Synthesizers and sound modules', wks: 'Workstations', smp: 'Samplers',
  drm: 'Drum machines and grooveboxes', pno: 'Digital and stage pianos', org: 'Organs',
  arr: 'Arranger and home keyboards', fx: 'Effects processors', gtr: 'Guitar and bass processors',
  voc: 'Vocal processors', seq: 'Sequencers', ctl: 'Controllers, master keyboards, wind and drum controllers',
  int: 'MIDI interfaces, patchbays and sync', mix: 'Mixers', rec: 'Recorders',
  exp: 'Expansion boards, cards and sound ROMs', pc: 'Music computers and sound cards', oth: 'Other',
};
const SHORT_CODE = {
  syn: 'synth', wks: 'workstation', smp: 'sampler', drm: 'drum machine', pno: 'piano', org: 'organ', arr: 'arranger',
  fx: 'effects', gtr: 'guitar/bass processor', voc: 'vocal processor', seq: 'sequencer', ctl: 'controller',
  int: 'MIDI interface', mix: 'mixer', rec: 'recorder', exp: 'expansion/sound ROM', pc: 'computer/sound card', oth: 'other',
};
const SHORT = Object.fromEntries(Object.entries(CATS).map(([k, v]) => [v, SHORT_CODE[k]]));
const FW = {
  E: 'EPROM', M: 'mask ROM', P: 'MCU internal ROM', F: 'flash', D: 'OS on disk/card',
  X: 'SysEx/MIDI-file update', B: 'USB/computer updater', C: 'ROM-card update', S: 'sound/wave ROMs',
  K: 'retrofit kit', '?': 'unknown',
};

const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const slug = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function load() {
  if (!fs.existsSync(JSON_PATH)) {
    return {
      about: 'MIDI-capable hardware (1983-) researched maker by maker, compared with the firmware collection (docs/FIRMWARE_CHECKLIST.md). '
        + 'Docs: node tools/firmware/midi_devices_report.mjs. Device fields: midi.din (in/out/thru), midi.usb, firmware.storage '
        + '(where the OS lives / how it is updated), firmware.officialDownload (maker publishes the update), versions (known OS versions), '
        + 'inCollection (false, or the matching checklist device and its files), match (checklist names to match; "-" = never), sources (per maker).',
      categories: Object.values(CATS), firmwareStorage: Object.values(FW), makers: {}, devices: [],
    };
  }
  return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
}
function save(db) {
  db.devices.sort((a, b) => a.maker.localeCompare(b.maker) || a.model.localeCompare(b.model, 'en', { numeric: true }));
  db.updated = new Date().toISOString().slice(0, 10);
  const lines = db.devices.map((d) => '    ' + JSON.stringify(d));
  const head = { ...db }; delete head.devices;
  let out = JSON.stringify(head, null, 2).replace(/\n}$/, ',\n  "devices": [\n' + lines.join(',\n') + '\n  ]\n}\n');
  fs.writeFileSync(JSON_PATH, out);
}

function midiOf(code) {
  const c = (code || 'IOT').toUpperCase();
  const din = [c.includes('I') && 'in', c.includes('O') && 'out', c.includes('T') && 'thru'].filter(Boolean);
  return { din: din.length ? din.join('/') : c.includes('?') ? 'unknown' : 'none', usb: c.includes('U'), ...(c.includes('R') ? { retrofit: true } : {}) };
}

function parseCompact(text, db) {
  let maker = null; const added = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.replace(/\\\|/g, '\u0001').split('|').map((s) => s.replace(/\u0001/g, '|').trim()); // "\|" keeps a literal pipe
    if (line.startsWith('@maker ')) {
      maker = f[0].slice(7).trim();
      const m = (db.makers[maker] ||= { sources: [] }); delete m.sysexId;
      for (const x of f.slice(1)) {
        if (x.startsWith('sysex ')) m.sysexId = x.slice(6);
        else if (x.startsWith('src ')) m.sources = [...new Set([...m.sources, ...x.slice(4).split(/\s+/)])];
        else if (x.startsWith('note ')) m.note = x.slice(5);
        else if (x.startsWith('status ')) m.status = x.slice(7);
      }
      continue;
    }
    if (!maker) throw new Error('device line before @maker: ' + line);
    const match = f.filter((x) => x.startsWith('=')).join(';').split(';').map((s) => s.replace(/^=/, '').trim()).filter(Boolean);
    const g = f.filter((x) => !x.startsWith('='));
    const [model, years = '', cat = 'syn', midi = '', fw = '?', versions = '', variants = '', where = ''] = g;
    if (!CATS[cat]) throw new Error(`bad category "${cat}" in: ${line}`);
    const codes = [...fw.replace('!', '')].filter((ch) => FW[ch]);
    const rec = {
      id: slug(maker + ' ' + model), maker, model,
      variants: variants ? variants.split(',').map((s) => s.trim()).filter(Boolean) : [],
      years, category: CATS[cat], midi: midiOf(midi),
      firmware: { storage: codes.map((ch) => FW[ch]), officialDownload: fw.includes('!'), ...(where ? { where } : {}) },
      versions, ...(match.length ? { match } : {}), inCollection: false, sources: db.makers[maker].sources,
    };
    const i = db.devices.findIndex((d) => d.id === rec.id);
    if (i >= 0 && db.devices[i].midiUpgrades) rec.midiUpgrades = db.devices[i].midiUpgrades; // kept: the compact format has no field for them
    if (i >= 0) db.devices[i] = rec; else db.devices.push(rec);
    added.push(rec.id);
  }
  return added;
}

// --- collection matching against docs/FIRMWARE_CHECKLIST.md ---
function readChecklist() {
  const text = fs.readFileSync(CHECKLIST, 'utf8');
  const devs = []; let cur = null; let group = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) { group = line.slice(3); cur = null; continue; }
    const m = line.match(/^- \[.\] \*\*(.+?)\*\*/);
    if (m) { cur = { name: m[1], group, files: [] }; devs.push(cur); continue; }
    const f = line.match(/^ {2}- `([^`]+)`(?: — (.*))?/);
    if (f && cur) cur.files.push(f[2] ? { file: f[1], info: f[2].slice(0, 160) } : { file: f[1] });
  }
  const index = new Map();
  const add = (k, d) => { const n = norm(k); if (n) { if (!index.has(n)) index.set(n, new Set()); index.get(n).add(d); } };
  for (const d of devs) {
    add(d.name, d);
    const base = d.name.replace(/\s*\(.*\)\s*$/, '');
    add(base, d);
    const paren = d.name.match(/\(([^)]*)\)\s*$/);
    if (paren) for (const p of paren[1].split(',')) add(base + ' ' + p, d);
    const parts = base.split('/');
    if (parts.length > 1) {
      const prefix = parts[0].trim().replace(/\s*\S+$/, '');
      for (const p of parts.slice(1)) add(prefix + ' ' + p.trim(), d);
      add(parts[0], d);
    }
  }
  return { devs, index };
}

/**
 * Retrofit-kit folders: entries of tools/firmware/download/also.json written as { "factory": false, "devices": [...] }.
 * Their files are the kit maker's firmware: they count for the kit maker's own devices (folder's first segment, e.g.
 * Tubbutec), but for the host devices (Roland TR-808, ...) they are kit firmware, not the factory firmware, so a host
 * with nothing else stays missing (in FIRMWARE_WANTED) and gets `kitInCollection` instead of `inCollection`.
 */
function kitFolders() {
  const p = path.join(ROOT, 'tools/firmware/download/also.json');
  if (!fs.existsSync(p)) return [];
  return Object.entries(JSON.parse(fs.readFileSync(p, 'utf8')))
    .filter(([, v]) => v && !Array.isArray(v) && v.factory === false)
    .map(([dir]) => ({ dir: dir.replace(/\\/g, '/').replace(/\/$/, ''), maker: dir.split('/')[0] }));
}

function match(db) {
  const { devs, index } = readChecklist();
  const byName = new Map(devs.map((d) => [d.name, d]));
  const kits = kitFolders();
  // a device whose only firmware is the kit's (no CPU of its own, e.g. the Korg Mono/Poly) counts the kit firmware as its own
  const isKit = (r, file) => !r.firmware.storage.every((s) => s === 'retrofit kit')
    && kits.some((k) => norm(k.maker) !== norm(r.maker) && (file === k.dir || file.startsWith(k.dir + '/')));
  const used = new Set();
  for (const r of db.devices) {
    const hits = new Set();
    for (const n of (r.match || []).filter((x) => x !== '-')) { const d = byName.get(n); if (d) hits.add(d); else console.warn(`! ${r.id}: no checklist device "${n}"`); }
    if (!(r.match || []).length) {
      for (const k of [r.model, ...r.variants]) for (const d of index.get(norm(r.maker + ' ' + k)) || []) hits.add(d);
    }
    const found = [...hits].map((d) => { used.add(d.name); return { checklistDevice: d.name, files: d.files.map((f) => (isKit(r, f.file) ? { ...f, kit: true } : f)) }; });
    const factory = found.some((c) => c.files.some((f) => !f.kit));
    r.inCollection = factory ? found : false;
    if (found.length && !factory) r.kitInCollection = found; else delete r.kitInCollection;
    // updates: the newest file fetched as "current" for this device (dl_log.jsonl records with current: true)
    const cur = currentFor(r);
    if (cur.length) {
      r.current = cur;
      for (const c of r.inCollection || []) for (const f of c.files) {
        const hit = cur.find((x) => x.file === f.file || x.file.startsWith(f.file.replace(/\/?$/, '/')));
        if (hit) f.current = hit.version;
      }
    } else delete r.current;
  }
  db.checklistNotListed = devs.filter((d) => !used.has(d.name)).map((d) => d.name);
}

/** dl_log.jsonl records marked current (an update fetched for a device already in the collection), newest per product line. */
let currentLog = null;
function currentFor(r) {
  if (!currentLog) {
    const p = path.join(ROOT, 'tools/firmware/download/dl_log.jsonl');
    const log = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
    const last = new Map();
    for (const x of log) if (x.current) last.set([x.maker, x.model, x.folder || '', x.currentKey || ''].join('\u0000'), x);
    currentLog = [...last.values()];
  }
  const names = new Set([r.model, ...(r.variants || [])].map(norm));
  return currentLog.filter((x) => norm(x.maker) === norm(r.maker) && names.has(norm(x.model)))
    .map((x) => ({ version: x.version, file: x.file, ...(x.currentKey ? { line: x.currentKey } : {}), date: x.date, ...(x.supersedes ? { supersedes: x.supersedes } : {}) }));
}

// --- docs ---
const md = (s) => String(s).replace(/\|/g, '\\|');
function haveText(r) {
  if (!r.inCollection) return '';
  const infos = r.inCollection.flatMap((c) => c.files.map((f) => (f.info || '').split(';')[0].trim()).filter(Boolean));
  const uniq = [...new Set(infos)].slice(0, 4);
  const cur = (r.current || []).map((c) => (c.line ? c.line + ' ' : '') + c.version);
  return (cur.length ? 'current: ' + cur.join(', ') + '; ' : '') + 'have: ' + (uniq.length ? uniq.join(', ') : r.inCollection.reduce((n, c) => n + c.files.length, 0) + ' file(s)');
}
function midiText(m) { return [m.din !== 'none' ? 'DIN ' + m.din : '', m.usb ? 'USB' : '', m.retrofit ? 'retrofit' : ''].filter(Boolean).join(', ') || 'none'; }
/** Third-party MIDI upgrades (retrofit kits), e.g. "MIDI: Tubbutec Juno-66 (retrofit), Kenton Juno-6 MIDI retrofit kit (retrofit)". */
function upgradeText(d) {
  const u = d.midiUpgrades || [];
  return u.length ? 'MIDI: ' + u.map((x) => `${x.maker} ${x.product} (retrofit${x.firmware && !/^not |^configured|^inside/.test(x.firmware) ? ', firmware in the collection' : ''})`).join(', ') : '';
}

function wantText(r) {
  const fw = r.firmware; const v = r.versions ? ` (${r.versions})` : '';
  const s = fw.storage; const snd = s.includes('sound/wave ROMs') ? ', plus sound ROMs' : '';
  let t;
  // the factory firmware comes first; "retrofit kit" only when the device has no firmware of its own
  if (fw.officialDownload) t = `official OS/firmware update${v}`;
  else if (s.length && s.every((x) => x === 'retrofit kit')) t = `retrofit-kit firmware${v}`;
  else if (s.includes('OS on disk/card')) t = `OS disk/card image${v}`;
  else if (s.includes('SysEx/MIDI-file update')) t = `SysEx/MIDI-file OS update${v}`;
  else if (s.includes('USB/computer updater')) t = `updater file${v}`;
  else if (s.includes('ROM-card update')) t = `OS ROM-card image${v}`;
  else if (s.includes('flash')) t = `flash dump or update file${v}${snd}`;
  else if (s.includes('EPROM')) t = `EPROM dump${v}${snd}`;
  else if (s.includes('mask ROM')) t = `mask ROM dump${v}${snd}`;
  else if (s.includes('MCU internal ROM')) t = `MCU ROM read-out${v} (often read-protected)`;
  else if (s.includes('sound/wave ROMs')) t = `sound/wave ROM dumps${v}`;
  else if (s.includes('retrofit kit')) t = `retrofit-kit firmware${v}`;
  else t = `firmware dump${v}`;
  return fw.where ? `${t}; ${fw.where}` : t;
}

function build(db) {
  const devs = db.devices; const makers = [...new Set(devs.map((d) => d.maker))];
  const have = devs.filter((d) => d.inCollection); const miss = devs.filter((d) => !d.inCollection);
  const today = new Date().toISOString().slice(0, 10);
  const L = [];
  L.push('# MIDI device list', '',
    'Every MIDI-capable hardware device researched so far (1983 to now), and whether its firmware is in the',
    'collection (`z:\\firmwares`, as listed in `docs/FIRMWARE_CHECKLIST.md`).', '',
    `Generated ${today} by \`node tools/firmware/midi_devices_report.mjs\` from \`tools/firmware/midi_devices.json\`. Do not edit by hand;`,
    'edit the JSON (or merge a compact list with `--add`) and run the script again. Missing firmware: `docs/FIRMWARE_WANTED.md`.', '',
    '## Summary', '',
    `- **${devs.length} devices** from **${makers.length} makers**: **${have.length}** with firmware in the collection, **${miss.length}** missing.`,
    `- **${devs.filter((d) => d.firmware.officialDownload).length}** devices have official OS/firmware downloads from their maker (${miss.filter((d) => d.firmware.officialDownload).length} of them missing).`,
    `- **${devs.filter((d) => d.kitInCollection).length}** devices have only retrofit-kit firmware in the collection (folders marked \`"factory": false\` in \`tools/firmware/download/also.json\`); they count as missing until their factory firmware is found.`,
    `- **${devs.filter((d) => (d.midiUpgrades || []).length).length}** devices get MIDI (or earlier versions get it) from third-party upgrades (retrofit kits, named on each line as "MIDI: ... (retrofit)"); devices with no MIDI and no known kit are left out (\`removedNoMidi\` in the JSON: ${(db.removedNoMidi || []).length}).`,
    `- Collection devices not matched to any device here: ${(db.checklistNotListed || []).length}${(db.checklistNotListed || []).length ? ' (listed at the end)' : ''}.`, '');
  const pending = Object.entries(db.makers).filter(([, m]) => m.status && m.status !== 'done').map(([k, m]) => `${k} (${m.status})`);
  if (pending.length) L.push(`- Makers only partly researched: ${pending.join(', ')}.`, '');
  L.push('| Category | Devices | In collection | Missing |', '|---|---:|---:|---:|');
  for (const c of Object.values(CATS)) {
    const ds = devs.filter((d) => d.category === c); if (!ds.length) continue;
    const h = ds.filter((d) => d.inCollection).length;
    L.push(`| [${c}](#${slug(c)}) | ${ds.length} | ${h} | ${ds.length - h} |`);
  }
  L.push(`| **Total** | **${devs.length}** | **${have.length}** | **${miss.length}** |`, '',
    'Legend: `[x]` firmware in the collection, `[ ]` missing. Each line: model (variants), years, MIDI, where the firmware lives, known versions; for `[x]` what the collection has.', '');
  for (const c of Object.values(CATS)) {
    const ds = devs.filter((d) => d.category === c); if (!ds.length) continue;
    L.push(`## ${c}`, '');
    for (const mk of [...new Set(ds.map((d) => d.maker))]) {
      const mds = ds.filter((d) => d.maker === mk);
      L.push(`### ${mk} (${SHORT[c]}, ${mds.filter((d) => d.inCollection).length}/${mds.length})`, '');
      for (const d of mds) {
        const bits = [d.years, midiText(d.midi), upgradeText(d), d.firmware.storage.join(' + ') + (d.firmware.officialDownload ? ' (official download)' : ''), d.versions, haveText(d)].filter(Boolean);
        L.push(`- [${d.inCollection ? 'x' : ' '}] **${md(d.model)}**${d.variants.length ? ' (' + md(d.variants.join(', ')) + ')' : ''} — ${md(bits.join('; '))}`);
      }
      L.push('');
    }
  }
  L.push('## Sources by maker', '');
  for (const mk of Object.keys(db.makers).sort()) {
    const m = db.makers[mk];
    L.push(`- **${mk}**${m.sysexId ? ` (SysEx ID ${m.sysexId})` : ''}: ${(m.sources || []).join(' ')}${m.note ? ' — ' + m.note : ''}`);
  }
  L.push('');
  if ((db.checklistNotListed || []).length) {
    L.push('## Collection devices not matched here', '', 'In `docs/FIRMWARE_CHECKLIST.md` but not matched to a device above (add the device, or a `match` name):', '');
    for (const n of db.checklistNotListed) L.push(`- ${md(n)}`);
    L.push('');
  }
  fs.writeFileSync(LIST_MD, L.join('\n'));

  const W = [];
  const official = miss.filter((d) => d.firmware.officialDownload);
  const rest = miss.filter((d) => !d.firmware.officialDownload);
  const soft = rest.filter((d) => !/EPROM|mask ROM|MCU internal ROM/.test(d.firmware.storage.join()) || /flash|disk|SysEx|USB|ROM-card/.test(d.firmware.storage.join()));
  const chips = rest.filter((d) => !soft.includes(d));
  W.push('# Firmware wanted', '',
    `Devices from \`docs/MIDI_DEVICE_LIST.md\` whose firmware is not in the collection yet: **${miss.length}** of ${devs.length}.`,
    `Generated ${today} by \`node tools/firmware/midi_devices_report.mjs\` from \`tools/firmware/midi_devices.json\`. Do not edit by hand.`, '',
    `1. [Official downloads](#1-official-downloads-easy-wins) (${official.length}): the maker publishes the OS/firmware update; fetch it from the support page.`,
    `2. [Updatable OS, no official download known](#2-updatable-os-no-official-download-known) (${soft.length}): flash, disk, SysEx or card OS; look for update disks, SysEx files, card images, user archives.`,
    `3. [EPROM and mask-ROM dumps](#3-eprom-and-mask-rom-dumps) (${chips.length}): the firmware is in chips on the board; needs a dump (look for the version and chip named).`, '');
  const sect = (title, list) => {
    W.push(`## ${title}`, '');
    for (const mk of [...new Set(list.map((d) => d.maker))]) {
      const m = db.makers[mk] || {}; const sup = (m.sources || []).filter((u) => /support|download|update|github/i.test(u));
      W.push(`### ${mk}`, '', ...(sup.length ? [`Support/downloads: ${sup.join(' ')}`, ''] : []));
      for (const d of list.filter((x) => x.maker === mk)) {
        W.push(`- [ ] **${md(d.model)}**${d.variants.length ? ' (' + md(d.variants.join(', ')) + ')' : ''} — ${md([d.years, SHORT[d.category], wantText(d), upgradeText(d)].filter(Boolean).join('; '))}`);
      }
      W.push('');
    }
  };
  sect('1. Official downloads (easy wins)', official);
  sect('2. Updatable OS, no official download known', soft);
  sect('3. EPROM and mask-ROM dumps', chips);
  fs.writeFileSync(WANTED_MD, W.join('\n'));
  console.log(`${devs.length} devices, ${makers.length} makers, ${have.length} in collection, ${miss.length} missing; checklist devices not matched: ${(db.checklistNotListed || []).length}`);
}

const args = process.argv.slice(2);
const db = load();
let doMatch = args.includes('--match');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--add') { const added = parseCompact(fs.readFileSync(args[++i], 'utf8'), db); console.log(`merged ${added.length} devices from ${args[i]}`); doMatch = true; }
}
if (doMatch) match(db);
save(db);
build(db);
