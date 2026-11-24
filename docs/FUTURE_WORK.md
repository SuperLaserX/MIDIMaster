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
  `docs/MAIN_LIBRARY.md`) with a round-trip test. The test "Every device definition translates its
  sounds" fails without it; its backlog only shrinks.

### Novation SuperNova II: stopped, not finished

A background agent built this from the Rack OS 2.0 firmware and checked it against a SuperNova
II Rack on MIDI port `2- Supernova` (the `sn2live.py` default spells it `2- SuperNova`). It hit
a usage limit on 2026-11-20, was resumed, and then stopped. It is committed in `0952c20`.

What exists:

- `js/devices/defs/novation-supernova2.js` (848 lines). It loads, and has Program (374 bytes:
  type 00 + 1E), Performance (852: 05 + 1B + 20, with a `multi` hook and a drum-part flag) and
  Global (560: 0F + 15) objects, bank/slot librarian hooks and the request list. The header
  comment lists the SysEx message types and their firmware addresses.
- `js/devices/defs/novation-supernova2-fw.js`: generated option lists (pan, FX types, vocoder,
  clock multiplier...).
- `tools/novation/sn2live.py`: python-rtmidi probe tool (ports, identity, raw, request, save).
  It only sends requests and edit-buffer messages.
- `re/sn2/` (not in git):
  - `eprom/`: Keyboard OS 1.5 and 2.0, and Rack OS 1.3, 1.5 and 2.0 images.
  - `docs/`: OS 2.0 manual, OS 2 readme and OS 1.4 addendum as text.
  - `live/`: the unit's original current program, performance and global, captured before
    probing. Restore them with `work/restoreperf.py` and `work/restoreglobal.py`.
  - `work/`: the RE tools. `h8dis.py` is an H8/300H disassembler, `emu.py` emulates the
    menu-ID switch at 2193A, and `menu.py`, `resolve_all.py`, `nrpnprobe.py`, `perfprobe.py`
    and others read the menu pages and probe the unit. The results are in `resolved.txt`,
    `fields_rack20.txt`, `menu_fields.json` and `progmap_draft.txt`.

What is left, in order:

1. **Register it.** Add `'novation-supernova2': () => import('./defs/novation-supernova2.js')`
   to `DEFS` in `js/devices/registry.js`. The catalog ID is `novation-supernova2`. Until this
   is done the editor cannot be opened.
2. **Write `docs/devices/novation-supernova2.md`.** The def and the `-fw.js` file both point to
   it, but it does not exist. Build it from the def's header comment and the `re/sn2/work`
   results, using the same layout as `docs/devices/korg-m1.md` (firmware, SysEx table, layouts
   with firmware addresses, live checks).
3. **Add tests.** An earlier note said `tests/novation-supernova2.test.js` exists, but it does
   not. Cover: message building and parsing for every type; a round trip of `re/sn2/live/*.syx`
   (skip when the files are absent, the way the D:/midi test does); `multi` column labels.
4. **Map the 35 global "Spare bytes".** The def itself says these are "not identified yet".
   This breaks the mapping rule above.
5. **Prove or map the other spare bytes.** 40 in the program and 307 in the performance are
   labelled "no menu, panel control or MIDI message of OS 2.0 reaches". Check that claim and
   write down the evidence. 307 is large enough that some may be real fields: look at the
   type 20 FX block per part (40 bytes × 8 parts).
6. **Arpeggio patterns.** Message types 0A, 0B, 0C, 0D, 0E, 14, 16 and 22 are named in the def,
   and "All arpeggio patterns" is in the request list, but there is no editor object for
   patterns or user pattern banks.
7. **Keyboard and older OS versions.** The map comes from the Rack OS 2.0. Cross-check the
   Keyboard OS 2.0 image (model byte 22, which is the default `unit.model`) for differences.
   Decide how to handle units on OS 1.x, which may not have the OS 2 messages (1B, 1C, 1E, 1F,
   20, 21).
8. **Check it in the UI against the unit**, then regenerate `docs/devices/STATUS.md` with
   `node tools/device_status.mjs`.

### Roland JP-8080 and JP-8000 (2026-11-23)

Both editors share `js/devices/defs/roland-jp.js`; each model is a config file
(`roland-jp8080.js`, `roland-jp8000.js`) with generated tables (`tools/roland/jp8080_fw.py` builds
both). The Motion page is `roland-jp8080-motion.js`. Docs: `docs/devices/roland-jp8080.md` and
`roland-jp8000.md`. Tests: `tests/roland-jp8080.test.js` and `roland-jp8000.test.js`.

**The JP-8080** was checked on the unit (`MIDI (OCTA-CAPTURE)`, device ID 10h): every byte named,
the preset banks, motion read, rebuild and write. RPS patterns have no SysEx in OS 1.04 (tested),
so they are not in the editor.

The Motion page draws motions with the mouse (freehand, line, erase, shape fill), and the
Librarian's **Complete dump** reads everything (checked: 89 KB in 147 s).

**The JP-8000** is built from its OS 1.05 firmware and the shared code. It was not checked on a
JP-8000, because none was available.

Left to do:

1. **Check both in the browser**: the Patch, Performance, System, MIDI channels and Motion pages
   (with the JP-8080 connected).
2. **Motion length when a motion starts empty.** It is fixed at 10368 ticks, the length of every
   motion on the test unit at loop length 4. Find how the length follows the loop length setting
   (system 00 00 20 xx).
3. **JP-8000 system 12h-16h** are shown as typed values. No menu of either firmware shows them;
   the JP-8000 owner's manual (address map) would name them.
4. **A JP-8000 hardware check** when one is available.

### Roland V-Synth XT (2026-11-23)

V-Synth engine done and checked on the unit (`2- VSynth`): see `docs/devices/roland-vsynth-xt.md`.
Every system and patch parameter (16 zones, effects named per type), whole-patch reads with one
RQ1, the 512 user patches with bank select 87/0-3, the 16 categories, and a translator: a JP-8080
patch sent through the Main Library played back exactly on the unit.

Left to do (details in the device doc's Open items):

1. **VC-1 (D-50) and VC-2 (Vocal Designer) engines**: separate applications in the same update
   (flash 400000 and 500000), not mapped yet. The user wants all three engines.
2. **Undocumented SysEx**: model 00 24 (5-byte addresses, sample/project access) and the device
   ID 7E commands of model 00 53. Map from the firmware first; nothing was sent to the unit.
3. **36 effect parameters** with value lists computed at run time (reverb time, room size, some
   delay times, slow LFO rates): raw steps for now.
4. **Browser check** of the V-Synth pages (5 775 patch parameters in 23 sections) and of loading a
   Main Library JP patch from the V-Synth Librarian (done from Node on the unit; not in a browser).

## All devices: complete dump (2026-11-23)

The Librarian's **Complete dump** (`js/devices/generic/fulldump.js`) sends a definition's
`fullDump` requests in turn and saves every reply as one entry. Devices without mapped requests
record a front-panel "dump all" instead; the K2000 keeps its own "Back up all RAM".

| Definition | Complete dump | Checked on hardware |
|---|---|---|
| JP-8080 | System, temporary areas, all user memory, motions | Yes: 821 messages, 89 KB, 147 s, 200 items |
| JV-2080 | System, temporary patch and performance, user patches, performances, rhythm sets | Yes: 1360 messages, 115 KB, 84 s, 165 items |
| M1 / M1R | All Data plus the program being edited | Yes (M1R): 50 KB, 20 s |
| Matrix-1000 | Edit buffer and banks 0-9, then the bank unlocked | No unit connected |
| SuperNova II | The Novation definition's requests | Definition not registered yet |

Requests that come back through MIDI thru (seen on the JV-2080 setup) are left out of the dump.

## Main Library (2026-11-23)

Built as planned; see `docs/MAIN_LIBRARY.md` for the format, folder layout and definition hooks.
It has a global page (`#/library`, "Main Library" in the sidebar), a panel in every device's
Librarian, and K2000 buttons on its Library page. Imports read `.syx .mid .j8k .pat .pfm .krz/.k25/.k26
.wav .json` and disk images. Translation between models works for JP-8080 ↔ JP-8000 only.

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
- **Merging** sub-libraries, and a **device** on each sub-library (set from the Librarian it was
  added from, the import's "from" choice, or the only device in the files; editable).
- **The "Other messages" / Suzuki-Dynacord-Digidesign entries**: the device Librarian stored `.mid`
  imports as whole MIDI files and split them as raw SysEx, so each event's length byte took the
  maker ID's place. Every file reader now uses `sysexMessages`; old entries are read correctly, and
  Main Library data made from them can be fixed with **Re-read SysEx** (select them, it reads every
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
   - JP-8080 Librarian: load a patch, send it, read it back; store one to a user slot;
   - JP-8000 editor: load a JP-8080 patch and read the translation report;
   - JP-8080 **Complete dump**, then **Add to Main Library** on the saved entry;
   - reload the page: **Reconnect folder**, and pending changes are written;
   - **Unregister** a sub-library: it leaves the list and its files stay;
   - **Change location...**, both Move and Open;
   - K2000: **Add to Main Library** with audio, then **Load from Main Library...** into Disk Import;
   - **Find duplicates** (both modes) and **Merge** on a real library; **Re-read SysEx** on the
     "Unknown Suzuki/Dynacord/Digidesign device" entries already in the user's library.
2. **Translator backlog** (definitions made before translators were required; the test's
   `BACKLOG`), each through `obj.toCommon` / `obj.fromCommon` with a round-trip test:
   Matrix-1000 patch (analog, closest to the JP), JV-2080 patch / performance / rhythm set (waves
   as `rom:` names), M1 / M1R program and combination, and the K2000 program.
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
   Main Library.
10. **Arturia Jup-8000 V presets** (extension-less files like `BA 303 Style  DC_upper` in the
    Dawnchaser sets: a boost "serialization::archive" text of the plug-in's parameters). Reading
    them needs a translator for the plug-in as its own device. They are skipped for now.
11. **WinJPLib `.PTN`** files (RPS patterns, e.g. `GRAB_BAG.PTN`) are not read.

## Roland JV-2080

- **Only list waves that can sound.** The Tone page's wave lists offered every number for
  every group, including expansion boards that are not installed and PCM card groups. Lists
  should hold the 255 INT-A and 193 INT-B waves, the installed boards' waves, and PCM card
  waves only when a card is known to be in the slot.
- **Names for the internal waves.** They are in the wave ROM, not the flash, so they were shown
  as numbers. The owner's manual lists them (Waveforms, pages 182-183).
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
