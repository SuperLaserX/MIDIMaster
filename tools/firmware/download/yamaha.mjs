// node yamaha.mjs "Keyword" ["Keyword" ...]  -> firmware assets found by Yamaha's download search (usa.yamaha.com)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const all = process.argv.includes("--all"); const fwOnly = process.argv.includes("--fw"); const kws = process.argv.slice(2).filter((a) => !a.startsWith("--"));
for (const kw of kws) {
  const u = `https://yamaha.search.zetacx.net/api/search/assets?limit=100&publicationId=152&customerType=${process.env.YCT || "C"}&searchKeyword=${encodeURIComponent(kw)}&nl=0`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://usa.yamaha.com/support/downloads/' } });
  const j = await r.json();
  const n = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const list = (j.assetsList || []).filter((x) => all || (fwOnly ? /Firmware/i.test(x.downloadType + " " + x.assetType) && !/Editor|Driver|VST|Steinberg|Mac/i.test(x.assetName) : null) || (!fwOnly && /Firmware/i.test(x.downloadType + ' ' + x.assetType) && /(OS|Firmware|System|Program|Main).*(Updat|Ver)|Updater|Firmware V|Update/i.test(x.assetName) && !/Editor|Driver|VST|Connect|Extension|IEEE1394|Steinberg|Plug|Librar|Expansion Manager|Voice|Song|Manual|USB-MIDI|Tools|Converter|Studio Manager|DME|Card Filer/i.test(x.assetName) && n(x.assetName).includes(n(kw))));
  console.log(`## ${kw}: ${(j.assetsList || []).length} assets, ${list.length} firmware`);
  for (const x of list) console.log(`- ${x.tcmId} | ${x.assetName} | v${x.assetVersion} | ${x.assetSize} | ${x.assetTypeFormat} | ${x.os || ''}`);
}
