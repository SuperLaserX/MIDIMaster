// node roland.mjs list slug [slug...]   -> update entries per product (title | entry url | zip names in the page)
// node roland.mjs entry url            -> zip names mentioned in one entry page
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const base = process.env.ROLAND_BASE || 'https://www.roland.com/global/support/by_product/';
const site = process.env.ROLAND_SITE || 'https://www.roland.com';
const getText = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA } }); return { status: r.status, url: r.url, text: r.ok ? await r.text() : '' }; };
const KEEP = /system|update|program|firmware|ver\.?\s*\d|version|os\b/i;
const DROP = /driver|editor|librarian|owner|manual|plug-?in|app\b|apps\b|tone|sound ?library|pattern|backup|songs?\b|data|kit|wave|sample|axial|utility/i;
const dlUrls = (t) => [...new Set([...t.matchAll(/tmEventtrack\(&#39;[^&]*&#39;,&#39;[^&]*&#39;,&#39;(https:[^&]+)&#39;/g)].map((m) => m[1].replace(/\\\//g, '/')))];
const zipNames = (t) => [...new Set([...t.matchAll(/[\w.\-]+\.(zip|exe|dmg|bin|syx|mid|svd|upd|img)\b/gi)].map((m) => m[0]))].filter((n) => !/^(jquery|lib|roland_core|ga_events)/i.test(n));
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'list') {
  for (const slug of rest) {
    const { status, text } = await getText(base + slug + '/updates_drivers/');
    if (status !== 200) { console.log(`## ${slug}: HTTP ${status}`); continue; }
    const entries = [...text.matchAll(/<h5><a href="([^"]+updates_drivers\/[0-9a-f-]{36}\/)">([^<]+)<\/a><\/h5>/g)].map((m) => ({ href: m[1], title: m[2].replace(/\s+/g, ' ').trim() }));
    const keep = entries.filter((e) => KEEP.test(e.title) && !DROP.test(e.title));
    console.log(`## ${slug}: ${entries.length} entries, ${keep.length} kept`);
    for (const e of keep) {
      const p = await getText(site + e.href);
      console.log(`- ${e.title} | ${e.href.split('/').slice(-2, -1)[0].slice(0, 8)} | ${dlUrls(p.text).join(' ') || zipNames(p.text).join(' ')}`);
    }
  }
} else if (cmd === 'entry') {
  const p = await getText(rest[0]);
  console.log(p.status, dlUrls(p.text).join(' '), zipNames(p.text).join(' '));
}
