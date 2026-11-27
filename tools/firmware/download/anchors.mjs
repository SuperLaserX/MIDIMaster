// node anchors.mjs <url> <href-regex> [ctxChars] [--ua x]: anchors whose href matches, with their text and the text before them
setTimeout(() => { console.log("# HARD TIMEOUT"); process.exit(2); }, 45000).unref();
const a = process.argv.slice(2); const ui = a.indexOf('--ua'); const ua = ui >= 0 ? a.splice(ui, 2)[1] : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const [url, re, n = '140'] = a;
const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 40000);
try {
  const r = await fetch(url, { headers: { 'User-Agent': ua }, redirect: 'follow', signal: ac.signal }); const t = await r.text(); clearTimeout(to);
  console.log(`# ${r.status} ${t.length} ${r.url}`);
  const rx = new RegExp(re, 'i');
  for (const m of t.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    const href = m[1].replace(/&amp;/g, '&'); if (!rx.test(href)) continue;
    let abs = href; try { abs = new URL(href, r.url).href; } catch {}
    const txt = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const ctx = t.slice(Math.max(0, m.index - 1500), m.index).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;/g, ' ').replace(/\s+/g, ' ').slice(-Number(n));
    console.log(`${abs}\n   [${txt.slice(0, 80)}] ${ctx}`);
  }
} catch (e) { console.log(`# ERR ${e.cause?.code || e.message} ${url}`); }
