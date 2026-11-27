import fs from 'node:fs';
const P = 'z:/MIDIMaster/tools/firmware/midi_devices.json';
const db = JSON.parse(fs.readFileSync(P, 'utf8'));
const ids = `alesis-adat alesis-adat-xt alesis-microverb alesis-microverb-ii apple-applecd-150 arp-pro-soloist arp-quadra
casio-pt-280 casio-sk-1 casio-sk-2 casio-sk-5 casio-sk-10 edp-spider eventide-h949 fostex-r8 frontier-design-tango
korg-kr-55 korg-mono-poly korg-polysix korg-trident korg-wavedrum-2009 lexicon-224-224x lexicon-pcm-60 lexicon-primetime-93
line-6-variax linn-linndrum moog-minimoog moog-source mxr-185-drum-computer oberheim-dsx oberheim-ob-1 oberheim-ob-sx
oberheim-ob-x oberheim-ob-xa oberheim-prommer oberheim-systemizer ppg-wave-2-0 rhodes-chroma roland-cr-78 roland-juno-6
roland-jupiter-4 roland-jupiter-8 roland-mc-4 roland-mc-202 roland-sh-101 roland-tb-303 roland-tr-606 roland-tr-808
roland-vp-330 roland-pg-200 roland-pg-300 roland-pg-800 roland-dif-at simmons-sds1000 tascam-aq-65
ursa-major-space-station-sst-282 ursa-major-stargate-323 kawai-sx-210 yamaha-mk-100 yamaha-pss-12 yamaha-pss-102
yamaha-pss-390 behringer-dcx2496 bel-bde-3200`.split(/\s+/);
const missing = ids.filter((id) => !db.devices.some((d) => d.id === id));
if (missing.length) { console.log('not found:', missing.join(' ')); process.exit(1); }
const removed = db.devices.filter((d) => ids.includes(d.id));
db.devices = db.devices.filter((d) => !ids.includes(d.id));
db.removedNoMidi = [...new Set([...(db.removedNoMidi || []), ...removed.map((d) => `${d.maker} ${d.model}`)])].sort();
db.about = db.about.replace(/ removedNoMidi:.*$/, '') + ' removedNoMidi: devices taken out because they have no MIDI (no DIN, no USB-MIDI, no factory MIDI version; retrofits do not count).';
fs.writeFileSync(P, JSON.stringify(db));
console.log('removed', removed.length);
