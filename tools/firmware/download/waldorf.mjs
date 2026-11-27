// node waldorf.mjs <page url> [...]  -> file name and size behind each downloads.waldorfmusic.com share linked from the page
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
for (const page of process.argv.slice(2)) {
  const r = await fetch(page, { headers: { 'User-Agent': UA } });
  const t = await r.text();
  const shares = [...new Set([...t.matchAll(/https:\/\/downloads\.waldorfmusic\.com\/cloud\/index\.php\/s\/[A-Za-z0-9]+/g)].map((m) => m[0]))];
  console.log(`## ${r.url}: ${shares.length} shares`);
  for (const s of shares) {
    const h = await fetch(s + '/download', { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow' });
    const cd = h.headers.get('content-disposition') || '';
    const name = decodeURIComponent((/filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="([^"]+)"/i.exec(cd) || [])[1] || '?');
    if (/\.pdf$/i.test(name)) continue;
    console.log(`- ${s}/download | ${name} | ${h.headers.get('content-length')}`);
  }
}
