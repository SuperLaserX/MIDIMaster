// Every device MIDIMaster knows about: the firmware catalog, plus the modules and
// definitions that implement them. A device opens its dedicated module when there is
// one, otherwise the generic MIDI module (with its definition when one exists).

import { CATALOG as GENERATED } from './catalog-data.js';
import { CATALOG_EXTRA } from './catalog-extra.js';
import { renderLogo, logoText, styleCombo, comboKey, COMBO_COUNT } from '../core/ui/logo.js';

/** Dedicated device modules (full editors). */
const MODULES = {
  'kurzweil-k2000': () => import('./kurzweil-k2000/module.js'),
};

/** Device definitions for the generic module (SysEx maps found in the firmware). */
const DEFS = {
  'oberheim-matrix1000': () => import('./defs/oberheim-matrix1000.js'),
  'roland-jv2080': () => import('./defs/roland-jv2080.js'),
  'korg-m1': () => import('./defs/korg-m1.js'),
  'korg-m1r': () => import('./defs/korg-m1.js'),
  'roland-jp8080': () => import('./defs/roland-jp8080.js'),
  'roland-jp8000': () => import('./defs/roland-jp8000.js'),
  'roland-vsynth-xt': () => import('./defs/roland-vsynthxt.js'),
  'roland-vsynth-xt-vc1': () => import('./defs/roland-vsynthxt-vc1.js'),
  'roland-vsynth-xt-vc2': () => import('./defs/roland-vsynthxt-vc2.js'),
  'roland-system8': () => import('./defs/roland-system8.js'),
  'roland-system8-jupiter8': () => import('./defs/roland-system8-jupiter8.js'),
  'roland-system8-sh101': () => import('./defs/roland-system8-sh101.js'),
  'roland-system8-juno106': () => import('./defs/roland-system8-juno106.js'),
  'roland-system8-jx3p': () => import('./defs/roland-system8-jx3p.js'),
  'roland-system8-juno60': () => import('./defs/roland-system8-juno60.js'),
  'roland-system8-jupiter4': () => import('./defs/roland-system8-jupiter4.js'),
  'roland-system8-promars': () => import('./defs/roland-system8-promars.js'),
  'roland-system8-sh2': () => import('./defs/roland-system8-sh2.js'),
  'roland-system8-system100': () => import('./defs/roland-system8-system100.js'),
  'novation-supernova2': () => import('./defs/novation-supernova2.js'),
  'novation-supernova': () => import('./defs/novation-supernova.js'),
  'novation-nova': () => import('./defs/novation-nova.js'),
  'novation-nova2': () => import('./defs/novation-nova2.js'),
  'access-virus-ti2': () => import('./defs/access-virus-ti2.js'),
  'access-virus-ti2-keyboard': () => import('./defs/access-virus-ti2-keyboard.js'),
  'access-virus-ti2-polar': () => import('./defs/access-virus-ti2-polar.js'),
  'access-virus-ti-desktop': () => import('./defs/access-virus-ti-desktop.js'),
  'access-virus-ti-keyboard': () => import('./defs/access-virus-ti-keyboard.js'),
  'access-virus-ti-polar': () => import('./defs/access-virus-ti-polar.js'),
  'access-virus-snow': () => import('./defs/access-virus-snow.js'),
  'access-virus-b': () => import('./defs/access-virus-b.js'),
  'access-virus-kb': () => import('./defs/access-virus-kb.js'),
  'access-virus-indigo': () => import('./defs/access-virus-indigo.js'),
  'access-virus-rack': () => import('./defs/access-virus-rack.js'),
  'access-virus-classic': () => import('./defs/access-virus-classic.js'),
  'access-virus-c': () => import('./defs/access-virus-c.js'),
  'access-virus-kc': () => import('./defs/access-virus-kc.js'),
  'access-virus-indigo2': () => import('./defs/access-virus-indigo2.js'),
  'access-virus-rack-xl': () => import('./defs/access-virus-rack-xl.js'),
  'access-virus-a': () => import('./defs/access-virus-a.js'),
  'yamaha-dx7': () => import('./defs/yamaha-dx7.js'),
  'yamaha-tx7': () => import('./defs/yamaha-tx7.js'),
  'yamaha-dx9': () => import('./defs/yamaha-dx9.js'),
  'yamaha-dx7ii': () => import('./defs/yamaha-dx7ii.js'),
  'yamaha-dx7s': () => import('./defs/yamaha-dx7s.js'),
  'yamaha-tx802': () => import('./defs/yamaha-tx802.js'),
  'yamaha-tx81z': () => import('./defs/yamaha-tx81z.js'),
  'yamaha-dx11': () => import('./defs/yamaha-dx11.js'),
  'yamaha-dx21': () => import('./defs/yamaha-dx21.js'),
  'yamaha-dx100': () => import('./defs/yamaha-dx100.js'),
  'yamaha-tx816': () => import('./defs/yamaha-tx816.js'),
  'yamaha-dx5': () => import('./defs/yamaha-dx5.js'),
  'alesis-wedge': () => import('./defs/alesis-wedge.js'),
  'alesis-midiverb4': () => import('./defs/alesis-midiverb4.js'),
  'alesis-microverb4': () => import('./defs/alesis-microverb4.js'),
  'alesis-quadraverb': () => import('./defs/alesis-quadraverb.js'),
  'alesis-quadraverb-plus': () => import('./defs/alesis-quadraverb-plus.js'),
  'alesis-quadraverb-gt': () => import('./defs/alesis-quadraverb-gt.js'),
  'alesis-quadraverb2': () => import('./defs/alesis-quadraverb2.js'),
  'rocktron-intellifex': () => import('./defs/rocktron-intellifex.js'),
  'alesis-midiverb3': () => import('./defs/alesis-midiverb3.js'),
  'art-multiverb-alpha2': () => import('./defs/art-multiverb-alpha2.js'),
  'art-multiverb-alpha2-se': () => import('./defs/art-multiverb-alpha2-se.js'),
  'art-multiverb-alpha-se': () => import('./defs/art-multiverb-alpha2-se.js'), // the catalog's v1.04 entry: the same unit
  'viscount-efx10': () => import('./defs/viscount-efx10.js'),
  'lexicon-lxp15': () => import('./defs/lexicon-lxp15.js'),
  'lexicon-lxp1': () => import('./defs/lexicon-lxp1.js'),
  'lexicon-lxp5': () => import('./defs/lexicon-lxp5.js'),
  'digitech-dsp256': () => import('./defs/digitech-dsp256.js'),
  'digitech-dsp256xl': () => import('./defs/digitech-dsp256xl.js'),
  'digitech-dsp128plus': () => import('./defs/digitech-dsp128plus.js'),
  'digitech-meq': () => import('./defs/digitech-meq.js'),};

/** Hand-picked logo styles; the rest are assigned in catalog order without repeats. */
const RESERVED = {
  __app: { style: 'half', frame: 'heavy', spacing: 1, captionAbove: false, captionStyle: 'rule' },
  'kurzweil-k2000': { style: 'extrude', frame: 'double', spacing: 1, captionAbove: false, captionStyle: 'spaced' },
};

const OPENABLE = new Set(['Y', 'R', '?', 'Y?']);

export const MIDI_LABEL = {
  Y: 'MIDI', R: 'MIDI (some versions)', '?': 'MIDI unknown', 'Y?': 'MIDI likely', N: 'No MIDI', H: 'MIDI host', D: 'Sound data',
};

/** The generated catalog plus the devices added since (catalog-extra.js), by maker and model. */
const CATALOG = [...GENERATED, ...CATALOG_EXTRA.filter((e) => !GENERATED.some((c) => c.id === e.id))]
  .sort((a, b) => a.maker.localeCompare(b.maker) || a.model.localeCompare(b.model, undefined, { numeric: true }));

function build() {
  const used = new Set(Object.values(RESERVED).map(comboKey));
  let n = 0;
  return CATALOG.map((c) => {
    const openable = OPENABLE.has(c.midi);
    let logo = RESERVED[c.id] || null;
    if (!logo && openable) {
      do { logo = styleCombo(n++); } while (used.has(comboKey(logo)) && n < COMBO_COUNT * 2);
      used.add(comboKey(logo));
    }
    return {
      ...c,
      title: `${c.maker} ${c.model}`,
      openable,
      hasModule: !!MODULES[c.id],
      hasDef: !!DEFS[c.id],
      logo,
    };
  });
}

export const DEVICES = build();
const BY_ID = new Map(DEVICES.map((d) => [d.id, d]));

export const getDevice = (id) => BY_ID.get(id) || null;

/** The device's ASCII-art logo. */
export function deviceLogo(entry, model = entry.model) {
  return renderLogo(logoText(model), { ...(entry.logo || styleCombo(0)), caption: entry.maker });
}

export function appLogo() {
  return renderLogo('MIDIMASTER', { ...RESERVED.__app, caption: 'every MIDI device, one editor' });
}

/** Load the module that edits a device. */
export async function loadModule(id) {
  const entry = getDevice(id);
  if (MODULES[id]) return (await MODULES[id]()).default;
  const def = DEFS[id] ? (await DEFS[id]()).default : null;
  const { createGenericModule } = await import('./generic/module.js');
  return createGenericModule(entry, def);
}

/** The device definition (generic module) of a device, or null. */
export async function loadDef(id) { return DEFS[id] ? (await DEFS[id]()).default : null; }

export const MODULE_IDS = Object.keys(MODULES);
export const DEF_IDS = Object.keys(DEFS);
