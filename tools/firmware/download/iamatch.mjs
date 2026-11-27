// node iamatch.mjs <identifier> : files of an archive.org item whose path names a device still missing in midi_devices.json
import fs from 'node:fs';
setTimeout(() => { console.log('# HARD TIMEOUT'); process.exit(2); }, 200000).unref();
const db = JSON.parse(fs.readFileSync(new URL('../midi_devices.json', import.meta.url), 'utf8'));
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SKIP = /Digital and stage pianos|Organs|Arranger and home/;
const miss = db.devices.filter((d) => !d.inCollection && !SKIP.test(d.category));
const id = process.argv[2];
const r = await fetch(`https://archive.org/metadata/${id}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
const j = JSON.parse(await r.text());
const files = (j.files || []).filter((f) => f.source === 'original' && !/_meta\.|_files\.xml|\.torrent$/.test(f.name));
console.log(`# ${id}: ${files.length} original files; ${j.metadata?.title}`);
if (process.argv[3] === '--all') for (const f of files.slice(0, 60)) console.log(`  ${f.size} ${f.name}`);
const seen = new Set();
for (const f of files) {
  const hay = norm(f.name);
  for (const d of miss) {
    const mk = norm(d.maker.split(' ')[0]);
    if (!hay.includes(mk) && !(d.maker === 'Boss' && hay.includes('roland'))) continue;
    const names = [d.model, ...(d.variants || [])].map(norm).filter((n) => n.length >= 3);
    const hit = names.find((n) => new RegExp(n.replace(/[^a-z0-9]/g, '') + '(?![0-9])').test(hay));
    if (hit && !seen.has(f.name + d.id)) { seen.add(f.name + d.id); console.log(`${d.maker} | ${d.model} | ${f.size} | https://archive.org/download/${id}/${f.name.split('/').map(encodeURIComponent).join('/')}`); }
  }
}
