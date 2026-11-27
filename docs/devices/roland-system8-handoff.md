# Roland SYSTEM-8: work handoff

Running notes for the multi-phase SYSTEM-8 editor job. Update after every milestone.
Device documentation proper: [roland-system8.md](roland-system8.md).

## State of the unit (keep this current)

| When | What | Restore |
|---|---|---|
| 2026-11-26 (phase 1) | Only reads (RQ1) and the PLUG-OUT info queries. Nothing written. | nothing to restore |
| 2026-11-26 (phase 2) | Port tests (temporary patch), browser live edit (temporary patch), first OS-dump runs (slot 3 = INIT BULK, two hangs, power cycles). | restored and verified (`20261126-after-osdump`, 0 bytes differ) |
| 2026-11-26/27 (phase 3) | **OS dump completed** (chunks 18-45: one run of 16 installs then a hang at the 17th, power cycle, then the last 12 in one run). JUNO-106 1.07 reinstalled in slot 3 (`os_dump.py --install ... Code8_3.Dat --slot 3`), slot 3 + perf restored from `20261126-phase2` (6914 messages). Then `tools/system8/clamp_check.py`: out-of-range DT1 into the temporary patch2 / patch3 (tempo, chord, step 1), originals written back and verified identical. | **restored and verified**: backup `re/system8/backup/20261126-phase3` = `20261126-initial`, 5343632 / 5343632 bytes, 0 differ (taken before the clamp check, which restored its three temporary leaves byte for byte) |

| 2026-11-27 (phase 4) | `backup.py` -> `20261127-phase4` (= phase3, 0 differ). Browser checks: H-8 of slots 0-3 and performance H-8 stored changed, read back, recalled, live-edited and stored back (each read back identical); temporary performance edits put back; complete dump compared with the backup: 0 differ in perf and slots 0-3; system block back to the backup after recalling SYSTEM-8 A-1 (byte 07 toggles at each program change: two more recalls of A-1). Then `persist_test.py write`: **slot 0 written between the brackets with H-8 named "MM PERSIST BANK", H-7 named "MM PERSIST PLAIN" (plain DT1), performance H-8 named "MM PERSIST PERF" (plain DT1)**, left for the power-cycle test. The user power-cycled the unit; `persist_test.py check`: all three names were the old ones again (DT1 writes into user memory are not kept). Then the first live install from the editor: JUNO-106 1.07 into PLUG-OUT 3 with the slot backup as patch bank (slot 3 read back identical) | **restored and verified**: nothing left to restore after the power cycle; final backup `re/system8/backup/20261127-phase4-final` = `20261127-phase4`: 5343632 / 5343632 bytes, 0 differ |

| 2026-11-27 (phase 4, test 2) | After a power cycle: `backup.py --slots=0,1,2 --no-edit` -> `20261127-flag0` (= phase4-final in those areas, 0 differ). `persist_test.py write2`: **JUPITER-8 H-8 "MM PLAIN BEFORE" and performance H-8 "MM PERF BEFORE" (plain DT1), then the SH-101 bank (H-8 "MM FLAG0 SLOT2") and the SYSTEM-8 bank (H-8 "MM FLAG0 SLOT0") between the brackets with flag 0, then SYSTEM-8 H-7 "MM PLAIN AFTER" (plain)**, all read back. The user power-cycled the unit; `check2`: all five had their old names (flag 0 keeps nothing either) | **nothing to restore** (the power cycle put the old data back); backup of system, perf and slots 0-2 `20261127-flag0-after` = `20261127-flag0` = `20261126-initial` in those areas: 4051152 / 4051152 bytes, 0 differ (slot 3 untouched since `20261127-phase4-final`) |

| 2026-11-27 (phase 5) | After the user's power cycle: `keep_test.py send` (SYSTEM-8 bank, H-8 "MM KEEP TEST", between the markers 64 / 1), then `send2` (Roland's plugin queries first, then the same): no "Receiving" screen either time, H-8 renamed in working memory only. SD card (E:, the user's own `sys8_bak.bin` / `.txt` left untouched, a copy in `re/system8/sdcard-user/`): `MMSDTEST.s8p`, `MMSDJUNO.s8p`, `MMSDBANK.s8p`, `MMSDPERF.s8f` written (new names, still on the card). The user imported them: read correctly, but IMPORT loads one patch / performance at a time into the edit buffer and saves nothing ("not a functional choice"). | **verified**: after the user's power cycle, `backup.py --slots=0 --no-edit` -> `20261127-phase5-after`; system, performances and slot 0 compared with `20261127-flag0-after`: 1466192 bytes, 0 differ in patches and performances; 3 bytes of the setup block (01 50 07 / 08 / 13: the current patch is now one of PLUG-OUT 3, selected by the user in the SD steps; 07 is the program-change toggle) = state, not memory. Slots 1-3 were not written in this session. |

Unit as found (2026-11-26, read over `SYSTEM-8 CTRL`): OS 1.32 (engine interface `0x136E`), 4 slots, 8 x 8 = 64
patches per slot, 64 performances:

| Slot | Plug-out | Model id | Version | Exact container on this PC |
|---|---|---|---|---|
| 0 | SYSTEM-8 | 5 | 1.20 | the 1.32 updater (`p1y01_p0m/p0s.bin`); Roland Cloud has 1.21 (`SYSTEM-8\Script\Code8_0.Dat`) |
| 1 | JUPITER-8 | 6 | 1.06 | the factory preload in the 1.32 updater (`p1y01_pl1m.bin`, region 0 only); Roland Cloud has 1.08 |
| 2 | SH-101 | 1 | 1.07 | `C:\Program Files\Common Files\VST3\Roland\SH-101\Script\Code8_2.Dat` (same version) |
| 3 | JUNO-106 | 7 | 1.07 | `re/system8/plugins/JUNO-106/Script/Code8_3.Dat` (copy of the Roland Cloud file, same version) |

Memory Protect: the SYSTEM-8 has no memory-protect setting.

## Backups

`re/system8/backup/20261126-initial/`, `20261126-phase2/`, `20261126-after-osdump/`, `20261126-phase3/` (gitignored,
all identical), made by `tools/system8/backup.py` (~12 minutes). `restore.py verify DIR` (complete), `compare A B`,
`restore DIR [AREAS] [--bank 0|1]` (the brackets Roland's plugin sends around a slot's 64 patches; use `--bank 0`
after reinstalling a PLUG-OUT). `slotN-retry.syx` are overlapping re-reads: not needed for a restore.

## Done

Phase 1: firmware unpacking, PLUG-OUT containers, layouts from the plugin scripts, region-0 display tables,
the live address map, the backup, the first patch editor (see the doc).

Phase 2 (2026-11-26): connections (only `SYSTEM-8 CTRL` carries SysEx), browser live edit, definition rewritten
(three structs per sound, performance, system raw, PLUG-OUT raw, full dump, link / needs), OS dump to 0x6010FFFF.

Phase 3 (2026-11-26/27):

* **OS dump complete**: `re/system8/osdump/os_full.bin` (2939504 bytes, 0x60000000-0x602CDA70). Master core 0
  (0x60000000-0x60130E00) imported into Ghidra (the GUI instance's project K2000, folder `/SYSTEM-8/s8_os132_core0.bin`,
  ARM Cortex LE, base 0x60000000, flash read-only, auto-analysed; renamed: PLUGOUT_HandleInstallDT1 0x60006084,
  PRM_FormatValueText 0x6005032E, SYSEX_SendIdentityReply 0x60005A32).
* **OS parameter catalog** (`tools/system8/os_tables.py` -> `re/system8/osdump/os_params.json`): 6783 parameters with
  names, value descriptions (screen texts), default / min / max / bias, type, SysEx address; the CC map (85 CCs);
  the SysEx leaf map (107 leaves); the formatter's tables. `gen_fw_js.py` (4th argument) writes the SysEx-reachable
  groups into `roland-system8-fw.js`; `roland-system8-os.js` ports the OS formatter and builds parameters.
* **Decoded**: the system block 01 50 = Setup Common (current state, every byte; reserved words); every performance
  byte (the "probable" ones fixed: common 8 = Octave, 9 Transpose, 10-19 arpeggio / chord / Prm Src / Carrier / KEY
  HOLD, CV Gate and INPUT leaves); MONO SW, F/A ENV VARIATION, CHORD MEMORY Form, chord notes (stored note + 1, 0 =
  NONE: the old editor had it wrong), effect LFO source / ext gain / offset, MFX, step flags / assign words, SMOOTH;
  the level table (not linear). The SYSTEM menu settings have no SysEx address (so Rx Edit Data etc. cannot be read
  or set over MIDI).
* **Checked on the unit** (`clamp_check.py`): the OS clamps DT1 to its catalog ranges; the plugin's Patch Tempo
  (0-2600) and step Gate (0-99) are wrong; the editor follows the OS.
* **Coverage test**: every byte of patch / patch2 / patch3 / performance / system is a parameter or an OS-reserved
  slot; the editor's leaves equal the OS leaf map.
* **PLUG-OUT engine editors**: 9 catalog entries (`roland-system8-jupiter8` ... `-system100`), generated tables
  (`tools/system8/gen_plugouts_js.py` -> `roland-system8-plugouts.js`), shared factory `roland-system8-engines.js`;
  the unit's own 192 PLUG-OUT patches decode within range. Tests: `tests/roland-system8.test.js` (15),
  `tests/roland-system8-engines.test.js` (4).
* **PLUG-OUT install** confirmed from the OS handler (codes in the doc); the generic job's spec in the doc is current.

Phase 4 (2026-11-27):

* **PLUG-OUT library and install** (`js/devices/defs/roland-system8-install.js`, doc section "PLUG-OUT library and
  install"): `def.files` kind `plugout` (container read and checked: XOR, records, image sum vs END, region
  checksums, the slot the build is linked for from the SYNINFO init pointers; SYSTEM-1 builds, slot-0 builds and
  damaged files refused), "Install..." (slot + patch bank dialog, Roland's plugin rules, `startTransfer` job: START,
  4096 records at 32000 bytes/s with the flow-control query before every 32nd one and its counter checked, END,
  slot record check, patch bank between the brackets; a missing reply stops at once with the power-cycle message and
  sends the abort), "Back up this slot" / "Back up a PLUG-OUT slot..." (container from the library or the Roland
  Cloud file + the 64 patches read in a job, a pair of entries). The simulator answers the whole install protocol as
  the OS handler does (START codes, record counter, refusals, END checks, the slot record changes).
* **Firmware**: the OS writes the slot's flash only after END passed (sum, size, region 0 checksum): a stopped
  transfer leaves the slot intact. The flow-control answer is the OS's record counter. START 64h = an earlier
  transfer was dropped (send START again); flags 40h = mode 2, loaded without writing the flash (Roland Cloud's
  unauthorised "try"). Doc updated.
* Fixed: "Find its slot" (engine editors) parsed the device client's message objects as raw bytes and found nothing
  in the browser.
* Complete dump: one step per bank (6 Branch Library entries instead of 321). Performance: "Parts (MIDI channels)"
  page (upper / lower; the part channels are SYSTEM menu settings without a SysEx address). Store notes: what Store
  writes is kept until power-off.
* **On the unit** (doc table "Checked on the unit in the browser"): store / read back / recall / live edit / store
  back in SYSTEM-8 and PLUG-OUT 1-3 H-8, performance edits and store, slot backup and complete dump equal to
  backup.py, the first live PLUG-OUT install from the editor (JUNO-106 1.07 into PLUG-OUT 3, 1 min 14 s, slot 3
  read back identical), and the persistence test (DT1 writes into user memory are lost at power-off).
* Tests: `tests/roland-system8-install.test.js` (8: container format on a built container and on the 37 Roland
  files when present, the install protocol in the simulator, a missing flow reply, a refused record, wrong slot,
  START codes, Stop, backup + install with the patch bank restored byte for byte, the JUNO-106 1.07 container).

Phase 5 (2026-11-27):

* **SD card** (`js/devices/defs/roland-system8-sd.js`, doc "SD card"): the `.s8p` / `.s8f` / backup `.bin` formats from
  the OS's file code (container with CRC32 checks, chunk tables, the OS's internal structs = one word per catalog
  parameter); conversion SysEx data <-> internal derived from `OS_GROUPS` (every byte of a sound and a performance one
  word); Roland's factory `.s8p` read and rebuilt byte for byte, the plugin's preset bank converts to it byte for byte;
  `osCheck` = the OS readers' checks. "Save to SD card..." on the Patch, PLUG-OUT patches, Performance and engine pages
  (the page's patch / performance, a bank read from the unit or from a Branch Library bank, all performances, everything
  for RESTORE without the SYSTEM settings), written into the card's SYSTEM-8 folders (File System Access API), with the
  steps on the unit. `tools/system8/s8files.py check` (Python twin), `tools/system8/sd_files.mjs` (test files from a
  backup onto a card; built in `re/system8/sdcard/`).
* **Saving over MIDI** (doc "Saving over MIDI"): WRITE and every other save go through the flash save objects; the only
  MIDI path in the OS code is the bank receive ("Receiving" / "Writing!" screen) behind the patch-bank markers (a slot's
  64 patches, when every patch written since the last save is in that slot). On the unit it did not open, twice, right
  after a power cycle (the second time after the plugin's queries): its trigger is in the kernel, not in the dump. No MIDI
  save; no page offers it (`keepBank` and the simulator model stay for a later test; `tools/system8/keep_test.py`).
* **Head Library PLUG-OUTs**: "Install a PLUG-OUT from the Head Library..." (PLUG-OUT patches page); the PLUG-OUT patches
  object renamed `plugout` -> `plugoutpatch` so that container rows no longer load into it as patch data.
* Ghidra (`/SYSTEM-8/s8_os132_core0.bin`): functions created at the save jobs and file readers (0x6000A29C, A53E, A7A4 ..,
  AC52, AF20, B2D0, B552, D626, D698, E9E8, 0x6001BF54, BFFC, 0x60028C40, 8CB8, 9128, 0x60037EF0, 0x60077D48, 0x60079220;
  saved). The kernel (0x0100xxxx: SysEx library, CRC32, file I/O) is not in the dump: its source area 0x602B9374 is
  reused as RAM after start-up (a block made from it was removed again). `tools/system8/find_bl.py` finds BL calls
  Ghidra missed.
* Tests: `tests/roland-system8-sd.test.js` (11); shared fixtures moved to `tests/roland-system8-fixtures.js`.

## Scripts (run with `python -I`; Windows MIDI ports are exclusive: close the browser tab's device first)

| Script | What |
|---|---|
| `tools/system8/s8midi.py` | helpers: ports, RQ1/DT1 builders, parser |
| `tools/system8/probe_ports.py` | identity request + device-type query on both ports |
| `tools/system8/port_caps.py` | what each port carries (temporary patch only, put back) |
| `tools/system8/scan_map.py OUT.json` | read-only address map |
| `tools/system8/backup.py [OUTDIR]` | complete backup (~12 min) |
| `tools/system8/restore.py verify/compare/restore` | check, compare, restore backups |
| `tools/system8/os_dump.py OUT.bin [--start --end --settle]` / `--install DAT --slot N` | OS dump through slot 3 (done); reinstall a container |
| `tools/system8/persist_test.py write DIR / check / restore DIR` | DT1 persistence over a power cycle: slot 0 between the brackets (H-8 renamed), H-7 and performance H-8 renamed by plain DT1; check the names; restore |
| `tools/system8/keep_test.py send DIR / check / restore DIR` | the OS's bank save over MIDI: SYSTEM-8 bank with H-8 renamed between the markers, check after a power cycle, put back |
| `tools/system8/s8files.py check` | SD-card formats in Python: factory `.s8p` checks, rebuild, plugin bank -> internal byte for byte |
| `node tools/system8/sd_files.mjs DIR SLOT3DIR CARD [--restore]` | SD-card test files from a backup onto a card (or folder) |
| `tools/system8/find_bl.py OS.bin ADDR...` | Thumb BL / B.W calls to an address (calls Ghidra did not disassemble) |
| `tools/system8/clamp_check.py` | out-of-range DT1 into the temporary patch2 / patch3, read back, restore and verify |
| `tools/system8/os_tables.py OS.bin OUT.json` | the OS parameter catalog, CC map, leaf map, formatter tables |
| `tools/system8/gen_fw_js.py SCRIPT.xml REGION0.bin OUT.js [OS.json]` | `roland-system8-fw.js` (plugin rows, region 0, OS catalog) |
| `tools/system8/gen_plugouts_js.py OUT.js` | `roland-system8-plugouts.js` (the nine engines) |
| `tools/system8/unpack_fw.py`, `codedat.py`, `script_layout.py`, `region0_tables.py` | phase 1 (see the doc) |

Regenerate: `python -I tools/system8/os_tables.py re/system8/osdump/os_full.bin re/system8/osdump/os_params.json`,
then `python -I tools/system8/gen_fw_js.py re/system8/plugins/SYSTEM-8/Script/Script.xml
re/system8/images/SYSTEM-8_s1_region0.bin js/devices/defs/roland-system8-fw.js re/system8/osdump/os_params.json` and
`python -I tools/system8/gen_plugouts_js.py js/devices/defs/roland-system8-plugouts.js`.

## Findings to remember

* Only `SYSTEM-8 CTRL` answers SysEx; device ID 10h only. Replies to the temporary areas can take > 50 ms.
* patch2 / patch3 bytes outside the script's fields are 0 in every patch of every slot (checked on the backup).
* The OS catalog's patch-struct records are SYSTEM-1 era (e.g. OSC variations 0-1): for the engine's panel values
  keep the plugin / region-0 ranges, take only the texts.
* A Chrome tab and Python can both have the ports open at times (Windows): never run a PLUG-OUT install while the
  browser has the device page open; tell main before and after every live session (the front page's "Scan MIDI
  ports" is unsafe meanwhile).
* The INIT-BULK install hangs the unit after ~8-17 installs in a row even with `--settle 15`.
* Python here-docs through the Bash tool lose `\\` escapes: write scripts with the Write tool, and avoid apostrophes
  in single-quoted JS strings; always `node --check` after an edit.

* Phase 4 measurements: the editor reads a whole patch (96 DT1) in about 0.15 s (a slot of 64 in 10 s, the
  complete dump in 2 min 5 s); backup.py is slower only because of its fixed waits.
* Setup block byte 07 ("PATCH or PERFORM" in the OS catalog) toggles 0 / 1 at every program change received in patch
  mode: after recalls, send an even number of program changes (or recall the original patch twice) to get the
  backup's value back.
* PLUG-OUT installs: the OS writes the slot flash only after a complete, checked transfer (doc). The live install
  from the editor (2026-11-27, the first after the user's power cycle) took 1 min 14 s; every flow-control reply
  equalled the records sent. One install since that power cycle.
* The scratch Chrome profile's Branch Library was found empty when the tab was reopened (entries made earlier in the
  same profile were gone): re-import the container before an install.

## Open questions

* What writing the setup block (01 50: current patch numbers, flags) does: untested (the editor sends it only on
  request).
* Plain DT1 writes into user memory do **not** persist over a power cycle (checked twice). The bank receive behind the
  markers did not open on the unit (phase 5, twice): what opens it is in the kernel's SysEx library, not in the OS dump
  (dumping 0x01000000 .. 0x010143AB live through the slot-3 install trick would show it).
* SD card: the unit reads the editor's `.s8p` / `.s8f` files, but IMPORT loads one patch at a time into the edit buffer
  without saving (checked by the user 2026-11-27): no bulk save. RESTORE of the editor's backup file (patches and
  performances, SYSTEM settings untouched) is the only bulk path and is untested; the editor does not offer it.
* The `70 20 01 01` handler itself is in the kernel (not dumped): which UI states let it open the "Receiving" screen
  is not known (START of an install refuses unless FUN_6001864A(0x2731) passes; the markers may need the same).
* The menu value lists at 0x6009A900.. (e.g. the CV Src menu map): only the CV Src list is used; other menus print
  catalog texts.
* Identity Request: the OS builds a reply (routes 0x800 / 0x1000); no port showed it in phase 2.

## Generic hook for main (not edited here: sendto.js / mainlib-pick.js)

The Head Library's PLUG-OUT rows (kind `plugout`, device `roland-system8`, `native.object` `plugout-container`) are
files, not object data. The definition installs them itself ("Install a PLUG-OUT from the Head Library..." on the
PLUG-OUT patches page). For the Head Library page's Send-to to offer it too, `sendto.js` would need, before the
object match in `fitFor` / `sendToDevice`: when `def.files` has an entry `fk` with `fk.kind === r.kind` and the row is
the device's (`r.device === g.entry.id`), offer `fk.actions` (the ones with `fromLibrary !== false`) and run
`a.run(objectApi(g, def.objects[0]), { name: r.name, notes: patch.notes, bytes: fromBase64(patch.native.bytes), kind: r.kind })`
after `lib.getPatch(r.sub, r.id)`. The SYSTEM-8's `Install...` action takes exactly that entry shape (it reads only
`bytes`, and the Branch Library through `api.g.host.library`).

## Next steps (phase 5 ended 2026-11-27; the user continues next week)

Findings to carry on from:
* **No MIDI save.** The OS's only MIDI-reachable save, the bank receive behind the patch-bank markers (doc "Saving over
  MIDI"), did not open on the unit, twice, right after a power cycle (plain, and after the plugin's queries). The code that
  reacts to `70 20 01 01` is in the kernel's SysEx library (0x0100xxxx, copied from the OS image at start-up), which the
  OS dump does not hold: its source area is reused as RAM.
* **SD IMPORT is no save path**: the unit reads the editor's files correctly but loads one patch / performance at a time
  into the edit buffer; each needs WRITE.
* **RESTORE is untested**: `backupFile` (PRF + PAT / PAT2 / PAT3, no SYS / TMOD / PLG) passes the OS's checks and the
  restore code takes such a file chunk by chunk; not offered in the editor.
* The test files are still on the user's card (`ROLAND/SYSTEM-8/EXPORT/PATCH/MMSD*.s8p`, `EXPORT/PERFORM/MMSDPERF.s8f`);
  they can be deleted on the unit (IMPORT file list, REST/ERASE) or on a computer. The user's `sys8_bak.bin` / `.txt` are
  untouched.

Next, each needs the user:
1. **Dump the kernel** (0x01000000 .. 0x010143AB, 82 KB) with the slot-3 dump install (`os_dump.py`, phase 3 method;
   hangs after 8-17 installs: power-cycle between runs), load it into Ghidra at 0x01000000 and read the `70 20`
   handler: what opens the "Receiving" screen. Then retry `keep_test.py send2`.
2. **RESTORE round trip**, only with the user's explicit OK: `node tools/system8/sd_files.mjs
   re/system8/backup/20261127-flag0-after re/system8/backup/20261127-phase4-final <card> --restore`, RESTORE
   `MMRESTST.bin` (H-8 renamed), power cycle, check; RESTORE `MMBACKUP.bin`, power cycle, full backup and compare. If it
   works, offer "everything for RESTORE" again in "Save to SD card..." (the code path was removed, `backupFile` stays).
3. The six PLUG-OUTs not installed here; DIN MIDI (as before).
