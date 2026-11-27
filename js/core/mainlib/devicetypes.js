// What kind of instrument a device is, for the Head Library (several types per device). Devices
// whose design is known are listed; the rest fall back to the catalog's type code.

const BY_CATALOG = {
  syn: ['Synthesizer'], smp: ['Sampler'], drm: ['Drum machine'], fx: ['Effects'], seq: ['Sequencer'], ctl: ['Controller'],
  if: ['MIDI interface'], mix: ['Mixer'], gtr: ['Guitar/bass processor'], pno: ['Piano/organ'], arr: ['Arranger'], rec: ['Recorder'],
  voc: ['Vocal processor'], cpu: ['Computer/card'], data: ['Sound data'], oth: ['Other'],
};

const KNOWN = {
  'roland-vsynth-xt': ['Synthesizer', 'Sampler', 'Virtual analog'],
  'roland-vsynth-xt-vc1': ['Synthesizer', 'Rompler'],
  'roland-vsynth-xt-vc2': ['Synthesizer', 'Vocoder'],
  'kurzweil-k2000': ['Synthesizer', 'Sampler'],
  'roland-jv2080': ['Rompler', 'Synthesizer'],
  'roland-jp8080': ['Synthesizer', 'Virtual analog'],
  'roland-jp8000': ['Synthesizer', 'Virtual analog'],
  'korg-m1': ['Rompler', 'Workstation'],
  'korg-m1r': ['Rompler'],
  'oberheim-matrix1000': ['Synthesizer', 'Analog'],
  'novation-supernova2': ['Synthesizer', 'Virtual analog'],
};

/** Types of a catalog entry ({id, type}). */
export function deviceTypes(entry) {
  return KNOWN[entry?.id] || BY_CATALOG[entry?.type] || ['Other'];
}

export const ALL_TYPES = [...new Set([...Object.values(KNOWN).flat(), ...Object.values(BY_CATALOG).flat()])].sort();
