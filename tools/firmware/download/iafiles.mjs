// node iafiles.mjs <identifier> ... : original files of archive.org items (name, size, uploader, date) with download URLs
setTimeout(() => { console.log('# HARD TIMEOUT'); process.exit(2); }, 200000).unref();
for (const id of process.argv.slice(2)) {
  try {
    const r = await fetch(`https://archive.org/metadata/${id}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = JSON.parse(await r.text());
    const m = j.metadata || {};
    console.log(`== ${id} | ${m.title} | uploader ${m.uploader ? 'yes' : '?'} | ${m.publicdate || m.date || ''} | collections ${[].concat(m.collection || []).join(',')}`);
    for (const f of j.files || []) {
      if (f.source !== 'original' || /^(Metadata|Item Tile|Archive BitTorrent|JPEG Thumb|Thumbnail)$/.test(f.format || '') || /_meta\.(xml|sqlite)$|_files\.xml$|\.torrent$/.test(f.name)) continue;
      console.log(`   ${String(f.size).padStart(10)} ${f.format || ''} | https://archive.org/download/${id}/${f.name.split('/').map(encodeURIComponent).join('/')}`);
    }
  } catch (e) { console.log(`== ${id} ERROR ${e.message}`); }
  await new Promise((r) => setTimeout(r, 1000));
}
