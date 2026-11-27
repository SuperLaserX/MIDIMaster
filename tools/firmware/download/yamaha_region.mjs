// node yamaha_region.mjs <publicationId> <host> kw ... : Yamaha regional download search, firmware-like assets with their download URLs
setTimeout(() => { console.log('# HARD TIMEOUT'); process.exit(2); }, 600000).unref();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const [pub, host, ...kws] = process.argv.slice(2);
const n = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
const BAD = /Editor|Driver|VST|Steinberg|Connect|Extension|Plug|Librar|Expansion Manager|Voice|Song|Manual|Tools|Converter|Studio Manager|Card Filer|Data List|Mac|Sample|Pattern|Template|Style/i;
for (const kw of kws) {
  for (const ct of ['C', 'P']) {
    try {
      const u = `https://yamaha.search.zetacx.net/api/search/assets?limit=100&publicationId=${pub}&customerType=${ct}&searchKeyword=${encodeURIComponent(kw)}&nl=0`;
      const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: `https://${host}/support/updates/` } });
      const j = await r.json();
      const list = (j.assetsList || []).filter((x) => /Firmware|Update|Program/i.test(`${x.downloadType} ${x.assetType} ${x.assetName}`) && !BAD.test(x.assetName) && n(x.assetName + ' ' + (x.productName || '')).includes(n(kw)));
      for (const x of list) console.log(`${kw} [${ct}] | ${x.assetName} | v${x.assetVersion} | ${x.assetSize} | ${x.os || ''} | https://${host}/download/files/${x.tcmId}`);
      if (!list.length) console.log(`${kw} [${ct}] | - (${(j.assetsList || []).length} assets)`);
    } catch (e) { console.log(`${kw} [${ct}] ERR ${e.message}`); }
    await new Promise((res) => setTimeout(res, 600));
  }
}
