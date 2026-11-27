// How complete each editor is: the one place that says which editors are "Full editor".
// tools/device_status.mjs (docs/devices/STATUS.md), tools/firmware_checklist.mjs (through STATUS.md)
// and the device picker read it. An editor that is not listed in FULL is "Mapped from firmware" while
// it has a module or definition; MISSING says what each of those still lacks.
//
// Reviewed 2026-11-25 against the code, the tests and the docs (docs/devices/*.md, intdocs/FUTURE_WORK.md).

/** What a full editor has (checked in this order). */
export const CRITERIA = [
  'Every byte of every object the device sends or keeps (sounds and settings) is a named parameter with the label, range and option list the firmware or manual gives; no "Byte nnh", spare or unknown fields, unless the doc shows the firmware never displays or uses them.',
  'Every object reads and writes: the edit buffers, every memory bank (store and fetch), names, and the Branch Library\'s complete dump.',
  'Checked on the hardware, or a documented reason it cannot be that the firmware analysis covers.',
  'Every sound object (patch, program, performance, combination, rhythm set...) has a Head Library translator (obj.toCommon / obj.fromCommon) with tests.',
  'A multitimbral device has its MIDI channels page.',
  'What is left open in the device doc and intdocs/FUTURE_WORK.md is a convenience, not missing data, an unchecked mapping or a missing object.',
];

/** Full editors, each with the evidence. */
export const FULL = {
  'korg-m1': 'every byte of programs, combinations, global and drum kits named from the M1R v1.06 firmware (cross-checked with the M1 keyboard rev 19 OS); checked on an M1R, which uses the same messages; program and combination translators; MIDI channels page',
  'korg-m1r': 'same editor as the M1: every byte named from the v1.06 firmware, checked on an M1R; program and combination translators; MIDI channels page',
  'roland-jp8080': 'every byte named from OS 1.04 and checked on a JP-8080 (presets, motions, complete dump); RPS patterns have no SysEx (tested); patch and performance translators; MIDI channels page',
  'roland-vsynth-xt': 'V-Synth engine: every system and patch parameter from OS 2.02, checked on a V-Synth XT (dumps, .p00 files, waves); translator; MIDI channels page',
  'roland-vsynth-xt-vc1': 'VC-1 (D-50) engine: every byte of the 448-byte patch from OS 2.02, checked on the XT (bank select, .P10 files); translator',
  'roland-vsynth-xt-vc2': 'VC-2 (Vocal Designer) engine: every byte of patch, system and sampling templates from OS 2.02 (the VC-2 application run in an emulator, 16 factory .p02 files matched against the unit), the modulator waves by name in the order the VC-2 lists them (value = wave number + 82, mod 128); checked on the XT (whole patches, single parameters, algorithms and their INIT PATCH, bank select, a Store); translator',
  'novation-supernova': 'every byte named from its OS 4.1 image (menus, handlers); panel pages and part mutes found by running the OS in an H8/300H emulator (tools/novation/h8); the read, send, store and recall of programs and performances checked byte for byte against its own receiver and transmitter, validated in an emulator of its OS, not on hardware; translator; MIDI channels page',
  'roland-jp8000': 'every byte of system, performance and patch named from OS 1.05 and the JP-8000 owner manual address map (system 12h-16h: Factory Preset Menu and Bulk Dump Menu with the two utility page lists, Keyboard Shift, Ribbon Relative, Ribbon Hold); OS 1.05 run in an H8/300H emulator: 42 checks of the editor messages against its own receiver and transmitter (live edits, whole objects, user memory store and recall, presets, motions, RPS patterns, complete dump restored byte for byte), validated in an emulator of its OS, not on hardware; shared code checked live on a JP-8080; patch and performance translators; MIDI channels page',
  'roland-system8': 'every byte of patch, patch2, patch3, performance and the setup block named from the OS 1.32 parameter catalog (OS dumped from the unit; coverage test) and the engine lists of its region 0; checked on the unit over SYSTEM-8 CTRL: temporary patch and performance live edits, store, read back and recall in SYSTEM-8 and PLUG-OUT 1-3 and the performances, complete dump and slot backup equal byte for byte to a raw backup, a PLUG-OUT install from the editor (JUNO-106 into PLUG-OUT 3); the unit keeps no SysEx write into user memory over a power cycle (checked twice, also a bank between the patch-bank brackets as the Roland plugin sends it; a device limit, the editor says to save with WRITE on the unit); the SYSTEM menu has no SysEx address (OS catalog); DIN parameter SysEx unchecked (no DIN cable); patch and performance translators; parts page',
  'roland-system8-jupiter8': 'JUPITER-8 patch struct named from its region 0 image (pages, labels, lists) and its plugin script, effects, chord memory and step sequencer from the OS catalog; checked on the unit in PLUG-OUT 1 (read, live edit, store, recall, store back, each read back identical; stores last until power-off as on the SYSTEM-8 itself, the editor says so); the 64 patches of the unit decode in range; translator',
  'roland-system8-sh101': 'SH-101 patch struct named from its region 0 image (pages, labels, lists) and its plugin script, effects, chord memory and step sequencer from the OS catalog; checked on the unit in PLUG-OUT 2 (read, live edit, store, recall, store back, each read back identical; stores last until power-off as on the SYSTEM-8 itself, the editor says so); the 64 patches of the unit decode in range; translator',
  'roland-system8-juno106': 'JUNO-106 patch struct named from its region 0 image (pages, labels, lists) and its plugin script, effects, chord memory and step sequencer from the OS catalog; checked on the unit in PLUG-OUT 3 (read, live edit, store, recall, store back, each read back identical; stores last until power-off as on the SYSTEM-8 itself, the editor says so); the 64 patches of the unit decode in range; translator',
  'roland-jv2080': 'every byte of system, performance, part, patch, tone and rhythm named from the v1.02 firmware screens and option lists and, for the JV-1080 / XP-80 bytes, from the address map in the owner manual (what the firmware stores and uses is in the doc); preset rhythm sets decoded from the flash and equal to the Roland dumps, board rhythm sets from the board ROMs (named JV rhythm by the firmware); part 10 chooses rhythm sets; checked on a JV-2080 (blocks, presets, store, part patches, boards, all ten preset and both user rhythm sets on part 10, the JV-1080 bytes stored or not as found in the firmware, restored byte for byte); data cards untested (none available); patch, performance and rhythm set translators; MIDI channels page',
  'oberheim-matrix1000': 'every byte of the patch and all 172 master bytes named from the OS 1.11, 1.13 and 1.14 images: the master bytes the 1000 only keeps carry the Matrix-6R and Matrix-6 master menu names (VEL SCALE = LIN, EXP1, EXP2; VEL SENS, SYSTEMX, LOCAL CTL, PED2 INV, LEVS INV, SET DISP, SQUICK, PMAP ECHO, STEREO, BASIC CHAN, STANDOFF, SPILLOVER, PATCH MAP), their non-use shown from every ROM reference and from read watches in the emulated OS (the 1000 never calls its velocity curve code); bytes 0, 30, 161, 162 and the channel copy 163 typed with their use; group mode bits as per-patch bytes; the OS and factory patch ROM run in a 6809 emulator: 30 checks of the editor messages against its own receiver and transmitter on 1.11, 1.13 and 1.14 (live edits, whole patches, stores, writes, recall, memory protect, group mode store, ROM banks, every master parameter, complete dump with all 1000 patches in range and a bank restored), validated in an emulator of its OS, not on hardware; the two remote edits broken in 1.11 (29, 53) sent as the whole edit buffer; patch translator; not multitimbral',
  'yamaha-dx7': 'every voice and function byte named from the v1.8 firmware (parameter and label tables, value texts) and Yamaha voice format, checked against the 128 factory ROM voices; the v1.8 OS run in an HD6303 emulator (tools/yamaha/check_editor.mjs): 17 checks of the editor messages against its own receiver and transmitter (every voice parameter as live edits and whole voices at both range ends, rename, store into the internal memory, all 32 voices unpacked by the DX7 equal to the editor, the voice it sends on program change, MIDI TRANSMIT of the 32 voices, a panel edit, every function parameter, SYS INFO AVAIL and memory protect refusals), validated in an emulator of its OS, not on hardware; cartridge voices not emulated; voice translator; not multitimbral',
  'access-virus-ti2': 'every byte of singles, multis and remote templates named from the TI2 host OS 5.1.7 and Virus Control 5.1.7 (value lists in the screen\'s texts, order and ranges; reserved bytes with the OS evidence; template records tied to the panel knobs from the OS knob table); checked on a TI2 Desktop (edit buffers, RAM/ROM banks, stores to RAM A 001 and multi 001, a template write, each restored byte for byte); globals sent only (the OS has no global request); single and multi translators; MIDI channels page',
};

/** What each editor that is not full still lacks. */
export const MISSING = {
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
  'roland-system8-jx3p': ['a hardware check: this PLUG-OUT is not installed on the unit (same code as the three engines checked live; it can be checked by installing it from the Branch Library)', 'stores over SysEx last only until power-off, as on the SYSTEM-8 itself'],
  'roland-system8-juno60': ['a hardware check: this PLUG-OUT is not installed on the unit (same code as the three engines checked live; it can be checked by installing it from the Branch Library)', 'stores over SysEx last only until power-off, as on the SYSTEM-8 itself'],
  'roland-system8-jupiter4': ['a hardware check: this PLUG-OUT is not installed on the unit (same code as the three engines checked live; it can be checked by installing it from the Branch Library)', 'stores over SysEx last only until power-off, as on the SYSTEM-8 itself'],
  'roland-system8-promars': ['a hardware check: this PLUG-OUT is not installed on the unit (same code as the three engines checked live; it can be checked by installing it from the Branch Library)', 'stores over SysEx last only until power-off, as on the SYSTEM-8 itself'],
  'roland-system8-sh2': ['a hardware check: this PLUG-OUT is not installed on the unit (same code as the three engines checked live; it can be checked by installing it from the Branch Library)', 'stores over SysEx last only until power-off, as on the SYSTEM-8 itself'],
  'roland-system8-system100': ['a hardware check: this PLUG-OUT is not installed on the unit (same code as the three engines checked live; it can be checked by installing it from the Branch Library)', 'stores over SysEx last only until power-off, as on the SYSTEM-8 itself'],
  'alesis-quadraverb2': ['a hardware check (no Quadraverb 2 is connected; mapped from the v2.01e image and checked against its simulator)'],
  'digitech-dsp256': ['a hardware check (no DSP-256 is connected; mapped from the v1.05 image: every edit page of the 27 configurations and every utility page run in an HD6303 emulator for every value, requests and dumps fed through its MIDI receiver and checked against its simulator)', 'the 01h program request jumps to RAM 0042h in v1.04 and v1.05, so the editor reads programs from the whole-memory dump instead'],
  'digitech-meq': ['a hardware check (no MEQ is connected; mapped from the v1.06 image, one firmware for the MEQ 28, MEQ 14 and MEQ 7: booted for each model in an HD6303 emulator, the display texts of every value read back through its own 7-segment font, the LED column of every band value, requests, program and memory dumps, program and control changes fed through its MIDI receiver and checked against its simulator)', 'the band names (frequencies) come from the DigiTech MIDI implementation manual, as the unit shows bands only as LED columns; the model is chosen in the editor or taken from a message of the unit', 'the MEQ 28 keeps programs 1-7 in a serial EEPROM that no MIDI message carries, and the 01h request one program of the manual restarts a v1.06 unit (never sent)'],
  'digitech-dsp128plus': ['a hardware check (no DSP-128 Plus is connected; mapped from the v2.00 image: every page of the 15 configurations run in an HD6303 emulator for every value with the display font replaced so the 4-character texts read back exactly, the MIDI pages likewise, requests, whole and cut memory dumps, program and control changes fed through its MIDI receiver and checked against its simulator)', 'the unit has no single-program or edit-buffer message: edits write programs 1 to n through a memory dump cut after program n, so programs after 1 need the memory read first', 'which of the two key panels in the firmware the unit has, and the expansion ROM socket at 6000h'],
  'digitech-dsp256xl': ['a hardware check (no DSP-256XL is connected; mapped from the image archived as 1.08, whose version page says 1.04: the DSP-256 software rebuilt, every edit page of its 28 configurations and every utility page run in an HD6303 emulator for every value, the Room Simulator decay texts for every room size, requests and dumps fed through its MIDI receiver and checked against its simulator)', 'the 01h program request jumps to RAM 0042h as in the DSP-256, so the editor reads programs from the whole-memory dump'],
  'lexicon-lxp1': ['a hardware check (no LXP-1 or MRC is connected; mapped from the v1.06 image: the LXP-1 has no display, so names and value texts come from the display routines of the Lexicon MRC v4.00 remote firmware run for every fader step in a Z80 emulator; requests, dumps and parameter messages answered byte for byte as the LXP-1 firmware answers them in the emulator, checked against its simulator)', 'the MIDI channel and Omni are set on the panel only (no message reads or sets them)'],
  'lexicon-lxp15': ['a hardware check (no LXP-15 is connected; mapped from the v2.00 image: every page of the five algorithms worked on the panel in a Z80 emulator, value texts from the display routines of the firmware, requests answered byte for byte as the firmware answers them, checked against its simulator)', 'the patch Scale and Offset texts in the units of the patch destination (the editor shows the no-destination percent)'],
  'lexicon-lxp5': ['a hardware check (no LXP-5 or MRC is connected; mapped from the v1.12 image: the LXP-5 shows only a program number, so names and value texts come from the display routines of the Lexicon MRC v4.00 remote firmware run for every value and every delay coarse and FINE pair in a Z80 emulator; requests, dumps and parameter messages answered as the LXP-5 firmware answers them in the emulator, checked against its simulator)', 'parameters 41h and 43h-45h and the byte after the name have no name on any screen'],
  'viscount-efx10': ['a hardware check (no EFX-10 is connected; mapped from the v1.02 image: every edit page of the 27 algorithms and the MIDI EDIT EXC. parser run in an 8051 emulator, checked against its simulator; dumps start on the unit, no requests exist)'],
  'kurzweil-k2000': [
    'a Head Library translator for programs (layers, keymaps and the DSP algorithm to and from the shared model)',
    'program settings in the Head Library listed parameter by parameter, not by object',
  ],
  'novation-supernova2': ['the SuperNova II Keyboard MIDI stream: External Part bytes 14-15 (except 15 bit 0) and message 20 part-block bytes 19 and 21-32 are typed values; only the first stream byte is placed (NRPN 122 MSB 96/104 + part); the Rack ignores them'],
  'novation-nova': ['vocoder bytes 5 and 8 (message 1B) read only without a name: sent as stored, no writer or reader found (bytes 9-15 are cleared by its transmitter)', 'a hardware check (validated in an emulator of its OS, not on hardware)'],
  'novation-nova2': ['the MIDI stream bytes it shares with the SuperNova II Keyboard', 'a hardware check (validated in an emulator of its OS, not on hardware)'],
};

/** 'Full editor' | 'Mapped from firmware' | 'Generic MIDI' | 'No MIDI' for a registry device entry. */
export function editorLevel(d) {
  if (FULL[d.id] && (d.hasModule || d.hasDef)) return 'Full editor';
  if (d.hasModule || d.hasDef) return 'Mapped from firmware';
  return d.openable ? 'Generic MIDI' : 'No MIDI';
}

export const isFullEditor = (d) => editorLevel(d) === 'Full editor';
