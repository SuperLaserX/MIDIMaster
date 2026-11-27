// node eventide.mjs <product> ... : eventideaudio.com/downloads?product=X -> download pages -> final file URL (redirect target, not fetched)
setTimeout(() => { console.log('# HARD TIMEOUT'); process.exit(2); }, 600000).unref();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SKIP = /user-guide|manual|algorithm-list|self-test|installation|guide-for|quick-start|release-notes|driver|emote|h9-control|h90-control|vst|aax|plug/i;
for (const prod of process.argv.slice(2)) {
  const r = await fetch(`https://www.eventideaudio.com/downloads/?product=${encodeURIComponent(prod)}`, { headers: { 'User-Agent': UA } });
  const t = await r.text();
  const slugs = [...new Set([...t.matchAll(/class='download-title' target='_self' href='\/downloads\/([a-z0-9-]+)'[^>]*>(?:<svg[\s\S]*?<\/svg>)?/g)].map((m) => m[1]))].filter((s) => !/^page$/.test(s));
  console.log(`## ${prod}: ${r.status}, ${slugs.length} download pages`);
  for (const s of slugs) {
    if (SKIP.test(s)) { console.log(`   skip ${s}`); continue; }
    try {
      const h = await fetch(`https://www.eventideaudio.com/downloads/${s}/`, { headers: { 'User-Agent': UA }, redirect: 'manual' });
      console.log(`   ${s} -> ${h.status} ${h.headers.get('location') || ''}`);
    } catch (e) { console.log(`   ${s} ERR ${e.message}`); }
    await new Promise((res) => setTimeout(res, 800));
  }
}
