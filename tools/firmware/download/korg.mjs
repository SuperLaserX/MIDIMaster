// node korg.mjs <products.tsv> "Name" ["Name" ...]  -> per product: update entries and their newest CDN files
import fs from 'node:fs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const get = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA } }); return r.ok ? r.text() : ''; };
const [tsv, ...names] = process.argv.slice(2);
const prods = fs.readFileSync(tsv, 'utf8').split('\n').map((l) => l.split('\t'));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const KEEP = /system|update|firmware|\bos\b|version up/i;
const DROP = /editor|librarian|driver|plug-?in|manual|sound|pcm|library|data|kontrol/i;
for (const n of names) {
  const hits = prods.filter(([, name]) => name && norm(name) === norm(n));
  if (!hits.length) { console.log(`## ${n}: no product`); continue; }
  for (const [id, name] of hits) {
    const page = await get(`https://www.korg.com/us/support/download/product/${id}/`);
    const entries = [...page.matchAll(/href="(\/us\/support\/download\/(software|manual|driver|other)\/[\d/]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((m) => ({ href: m[1], kind: m[2], title: m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
      .filter((e) => e.kind !== 'manual' && e.kind !== 'driver');
    console.log(`## ${name} (${id}): ${entries.length} software entries`);
    for (const e of entries) {
      if (!KEEP.test(e.title) || DROP.test(e.title)) { console.log(`  . ${e.title}`); continue; }
      const t = await get('https://www.korg.com' + e.href);
      const files = [...t.matchAll(/href="(https:\/\/cdn\.korg\.com\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      const fn = (u) => decodeURIComponent((/filename%2A%3DUTF-8%27%27([^&]+)/.exec(u) || /filename\*=UTF-8''([^&]+)/.exec(decodeURIComponent(u)) || [])[1] || u.split('?')[0].split('/').pop());
      console.log(`- ${e.title} | ${e.href} | ${files.slice(0, 3).map(fn).join(' ')}${files.length > 3 ? ` (+${files.length - 3})` : ''}`);
      if (files[0]) console.log(`  URL ${files[0]}`);
    }
  }
}
