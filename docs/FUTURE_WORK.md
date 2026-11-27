# Future work

Requests and ideas not finished yet. Each item says what is wanted and what is known so far.

## Hand-off (2026-11-23)

All work was stopped on 2026-11-23. Nothing is running: no agents were active in this session,
and no file in the repo or in `re/` has changed since 2026-11-20 11:41. `git status` is clean
at `0952c20`, and `npm test` passes (38 tests). `re/` is gitignored, so the firmware images,
Ghidra projects and RE scripts there exist only on this disk. Back that folder up before
cleaning it.

Rules that apply to every device (from the user's standing feedback):

- **Map every value from the firmware's screen strings.** Trace each MIDI byte to the label,
  range and option list the device shows while editing it. Use related firmware (other OS
  versions, sibling models) when the meaning is easier to find there. "Byte nnh" / "not mapped"
  is not an acceptable end state. A byte can be called unreachable only after showing that the
  firmware never displays or uses it, and the doc must say how that was shown.
- **Exact values, not knobs.** Dropdowns (named where possible) for IDs, banks, numbers,
  channels and sources. Typed number inputs for raw values. Knobs only for continuous amounts.
- **Multitimbral devices get a MIDI channels page.** Add the `multi` hook (spec in
  `js/devices/generic/views/multi.js`) and make sure the "MIDI channels pages" test in
  `tests/devices.test.js` covers it.
- **Live checks use edit buffers only.** Capture the unit's current state before probing and
  restore it afterwards. Never write memory (stored patches, globals) without asking the user.
- **Every new device needs a translator** (core functionality, user's rule of 2026-11-23): each
  object that holds a sound gets `obj.toCommon` / `obj.fromCommon` (the shared synth model,
  `docs/HEAD_LIBRARY.md`) with a round-trip test. The test "Every device definition translates its
  sounds" fails without it; its backlog only shrinks.

### Novation SuperNova II (2026-11-25)

Registered and usable: `js/devices/defs/novation-supernova2.js` (+ `-fw.js` option lists,
`-translate.js` translator), documented in `docs/devices/novation-supernova2.md`, tested in
`tests/novation-supernova2.test.js` (messages, the unit's dumps rebuilt byte for byte, every global
bit named, simulator, MIDI channels page, shared model). Checked on the Rack (`2- SuperNova`,
OS 2.0, global channel 16), also in Chrome (pages read the unit's program, performance and global
byte for byte; Send to SuperNova round-trips); everything touched was put back and compared byte
for byte, except Memory protect, which is in no dump (a probe left it On; its earlier state is
unknown).

Done on 2026-11-25:

- **Global: every bit named.** All global NRPNs/CCs were sent to the unit and read back
  (`re/sn2/work/globprobe.py`): power-up sound (0F 10-14), local control, breath mode/sensing,
  input/pedal switches, gains, vel sensing, knob mode, Tx flags, Sysex Tx delay, display time, user
  pattern bank, digital I/O card settings; Sysex transmission/reception with the firmware's
  stored-value permutation (62/25 choices); arp transpose channel 7Fh = Off. The constant bytes
  (15 4-11, 24-25, 28-31) and unused bits are shown read-only with the firmware evidence. Memory
  protect is not in the dump (RAM 34666): two buttons set it. A firmware bug (message 15 byte 2 ORed
  into the wrong RAM byte) is worked around after **Write global settings**.
- **Program/performance spare bytes**: program-mode arp speed (239), latch (247) and arpeggiator
  (250), constant gate (237 bit 3), program-mode vocoder input (249 bit 1), the digital-input
  extensions (1E 33-36, 71, part block 15), the part's own arp bank/pattern (part block 34/35),
  transmitter-cleared bytes (1E 42-55, 76-87; part block 38-39; 20: 454-463), and the Keyboard's
  External Parts / transpose zone (20: 320-453, from the Keyboard OS 2.0). A program-mode sweep of
  every CC, packed NRPN value and NRPN 120/122 MSB (`progsweep.py`) found the program-mode bytes.
- **Translator** for programs and performances (exact between SuperNova IIs).
- **Memory protect Off** on the unit (the user's normal setting), proven by an accepted global write.
- **Arp patterns page** (2026-11-25, later): user patterns (edit buffer 0A/0D, banks U/V/W via
  13/22) in a step grid with note, velocity and gate (Rest/Tie/Norm/Glide from the setters at
  D16C/D1D2); read, edit-buffer send and restore checked on the unit.
- **Rack / Keyboard**: a Model choice on the Global and Performance pages hides the Keyboard-only
  settings on a Rack.
- **SuperNova, Nova, Nova II** (later on 2026-11-25), from Novation's OS-update files in
  z:\firmwares (the complete set Novation published: no Nova II rack/desktop OS, no SuperNova
  keyboard OS, one Nova OS for the desktop and the Laptop). `tools/novation/os_mid.py decode` turns an
  update into its image (format from the loader at 000E1C of the Keyboard OS 2.0; the SuperNova II
  Keyboard update decodes to its EPROM byte for byte); images in `re/novfw/` (not in git), RE scripts
  in `re/novwork/` (menu records, handler-table comparison, factory data).
  - **SuperNova** (model 20, OS 4.1) and **Nova** (model 21, OS 4.1, 6 parts, vocoder 1B/1C) on one
    builder `novation-os4.js`: message types and lengths from their receivers, program bytes from
    the controller map and setters (identical to the SuperNova II's except CC 9, NRPN 102), labels
    and lists from their menus, Nova-only Expression pedal, Pedal mode, Headphones out, Trim1/2,
    Constant gate. Docs `novation-supernova.md`, `novation-nova.md`; tests
    `tests/novation-supernova.test.js`, `tests/novation-nova.test.js`.
  - **Nova II Keyboard** (model 23): the SuperNova II definition with model 23 (`novation-nova2.js`,
    `docs/devices/novation-nova2.md`): same formats and setters, no digital I/O card, banks A-D /
    a-d / A-B / U-V, 6 parts.
  - **SuperNova II**: part byte 10 bit 5 (the Nova's Expression pedal) and global 15 13, 24, 25 (the
    Nova's Headphones out, Trim1/2) explained; the panel-state bits of 19-21 traced to the button
    table; factory-data evidence for the rest; Keyboard-only External Parts and transpose zone get
    the Keyboard OS 2.0 menu displays. One edit-buffer-only live test (part mute vs byte 19),
    restored and verified byte for byte; Memory protect untouched (Off).

Left to do:

Done in the follow-up (2026-11-25, late): readers searched in all eight images (SuperNova II Rack
1.3/1.5/2.0, Keyboard 1.5/2.0, Nova II, SuperNova/Nova 4.1). **238 bits 0-1 = Polyphony** (program
mode, menu "polyphony", setter E590) is now named; the panel states (19 bits 0-2, 20 bits 0-3, 21
bits 0-1, 237 bits 4-6), 1E 9-12 (new-program values 64/60/36/76), performance 16/19, 1B 5 and the
all-zero bytes are read-only with their evidence (no more typed "spare" fields). **Nova II: 6
External Parts** (NRPN 120 handlers for parts 1-6 only; 7-8 read-only). **Arp patterns page** for the
SuperNova and Nova (OS 4.1: SuperNova II format, bank U, the SuperNova II's generic step-grid page);
the generic step grid got named bar values (Gate: Norm/Tie/Rest/Glide), checked in Chrome on the
Rack (typed "rest"/"glide" reached the edit buffer; restored byte for byte). **Nova message 1D**:
copy program banks A-B to C-D and performance bank A to B, once (Global page action).

Left to do:

1. **SuperNova II read-only bytes without names**: 1E 9-12 (next: the voice engine's pointer-based
   reads of the OS 2 block), the panel states (need the panel layout for the button numbers),
   performance 16 (always 2Fh) and 19, 1B 5.
2. **Keyboard**: the External Parts' Tx option bits and stream bytes, byte 448, the transpose zone
   switch (typed values): the Keyboard NRPN 120 MSB 16-111 handlers fall through into each other and
   need tracing field by field.
3. **SuperNova / Nova / Nova II**: no unit to check anything; category User 1-5 numbering in the Main
   Library; whether the Nova's banks C-D can be read over MIDI.
4. SuperNova II units on OS 1.x are out of scope (the user's decision).

### Roland JP-8080 and JP-8000 (2026-11-23)

Both editors share `js/devices/defs/roland-jp.js`; each model is a config file
(`roland-jp8080.js`, `roland-jp8000.js`) with generated tables (`tools/roland/jp8080_fw.py` builds
both). The Motion page is `roland-jp8080-motion.js`. Docs: `docs/devices/roland-jp8080.md` and
`roland-jp8000.md`. Tests: `tests/roland-jp8080.test.js` and `roland-jp8000.test.js`.

**The JP-8080** was checked on the unit (`MIDI (OCTA-CAPTURE)`, device ID 10h): every byte named,
the preset banks, motion read, rebuild and write. RPS patterns have no SysEx in OS 1.04 (tested),
so they are not in the editor.

The Motion page draws motions with the mouse (freehand, line, erase, shape fill), and the
Branch Library's **Complete dump** reads everything (checked: 89 KB in 147 s).

**The JP-8000** is built from its OS 1.05 firmware and the shared code. It was not checked on a
JP-8000, because none was available.

2026-11-25: the JP-8080 is finished. Its pages were checked in Chrome with the unit (data equal to
a fresh read byte for byte; the two "Metronome" settings labelled pattern / motion recording), and
the motion length is traced: ticks are MIDI clocks (96 a measure), the loop point is Loop Length x
96, a motion is Loop Length x 96 + 192 + 9792 ticks (the unit's empty tail), and the Motion page
now shows and draws the loop. See `docs/devices/roland-jp8080.md`, "Time and length".

Left to do (JP-8000 only):

1. **JP-8000 system 12h-16h** are shown as typed values. No menu of either firmware shows them;
   the JP-8000 owner's manual (address map) would name them.
2. **A JP-8000 hardware check** when one is available.

### Roland V-Synth XT (2026-11-23)

V-Synth engine done and checked on the unit (`2- VSynth`): see `docs/devices/roland-vsynth-xt.md`.
Every system and patch parameter (16 zones, effects named per type), whole-patch reads with one
RQ1, the 512 user patches with bank select 87/0-3, the 16 categories, and a translator: a JP-8080
patch sent through the Head Library played back exactly on the unit.

2026-11-24: the **VC-1 (D-50)** and **VC-2 (Vocal Designer)** engines are devices of their own
(`roland-vsynthxt-vc1.js`, `roland-vsynthxt-vc2.js`) with translators; D-50 SysEx files import as
VC-1 patches (one-way DT1 or handshake DAT); the 384 factory D-50 patches in the VC-1 image are
test data. Both were checked on the unit (VC-1 edit buffer; VC-2 with writes allowed by the user,
everything put back): the VC-2 turned out to use its own model 00 00 0D and map (rebuilt from its
MIDI implementation, value names from its screens), with per-algorithm locks, user banks at bank
select 87/1-4 and no split multi-nibble values. The undocumented SysEx is mapped (model 00 24 file
access, device-7E mode commands, VC-1 model 00 11 DSP access, VC-2 models 00 6D / 00 4D: unused on
the XT); model 00 24 reads wave names in V-Synth and VC-2 mode (**Read wave names** action).

2026-11-24 (later): device 7E is the factory-test remote (0-2 = Digital Output Frequency, offered
as a write-only button; 3/4 flash the coaxial sampling screen); model 00 24 writes checked (kind 1
puts a wave on OSC 1/2 and sets PCM; kind 4 holds the name the XT shows); the 55 + 71 effect value
lists the firmware computes come from its own display routine run in Ghidra's emulator; `.p00`
patch files are read and written (Open/Save on the Patch page, Head Library import, whole drive
images) and VC-1 `.P10` banks import.

2026-11-25: the **VC-2 is mapped completely**. Its address descriptors, built by the firmware at
start-up, were produced by running that code in Ghidra's emulator; they give every parameter its
algorithm group and firmware parameter. Per algorithm, the groups, wave ranges and INIT PATCH (what
choosing an algorithm loads) were checked on the unit. `.p02` files are read, written and imported
(all 208 values placed, checked on 16 factory files). The editor hides what the algorithm does not
use and offers the waves by name. Every parameter is in
`docs/devices/roland-vsynth-xt-vc2-params.md` (generated by `tools/roland/vc2_doc.mjs`).
**Head Library → device**: "Send to the <model>..." on the Head Library page (one patch, ticked
patches, a sub-library or search results) and in a Branch Library's Head Library panel loads into the
editor, sends to the edit buffer or stores into consecutive slots, translating other models.

2026-11-25 (later): the user checked on the unit that saved `.P10` and `.p02` files load, a copied
WAV works and VC-1 bank select works. The VC-1 bank list now reads Internal 1-8 / Preset 1-6 (slots
Int1-11 ... Pre6-88 as on the unit), the preset names come from the firmware (the factory patches
in order), Edit of a patch in another bank selects it and reads the temporary patch, Play reads the
newly selected bank's names, and the current bank is identified on connect from its names.
**Names are remembered** per device (`js/devices/generic/namecache.js`, localStorage key
`midimaster.names.<device>.<ID>`): lists show them at once (muted until read again), they are read
again on connect, and a toast lists any that changed. Wave names too (Read wave names, which now
stops at the end of the XT's table of loaded waves). `tools/browser/cdp.mjs --tab <text>` lets two
sessions share the test Chrome (the SuperNova II work uses `?tab=sn2`).

Left to do (details in the device doc's Open items):

1. **On the unit**: when does the XT load a WAV copied onto the drive (its name only answers once
   loaded). (VC-1 SysEx patch memory does follow bank select: checked 2026-11-25. The V-Synth OSC
   wave lists offer every number 1-500, unnamed ones as user samples.)
2. The rest of the user-sample chunks (loop, Variphrase data); names for the VC-2 modulator waves.
3. **Browser check** of the VC-1 page's new bank handling and of loading Head Library patches from
   its Branch Library (the user used the VC-1 page on the unit; the V-Synth and VC-2 pages were checked
   in Chrome on the unit, 2026-11-24/25, with `tools/browser/cdp.mjs`: Chrome with
   --remote-debugging-port and its own profile; no packages).

Audition keyboard (2026-11-24): the test patterns come from `js/core/patterns.js`: chord
progressions (1-5-6-4, 1-6-4-5, 6-4-1-5, 2-5-1 with sevenths, Canon, Andalusian, circle of
fifths, 12-bar blues, a 1-4 vamp, a tour of several), arpeggio, bass line, melody (seeded, one per
setting), a band of chords, bass and melody with or without GM drums, scale runs and glides, in any
key and 11 scales (Key / Scale / Progression menus on the keyboard bar).

## All devices: complete dump (2026-11-23)

The Branch Library's **Complete dump** (`js/devices/generic/fulldump.js`) sends a definition's
`fullDump` requests in turn and saves the replies:
- **Entries:** each bank of sounds is an entry of its own; the rest goes together into one entry.
- **Panel dumps:** devices without mapped requests record a front-panel "dump all" instead; the K2000 keeps its own "Back up all RAM".

Since 2026-11-26 a dump (and a recording) is a background job of the device (`js/devices/generic/dumpjob.js`):
- **Pages:** it goes on while other pages of the device are shown. The Branch Library page shows it again when opened, and the busy line at the top leads there.
- **Saving:** it saves itself and says so in a message.
- **Requests:** while it runs, other pages' requests wait (the client's `hold`).
- **Replies:** each step records only its own replies (`accept`).
- **Pace:** requests use the pace measured on the Connect page, or the DIN-MIDI default. The dialog says which one.
- **Leaving:** leaving the device asks first, and keeps what has arrived.

| Definition | Complete dump | Checked on hardware |
|---|---|---|
| JP-8080 | System, temporary areas, all user memory, motions | Yes: 821 messages, 89 KB, 147 s, 200 items |
| JV-2080 | System, temporary patch and performance, user patches, performances, rhythm sets | Yes: 1360 messages, 115 KB, 84 s, 165 items |
| M1 / M1R | All Data plus the program being edited | Yes (M1R): 50 KB, 20 s |
| Matrix-1000 | Edit buffer and banks 0-9, then the bank unlocked | No unit connected |
| SuperNova II | Current performance (with its 8 programs), global, Total data | No (registered 2026-11-25) |

Requests that come back through MIDI thru (seen on the JV-2080 setup) are left out of the dump.

## Head Library (2026-11-23)

Built as planned; see `docs/HEAD_LIBRARY.md` for the format, folder layout and definition hooks.
It has a global page (`#/library`, "Head Library" in the sidebar), a panel in every device's
Branch Library, and K2000 buttons on its Library page. Imports read `.syx .mid .j8k .pat .pfm .krz/.k25/.k26
.wav .json` and disk images. Translation between models: every definition has its translators
(2026-11-25); the K2000 program translator is still to do (item 2 below).

### Equivalent features and open choices (proposal, 2026-11-26)

The user: some sounds have several names for the same thing (a Roland Super Saw is an Access HyperSaw
is a "Union Saw"); a translation that is not 1:1 should ask, or allow None to decide later. Today each
translator maps its own names to the shared model's canonical ids (`supersaw` already covers Super
Saw and HyperSaw), so equal features do meet, but the tables live in each translator and nothing asks.
Proposed:
1. **One alias table** (`js/core/mainlib/aliases.js`): canonical ids (oscillator shapes, filter types,
   effect kinds, LFO waves...) with each maker's names and a one-line description. Translators look
   names up there instead of private tables; the translation report shows "Super Saw -> HyperSaw
   (the same feature)".
2. **The user's own equivalences**: an "Equivalents" page on the Head Library page to group names
   ("Union Saw" = supersaw), stored in the library folder (`aliases.json`) so they travel with it.
3. **Open choices**: a translator returns `choices` for values without a 1:1 target
   (`{what, wanted, options, suggested, param}`). The load / send dialog lists them, each a list with
   the suggestion first, the other targets, and **"None (decide later)"**. None keeps the target's
   initial value and records `pending: [{what, wanted}]` in the result; the editor and the Head
   Library show a badge ("2 open choices") until the user sets them. "Always use this" adds the
   pair to the equivalences.

Checked in Node with real files from `D:/midi` and `re/jp8080/live`: the JP-8080 and JV-2080
complete dumps, the Alan M and AZS Eternal sets in all their formats (byte for byte against each
other), KRZ audio exact to the sample, and the TR909 KRZ. The page and the panel ran on a fake DOM
(`tests/mainlib-ui.test.js`). **Nothing has run in a browser yet.**

Two bugs were found and fixed on the way: the importer read dropped Files as empty (current
browsers give every File a `bytes()` method), and stored KRZ audio was silent (`writeWav` takes
Int16 samples, it was given floats).

Added the same day, after the user's first look:

- **Duplicates**: "Find duplicates..." by name (groups whose settings differ are flagged and left
  unticked) or by settings (deep scan, names ignored; optionally across models through the
  translator). Checked on the Alan M set in three formats and AZS Eternal as JP-8000 and JP-8080.
- **Merging** sub-libraries, and a **device** on each sub-library (set from the Branch Library it was
  added from, the import's "from" choice, or the only device in the files; editable).
- **The "Other messages" / Suzuki-Dynacord-Digidesign entries**: the device Branch Library stored `.mid`
  imports as whole MIDI files and split them as raw SysEx, so each event's length byte took the
  maker ID's place. Every file reader now uses `sysexMessages`; old entries are read correctly, and
  Head Library data made from them can be fixed with **Re-read SysEx** (select them, it reads every
  data entry of the same file again).
- **Damaged messages** (X-Plorations vol2/vol3 have patches cut short in the files themselves) are
  kept as the JP's data, not as an unknown device.
- **`.zip`** archives, and default names with underscores turned into spaces.
- The JP-8080 table labelled patch byte 0 (the name's first character) "VOCAL MIX"; fixed in
  `tools/roland/jp8080_fw.py` (it was hidden, so nothing showed it).

Left to do:

1. **Browser check (Chrome or Edge)**, with the units connected:
   - choose a library folder; import `D:/midi/jp8080` (drop the folder); the JSON files appear
     on disk with readable `settings`;
   - JP-8080 Branch Library: load a patch, send it, read it back; store one to a user slot;
   - JP-8000 editor: load a JP-8080 patch and read the translation report;
   - JP-8080 **Complete dump**, then **Add to Head Library** on the saved entry;
   - reload the page: **Reconnect folder**, and pending changes are written;
   - **Unregister** a sub-library: it leaves the list and its files stay;
   - **Change location...**, both Move and Open;
   - K2000: **Add to Head Library** with audio, then **Load from Head Library...** into Disk Import;
   - **Find duplicates** (both modes) and **Merge** on a real library; **Re-read SysEx** on the
     "Unknown Suzuki/Dynacord/Digidesign device" entries already in the user's library.
2. **Translator backlog**: done for the definitions (2026-11-25: Matrix-1000 patch, M1/M1R
   program and combination, JV-2080 patch, performance and rhythm set; `tests/translators.test.js`;
   the test's `BACKLOG` is empty). Left: **the K2000 program** (its own module, not a definition):
   `toCommon` from layer 1 (keymap as `rom:<keymap name>` or the RAM keymap's samples, CAL tuning,
   AMPENV and ENV2 times through `envTimeMs`, the algorithm's filter block by DSP function with its
   frequency through `filterCoarseHz`, LFO rates through `lfoRateCentiHz`), set as `common` by
   `k2000Patch` (`kurzweil-k2000/disk/mainlib.js`); `fromCommon` from a one-layer template program
   with a ROM keymap per wave shape, and a translated load path next to `krzFromPatches`.
   Assumptions in the Matrix-1000 translator (Mix and Waveshape direction, detune scale) are listed
   in its doc and need a hardware check.
3. **K2000 program settings** are listed by object (names and IDs of the keymaps and
   soundblocks), not parameter by parameter. Use the program editor's model to fill `settings`.
4. **Load a performance with its patches.** A JP performance's two patches are imported as
   linked patches (`links`), but **Load** puts only the performance into the editor. It should
   also load the linked patches into the upper and lower parts.
5. **M1 all-data dumps** stay one `data` item. Split them into the 100 programs and 100
   combinations (the M1 definition already decodes them on its own pages).
6. **Big disk images** hold every sample's WAV in memory until the import is written. Write
   samples to the folder while importing.
7. **SR-JV80 board audio** (and other ROMplers): decoding the wave ROM so its samples can be
   moved to samplers. ROM waves are matched by name only for now (`rom:<name>`).
8. **WinJPLib byte EFh.** `.pat`/`.pfm` records hold patch bytes 00-EE; byte EFh is filled with
   the default. Check whether anything uses it.
9. **Old `#/library` bookmarks** opened the K2000 library (KEdit2000); that address is now the
   Head Library.
10. **Arturia Jup-8000 V presets** (extension-less files like `BA 303 Style  DC_upper` in the
    Dawnchaser sets: a boost "serialization::archive" text of the plug-in's parameters). Reading
    them needs a translator for the plug-in as its own device. They are skipped for now.
11. **WinJPLib `.PTN`** files (RPS patterns, e.g. `GRAB_BAG.PTN`) are not read.

## Roland JV-2080

- **Only list waves that can sound.** The Tone page's wave lists offered every number for
  every group, including expansion boards that are not installed and PCM card groups. Lists
  should hold the 255 INT-A and 193 INT-B waves, the installed boards' waves, and PCM card
  waves only when a card is known to be in the slot.
- **Names for the internal waves.** Done 2026-11-25: the Tone and rhythm key wave lists name the
  INT-A and INT-B waves from the owner's manual (`roland-jv2080-waves.js`, which existed but was
  not used).
- **Rhythm sets.** The rhythm set page only offered the performance's part 10 and the two user
  sets. The JV-2080 also has two in each preset group (PR-A, PR-B, PR-C, PR-D GM, PR-E), card
  sets, and the expansion boards' sets (1 or 4 per board, from the board ROMs). They are
  selected with bank select and program change on part 10's channel (manual page 184).
- **Part 10 plays rhythm sets.** Choosing a patch for part 10 (MIDI channel 10 by default)
  should offer rhythm sets, not patches. Other romplers have the same kind of drum part; the
  MIDI channels page should know which parts are drum parts.
- **Adding new waves.** The JV-2080 cannot load samples: its waves come from the internal wave
  ROM, SR-JV80 expansion boards and SO-PCM1 PCM cards, all read-only. The DATA card slot holds
  patches, performances and rhythm sets, not waves. New waves would need new hardware: an
  SR-JV80-compatible board (or PCM card) with a ROM image built in Roland's format. The board
  format is mostly understood already (`tools/roland/srjv80_rom.py` unscrambles and parses the
  sample, wave, patch and rhythm tables), so building such an image is possible in principle;
  still unknown are the sample encoding details, the checksum (if any) and the board's chip and
  bus wiring.
- **Board rhythm set names.** The board ROMs hold rhythm sets (count known); their names are
  read from the unit when the bank is scanned, not yet parsed from the ROM.

## All devices

- **Drum demo.** Play a rhythm set or drum kit with a standard 4/4 pattern using the General
  MIDI drum notes (bass drum, snare, low/mid/high tom, rim shot, hand clap, closed and open
  hi-hat, crash, ride), on MIDI channel 10 by default.
- **Reset controllers.** A button on the Controllers page that puts every controller back to its
  default value.

## Korg M1

- **Program names on start.** The program memory names should be read when the M1 connects.

## Access Virus TI 2

Started 2026-11-25 (docs/devices/access-virus-ti2.md). **Done (phase 1):** Virus Control's parameter
description extracted from its DLL (`tools/virus/vc_xml.py`, `gen_fw.py` -> `access-virus-ti2-fw.js`);
the definition (single, multi with 16 parts and the MIDI channels page, global page sent only, RAM/ROM
banks with names, store, Branch Library, simulator); translator; tests; checked on the unit.
**Done (phase 2, 2026-11-25):** the host OS's parameter tables (`tools/virus/os_tables.py` ->
`access-virus-ti2-os.js`): every byte without an OS parameter is a named read-only reserved entry with
the evidence (old format places of moved parameters, controller bytes, reserved), the status bits and
the arpeggiator "Bitfield" named; older formats 8/9/11 converted as the OS does (`upgradeSingle`, checked
on the unit); requests 38-3B decoded (32 remote templates in the complete dump); multi dump into the
edit buffer, a global change (Device ID), stores to RAM A 001 and RAM multi 001 (multis 001-016 are
stored with bank 32h, found in the receiver) checked and restored byte for byte; part names on the MIDI
channels page.
**Done (phase 3, 2026-11-26):** every value list is the OS screen's (`os_tables.py` matches each Virus
Control parameter to its internal parameter by text: `PARAM`, `REORDER`, the range routines at bank 2 BB6D):
screen texts, the screen's order (reordering tables 0-3, 8, 9, 11-13: modulation sources / destinations,
soft knob destinations, categories, distortion types, clocks) and range (destinations: 122 entries incl.
stored values 122-127, without the six reserved ones; Reverb Predelay's end follows Reverb Type); 542 of
568 parameters have Virus Control's texts, the rest differ only in "FreqShifter" names
(`re/virusti/vc/os_vs_vc.txt`). Remote templates decoded (38 tt kk = template tt, record kk; knob name,
range type, MIDI string, template name and channel switch) and shown read only (Remote templates page);
the complete dump reads all 1024 records. The status bytes: what sets and clears them is documented (only
loading a stored multi restores 00h / 10h).
**Done (phase 4, 2026-11-26):** records 0-31 are the panel knobs 0-31 of the OS's knob table (bank 1 D014/D3FE/
D209/D614: knob 16 = Master Volume, never remote, so record 16 is the name); each record is shown with its knob's
display name (list 45) and grouped by panel area (`PANEL_KNOBS` from `os_tables.py`). Virus Control sends its
knob behaviour numbers unconverted (static analysis of its DLL, FUN_18008b020). Template editing and writing
(13 tt kk, the OS receiver's format) in the editor, .vrt import with the behaviours converted, .syx export /
import; checked with the simulator and on the unit (template 31 only, with the user's consent: written from the
browser, read back identical, the saved original written back and verified byte for byte). The output-select
variants (lists 117/119/121, tables 4/6/7) are the Snow's: its menu pages show internal parameters 035D / 0441
where the TI2's show 035C / 0440. **Left:**

1. (generic, for the main session) the device client paces SysEx with page timers, which Chrome slows to one a
   second (one a minute after 5 minutes) in a background tab: long sends from a hidden tab crawl.
2. Status byte leftovers on the unit: multi status 05h (00 before phase 1), part 16 status 05h (10h before
   phase 1). Only reloading the stored multi (which replaces the multi edit buffer) would restore them;
   they do not change the sound. Not done (needs the user's consent).
3. Phase 5 (started 2026-11-26): done: the TI and TI2 Desktop / Keyboard / Polar as devices over the TI2 editor
   (`tiModel()`, docs/devices/access-virus-ti-models.md; the TI's host OS = the TI2's except byte 000A, same DSP
   code; none checked on those units). **Done (2026-11-26): the Virus TI Snow** as its own device
   (docs/devices/access-virus-snow.md, `access-virus-snow*.js`, tests/access-virus-snow.test.js; firmware only,
   no Snow connected): `os_tables.py snow` (value lists bank 1 D19D, range routines bank 2 BB19), the Snow's
   fw.js from Virus Control's Snow description; 4 parts; single banks RAM 1-8 / ROM 1-8 of 64 = SysEx banks 1-8
   of 128 (5A52); 64 multis each holding its 4 singles (10/30 (20h + m) pp, 11 32 m store, 34 20h + m read);
   the Snow's output lists and order. The TI2 module's multi / global builders take a model's tables
   (`makeTables`, `multiParams({ parts, T })`, `globalParams(T)`). Open for the Snow: a hardware check; the
   multi part Bank list (67 vs the Snow's 68); its remote templates (knob table bank 1 D121 not decoded).
4. Phase 6: the earlier Virus models (A, B, C, Classic, Rack, Rack XL, kb, Indigo, KC, Indigo 2), from their own
   firmware (docs/devices/access-virus-abc.md). **Done (2026-11-26): the Virus b, kb, Indigo, Rack (assumed B OS)
   and Classic** over one shared definition (`access-virus-abc.js`, `abcModel()`; translator
   `access-virus-abc-translate.js`; tests/access-virus-abc.test.js; docs access-virus-b.md and the model docs).
   Method: the OS updates (MIDI files) decode to the flash images (`re/virus/old/osupd.py`; B T = the flash dump);
   the 8051 host's menu records (24 bytes, three play-mode tables in bank 2), knob handlers and parameter reader
   run in the 8051 emulator (`tools/virus/abc_host.py`), giving every menu / knob parameter its screen label,
   range and value texts (`tools/virus/abc_tables.py` -> `access-virus-b-os.js`, `access-virus-classic-os.js`).
   SysEx: the dump layouts and checksum confirmed by Access's ABM.mid / .syx dumps (`re/virus/dumps/`); the
   receiver runs on the DSP (not traced): requests 30-35 are Access's documented ones. Browser check of the B pages
   (demo mode) done 2026-11-26: knob-only parameters now sit on their panel area's card (Oscillator 1 / 2, Mixer,
   Filters, Filter / Amp Envelope, LFO n), the multi part rows are the reader's part handlers only (C 45 / 47 / 76
   are globals), Knob Display shows its band, the program screen's category (C 71) is named.
   **Done (2026-11-26): the Virus C, KC and Indigo 2** (C OS 6.6 flash dump; docs/devices/access-virus-c.md,
   `access-virus-c*.js`, `-kc.js`, `-indigo2.js`, catalog entries for the KC and Indigo 2): 18 edit-mode tables
   (bank 2 B598, records ending FEh), loader 5300, reader 1425 (handler numbers at bank 1 F71A), knob dispatch
   3A20 run in the emulator (`abc_host.py` C66 config); the C's panel selections B 125-127; LFO 3 Dest as the
   record edit mode 2 shows; format 7; Access's C dumps read back. **Done (2026-11-26): the Virus Rack XL**
   (OS 6.5 x079; docs/devices/access-virus-rack-xl.md, `access-virus-rack-xl*.js`, catalog entry): 11 edit-mode
   tables of 23-byte records (pointers at 0138, marker AAh / ABh at 16h), loader 3E24, display 6FB7, reader 0788,
   four parameter knobs whose 24 knob pages the shown record picks (bank 2 9FE1), all run in the emulator (`RXL`
   config). Also 2026-11-26: Head Library import of the Virus families (`recognise` / `isRequest` / `isOwn` /
   `prefer` in the A / B / C, TI2 and Snow definitions: 267- vs 524-byte singles, the sound format 6 / 7, TI-only and
   Snow-only banks) and complete dumps with `expect` / `seconds` and the ROM banks as an optional group.
   **Done (2026-11-26): the Virus A** (OS 2.8; docs/devices/access-virus-a.md, `access-virus-a*.js`, catalog entry):
   three play-mode tables of 25-byte records, loader 726E, display 333C, reader 3963, knob dispatch 5B3B / store
   5E93 / display 34A2 in the emulator (`A28` config). Every Virus model now has its editor (the Rack XL and A pages
   checked in the browser, demo mode). **Left:**
   - The Virus A's assumptions: RAM A-B / ROM C-D (its menus offer banks A-D), sound format 6, 128 multis (no A
     dump in the collection).
   - A hardware check of every model; the DSP-side receiver (which requests each model answers).

## Effects units (2026-11-26)

An agent goes through the effects units of `docs/FIRMWARE_CHECKLIST.md` (effects, guitar/bass and
vocal processors) and builds an editor for each one with firmware in the collection and MIDI worth
editing. Work files (firmware copies, listings) are in `re/fx/<device>/`; the 8051 emulator used to
read display routines is `tools/alesis/i8051.py` (LCD decoding shared in `tools/alesis/alesis_lcd.py`).

| Device | State | Notes |
|---|---|---|
| ART ProVerb (200) | Skipped | No firmware in the collection (asked about first) |
| Alesis Wedge | Done (not checked on hardware) | `docs/devices/alesis-wedge.md`. Every program byte with the LCD text of its display routine (28 configurations), global settings, program change table, simulator, translator. Open: a hardware check; single-program requests (44h) are dead in v1.02, so user programs are read from the 43h bank dump |
| Alesis Quadraverb | Done (not checked on hardware) | `docs/devices/alesis-quadraverb.md`. The dumps' low address lines are reversed (`tools/alesis/qv_unscramble.py`). From v1.07: the page tree per configuration and type, every page's LCD label and value texts (run in the 8051 emulator), MOD TARGET names per configuration, 90 Alesis programs, spare bytes shown to be unused; live page edits (opcode 01), program / edit buffer / all-program dumps, send-only MIDI page, simulator, translator. Open: a hardware check |
| Alesis Quadraverb Plus | Done (not checked on hardware) | `docs/devices/alesis-quadraverb-plus.md`. The Quadraverb with the v2 software (v2.03): same SysEx and program, eight configurations (ring modulator, resonator, sampling), multi-tap delay taps kept in 40 program bytes (TAP_MAP), new pages on the v1 spare bytes; built by the shared `alesis-quadraverb-common.js` from the same generator (it finds every address from code patterns). Open: a hardware check; the Sample Dump Standard packets the receiver takes (BC70) |
| Alesis Quadraverb GT | Done (not checked on hardware) | `docs/devices/alesis-quadraverb-gt.md`. v1.03: the Plus software + preamp (function 10); same 128-byte program and dump size (147 packed bytes). Preamp and other work-byte pages (83A8-83C9) packed into program bytes 7C-7E and bits 7-1 of 1B/1C/28/45 (map found by running the pack routine 1476 in the emulator), EQ MODE variants with the 5-resonator indexed pages, EQ MODE / EQ PRESET writes (run in the emulator), global CAB SIMULATOR (8590/8591) on the MIDI tab, Quadraverb programs converted as the unit converts them (02 header, B92D). Open: a hardware check; v1.00 not compared |
| Alesis MIDIVerb 4 | Done (not checked on hardware) | `docs/devices/alesis-midiverb4.md`. The Wedge's sibling (same SysEx framework and LCD): 32 configurations, 16-parameter programs with LCD texts, global settings, program change table, simulator, translator (shared with the Wedge). No parameter-change message: every edit sends the whole program. Same dead 44h request |
| Alesis Microverb 4 | Done (not checked on hardware) | `docs/devices/alesis-microverb4.md`. User programs = Edit A / Edit B + the ROM program they build on; each knob named after the parameter its routine drives, values as the LED shows them; presets and reset contents from the ROM tables; simulator, translator. Same dead single-program request (42h) |
| Yamaha SPX90 | Skipped for now | MIDI is program change and MIDI control only (no SysEx in the firmware's menus) |
| Boss SE-70 | Surveyed only | v1.01 image (512 KB) extracted to `re/fx/boss-se70/fw/`: few plain strings (character sets at 125D8/1277A, "OffOn"), vectors start 00 00 01 00; CPU and the Roland DT1/RQ1 address map still to be identified. Next candidates after it: Roland SDE-330, Yamaha REV5 / SPX1000 (bulk out menus, readable LCD templates), Lexicon LXP/MPX |
| Alesis MIDIVerb III | Done (not checked on hardware) | `docs/devices/alesis-midiverb3.md`. v1.01 (v1.00 has the same MIDI code): 16-byte programs with every value as its LED display routine shows it (run in the emulator), button positions per configuration (reverb pages hidden in 14 / 15, 490 ms delay), names from the Alesis reference and service manuals (the firmware has none; the doc says per byte where each name comes from), 100 factory programs, memory object (MIDI channel, program change, echo, program map, current program) sent as the all-data dump; live edits (opcode 03), edit buffer / user program writes (01), request (02). Simulator, translator. Generator `tools/alesis/midiverb3_fw.py`; manual text in `re/fx/alesis-midiverb3/doc/`. Open: a hardware check |
| Rocktron Intellifex LTD | Done (not checked on hardware) | `docs/devices/rocktron-intellifex.md`. v1.0: 100-byte presets (55 parameter bytes in the order of the configuration's page list 320F, 13-character title, 8 controller assignments), six configurations with their blocks, every page's display text (16-segment font decoded, routines run in the emulator; DLY TIME follows D TYPE), 80 factory presets, globals and program map (both FACTORY RESTORE codes). SysEx 28h preset / 2Ah + 81 x 2Bh user data, 7+1-bit pairs with XOR checksum; no requests: the editor listens for PRESET DUMP / DUMP USER DATA and sends to PRESET LOAD / LOAD USER DATA (2 s gap for the EEPROM). Simulator, translator. Generator `tools/rocktron/intellifex_fw.py`; recursive 8051 listing tool `re/fx/tools/rdis8051.py`. Open: a hardware check; which key starts a dump |
| Alesis Quadraverb 2 | Surveyed only | v2.01e (128 KB, bank-switched 8031, LJMP 0267) in `re/fx/_survey/`: rich LCD texts (block routing, EQ/pitch/delay/reverb types, MOD x pages, sampling). A larger design than the Quadraverb (four blocks with routes); a big but text-rich candidate |
| Yamaha REV5 / SPX1000 / Roland SDE-330 | Surveyed only | REV5 v1.0 (`re/fx/yamaha-rev5/fw`, 64 KB, reset vector 9C00, LCD templates and 30 preset names at 2000, BULK OUT ALL / MEM / BANK; no `F0` / `43` immediates found, so the CPU and memory map are still open); SPX1000 v1.1 (128 KB, reset 8000, BULK OUT ALL / MEM / BANK / ER / SYS); SDE-330 v1.07 (`re/fx/roland-sde330/fw`, 512 KB x86 code, 19 algorithm names and parameter screens at 304D4) |
| Alesis MIDIVerb II / MIDIFEX | Skipped | MIDI is program change only: no SysEx code in the 8051 program ROMs (MIDIVerb II `MVII.OBJ` 4/10/87; MIDIFEX's MVOP 4/7/86 shares the MIDIVerb's operating program). Copies in `re/fx/_survey2/` |
| ART Multiverb Alpha 2 | Done (not checked on hardware) | `docs/devices/art-multiverb-alpha2.md`. v2.02 (Z80, bank-switched; listing tool `re/fx/tools/z80dis.py`, emulator `tools/art/z80.py`): 54 configurations, 28 effect types with every parameter's LCD label and value texts (edit display run in the emulator for every value of every configuration; TUNER REFRNC follows TYPE), 98-byte edit buffer and the packed preset form (pack / recall checked against the firmware's own routines for all 115 factory presets and every configuration), 8 PERFORMANCE MIDI assignments, X-15 FX ON/OFF status, settings (03 s v, every UTILITY / MIDI page with its texts), FX ON/OFF controllers, program table. SysEx (more than the manual documents): edit buffer 05, preset 06 / 46, recall 09 (and factory recall), store 0A, all presets 0B / 4B (0F / 4F expanded), table 0C / 08, settings 03 / 43, status 0D. Simulator, translator. Generator `tools/art/alpha2_fw.py`; manual in `re/fx/art-alpha2/doc/`. Open: a hardware check. Siblings in the collection: Alpha 2 SE (done, shared editor), SGE Mach II v1.20-1.24 (same software family, not covered) |
| ART Multiverb Alpha 2 SE | Done (not checked on hardware) | `docs/devices/art-multiverb-alpha2-se.md`. Tables from v1.03 (`re/fx/art-alpha2se/fw/`); the catalog's "Multiverb Alpha SE" (v1.04 archive) is the same unit and opens the same editor. `tools/art/alpha2_fw.py` now finds every address by code pattern (Alpha 2 output unchanged byte for byte; board model: 8 KB page at A000), and `art-multiverb-alpha2.js` became a shared factory (`art-multiverb-alpha2-common.js`, thin model files). SE: four ROM banks (CLASSIC 112, STUDIO 103, PERFORMANCE 103, PRODUCTION 86) as slot pages, slots holding user RAM presets or ROM references (OPEN = the selected BANK), the bit-packed preset form (pack / recall checked against the firmware for all 404 ROM presets and every configuration), the recall's settling of unused effects, STORE's ROM references, SLOT / BANK pages, TUNER BASS12F / GTR 12F, BANK setting 03 09, 200-entry program table (CC 32 bank), SysEx 12 / 52 (all presets), 13 / 53 and 11 / 51 (table), 0B (Alpha 2 form, converted); no single-preset message (05 + 0A). `prefer` picks Alpha 2 or SE from model-only messages. Open: a hardware check; the v1.04 dump has two configuration bytes with bit 0 set (config 15 / 16) that break PRODUCTION 27 / 28: probably a read error
| Viscount EFX-10 | Done (not checked on hardware) | `docs/devices/viscount-efx10.md`. v1.02 (128 KB, 8051: code in the low half, MOVX reads at 8000+ and with P1.7 low in the high half; board model `tools/viscount/efx10_board.py`). 64-byte presets (title, algorithm, parameters, levels, MIDI CTRL 1 / 2, XOR byte the recall checks); all 27 algorithms with every edit page run in the emulator from reset (shown, stepped to both ends: bytes, bits, LCD label and value texts; pages the unit hides found by trying the values of the other pages), 27 ROM presets, the 101 user presets of the first power-up, settings and program map from the MIDI menu pages. SysEx F0 31 1n 02: 64-byte nibble blocks (12, numbers F0 / F1 map, F2 settings, 1B-7F presets 028-128), end of dump (45), MIDI EDIT EXC. parameter messages (03: the parser explored by the values it compares, each path matched to its page, five value forms); taken with MIDI EDIT EXC. ON or on MIDI BULK LOAD; no requests (MIDI BULK DUMP FROM / To on the unit); identity (device 0F only). Live edits per page for the program shown, slots, settings, gallery of the algorithms, simulator, translator. Generator `tools/viscount/efx10_fw.py` (about 40 minutes); `re/fx/tools/rdis8051.py` now follows MOVC A,@A+PC word tables. Open: a hardware check |
| Behringer DSP2024P | Surveyed only | Image in `re/fx/_survey2/`. v1.01 (128 KB 8032, LED display: parameter names only in the manual): Behringer ID bytes 00 20 32 at 1628D, receiver not found yet |

## Yamaha DX family

An agent builds the DX/TX editors on shared code (`js/devices/defs/yamaha-dx.js` and
`yamaha-dx-*.js`; the 4-operator models on `yamaha-dx4.js`; docs `docs/devices/yamaha-*.md`; tests
`tests/yamaha-dx7.test.js`, `tests/yamaha-dx-family.test.js`, `tests/yamaha-dx4.test.js`). Ghidra
has no 6800/6801 language, so the HD6303 firmware is read with `tools/yamaha/hd6303_dis.py`
(`--auto` follows jump tables; `tab:ADDR:N` a given one; `bt:ADDR` a routine followed by an inline
byte-offset table, TX81Z B563), the DX5's 6809 with `tools/yamaha/m6809_dis.py`;
`tools/yamaha/dx_fw.py` writes the firmware tables (`yamaha-dx7-fw.js`, `yamaha-dx7ii-fw.js`);
`hd6303_dis.py` also takes `sw:ADDR` (inline offset/limit switch tables, e.g. DX7II BADE, DX9 DC32, DX7s
A97B) and `ix:ADDR` (an indexer routine for `--auto`). Tests also `tests/yamaha-dx7ii.test.js`.
Work files: `re/dx/` (firmware copies under `re/dx/fw/`, listings `re/dx/*.lst`). No DX unit was
connected: nothing is checked on hardware yet. Graphics: the voice editors' Algorithm cards draw
the algorithm and offer all of them to click; EG and keyboard scaling cards draw their curves
(groupInfo.draw).

| Model | State | Open |
|---|---|---|
| DX7 | Done from the v1.8 firmware | Hardware check; panel-button remote (group 2, 0-41) not offered |
| TX7 | Voice (DX7 labels), function data (format 1) from the v1.4 firmware; the bytes it never reads read-only and named from the DX5 v6 firmware (`yamaha-dx-fn94.js`); function memories (format 2) read and written back from the Function data page's slot list (`fmemSlots`, receiver DE02); System page: the 7Dh status answer ("LM  8951  ", E2F7: flags, MIDI RCV.CH., battery, volume) read, the settings sent as the TX7 takes them (no 7Dh bulk: system parameter changes 11h pp, table C85E; group 1 numbers 1 and 40h; omni control changes), with its page titles | Hardware check |
| DX7II-D/FD | Voice + ACED, performance, system setup, micro tuning (edit buffer, user tables), fractional scaling; 64 voices with their AMEM in two banks and the cartridge's 64 in the slot list (program change 0-63 / 64-127, L A3F6 -> U 8309; Get / Store switch system bytes 12/13 with 19h 4Ch / 4Dh and set them back); parameter changes, requests and bulk formats from the v1.9 MIDI code (both banks disassembled through the cross-bank tables 8053/E983: `hd6303_dis.py ... tab:8053:136 tab:86FB:9 sw:BADE --auto` and `... tab:E983:61 tab:F088:32 tab:F0C8:176 ix:DB0A --auto`); tests `tests/yamaha-dx7ii.test.js` | Hardware check; preset micro tuning tables other than equal temperament; system byte 19 and parameter 54h unnamed |
| DX7s | The DX7II formats with its own v1.3 page labels, value texts and ranges (page tables 9B1C / 9BCD and their label pointer tables; `yamaha-dx7s-data.js`): voice, additional data, its single-voice performance (unused bytes read-only, micro tune 0-75), its system setup (Trns ch off = 16, Exclusive / Device number); 64 voices and the cartridge's as on the DX7II; its v1.3 receiver checked (`re/dx/dx7s.lst`) | Hardware check |
| TX802 | DX7II voice (its unused ACED bytes 39-48, pitch bend mode and poly/mono key mode marked from v1.5); its own eight-TG performance (116 bytes, ASCII-hex "LM  8952PE", 64 packed "LM  8952PM") with TG links and the MIDI channels page, from the v1.5 program ROM and the XB536 data ROM's screens | System setup an object (263 bytes, every byte from the SYSTEM pages); micro tuning and fractional scaling objects per TG (the TG being edited, RAM 596Bh: MCRYE 3000h + TG x 100h, FKSYE from the TG's voice; the pages select their TG by re-sending its receive channel); AMEM as the DX7II's (sender A974: 26 bytes + 9 zeros; receiver A195); 64 voices in the slot list (I01-I32 / I33-I64 through the Voice data receive block 565Fh, which also picks the block a request answers, ABF3; C01-C64 and the preset banks A / B selected into a TG and read back), program changes per TG read (J99E6 / 9A42: each group on the channel keeps its bank, takes voice program AND 3Fh + 1; Play uses the performance's voice parameter for the exact bank) | Hardware check; performance memory select; its own preset tuning tables (Equal temperament uses the DX7II's) |
| DX9 | The DX7 format it sends (F262/F27A), its parameters marked from table F0B9; ALGORITHM 1-8 = DX7 1, 14, 8, 7, 5, 22, 31, 32 (table D0D4); receiver C5B8 read (no dump requests) | Group 3 parameter changes (F59C/F5C7) |
| TX81Z | Voice + ACED (8 waves) with its own frequency display (CRS/FIN as "(RATIO)=1.06" or "(FIX)=440Hz", A1E0; the DX11 shares it), 32 voices, performance with MIDI channels page and Init templates, 24 performance memories (PMEM packing 8509/846B; slot list, Store), system setup, program change table, effects, octave and full micro tuning as objects with their parameter changes (receiver D8DD: 10h 7Bh-7Fh); from v1.6 (`tests/yamaha-tx81z.test.js`) | Hardware check; VCED parameter 93 (operator switches) and the panel switch messages not offered; the DX11 keeps these dumps as data |
| DX11 | The TX81Z definition and its own after touch data "LM  8023AE" (sender EE02, maxima 061A, screens 4572) | System "LM  8023S0"; whether its 32-voice bulk carries the aftertouch bytes |
| DX21 | 4-op voice with pitch EG and chorus; init, ratio table, labels and value texts from the v1.5 screens; its SysEx parser read (`re/dx/dx21_v15.lst`, E20A: formats 3 and 4, requests, parameter changes 12h 0-7Ch and 08h panel switches; no other format); performance memories decoded (32 x 16 bytes at 1C89h) and shown to have no MIDI format (tape only); its function settings a send-only object (Function page: parameter changes 65h-7Ch with the FUNCTION CONTROL texts, page maxima B653 and RAM table E5CE; Key Shift / Bend Mode switches 7Ah / 79h, split point 66h; the modes each is taken in; actions 6Eh-70h, 7Bh) | Hardware check |
| DX100 / DX27 | 4-op voice, 32 voices; parser, ranges, init and short labels (table AB9A) from v1.1, with its display tokens expanded (words at AD7E + token: LFS, LFD, PMD, AMD, PMS, AMS, MW/BC Pitch, Ampli, P/E Bias) | Hardware check; the "Bend Mode" / "Key Shift" screens (ADB0, ADA6) not tied to a byte |
| TX816 (TF1) | Per module (by channel): DX7 voice, 32 voices, function data (DX5 names; key limits in the name text as the TF1 keeps them); Modules page (channel, voice, key limits, master tune, attenuation, memory protect) with MIDI channels page and Find modules (7Dh status); from the TF1 firmware (receiver CFC0) | Status byte 14 (5407h) and the panel-only omni switch not named |
| DX5 / DX1 | DX5: voice (its own labels from records 8234), every byte of the 94-byte performance (tables 866D, B8A7; init D550), group 1 numbers (C919), MIDI channels page for A and B; its own voice value texts (B8A7: curves, R / Hz, detune, Off / On, transpose, LFO waves); System page from its 7Dh status answer (EFA7: MIDI switch, SUBJOB1-8, M prot, version; read only, as the DX5 takes none of them over MIDI and M tune is in no message); from the v6 firmware, a 6809 (`tools/yamaha/m6809_dis.py`) | DX5: hardware check; the frequency display B9E3 not compared with the DX7's. DX1: no firmware or document in the collection, so no editor; its own bytes are 17-25 of each channel |

## Yamaha grooveboxes: DX200, AN200, SU200 (later)

The user (2026-11-26): the DX200 is a groovebox, not a DX-family synthesizer; it belongs with the
AN200 and SU200 and the three will be addressed later as their own family. What was found so far:

| Model | State | Open |
|---|---|---|
| DX200 | OS 1.01 update decoded, no editor yet: `python -I tools/yamaha/dx200_update.py z:/firmwares/Yamaha/DX200/DX2_V101.MID re/dx/dx200/out` (model 67h messages; data in groups of seven bytes and a trailing high-bit byte, bit 6 = the first; six blocks of 2BFF8h from 4004h, each ended by a short "01" message with its last 78h bytes; a 16 KB RAM loader first) writes `re/dx/dx200/out/dx200_v101.bin` (4004h-E91A6h; Hitachi "FBHI2000/3" flash library inside, so an H8/300H) and `loader.bin` | Not verified against the readme's checksum 9FB7 (the boot sector 0-3FFFh is not in the update); Ghidra 12.1.4 has no H8 language, so an H8/300H disassembler is needed first; the DX200 shows values on a 7-segment LED only, so the firmware holds no screen texts: parameter names must come from Yamaha's DX200 documents or editor, which the collection lacks. Then: the SysEx parser (voice common, free EG, the DX7-style operators, scenes, pattern, effects, system) |
| AN200, SU200 | Not started; check the firmware collection for their OS updates | |
