// Music helpers shared by every device module.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Note name with C4 = MIDI note 60 (the convention most manufacturers use). */
export function noteName(n) { return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`; }

export function parseNoteName(s) {
  const m = /^([A-Ga-g])(#|b)?(-?[0-9])$/.exec(String(s).trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  return base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (parseInt(m[3], 10) + 1) * 12;
}

/** General MIDI controller names (0-127). */
export const CC_NAMES = {
  0: 'Bank Select MSB', 1: 'Modulation', 2: 'Breath', 4: 'Foot', 5: 'Portamento Time', 6: 'Data Entry MSB',
  7: 'Volume', 8: 'Balance', 10: 'Pan', 11: 'Expression', 12: 'Effect Control 1', 13: 'Effect Control 2',
  16: 'General Purpose 1', 17: 'General Purpose 2', 18: 'General Purpose 3', 19: 'General Purpose 4',
  32: 'Bank Select LSB', 38: 'Data Entry LSB', 64: 'Sustain', 65: 'Portamento', 66: 'Sostenuto', 67: 'Soft Pedal',
  68: 'Legato', 69: 'Hold 2', 70: 'Sound Variation', 71: 'Resonance', 72: 'Release Time', 73: 'Attack Time',
  74: 'Cutoff', 75: 'Decay Time', 76: 'Vibrato Rate', 77: 'Vibrato Depth', 78: 'Vibrato Delay',
  80: 'General Purpose 5', 81: 'General Purpose 6', 82: 'General Purpose 7', 83: 'General Purpose 8',
  84: 'Portamento Control', 91: 'Reverb Send', 92: 'Tremolo Depth', 93: 'Chorus Send', 94: 'Celeste Depth',
  95: 'Phaser Depth', 96: 'Data Increment', 97: 'Data Decrement', 98: 'NRPN LSB', 99: 'NRPN MSB',
  100: 'RPN LSB', 101: 'RPN MSB', 120: 'All Sound Off', 121: 'Reset All Controllers', 122: 'Local Control',
  123: 'All Notes Off', 124: 'Omni Off', 125: 'Omni On', 126: 'Mono On', 127: 'Poly On',
};

export const ccName = (n) => CC_NAMES[n] || (n >= 32 && n < 64 && CC_NAMES[n - 32] ? `${CC_NAMES[n - 32]} LSB` : `CC ${n}`);
