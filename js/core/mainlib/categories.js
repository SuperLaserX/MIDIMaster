// Sound categories for the Head Library. The standard set is Roland's 38-category list from the
// JV-2080 firmware (also used by the JV/XP family), so a device with its own category system maps
// straight onto it. Other patches get a category from their name: a prefix code ("BA ...", "PD:")
// or a telling word ("Bass", "Pad").

export const CATEGORIES = [
  ['none', 'No category'], ['ac-piano', 'Ac. Piano'], ['el-piano', 'El. Piano'], ['keyboards', 'Keyboards'], ['bell', 'Bell'],
  ['mallet', 'Mallet'], ['organ', 'Organ'], ['accordion', 'Accordion'], ['harmonica', 'Harmonica'], ['ac-guitar', 'Ac. Guitar'],
  ['el-guitar', 'El. Guitar'], ['dist-guitar', 'Dist. Guitar'], ['bass', 'Bass'], ['synth-bass', 'Synth Bass'], ['strings', 'Strings'],
  ['orchestra', 'Orchestra'], ['hit-stab', 'Hit & Stab'], ['wind', 'Wind'], ['flute', 'Flute'], ['ac-brass', 'Ac. Brass'],
  ['synth-brass', 'Synth Brass'], ['sax', 'Sax'], ['hard-lead', 'Hard Lead'], ['soft-lead', 'Soft Lead'], ['techno-synth', 'Techno Synth'],
  ['pulsating', 'Pulsating'], ['synth-fx', 'Synth FX'], ['other-synth', 'Other Synth'], ['bright-pad', 'Bright Pad'], ['soft-pad', 'Soft Pad'],
  ['vox', 'Vox'], ['plucked', 'Plucked'], ['ethnic', 'Ethnic'], ['fretted', 'Fretted'], ['percussion', 'Percussion'],
  ['sound-fx', 'Sound FX'], ['beat-groove', 'Beat & Groove'], ['drums', 'Drums'], ['combination', 'Combination'],
];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
/** The JV-2080 Category parameter value n is CATEGORIES[n] (same order as the firmware list). */
export const categoryFromRoland = (n) => CATEGORIES[n]?.[0] ?? 'none';

// Prefix codes seen in factory and third-party sets ("BA 303 Style", "PD:Warm", "SQ-Arp1",
// "LD Saw"). Matched as the first word of the name, before a space, colon, dash or dot.
const PREFIXES = {
  BA: 'synth-bass', BS: 'synth-bass', SB: 'synth-bass', BASS: 'synth-bass',
  PD: 'soft-pad', PAD: 'soft-pad', PA: 'soft-pad',
  LD: 'hard-lead', LEAD: 'hard-lead', LE: 'hard-lead', SL: 'soft-lead',
  SQ: 'pulsating', SEQ: 'pulsating', ARP: 'pulsating', AR: 'pulsating', PU: 'pulsating',
  PN: 'ac-piano', PNO: 'ac-piano', PIA: 'ac-piano', EP: 'el-piano', EPN: 'el-piano', KB: 'keyboards', KEY: 'keyboards', CLV: 'keyboards',
  OR: 'organ', ORG: 'organ', ST: 'strings', STR: 'strings', STRG: 'strings', OR2: 'orchestra', ORC: 'orchestra',
  BR: 'synth-brass', BRS: 'synth-brass', SBR: 'synth-brass', AB: 'ac-brass',
  GT: 'el-guitar', GTR: 'el-guitar', AG: 'ac-guitar', DG: 'dist-guitar',
  FX: 'synth-fx', SFX: 'sound-fx', EFX: 'synth-fx', HT: 'hit-stab', HIT: 'hit-stab', STB: 'hit-stab',
  DR: 'drums', DRM: 'drums', KIT: 'drums', PC: 'percussion', PRC: 'percussion', PERC: 'percussion',
  VX: 'vox', VOX: 'vox', VOC: 'vox', CH: 'vox', PL: 'plucked', PLK: 'plucked', BL: 'bell', BEL: 'bell', MLT: 'mallet',
  SY: 'other-synth', SYN: 'other-synth', TS: 'techno-synth', TEC: 'techno-synth', WD: 'wind', FL: 'flute', SX: 'sax',
  ET: 'ethnic', ETH: 'ethnic', BT: 'beat-groove', GRV: 'beat-groove',
};

// Words anywhere in the name, checked in this order (more specific first).
const WORDS = [
  [/\b(synth ?bass|sub ?bass|acid|303|bassline)\b/i, 'synth-bass'], [/\bbass(es)?\b/i, 'bass'],
  [/\b(e\.? ?piano|rhodes|wurli|el\.? ?piano|dx ?piano)\b/i, 'el-piano'], [/\bpiano\b/i, 'ac-piano'],
  [/\b(clav|harpsi)/i, 'keyboards'], [/\borgan\b/i, 'organ'], [/\b(bell|chime)s?\b/i, 'bell'],
  [/\b(marimba|vibe|xylo|mallet)/i, 'mallet'], [/\b(string|violin|cello|viola)s?\b/i, 'strings'],
  [/\b(orchestra|orch)\b/i, 'orchestra'], [/\b(hit|stab)s?\b/i, 'hit-stab'], [/\b(brass|horn)s?\b/i, 'synth-brass'],
  [/\b(trumpet|trombone)s?\b/i, 'ac-brass'], [/\bsax/i, 'sax'], [/\bflute\b/i, 'flute'],
  [/\b(guitar|gtr)\b/i, 'el-guitar'], [/\b(lead|solo)s?\b/i, 'hard-lead'], [/\b(pad|warm|sweep)s?\b/i, 'soft-pad'],
  [/\b(arp|seq|sequence|pulse|gate)s?\b/i, 'pulsating'], [/\b(choir|vox|voice|vocal|ahh|ooh)s?\b/i, 'vox'],
  [/\b(pluck|harp|koto|pizz)/i, 'plucked'], [/\b(drum|kit|909|808|kick|snare|hat)s?\b/i, 'drums'],
  [/\b(perc|percussion|conga|bongo)/i, 'percussion'], [/\b(fx|noise|zap|laser)\b/i, 'synth-fx'],
];

/** Category guessed from a patch name, or null. */
export function categoryFromName(name = '') {
  const n = String(name).trim();
  const m = /^([A-Za-z]{2,4}\d?)[\s:_.\-]/.exec(n);
  if (m && PREFIXES[m[1].toUpperCase()]) return { id: PREFIXES[m[1].toUpperCase()], source: 'name-prefix' };
  for (const [re, id] of WORDS) if (re.test(n)) return { id, source: 'name-word' };
  return null;
}

/** {id, label, source} from a device category (id), else the name, else none. */
export function categorize(name, deviceCategory = null) {
  const c = deviceCategory && deviceCategory !== 'none' ? { id: deviceCategory, source: 'device' } : categoryFromName(name) || { id: 'none', source: 'none' };
  return { ...c, label: CATEGORY_LABEL[c.id] || c.id };
}
