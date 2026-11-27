// Music Tribe brand sites (behringer.com, tcelectronic.com, tchelicon.com, klarkteknik.com, midasconsoles.com):
// product pages are server-rendered Next.js pages (/en/products/<SKU>) whose flight data carries the download list.
//   node musictribe.mjs page <product-url>                 resource rows of one product page (JSON)
//   node musictribe.mjs crawl <host> <out.jsonl> [regex]   every /en/products/ page in https://<host>/sitemap.xml (or only
//                                                          URLs matching regex), one request at a time, 1.2 s apart;
//                                                          resumable (pages already in out.jsonl are skipped)
//   node musictribe.mjs list <out.jsonl> [name-regex]      firmware/software/driver rows: product | type | name version | file URLs
// Files are on cdn-media.empowertribe.com/<hash>/<name> (plain public links; fetch them with fw.mjs get / the queue).
import fs from 'node:fs';

const UA = 'Mozilla/5.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resource rows (manuals, firmware, software, drivers) of a product page's HTML. */
export function parsePage(html) {
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try { flight += JSON.parse('"' + m[1] + '"'); } catch {}
  }
  const grab = (s, at) => { // the JSON object around position at
    let depth = 0, i = at;
    for (; i >= 0; i--) { const c = s[i]; if (c === '}') depth++; else if (c === '{') { if (depth === 0) break; depth--; } }
    let j = i, d = 0, inStr = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') d++; else if (c === '}') { d--; if (d === 0) break; }
    }
    return s.slice(i, j + 1);
  };
  const rows = []; const seen = new Set();
  for (const m of flight.matchAll(/"resourceType":"/g)) {
    const txt = grab(flight, m.index);
    if (seen.has(txt)) continue; seen.add(txt);
    try { rows.push(JSON.parse(txt)); } catch {}
  }
  const nm = html.match(/"@type":"Product","name":"([^"]+)","sku":"([^"]+)"/) || flight.match(/"@type":"Product","name":"([^"]+)","sku":"([^"]+)"/) || [];
  return { name: nm[1], sku: nm[2], rows };
}

async function fetchPage(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(45000) });
      const html = await r.text();
      if (r.status === 200) return { url, status: 200, ...parsePage(html) };
      if (r.status === 404) return { url, status: 404 };
    } catch (e) { if (attempt === 2) return { url, error: String(e.message || e) }; }
    await sleep(10000 * (attempt + 1));
  }
  return { url, error: 'failed' };
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'page') {
  console.log(JSON.stringify(await fetchPage(args[0]), null, 1));
} else if (cmd === 'crawl') {
  const [host, out, re] = args;
  const sm = await (await fetch(`https://${host}/sitemap.xml`, { headers: { 'User-Agent': UA } })).text();
  let urls = [...new Set([...sm.matchAll(/<loc>([^<]+\/en\/products\/[^<]+)<\/loc>/g)].map((m) => m[1]))];
  if (re) urls = urls.filter((u) => new RegExp(re, 'i').test(u));
  const done = new Set();
  if (fs.existsSync(out)) for (const l of fs.readFileSync(out, 'utf8').split('\n')) { try { done.add(JSON.parse(l).url); } catch {} }
  console.log(`${urls.length} product pages, ${done.size} already done`);
  let n = 0;
  for (const u of urls) {
    if (done.has(u)) continue;
    fs.appendFileSync(out, JSON.stringify(await fetchPage(u)) + '\n');
    if (++n % 50 === 0) console.log(new Date().toISOString(), n);
    await sleep(1200);
  }
  console.log('done', n);
} else if (cmd === 'list') {
  const [file, re] = args;
  const rx = re ? new RegExp(re, 'i') : null;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const p = JSON.parse(l);
    if (p.status !== 200 || (rx && !rx.test(p.name || ''))) continue;
    const seen = new Set();
    for (const r of p.rows || []) {
      if (!/firmware|software|driver/i.test(r.resourceType)) continue;
      const files = Array.isArray(r.files) ? r.files.map((f) => f.url) : [];
      const k = r.name + r.version + files.join();
      if (!files.length || seen.has(k)) continue; seen.add(k);
      console.log(`${p.name} | ${p.sku} | ${r.resourceType} | ${r.name}${r.version ? ' ' + r.version : ''} | ${files.join(' ')}`);
    }
  }
} else {
  console.log('usage: node musictribe.mjs page <url> | crawl <host> <out.jsonl> [regex] | list <out.jsonl> [name-regex]');
}
