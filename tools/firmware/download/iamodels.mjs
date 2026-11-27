// node iamodels.mjs [makers-regex] : archive.org title search for the models of missing devices (sections 2 and 3), matched back to devices
import fs from 'node:fs';
setTimeout(() => { console.log('# HARD TIMEOUT'); process.exit(2); }, 290000).unref();
const db = JSON.parse(fs.readFileSync(new URL('../midi_devices.json', import.meta.url), 'utf8'));
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SKIP = /Digital and stage pianos|Organs|Arranger and home/;
const mrx = new RegExp(process.argv[2] || '.', 'i');
const miss = db.devices.filter((d) => !d.inCollection && !SKIP.test(d.category) && !d.firmware.officialDownload && mrx.test(d.maker) && d.maker !== 'Novation');
const terms = [...new Set(miss.map((d) => d.model).filter((m) => m.length >= 4 && /[0-9]/.test(m)))];
const items = new Map();
for (let i = 0; i < terms.length; i += 30) {
  const q = `title:(${terms.slice(i, i + 30).map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')}) AND (mediatype:software OR mediatype:data OR title:(rom OR eprom OR firmware OR os OR update OR system))`;
  try {
    const r = await fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=item_size&rows=300&output=json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    for (const d of JSON.parse(await r.text()).response.docs) items.set(d.identifier, d);
  } catch (e) { console.log('# search error', e.message); }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(`# ${terms.length} models, ${items.size} items`);
const out = new Set();
for (const it of items.values()) {
  const hay = norm(String(it.title)) + ' ' + norm(it.identifier);
  if (/manual|service|brochure|catalog|magazine|review|schematic|owner|patch|sample|sound ?bank|demo/i.test(String(it.title))) continue;
  for (const d of miss) {
    const mk = norm(d.maker.split(' ')[0]);
    if (!hay.includes(mk) && !(d.maker === 'Boss' && hay.includes('roland'))) continue;
    const hit = [d.model, ...(d.variants || [])].map(norm).filter((n) => n.length >= 3).find((n) => new RegExp(n + '(?![0-9])').test(hay));
    if (hit) out.add(`${d.maker} | ${d.model} | ${it.identifier} | ${String(it.title).slice(0, 80)} | ${it.item_size}`);
  }
}
for (const l of [...out].sort()) console.log(l);
