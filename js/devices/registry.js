// Every device MIDIMaster knows about: the firmware catalog, plus the modules and
// definitions that implement them. A device opens its dedicated module when there is
// one, otherwise the generic MIDI module (with its definition when one exists).

import { CATALOG } from './catalog-data.js';
import { renderLogo, logoText, styleCombo, comboKey, COMBO_COUNT } from '../core/ui/logo.js';

/** Dedicated device modules (full editors). */
const MODULES = {
  'kurzweil-k2000': () => import('./kurzweil-k2000/module.js'),
};

/** Device definitions for the generic module (SysEx maps found in the firmware). */
const DEFS = {
  'oberheim-matrix1000': () => import('./defs/oberheim-matrix1000.js'),
  'roland-jv2080': () => import('./defs/roland-jv2080.js'),
};

/** Hand-picked logo styles; the rest are assigned in catalog order without repeats. */
const RESERVED = {
  __app: { style: 'half', frame: 'heavy', spacing: 1, captionAbove: false, captionStyle: 'rule' },
  'kurzweil-k2000': { style: 'extrude', frame: 'double', spacing: 1, captionAbove: false, captionStyle: 'spaced' },
};

const OPENABLE = new Set(['Y', 'R', '?', 'Y?']);

export const MIDI_LABEL = {
  Y: 'MIDI', R: 'MIDI (some versions)', '?': 'MIDI unknown', 'Y?': 'MIDI likely', N: 'No MIDI', H: 'MIDI host', D: 'Sound data',
};

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

export const MODULE_IDS = Object.keys(MODULES);
export const DEF_IDS = Object.keys(DEFS);
