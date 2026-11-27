// node cdx.mjs <url-prefix e.g. mfberlin.de/> [file-regex] : archived files (HTTP 200) on the Wayback Machine, newest capture per URL
setTimeout(() => { console.log('# HARD TIMEOUT'); process.exit(2); }, 110000).unref();
const [prefix, re = '\.(zip|syx|bin|hex|mid|rar|7z|exe|img|sit|hqx|lzh|upd|dmg|tgz|gz)$'] = process.argv.slice(2);
const u = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(prefix)}*&output=json&fl=timestamp,original,mimetype,length,statuscode&filter=statuscode:200&limit=20000`;
const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
const txt = await r.text(); let rows; try { rows = JSON.parse(txt).slice(1); } catch { console.log('# CDX ERROR ' + r.status + ' ' + (txt.match(/<title>([^<]*)/)||[])[1]); process.exit(3); }
const rx = new RegExp(re, 'i'); const best = new Map();
for (const [ts, orig, mime, len] of rows) {
  const key = orig.replace(/^https?:\/\/(www\.)?/i, '').replace(/:80\//, '/').toLowerCase();
  if (!rx.test(key.split('?')[0])) continue;
  const b = best.get(key); if (!b || ts > b.ts) best.set(key, { ts, orig, mime, len });
}
for (const [, b] of [...best].sort()) console.log(`${b.ts} ${String(b.len).padStart(9)} ${b.mime.padEnd(26)} https://web.archive.org/web/${b.ts}id_/${b.orig}`);
console.log(`# ${best.size} files (${rows.length} captures)`);
