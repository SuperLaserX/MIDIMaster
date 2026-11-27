// node probe.mjs <url> [...]  -> status and firmware-looking file links on each page (absolute URLs)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const EXT = /\.(zip|bin|syx|hex|mid|dfu|upd|img|uf2|sys|fw|frm|prg|ppf|7z|rar)(\?[^"'\s]*)?$/i;
const SKIP = /manual|preset|patch|sound|sample|bank|font|logo|\.(png|jpe?g|svg|gif|webp|css|js)\b/i;
for (const u of process.argv.slice(2)) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    const t = r.ok ? await r.text() : '';
    const links = [...new Set([...t.matchAll(/(?:href|data-href|data-url)=["']([^"']+)["']/gi)].map((m) => { try { return new URL(m[1].replace(/&amp;/g, '&'), r.url).href; } catch { return null; } }).filter(Boolean))];
    const fw = links.filter((l) => EXT.test(l) && !SKIP.test(l.split('/').pop()));
    console.log(`## ${u} -> ${r.status} ${r.url !== u ? r.url : ''} (${fw.length})`);
    for (const l of fw.slice(0, 12)) console.log('  ' + l);
  } catch (e) { console.log(`## ${u} -> ERR ${e.message}`); }
}
