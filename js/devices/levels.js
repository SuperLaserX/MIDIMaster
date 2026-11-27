// How complete each editor is: the one place that says which editors are "Full editor".
// tools/device_status.mjs (docs/devices/STATUS.md), tools/firmware_checklist.mjs (through STATUS.md)
// and the device picker read it. An editor that is not listed in FULL is "Mapped from firmware" while
// it has a module or definition; MISSING says what each of those still lacks.
//
// Reviewed 2026-11-25 against the code, the tests and the docs (docs/devices/*.md, docs/FUTURE_WORK.md).

/** What a full editor has (checked in this order). */
export const CRITERIA = [
  'Every byte of every object the device sends or keeps (sounds and settings) is a named parameter with the label, range and option list the firmware or manual gives; no "Byte nnh", spare or unknown fields, unless the doc shows the firmware never displays or uses them.',
  'Every object reads and writes: the edit buffers, every memory bank (store and fetch), names, and the Branch Library\'s complete dump.',
  'Checked on the hardware, or a documented reason it cannot be that the firmware analysis covers.',
  'Every sound object (patch, program, performance, combination, rhythm set...) has a Head Library translator (obj.toCommon / obj.fromCommon) with tests.',
  'A multitimbral device has its MIDI channels page.',
  'What is left open in the device doc and docs/FUTURE_WORK.md is a convenience, not missing data, an unchecked mapping or a missing object.',
];

/** Full editors, each with the evidence. */
export const FULL = {
  'korg-m1': 'every byte of programs, combinations, global and drum kits named from the M1R v1.06 firmware (cross-checked with the M1 keyboard rev 19 OS); checked on an M1R, which uses the same messages; program and combination translators; MIDI channels page',
  'korg-m1r': 'same editor as the M1: every byte named from the v1.06 firmware, checked on an M1R; program and combination translators; MIDI channels page',
  'roland-jp8080': 'every byte named from OS 1.04 and checked on a JP-8080 (presets, motions, complete dump); RPS patterns have no SysEx (tested); patch and performance translators; MIDI channels page',
  'roland-vsynth-xt': 'V-Synth engine: every system and patch parameter from OS 2.02, checked on a V-Synth XT (dumps, .p00 files, waves); translator; MIDI channels page',
  'roland-vsynth-xt-vc1': 'VC-1 (D-50) engine: every byte of the 448-byte patch from OS 2.02, checked on the XT (bank select, .P10 files); translator',
  'access-virus-ti2': 'every byte of singles, multis and remote templates named from the TI2 host OS 5.1.7 and Virus Control 5.1.7 (value lists in the screen\'s texts, order and ranges; reserved bytes with the OS evidence; template records tied to the panel knobs from the OS knob table); checked on a TI2 Desktop (edit buffers, RAM/ROM banks, stores to RAM A 001 and multi 001, a template write, each restored byte for byte); globals sent only (the OS has no global request); single and multi translators; MIDI channels page',
};

/** What each editor that is not full still lacks. */
export const MISSING = {
  'yamaha-dx7': ['a hardware check (no DX7 was connected; everything is from the v1.8 firmware and Yamaha\'s voice format, checked against the 128 factory ROM voices)'],
  'yamaha-tx7': [
    'a hardware check (no TX7 was connected)',
  ],
  'yamaha-dx5': [
    'a hardware check (no DX5 was connected)',
    'its system settings are shown read only (the DX5 takes none of them over MIDI, and M tune is in no message); the frequency display keeps the DX7\'s (its own B9E3 not compared)',
  ],
  'yamaha-tx816': [
    'a hardware check (no TX816 was connected)',
    'status byte 14 and the panel-only omni switch are not named',
  ],
  'yamaha-dx9': [
    'a hardware check (no DX9 was connected)',
    'its group 3 parameter changes (F59C / F5C7) are not named (algorithm numbering, receiver and screens are mapped)',
  ],
  'yamaha-dx7ii': [
    'a hardware check (no DX7II was connected; everything is from the v1.9 firmware, including its MIDI code)',
    'preset micro tuning tables other than equal temperament are not offered; system byte 19 and parameter 54h are not named',
  ],
  'yamaha-dx7s': [
    'a hardware check (no DX7s was connected; everything is from the v1.3 firmware: its page tables, screens and MIDI receiver)',
  ],
  'yamaha-tx802': [
    'a hardware check (no TX802 was connected)',
    'performance memories are read by the Branch Library (unpacked) but not selected or stored from the editor; the Equal temperament micro tuning is the DX7II\'s table (the TX802\'s own preset tables were not found in its ROMs in that form)',
  ],
  'yamaha-tx81z': [
    'a hardware check (no TX81Z was connected; everything is from the v1.6 firmware: screens, packing and its MIDI code)',
    'VCED parameter 93 (operator on/off switches) and the panel switch messages (13h 40h-4Bh) are not offered',
  ],
  'yamaha-dx11': [
    'a hardware check (no DX11 was connected)',
    'its system data "LM  8023S0" is kept, not edited; the TX81Z-style memories, system, tables, effects and micro tuning dumps are kept as data (layouts not compared with the DX11 firmware); whether its 32-voice bulk carries the after touch bytes is not read',
  ],
  'yamaha-dx21': [
    'a hardware check (no DX21 was connected)',
    'its performance memories have no MIDI format (tape only; documented); the function settings are sent only (the DX21 has no dump of them, so the Function page shows defaults until changed)',
  ],
  'yamaha-dx100': [
    'a hardware check (no DX100 or DX27 was connected)',
    'the "Bend Mode" and "Key Shift" screens (ADB0, ADA6) are not tied to a voice byte; FC Volume has no DX100 screen (keeps the TX81Z word)',
  ],
  'access-virus-ti2-keyboard': ['a hardware check (only a TI2 Desktop was connected; the same host OS image as the checked TI2)'],
  'access-virus-ti2-polar': ['a hardware check (only a TI2 Desktop was connected; the same host OS image as the checked TI2)'],
  'access-virus-ti-desktop': ['a hardware check (only a TI2 Desktop was connected; the TI host OS differs from the TI2\'s in one byte)'],
  'access-virus-ti-keyboard': ['a hardware check (only a TI2 Desktop was connected; the TI host OS differs from the TI2\'s in one byte)'],
  'access-virus-ti-polar': ['a hardware check (only a TI2 Desktop was connected; the TI host OS differs from the TI2\'s in one byte)'],
  'access-virus-b': [
    'a hardware check (no Virus b was connected; every menu and knob parameter read from its OS 4.9 run in an 8051 emulator)',
    'the SysEx receiver runs on the DSP and is not traced: requests 30-35 are Access\'s documented ones (dump layouts and checksum confirmed by Access\'s ABM dumps)',
  ],
  'access-virus-kb': [
    'a hardware check (no Virus kb was connected; it runs the B OS 4.9 mapped for the Virus b)',
    'the DSP-side SysEx receiver is not traced (requests as Access documented them)',
  ],
  'access-virus-indigo': [
    'a hardware check (no Indigo was connected; it runs the B OS 4.9 mapped for the Virus b)',
    'the DSP-side SysEx receiver is not traced (requests as Access documented them)',
  ],
  'access-virus-rack': [
    'no Virus Rack OS in the firmware collection: the B OS 4.9 is assumed',
    'a hardware check (no Rack was connected)',
  ],
  'access-virus-classic': [
    'a hardware check (no Classic was connected; its OS 4.9 x061 gives tables identical to the B\'s)',
    'the DSP-side SysEx receiver is not traced (requests as Access documented them)',
  ],
  'access-virus-c': [
    'a hardware check (no Virus C was connected; every menu and knob parameter read from its OS 6.6 run in an 8051 emulator)',
    'the SysEx receiver runs on the DSP and is not traced: requests 30-35 are Access\'s documented ones (dump layouts and checksum confirmed by Access\'s C dumps, format 7)',
  ],
  'access-virus-kc': [
    'a hardware check (no Virus KC was connected; it runs the C OS 6.6 mapped for the Virus C)',
    'the DSP-side SysEx receiver is not traced (requests as Access documented them)',
  ],
  'access-virus-indigo2': [
    'a hardware check (no Indigo 2 was connected; it runs the C OS 6.6 mapped for the Virus C)',
    'the DSP-side SysEx receiver is not traced (requests as Access documented them)',
  ],
  'access-virus-a': [
    'a hardware check (no Virus A was connected; every menu and knob parameter read from its OS 2.8 run in an 8051 emulator)',
    'assumed, not in the host code: RAM A-B / ROM C-D (its menus offer banks A-D), the sound format 6 and 128 multis (no Virus A dump in the collection); the DSP-side SysEx receiver is not traced',
  ],
  'access-virus-rack-xl': [
    'a hardware check (no Rack XL was connected; every menu and knob parameter read from its OS 6.5 x079 run in an 8051 emulator)',
    'the SysEx receiver runs on the DSP and is not traced: requests 30-35 are Access\'s documented ones; the sound format (7, the C\'s) is assumed, no Rack XL dump in the collection',
  ],
  'access-virus-snow': ['a hardware check (no Snow was connected; mapped from the Snow host OS: 4 parts, RAM/ROM 1-8 single banks of 64, 64 multis holding their 4 part singles)'],
  'alesis-microverb4': ['a hardware check (no Microverb 4 is connected; mapped from the C4C v1.02 image and checked against its simulator)'],
  'alesis-midiverb4': ['a hardware check (no MIDIVerb 4 is connected; mapped from the v1.04 image and checked against its simulator)'],
  'alesis-midiverb3': ['a hardware check (no MIDIVerb III is connected; mapped from the v1.01 image and checked against its simulator; parameter names from the Alesis manuals, the firmware has none)'],
  'alesis-quadraverb': ['a hardware check (no Quadraverb is connected; mapped from the v1.07 image and checked against its simulator)'],
  'alesis-quadraverb-gt': ['a hardware check (no Quadraverb GT is connected; mapped from the v1.03 image and checked against its simulator)'],
  'alesis-quadraverb-plus': ['a hardware check (no Quadraverb Plus is connected; mapped from the v2.03 image and checked against its simulator)'],
  'alesis-wedge': ['a hardware check (no Wedge is connected; mapped from the W1 v1.02 image and checked against its simulator)'],
  'art-multiverb-alpha2-se': ['a hardware check (no Alpha 2 SE is connected; mapped from the v1.03 image, its display, recall, store and bit-packing routines run in a Z80 emulator for all 404 ROM presets and every configuration, and checked against its simulator)'],
  'art-multiverb-alpha-se': ['a hardware check (the catalog\'s v1.04 entry of the Alpha 2 SE, same editor: see art-multiverb-alpha2-se)'],
  'art-multiverb-alpha2': ['a hardware check (no Alpha 2 is connected; mapped from the v2.02 image, its display, recall and packing routines run in a Z80 emulator, and checked against its simulator)'],
  'rocktron-intellifex': ['a hardware check (no Intellifex is connected; mapped from the LTD v1.0 image and checked against its simulator; dumps start on the unit, no requests exist)'],
  'viscount-efx10': ['a hardware check (no EFX-10 is connected; mapped from the v1.02 image: every edit page of the 27 algorithms and the MIDI EDIT EXC. parser run in an 8051 emulator, checked against its simulator; dumps start on the unit, no requests exist)'],
  'kurzweil-k2000': [
    'a Head Library translator for programs (layers, keymaps and the DSP algorithm to and from the shared model)',
    'program settings in the Head Library listed parameter by parameter, not by object',
  ],
  'oberheim-matrix1000': [
    'a hardware check (no Matrix-1000 was connected)',
    'master bytes 0, 15-16, 21-30, 33 and 162-163 are kept without names; the doc should show the firmware never uses them',
    'the velocity curve values 0-3 are numbers without the curves\' names',
  ],
  'roland-jp8000': [
    'a hardware check (no JP-8000 was available)',
    'system bytes 12h-16h are typed values: no menu of either firmware shows them (the owner\'s manual address map would name them)',
  ],
  'roland-jv2080': [
    'preset and expansion-board rhythm sets cannot be chosen for part 10 (only the performance\'s own and the two user sets), and part 10 offers patches instead of rhythm sets',
    'performance common 40h, part 14h-19h and system 28h-61h are labelled from the XP keyboards\' format with "Unknown" for several',
    'wave lists offer boards and PCM cards that are not installed; board rhythm set names are not parsed from the board ROMs; data cards were never tested',
  ],
  'roland-vsynth-xt-vc2': [
    'the modulator waves 0-127 have no names (what each number plays is unknown)',
  ],
  'novation-supernova2': [
    'read-only bytes without a name (1E 9-12, panel button states, performance 16 and 19, 1B 5: the firmware evidence is in the doc), the Keyboard External Parts Tx option bits and stream bytes (docs/devices/novation-supernova2.md)',
  ],
  'novation-supernova': [
    'a hardware check (no SuperNova was available; mapped from its OS 4.1 image)',
    'the SuperNova II read-only bytes it shares (program panel states)',
  ],
  'novation-nova': [
    'a hardware check (no Nova was available; mapped from its OS 4.1 image)',
    'vocoder bytes 5 and 8-15 read-only without a name',
  ],
  'novation-nova2': [
    'a hardware check (no Nova II was available; mapped from its Keyboard OS 2 image on the SuperNova II editor)',
    'the SuperNova II open items it shares (read-only bytes, External Parts Tx option bits)',
  ],
};

/** 'Full editor' | 'Mapped from firmware' | 'Generic MIDI' | 'No MIDI' for a registry device entry. */
export function editorLevel(d) {
  if (FULL[d.id] && (d.hasModule || d.hasDef)) return 'Full editor';
  if (d.hasModule || d.hasDef) return 'Mapped from firmware';
  return d.openable ? 'Generic MIDI' : 'No MIDI';
}

export const isFullEditor = (d) => editorLevel(d) === 'Full editor';
