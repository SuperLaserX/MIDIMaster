// [RSITE=https://www.boss.info] node roland_region.mjs <region> slug [slug...] : Roland regional support site (e.g. us, uk, ca): update entries with their static.roland.com files
setTimeout(() => { console.log('# HARD TIMEOUT'); process.exit(2); }, 1500000).unref();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const [region, ...slugs] = process.argv.slice(2);
const site = process.env.RSITE || 'https://www.roland.com';
const get = async (u) => { try { const r = await fetch(u, { headers: { 'User-Agent': UA } }); return { status: r.status, text: r.ok ? await r.text() : '' }; } catch (e) { return { status: 'ERR ' + e.message, text: '' }; } };
const DROP = /\bmac\b|macintosh|smf player|factory|wav convert|templates|pg-800|blank project|sampling cd|wave converter|usb port|driver|editor|librarian|owner|manual|plug-?in|\bapps?\b|sound ?library|backup|utility|patch|tone|rhythm|song|demo/i;
const files = (t) => [...new Set([...t.matchAll(/https:\\?\/\\?\/static\.roland\.com\\?\/[^&'"\s]+/g)].map((m) => m[0].replace(/\\\//g, '/')))]
  .filter((u) => /assets\/media\/.+\.(zip|exe|hqx|sit|bin|mid|syx|dmg|lzh|svd)$/i.test(u) && !/SMFPLAYR|5bImages/i.test(u));
for (const slug of slugs) {
  const { status, text } = await get(`${site}/${region}/support/by_product/${slug}/updates_drivers/`);
  if (status !== 200) { console.log(`## ${slug}: HTTP ${status}`); continue; }
  const entries = [...text.matchAll(/<h5><a href="([^"]+updates_drivers\/[0-9a-f-]{36}\/)">([^<]+)<\/a><\/h5>/g)].map((m) => ({ href: m[1], title: m[2].replace(/\s+/g, ' ').replace(/&amp;/g, '&').trim() }));
  const keep = entries.filter((e) => !DROP.test(e.title));
  console.log(`## ${slug}: ${entries.length} entries, ${keep.length} kept; dropped: ${entries.filter((e) => DROP.test(e.title)).map((e) => e.title).join(' / ').slice(0, 300)}`);
  for (const e of keep) {
    const p = await get(site + e.href);
    console.log(`- ${e.title} | ${files(p.text).join(' ') || '(no file link)'}`);
    await new Promise((r) => setTimeout(r, 700));
  }
}
