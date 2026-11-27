// What an instrument fundamentally is, for grouping the device picker: grooveboxes, FM, analog,
// virtual analog, ROMplers, samplers, drum machines, effects processors...
//
// One family per device. A multi-purpose instrument goes by its prominent feature (an opsix can do
// subtractive synthesis but is an FM synthesizer; a V-Synth is built on sample playback), and a
// groovebox is a groovebox whatever its synthesis (DX200, MC-303). A sampler (it records its own
// sounds: K2000, Prophet 2000) is apart from a ROMpler (it plays factory samples: JV-2080, M1); the
// catalog's sampler type (smp) wins over a maker's synthesizer pattern. Devices whose design is known are
// matched by id below; the rest fall back to the catalog's type code. When an editor is added for a
// synthesizer not matched here, add its id (the "Other synthesizers" group shows what is missing).

export const FAMILIES = [
  { key: 'groovebox', label: 'Grooveboxes' },
  { key: 'fm', label: 'FM synthesizers' },
  { key: 'analog', label: 'Analog synthesizers' },
  { key: 'va', label: 'Virtual analog synthesizers' },
  { key: 'rompler', label: 'ROMplers (sample playback synthesizers and workstations)' },
  { key: 'sampler', label: 'Samplers' },
  { key: 'wave', label: 'Wavetable and other digital synthesizers' },
  { key: 'synth', label: 'Other synthesizers' },
  { key: 'drum', label: 'Drum machines' },
  { key: 'fx', label: 'Effects processors' },
  { key: 'piano', label: 'Pianos and organs' },
  { key: 'seq', label: 'Sequencers' },
  { key: 'ctl', label: 'Controllers and MIDI interfaces' },
  { key: 'other', label: 'Other devices' },
];
export const FAMILY_LABEL = Object.fromEntries(FAMILIES.map((f) => [f.key, f.label]));

/** [id pattern, family]: the first match wins, so grooveboxes come first. */
const BY_ID = [
  // grooveboxes, whatever their synthesis
  [/^yamaha-(dx200|an200|su200|su700|rm1x|rs7000|rs-?7000)$/, 'groovebox'],
  [/^roland-(mc-?(303|307|505|909|808|707|101|09)|jx-?305|d2|dj-?70(mkii)?|sp-?(404|505|606|808)|mv-?8000|mv-?8800|tr-?8s?|verselab)/, 'groovebox'],
  [/^korg-(electribe|er-?1|ea-?1|es-?1|emx|esx|electribe2|kaossilator|volca-sample)/, 'groovebox'],
  [/^akai-(mpc|force)/, 'groovebox'],
  [/^novation-circuit/, 'groovebox'],
  [/^elektron-(machinedrum|monomachine|octatrack|digitakt|digitone|model-?(samples|cycles)|syntakt|analog-?rytm)/, 'groovebox'],
  [/^(teenage-engineering-op|polyend-(tracker|play))/, 'groovebox'],
  // FM (Yamaha's FM family, Korg's opsix...)
  [/^yamaha-(dx|tx(?!16w)|tq|fb-?01|fs1r|sy77|sy99|tg77|v50|ds-?55|reface-?dx|montage|modx)/, 'fm'],
  [/^korg-(opsix|volca-fm|ds-?8|707)/, 'fm'],
  [/^elektron-digitone/, 'fm'],
  // analog
  [/^oberheim-/, 'analog'],
  [/^(sequential|dave-smith|moog|arp|rhodes-chroma|tom-oberheim)/, 'analog'],
  [/^roland-(jupiter-?[468]|juno-?(6|60|106|1|2)|mks-?(30|50|70|80)|jx-?[38]p|jx-?10|sh-?(09|101|2)|system-?100|alpha-?juno)/, 'analog'],
  [/^korg-(minilogue|monologue|prologue|ms-?20|polysix|mono-?poly|poly-?(61|800)|dw-?(6000|8000)|ex-?800)/, 'analog'],
  // virtual analog
  [/^access-virus/, 'va'],
  [/^novation-(supernova|nova|k-?station|a-?station|ks-?\d|x-?station|ultranova|mininova|peak|summit)/, 'va'],
  [/^roland-(jp-?8000|jp-?8080|jp8000|jp8080|sh-?32|sh-?201|gaia|system-?[18]|jd-?xi|jd-?xa)/, 'va'],
  [/^(clavia-nord-(lead|modular)|nord-(lead|modular))/, 'va'],
  [/^korg-(ms-?2000|microkorg|radias|r3|z1|prophecy|kingkorg)/, 'va'],
  [/^waldorf-(q|micro-?q|blofeld)/, 'va'],
  // samplers: they record (or load) their own sounds; the V-Synth samples and resynthesizes
  // (VariPhrase), the K2000 / K2500 / K2600 take sampling options and load sample disks
  [/^sequential-(prophet-?200[02]|studio-?440)/, 'sampler'],
  [/^kurzweil-(k2000|k2500|k2600|k2vx|k2661|k2m)/, 'sampler'],
  [/^roland-(vsynth|v-?synth)/, 'sampler'],
  // ROMplers: factory samples in ROM (workstations too)
  [/^roland-(jv|xv|jd-?(800|990)|u-?(20|110|220)|d-?(5|10|20|50|110|550)|fantom|integra|mv-?30|sound-?canvas|sc-)/, 'rompler'],
  [/^korg-(m1|m1r|m3|t[123]|01|03|05|trinity|triton|kronos|nautilus|wavestation|x[35]|n[1-5]|i[2-5])/, 'rompler'],
  [/^kurzweil-(k2|k25|k26|pc)/, 'rompler'],
  [/^(emu|e-?mu)-(proteus|morpheus|ultra-?proteus|vintage|planet|orbit|mo-?phatt|b-?3|xl-?7|mp-?7)/, 'rompler'],
  [/^ensoniq-(sq|ts|vfx|kt|zr|mr)/, 'rompler'],
  // wavetable and other digital
  [/^(waldorf-(microwave|wave|xt)|ppg-|korg-(wavestate|modwave|dw))/, 'wave'],
  [/^casio-cz/, 'wave'],
];

const BY_TYPE = {
  syn: 'synth', smp: 'sampler', drm: 'drum', fx: 'fx', gtr: 'fx', voc: 'fx', pno: 'piano', arr: 'piano',
  seq: 'seq', ctl: 'ctl', if: 'ctl', mix: 'other', rec: 'other', cpu: 'other', data: 'other', oth: 'other',
};

/** The family key of a catalog entry ({id, type}). */
export function deviceFamily(entry) {
  const id = String(entry?.id || '');
  const known = BY_ID.find(([re]) => re.test(id))?.[1];
  // a sampler by the catalog stays a sampler (Prophet 2000: not an analog synthesizer), unless it is a groovebox
  if (entry?.type === 'smp' && known !== 'groovebox') return 'sampler';
  return known || BY_TYPE[entry?.type] || 'other';
}
