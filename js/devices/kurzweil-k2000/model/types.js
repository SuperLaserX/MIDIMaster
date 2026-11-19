// K2000 object types (SysEx `type` field values) and ID helpers.

export const T = Object.freeze({
  PROGRAM: 132, KEYMAP: 133, SOUNDBLOCK: 134, SETUP: 135, EFFECT: 113, SONG: 112,
  VELMAP: 104, PRESSMAP: 105, QABANK: 111, INTONATION: 103, TABLE: 100,
});

export const TYPES = [
  { type: T.PROGRAM, key: 'programs', name: 'Programs', single: 'Program', editable: true },
  { type: T.SETUP, key: 'setups', name: 'Setups', single: 'Setup' },
  { type: T.KEYMAP, key: 'keymaps', name: 'Keymaps', single: 'Keymap', editable: true },
  { type: T.SOUNDBLOCK, key: 'samples', name: 'Samples', single: 'Sample', editable: true },
  { type: T.EFFECT, key: 'effects', name: 'Effects', single: 'Effect' },
  { type: T.QABANK, key: 'qabanks', name: 'Quick Access', single: 'QA Bank' },
  { type: T.SONG, key: 'songs', name: 'Songs', single: 'Song' },
  { type: T.VELMAP, key: 'velmaps', name: 'Velocity Maps', single: 'Velocity Map' },
  { type: T.PRESSMAP, key: 'pressmaps', name: 'Pressure Maps', single: 'Pressure Map' },
  { type: T.INTONATION, key: 'intonation', name: 'Intonation', single: 'Intonation Table' },
];

export const TYPE_BY_ID = Object.fromEntries(TYPES.map((t) => [t.type, t]));

export function typeName(type) { return TYPE_BY_ID[type]?.single || (type === T.TABLE ? 'Table' : `Type ${type}`); }

/** The Master parameters live in object type 100, ID 16. Macros are type 100, ID 35. */
export const MASTER = { type: T.TABLE, id: 16 };
export const MACRO_TABLE = { type: T.TABLE, id: 35 };

/** Banks are hundreds: bank 0 = IDs 1-99, bank 1 = 100-199 ... bank 9 = 900-999. */
export function bankOf(id) { return Math.floor(id / 100); }
export function bankRange(bank) { return bank === 0 ? [1, 99] : [bank * 100, bank * 100 + 99]; }

export const ROM_NOTE = 'IDs 1-199 hold the factory ROM objects. RAM objects at the same ID hide the ROM version.';
