// node links.mjs <url> [regex] [--ua x] : lists absolute links on a page matching the regex (default: firmware-like files)
setTimeout(() => { console.log("# HARD TIMEOUT"); process.exit(2); }, 45000).unref();
const a = process.argv.slice(2); const ui = a.indexOf('--ua'); const ua = ui >= 0 ? a.splice(ui, 2)[1] : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const [url, re = '\\.(zip|syx|bin|hex|img|uf2|dfu|mid|exe|dmg|pkg|rar|7z|upd|fw|wav|frm|tar|gz|bfw|sfw|ldr|x)(\\?|$)'] = a;
const ac = new AbortController(); setTimeout(() => ac.abort(), 40000);
try {
  const r = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'text/html,*/*' }, redirect: 'follow', signal: ac.signal });
  const t = await r.text();
  console.log(`# ${r.status} ${t.length} ${r.url}`);
  const rx = new RegExp(re, 'i'); const out = new Set();
  for (const m of t.matchAll(/(?:href|src|data-href|data-url)\s*=\s*["']([^"'#]+)["']/gi)) { try { const u = new URL(m[1].replace(/&amp;/g, '&'), r.url).href; if (rx.test(u)) out.add(u); } catch {} }
  for (const m of t.matchAll(/https?:\?\/\?\/[^"'\s<>()]+/g)) { const u = m[0].replace(/\\//g, '/'); if (rx.test(u)) out.add(u); }
  for (const u of out) console.log(u);
} catch (e) { console.log(`# ERR ${e.cause?.code || e.message} ${url}`); }
