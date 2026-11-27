# Roland SYSTEM-8: MIDI implementation, PLUG-OUT format and firmware

Status (2026-11-27): phase 5: the SD-card files (.s8p, .s8f, backup) decoded and written by the editor ("Save to SD card..."), checked against a backup the unit wrote itself; the bank receive of the OS read from the code but not triggered on the unit (no MIDI save); PLUG-OUT install from the Head Library. Phase 4: PLUG-OUT library, install (checked live) and slot backup from the editor; browser checks on the unit; plain DT1 writes into user memory do not survive a power cycle. Phase 3: The OS plaintext is dumped and read: every value's range and screen text from the OS
parameter catalog, the system block, every performance byte, the CC map, the SysEx leaf map, the PLUG-OUT install
handler; PLUG-OUT engine editors for the nine plug-outs. Work notes and the unit's state are in
[roland-system8-handoff.md](roland-system8-handoff.md). Work files (firmware, Roland Cloud plugin
scripts, decoded images, backups) are in the gitignored `re/system8/`; scripts in `tools/system8/`.

## Sources

| Source | What it gives |
|---|---|
| System program 1.32 (`z:\firmwares\Roland System 8_sys_v132 .zip`, `system8_sys_v132.zip` on static.roland.com; the newest on Roland's support page, 2026-11-26) | OS (encrypted), the SYSTEM-8 engine (slot 0) and the factory PLUG-OUT images |
| Roland Cloud plugins installed on this PC (`C:\Program Files\Common Files\VST3\Roland\<name>\Script\`) | `Script.xml` = the device memory map with names, ranges and defaults; `Code8_<slot>.Dat` PLUG-OUT containers (SYSTEM-8 itself, JUPITER-8, JUNO-106, JX-3P, JUNO-60, JUPITER-4, PROMARS, SH-101, SH-2, SYSTEM-100); banks in `C:\ProgramData\Roland Cloud\<name>\` |
| Roland manuals (static.roland.com): `SYSTEM-8_reference_eng04_W.pdf`, `SYSTEM-8_eng02_W.pdf`, `SYSTEM-8_MIDI_Imple_Chart_e01_W.pdf`, the JUPITER-8 / JUNO-106 / JX-3P parameter correspondence tables | menus, value ranges, CC list, bank select (MSB 85, LSB 0 SYSTEM-8, 1-3 PLUG-OUT 1-3) |
| `SYSTEM-8_Sound_Bank_For_V120.zip` | the `.s8p` export format (see below) |
| The OS 1.32 plaintext, dumped from the unit (`re/system8/osdump/os_full.bin`, 0x60000000-0x602CDA70, `tools/system8/os_dump.py`; master core 0 = the first 0x130E00 bytes, in Ghidra as `/SYSTEM-8/s8_os132_core0.bin`) | the parameter catalog (names, value texts, ranges, defaults and SysEx addresses of 6783 parameters), the SysEx leaf map, the CC map, the value formatter, the menu strings, the PLUG-OUT install handler (see "OS parameter catalog") |
| Community SDK: [enorrmann/roland-plugout-reveng](https://github.com/enorrmann/roland-plugout-reveng) (MIT, Emilio Norrmann, released 2026-11-21) | reverse-engineered container format, install protocol, DSP ISA, assembler, compiler (`s1cc`), emulator, example PLUG-OUTs, a browser installer (`web/`) |

## Hardware and firmware

* Three Roland **BMC** chips (Cortex-M cores + DSP blocks): the master (core 0: OS = μT-Kernel, UI, MIDI, SD, USB,
  PLUG-OUT management; core 1: effects and master section) and two slaves (the voices: the PLUG-OUT engine). A
  STM32F103 scans the panel and keyboard. (SDK vol. I and vol. IV ch. 6.)
* `SYSTEM8_UP.BIN` is a tar of `_tmp/p1y01_*.bin` (`tools/system8/unpack_fw.py`):

| File | Contents |
|---|---|
| `p1y01_m0c0a_up.bin` | `App1_Main`: the OS, load `0x60000000`, 0x60-byte clear header, payload 3-key 3DES ECB (key in the BMC boot ROM, not public) |
| `p1y01_p0m.bin`, `p0s.bin` | slot 0 = the SYSTEM-8 engine: region 0 (model, `0x60800000`) and region 1 (engine, `0x60200000`), SYNINFO `SYSTEM-8` id 5 version 1.20 |
| `p1y01_pl1m.bin`, `pl1s.bin`, `pl2m.bin` | `PRELOAD_PLUGOUT` + region 0 of JUPITER-8 (1.06), JUNO-106, JX-3P |

* A region is a 0x40-byte header (`"SYSTEM-8:Plugout"`, build date, tool version, load address, compressed size,
  32-bit byte sum of the compressed bytes, uncompressed size) + Okumura LZSS (4 KB ring **zero-filled**, write
  position 0xFEE, flag byte LSB first, 1 = literal, reference `pos = b0 | (b1 & F0) << 4`, `len = (b1 & 0F) + 3`).
* Each image starts with SYNINFO: `"SYSTEM8_SYNINFO\0"`, name[16], u16 model id, u16 version, init function.

### Display tables in region 0

Region 0 (the "model" image, run by the OS CPU) holds the panel and menu tables of its engine
(`tools/system8/region0_tables.py`): little-endian TLV records

| Type, length | Record |
|---|---|
| 0, 0x20 | page: `count`, `name[16]` (LFO, OSC1, OSC2, OSC3, MIXER, PITCH, FILTER, AMP, EFFECT, DLY/CH, REVERB, CONTROL, BEND SENS, MOD SENS, BEND, ROUTING) |
| 1, 0x4C | parameter: `id`, size class, min, max, list number, display kind, index on the page, `name[16]` at +0x38 (empty when the OS supplies the label) |
| 2, 0x14 | value list header: number, count |
| 3, 0x1C | value: `text[16]`, value |

Parameter ids follow the `Script.xml` patch values in order: `0x6CD` LFO WAVE ... `0x70C` (64 panel values),
`0x70D`-`0x71C` the 16 name characters, `0x71D` PAT_NAME1 (INPUT JACK USING) ... `0x73D` PAT_NAME3 (LFO VARIATION).
The SYSTEM-8 image names its value lists (LFO waves SIN ... RNDx2, TYPE1-6; OSC waves of the four variations;
filter variations LPF/HPF, SBF, SYS-1, JP-8, JU-106, FMT 2, FMT 3, HARM; patch-cord sources (OPEN), GATE, LFO,
LFO A, LFO B, P.ENV, F.ENV, A.ENV, OSC1, OSC1SYNC, OSC2, OSC3, MIXER ...). Each PLUG-OUT's region 0 has its own
pages, labels (JUPITER-8: VCO MODULATOR, PWM Source, Slope, Assign Mode, VCO-1 BendSw ...) and value lists, and
its factory presets (names stored as byte-reversed 32-bit words). The labels of the SYSTEM-8's own panel values,
the performance, system and step-sequencer menus are in the OS (encrypted in the update; read from the dumped plaintext: "OS parameter catalog").

## MIDI ports and connections

Checked on the unit 2026-11-26 (`tools/system8/port_caps.py`):

| Connection | SysEx RQ1/DT1 | CC (panel values) | Program change + bank select | Notes, clock | PLUG-OUT install |
|---|---|---|---|---|---|
| USB `SYSTEM-8 CTRL` | yes (the only port that answers; device ID 10h) | CC 3 sent: no change (see below) | yes (bank 85/0-3 + PC, Patch Ch) | - | yes (Roland's plugin, the SDK) |
| USB `SYSTEM-8` | DT1 ignored, RQ1 unanswered | CC 3 sent: no change | yes | notes; the unit sends MIDI clock here (Sync Output ON) | no |
| DIN MIDI IN/OUT | chart: SysEx "o / o"; parameter RQ1/DT1 **unchecked** (no DIN cable on this unit) | chart: the CC list | chart: yes | chart: yes | no (USB only) |

Identity Request was answered on no port in our tests (also not on DIN, SDK), although the OS builds an Identity
Reply (`F0 7E dev 06 02 41 2E 03 00 00 00 03 00 00 F7`, SYSEX_SendIdentityReply at 0x60005A32). CC: the OS's own CC
map (0x600FB3D8, below) has 85 controllers, no NRPN. CC 3 = 100 did not change FILTER CUTOFF on either USB port:
SYSTEM: MIDI Rx: Rx Edit Data gates the panel CCs, and the SYSTEM menu settings (Rx Edit Data among them) have no
SysEx address in the OS catalog, so no editor can read or set it: it is set on the unit. The editor sends every edit
as DT1 over `SYSTEM-8 CTRL` and declares `needs: 'sysex'` on every object; over `SYSTEM-8` or DIN only recall
(program change) works.

### CC map (OS 0x600FB3D8: 128 x {cc, group, OS parameter})

| CC | Parameter (OS group: name) | CC | Parameter |
|---|---|---|---|
| 1 | midi: Modulation | 3 | flt: Cutoff |
| 5 | ctrl: Portamento | 7 | midi: Volume |
| 9 | flt: Resonance | 10, 11 | midi: Pan, Expression |
| 12, 13 | efx: Depth, Time (delay / chorus) | 14, 15 | LFO Variation, Trig Env |
| 16-19 | mix: OSC 1, OSC 2, OSC 3, Noise | 20, 21 | OSC1 Coarse Tune, Fine Tune |
| 22-24 | pit: Env, Attack, Decay | 25 | OSC3 Color |
| 26-30 | lfo: Pitch Depth, Fade Time, FilterDepth, Rate, AMP Depth | 35 | lfo: Wave |
| 41 | ctrl: Bend Range | 46, 47, 50, 52, 60 | osc1: Wave, Range, Color, Cross Mod, Mod |
| 48, 49, 51 | OSC3 Tune, Bend Gain, Filter Variation | 53, 54 | FILTER / AMP Velo Sens |
| 55, 56, 61-63, 87 | osc2: Color, Fine Tune, Wave, Range, Mod, Coarse Tune | 64, 66, 67 | Hold, Sostenuto, Soft pedal |
| 68, 75, 80, 109 | Bend Sens Pitch, Filter; Mod Sens Pitch, Filter | 69 | amp: Tone |
| 70, 71 | Effect Type, Tone | 72-74 | Delay Type, Reverb Type, Reverb Time |
| 79, 81-86 | flt: HPF Cutoff, Env, Key Follow, Attack, Decay, Sustain, Release | 89, 90, 96, 97 | amp: Attack, Decay, Sustain, Release |
| 91, 94 | efx: Reverb Level, Delay Level | 102, 113, 115 | (MOD ASIGN), (MIX SUB OSC TYPE), (FILTER LPF TYPE) |
| 103, 104, 107, 108 | OSC1 / OSC2 Variation, OSC3 Wave, Filter Type | 110 | extend: Level |
| 111, 112, 114 | osc2: Ring, Sync; mix: NoiseType | 116-119 | ctrl: Legato; lfo: Key Trig; ctrl: Tempo Sync, Mono |

The chart lists the same set without CC 87, 102, 113 and 115. The editor does not send CCs (DT1 carries every value at
full resolution).

## SysEx

`F0 41 dev 00 00 7E cmd a1 a2 a3 a4 ... sum F7`, `dev` = 10h (Device ID 17, SYSTEM: Device ID 17-32).
`cmd` 11 = RQ1 (`size` as 4 x 7-bit bytes), 12 = DT1. The Roland checksum covers address and data.
Addresses and sizes are 7-bit packed (each byte 0-7F). The unit answers an RQ1 with one DT1 per leaf (sub-block)
inside the requested range (clipped to the range), splitting leaves longer than 240 bytes into 240-byte messages.
A range that holds no parameter gets no answer, and neither did a whole-area request (`01 00 00 00`, size
`01 00 00 00`): read struct by struct. Replies to the temporary areas (`03`-`06`) can take more than 50 ms; match
replies by their address, not by timing.

### Address map (scan of every `b0 b1 00 00`, `tools/system8/scan_map.py`; the OS's leaf map below)

| Address | Block | Leaves / size |
|---|---|---|
| `01 50 00 00` | setup block (OS group stp_com "Setup Common": the unit's current state, see below) | one leaf of 336 bytes (sent as 240 + 96) |
| `03 00 00 00`, `03 20`, `03 30` | temporary patch (`patch`) x 3: patch mode, upper, lower (to confirm) | 640 |
| `04 00 00 00` | temporary performance | 12 leaves, 2709 bytes |
| `05 00/20/30 00 00` | temporary `patch2` x 3 | 3975 |
| `06 00/20/30 00 00` | temporary `patch3` (step sequencer) x 3 | 15580 |
| `10`-`17` `nn 00 00` | performances, bank A-H = 10-17, number 1-8 = nn 00, 10, ... 70; name in leaf `01 20 00` | 64 x 2709 |
| `20+b i 00 00` | slot 0 (SYSTEM-8) patch `b*8+i` | 64 x 640 |
| `40+b i 00 00` | slot 1 patch | |
| `0E (b*16+i) 00 00`, `0F ...` | slot 2, slot 3 patch | |
| `(p << 18) + T` | `patch2` / `patch3` of patch p; T = 28 / 30 / 38 / 68 (patch2 of slots 0-3), 48 / 50 / 58 / 60 (patch3) | |
| `70 ..` | PLUG-OUT control (below) | |

The OS's SysEx leaf map (0x600D2988, 107 entries {address, bytes, group}) lists every leaf of the system and temporary
areas: `01 50` stp_com 336; `03 00 00 00` lfo 14, osc1 10, osc2 16, mix 12, pit 6, flt 20, amp 10, efx 8, ctrl 12,
extend 20, `03 00 01 00` pat_name 512; `04 00 00 00` ... `04 01 30 00` the 12 performance leaves (pfm_com 228 ...
pfm_extd 240); `05 00 00 00` ... `05 02 00 00` the 17 patch2 leaves; `06 00 00 00` ... `06 08 10 00` patch3 (common,
64 steps of 236 bytes, a reserved leaf of 240). The editor's leaves are exactly these (test). User memory (10-17,
20-27, 40-47, 0E, 0F, 28-6F) holds the same structs.

The `patch`, `patch2` and `patch3` structures are in each plugin's `Script.xml` (`fm.usrX`, `fm.usr2X`, `fm.usr3X`);
`tools/system8/script_layout.py` turns them into `re/system8/layout/<plugin>.json`. Value types: `intNxM` = N bytes
of M bits each, most significant first (`int2x4` = 2 nibbles, `int8x4` = a 32-bit value in 8 nibbles, `int1x7` = one
byte); names are 2 nibbles per character. All PLUG-OUTs use the same layout; names and ranges differ.

* `patch` (640): LFO, OSC1, OSC2, MIX, PIT, FLT, AMP, EFX, CTRL, EXTEND (the 64 panel values, `int2x4`), NAME0
  (16 characters), PAT_NAME1-3 (48 `int8x4` values: arpeggio, scatter, octave, key hold, the 16 patch-cord inputs,
  variations, OSC3, filter type, effect types, condition, bend and mod sensitivity ...).
* `patch2` (3975): effect details (DELAY, CHORUS, FLANGER, MFX, REVERB), CHORD MEMORY, velocity sensitivities,
  high-resolution LFO rate and cutoff, patch tempo, comment, rating.
* `patch3` (15580): step sequencer common + 64 steps (8 notes, velocities, gates, flags, 4 assign targets/values).

### PLUG-OUT control (`70 ..`, DT1, answered at `71 ..`; SDK vol. IV ch. 4)

| Send (DT1, 1 data byte) | Reply | Content |
|---|---|---|
| `70 00 02 00` | 1 byte | device type: 0 SYSTEM-1, 1 SYSTEM-1m, 2 SYSTEM-8 |
| `70 00 02 01`, `02 02` | 1 byte each | banks x patches (8 x 8) |
| `70 00 02 03` | 1 byte | slots (4: slot 0 = the SYSTEM-8, 1-3 PLUG-OUT 1-3) |
| `70 00 01 00` [slot] | 48 bytes, one nibble each | 0-3 OS version (`0132`), 4-7 engine interface (`136E`), 8-11 model id, 12-15 version, 16-47 name |
| `70 10 00 00` [slot, + 40h for a second mode] | `71 10 00 00` = 00 OK, 07 refused (the OS's state check fails), 08 slot > 3, 64h a transfer was running (restarted) | START of an install |
| `70 30 00 09` + 586 bytes | (`71 30 00 00` = error) | one 512-byte flash block, 7-in-8 (bit j of the first byte = bit 7 of byte j) |
| `70 30 01 09` [01] | | an erased block (filler) |
| `70 30 03 00` [00] | 4 bytes | flow control, before every 32nd record: the OS's 16-bit block counter as 4 nibbles |
| `70 30 02 00` [00] | `71 30 02 00` = status | abort the transfer (`70 40 01 00` [00] answers 00 the same way) |
| `70 10 00 01` + 4 nibbles | `71 10 00 01` = 00 | END: 16-bit sum of the 2 MB flash image |
| `70 20 01 01` [n] / `70 20 01 02` [0/1] | | patch bank start / end (the plugin writes its 64 patches between them) |

The OS handler (PLUGOUT_HandleInstallDT1 at 0x60006084, reached through 0x600062E8 for model 00 00 7E) confirms the
SDK's protocol: a data record `70 30 00 nn` carries 2^nn bytes (the handler checks the message length 2^nn / 7 + 2^nn
+ 1: 586 for nn = 9), `70 30 01 nn` [0 / 1] fills a block with 00 / FF, a refused record is answered `71 30 00 00`
[code], END `70 10 00 01` takes 4 nibbles and answers its check result. The `70 00 ..` queries and the patch-bank
brackets `70 20 01 ..` are handled elsewhere.

There is no command that reads a slot's firmware back. A PLUG-OUT "backup" is therefore the container file that
was installed (identified on the unit by name, model id and version) plus the slot's 64 patches.

### `Code8_<slot>.Dat` (PLUG-OUT container, `tools/system8/codedat.py`)

Chained XOR over 32-bit words (`plain[i] = c[i] ^ c[i-1]`, `c[-1] = BACADABEh`); header `0x80`,
`"PLUGOUT_SYS_INF"`, name, model id, version, then the START message, the END message and 4096 records
(`u32 length` + one complete SysEx each, stride 0x260). The 4096 blocks form a 2 MB flash image: region 0 in the
first half, region 1 in the second. Each slot has its own build (pointers relocated by 0x200000 per slot).
The SDK rebuilds every Roland container byte for byte and builds new ones (`tools/plugout_build.py`,
`s1cc`); its installer is the same protocol.

### Model ids

SH-101 1, SH-2 2, SYSTEM-100 3, PROMARS 4, SYSTEM-8 5, JUPITER-8 6, JUNO-106 7, JX-3P 8, JUNO-60 0Ah,
JUPITER-4 0Bh (from the containers on this PC).

## SD card: patch and performance exports, backup (phase 5: `roland-system8-sd.js`)

The SYSTEM-8 reads three kinds of file from its SD card (UTILITY: IMPORT and RESTORE). The editor writes them from
its own data ("Save to SD card..." on the Patch, PLUG-OUT patches, Performance and PLUG-OUT engine pages), so sounds
reach the unit without MIDI. Everything below is from the OS 1.32 file code (master core 0) and checked byte for
byte on Roland's factory bank `S8_V120_Pat.s8p` (`tools/system8/s8files.py check`, `tests/roland-system8-sd.test.js`).

### Folders and names (OS strings 0x6000B677 .., 0x6000D4C3 .., 0x6001C6E8 ..)

| Folder on the card | Files | Unit menu |
|---|---|---|
| `ROLAND/SYSTEM-8/EXPORT/PATCH` | `*.s8p` (default `sys8_pat.s8p`, `EXPORT%03d`) | patch mode: UTILITY > IMPORT, Src EXPORT |
| `ROLAND/SYSTEM-8/EXPORT/PERFORM` | `*.s8f` (default `sys8_prf.s8f`) | performance mode: IMPORT, Src EXPORT; patch mode: Src EXPORT (Perf) for its patches |
| `ROLAND/SYSTEM-8/BACKUP` | `*.bin` (default `sys8_bak.bin`, `BACKUP%03d`) | UTILITY > RESTORE (everything); IMPORT Src BACKUP (one patch or performance) |

The export also writes a `.tsv` listing (`sys8_pat.tsv`); no reader needs it. The name editors take 12 characters;
the editor writes up to 12 letters, digits, `_` and `-` (`cardName`).

### The container (header FUN_6000CB3E, chunk header FUN_6000CC04, checks FUN_6000C76A / C71E / C6E8 / C672)

| Offset | File header (0x30) | Chunk header (0x20), then the data |
|---|---|---|
| 0 | magic `S8P `, `S8F ` or `SYS8` | tag (`NAME`, `PLG `, `PATs`, `PRFs`, `SYS `, `PRF `, `PAT `, `PAT2`, `PAT3`, `TMOD`) |
| 4 | 0 (checked) | 0 (checked against the reader's table) |
| 8 | chunk count (1 .. 3 / 2 / 7, checked) | data size (checked: count x entry size, or the backup table's size) |
| 0x10 | 16 spaces | count |
| 0x14 | | entry size |
| 0x18 | | CRC32 of the data (checked on import / restore) |
| 0x1C | | CRC32 of the chunk header's first 0x1C bytes (checked) |
| 0x28 | CRC32 of all chunk headers (checked) | |
| 0x2C | CRC32 of the header's first 0x2C bytes (checked) | |

CRC32 is the zlib one (the BMC's own routine at 0x0100FF68 .. FFC8 in the kernel RAM). The `.s8p` and `.s8f` readers
seek by position: the chunks must come in the order NAME, PLG, PATs (NAME, PRFs).

| File | Chunks (count x entry) |
|---|---|
| `.s8p` (FUN_6000DC78 writes, FUN_6000D698 reads one patch) | `NAME` n x 16 (the name from the patch's 4 name words, high byte first), `PLG ` n x 32 (u16 model id, u16 version, 12 zero bytes, name[16] of the engine: the slot table 0x60AC1DF8; the import list keeps only the patches whose model id is the chosen slot's), `PATs` n x 16808 |
| `.s8f` (FUN_6000E9E8 writes, FUN_6000E054 reads) | `NAME` n x 16 (performance name), `PRFs` n x 35360 = the performance (1744) + the patch its upper part points at + the lower one (16808 each, from memory: PART Slot x 64 + PART Memory) |
| backup `.bin` (FUN_6000B552 writes, FUN_6000B2D0 restores one chunk) | `SYS ` 1 x 2196 (the SYSTEM menu: groups sys_com .. sys_extd), `PRF ` 64 x 1744, `PAT ` / `PAT2` / `PAT3` 256 x 512 / 2200 / 14096 (slot x 64 + patch), `TMOD` 8 x 3360, `PLG ` 4 x 32 |

### Entries: the OS's internal structs

One 32-bit little-endian word per OS parameter, the catalog groups back to back, each group's parameters (reserved
ones included) in address order (`roland-system8-sd.js` `MAP`, from `OS_GROUPS`): PAT = lfo .. extend (64 panel
words) + pat_name (16 name words, 48 more: PAT_NAME1-3); PAT2 = pat2_lfo .. pat2_extd (17 groups, 2200); PAT3 =
pat3_seq_com + 64 steps of 54 words + g129 (14096); PRF = pfm_com .. pfm_extd (1744). A word is the SysEx raw
value minus the bias for the parameters stored with a bias (type 200h: chord notes, NONE = FFFFFFFFh), else the raw
value (8-nibble values as their bit pattern). Every byte of a sound (20195) and of a performance (2709) is exactly one
word (test); the plugin's own preset bank (SysEx layout, `Patch/2 Preset.bin`) converts to the factory `.s8p`
entries byte for byte (64 of 64). A backup the SYSTEM-8 wrote itself (the user's card, `sys8_bak.bin`, copied to
`re/system8/sdcard-user/`) passes the same checks; all its 256 patches convert to SysEx and back to the same words once a
biased value is taken as signed in its nibbles (a JUPITER-8 OSC2 Coarse Tune of -12 is FFh, +12 is 17h with bias 11:
engines go one step past the catalog's -11 .. +11).

### What import and restore do

* IMPORT (Src EXPORT, `.s8p`): checks the container (above), lists the file's patches whose engine model id equals
  the chosen slot's, loads the chosen one into an extra RAM patch (patch 257) and from there into the temporary patch
  to audition; WRITE then saves it. Nothing is saved by the import itself.
* IMPORT of a performance (`.s8f`): the performance settings only; its patches are imported in patch mode
  (Src EXPORT (Perf), which lists the two patches of each performance whose model id fits the slot).
* RESTORE (FUN_60077D48): reads every chunk of the file whose tag it knows straight into its RAM area (unknown tags
  are skipped, a chunk whose size differs is refused), then saves SYS, PRF, PAT, PAT2 and PAT3 to the flash and asks
  for a power cycle. A file without `SYS ` / `TMOD` / `PLG ` leaves those as they are: the editor's restore file holds
  `PRF ` (when the performances were read) and `PAT ` / `PAT2` / `PAT3` only, because the SYSTEM menu settings have no
  SysEx address. IMPORT with Src BACKUP needs all seven chunks in order (it seeks by position), so it does not list the
  editor's restore files; the `.s8p` files are the way to import single patches.

### "Save to SD card..." (the editor)

The page action asks what to save (the patch or performance on the page; a bank of 64 read from the unit or from a
Branch Library bank entry; all 64 performances with their patches) and a file name, builds the file, runs the OS's
checks on it (`osCheck`), and writes it into the SYSTEM-8 folders of a card or folder the user picks (File System Access
API: Chrome, Edge, the desktop app; the card itself, its ROLAND folder or its SYSTEM-8 folder may be picked; an existing
file is replaced only after a question; other browsers download the file). It ends with the steps on the unit
(`UNIT_STEPS`). A `.s8p` entry carries the engine of its slot: SYSTEM-8 5 / 1.20, a PLUG-OUT's model id and version from
the slot record (or the user's choice when the unit is not connected). `backupFile` (a RESTORE file without the SYSTEM
settings) is written and checked but not offered: a RESTORE of it is untested on the unit.

**On the unit (2026-11-27):** the test files (`MMSDTEST.s8p`, `MMSDJUNO.s8p`, `MMSDBANK.s8p`, `MMSDPERF.s8f`) were read
correctly, but IMPORT loads one patch (or performance) at a time into the edit buffer and saves nothing; each must be
kept with WRITE. The user: not a usable way to save a set of sounds. RESTORE is the only bulk path and is untested.

`tools/system8/sd_files.mjs BACKUPDIR SLOT3DIR CARD [--restore]` writes test files from a backup straight onto a card.

## Saving over MIDI (the patch-bank markers)

DT1 writes into user memory change only the RAM copy; the flash is written by save objects (FUN_60009B56 range save,
FUN_60009C22 whole area): WRITE saves one patch (FUN_60016EE6: PAT, PAT2, PAT3 of that number) or one performance
(FUN_60016E6A); the system WRITE saves SYS; factory reset, RESTORE and PLUG-OUT removal save whole areas. The only
MIDI-reachable save is the bank receive that Roland's plugin uses after an install:

1. `70 20 01 01` [n] (handled in the kernel's SysEx library, struct at 0x20000308: n at +200h) opens the "Receiving"
   screen (proc 0x60029128, screen FUN_60028E70 / FUN_60028EAA: n expected, a 15 s timer).
2. Its job (FUN_60028E52) counts, over all 256 patches, those flagged as written since they were last saved (the
   parameter manager's flags of the PAT / PAT2 / PAT3 groups, FUN_600070BA). They must all be in one slot (else error)
   and must not exceed n.
3. When the count reaches n and `70 20 01 02` [flag] has arrived (+202h >= 0), and the slot is not a RAM-only "try"
   PLUG-OUT, it shows "Writing!" and saves that slot's 64 patches to the flash (FUN_60028CB8 -> FUN_60028C40).
4. 15 s without a new patch: the slot is reloaded from the flash instead (FUN_60028D06), the bank is lost.

Read from the code, a bank sent between the markers is saved only when nothing was written into another slot since
the last save or power-on; the phase-4 tests broke that rule. **Checked on the unit 2026-11-27 (phase 5,
`tools/system8/keep_test.py`): the markers did not open the "Receiving" screen.** Right after a power cycle (nothing
written before), the SYSTEM-8 bank was sent between the markers (64, flag 1) with H-8 renamed: all 6146 messages
arrived (H-8 read back renamed), the user saw no change on the display, and the bank was not reloaded from flash either
(H-8 still renamed minutes later), so the receive job never ran. A second try sent Roland's plugin queries first
(`70 00 02 00` .. `02 03`, the four slot records, all answered): the same. The condition that opens the screen sits in the
kernel's SysEx library, which the OS dump does not hold. **No MIDI save is confirmed: WRITE on the unit, or an SD-card
file (import, then WRITE; or RESTORE) keeps sounds.** `keepBank` / `keepBankMessages` (`roland-system8-install.js`) and
the simulator's model of the code (`saves`, `refused`, `powerCycle`) stay for a later test; no page offers it.

The kernel code at 0x01000000 .. 0x010143AB (the SysEx library, CRC32, file I/O) is copied there from the OS image at
start-up; the dumped OS image has that source area reused as RAM, so the `70 20` handler itself is not in the dump.

## Struct layouts (editor: `js/devices/defs/roland-system8-mem.js`)

Leaf k of `patch2`, `patch3` and the performance starts at packed offset `k * 0x800` (b2 += 10h; b1 += 1 per 8
leaves). The editor keeps each struct's leaves back to back ("compact"): a sound = patch (640) + patch2 (3975) +
patch3 (15580) = 20195 bytes.

| Struct | Leaves (bytes) | Content |
|---|---|---|
| patch2 | 240 x 5, 234, 234, 240, 240, 240, 230, 216, 212, 233, 222, 234, 240 | 0 LFO RATE H (float), 5 FILTER VELOCITY SENS + CUTOFF H, 6 AMP VELOCITY SENS, 8 Patch Tempo, 9 comment (40 characters), 10 delay, 11 chorus, 12 flanger, 13 MFX, 14 reverb, 15 chord memory, 16 rating; leaves 1-4 and 7 are 0 in every patch of every slot |
| patch3 | 236 x 65, 240 | 0 sequencer common, 1-64 the steps (8 notes, 8 velocities, 8 gates, note/slide/mute flags, 4 assign targets/values/transients, assign flag), 65 unused |
| performance | 228, 226, 226, 225, 211, 230, 216, 212, 233, 222, 240, 240 | the OS's group names (0x6003B846): Perform Common, Upper, Lower, CV Gate, Input, Input Dly, Input Cho, Input Fl, Input MFX, Input Rev, Name, Extend; Input Dly ... Rev have exactly the patch2 effect leaves' layout |

### Performance (OS groups pfm_com ... pfm_name: every byte)

| Leaf + byte | OS name: values (screen texts of the OS catalog) |
|---|---|
| Common 0-3 | Perf Mode DUAL / SINGLE; Perf Lev -INF, -53.0dB ... +10.0dB (the OS's 128-step table: 107 = 0.0dB, not linear); PartBalance LW64 ... 0 ... UP63; Tempo Src KNOB / PERF |
| Common 4-7 | Perf Tempo 400-3000 = 40.0-300.0 (4 nibbles) |
| Common 8-19 | Octave 0-6 = -3 ... +3; Transpose 0 ... +11; Arp Src UPPER / LOWER; Arp Dst UPPER / LOWER / UP&LW; Arp Switch; Chord Src; Chord Dst; Chord Switch; Prm Src (CV/GATE OUT) SYSTEM / PERFORM; Carrier (INPUT (Voc)) UPPER / LOWER / UP&LW; Prm Src (INPUT) SYSTEM / PERFORM; KEY HOLD |
| Common 20-227 | reserved (26 words) |
| Upper / Lower 0-17 | PART SW; PART Slot SYSTEM-8 / PLUG-OUT 1-3; PART Model (2 nibbles: the engine's model id, 5 = SYSTEM-8); PART Memory A-1 ... H-8; Level (the level table); Pan L5 ... CENTER ... R5; Octave -3 ... +3 (stored + 3); Transpose -12 ... +12 (stored + 12); Fine Tune -100 ... +100 (2 nibbles, stored + 100); Range Lower / Upper (notes); Rx Bend, Rx Mod, Rx Hold, Rx Express; Mute |
| CV Gate 0-8 | Prm Src CONTROLLER / SOUND MODULE; Src (the menu's list: ALL, USB OMNI, USB CH1-16, MIDI IN OMNI, MIDI IN CH1-16, KBD(U&L), KBD(U), KBD(L), STEP SEQ(U), STEP SEQ(L) = 0-39); Asgn Mode TOP / BOTTOM / LAST; Bend Range 1-24; Portamento OFF / ALWAYS / LEGATO; PortTime; Src UPPER / LOWER (the menu's PATCH (L) / (U) = Prm Src SOUND MODULE + this); Asgn Mode; Ref Note C0-C4 |
| Input 0-18 | Input Effect; INPUT EFFECT TYPE (0 = VOCODER); INPUT(Dly) Type DLY / PAN / CH1 / CH2 / FL / DLY+CH, Time, Level (OFF, 1-255); INPUT(Rev) Type AMBI / ROOM / HALL1 / HALL2 / PLATE / MOD, Time, Level; Tempo Sync; Formant; Consonant -40dB ... +40dB; Balance D128 ... 0 ... W127 |
| Input Dly / Cho / Fl / MFX / Rev | the patch2 effect leaves' layout and texts |
| Name | PERFORM NAME 000-003 ... 060-063: 16 words of 4 characters (the unit uses the first 16 characters) |

## OS parameter catalog (OS 1.32, `tools/system8/os_tables.py` -> `re/system8/osdump/os_params.json`)

The OS keeps one record per parameter, 6783 in 129 groups (sys_com, plugout, sys_cal, sys_cvgate, sys_input,
sys_in_dly/cho/fl/mfx/rev, sys_scale, sys_extd, stp_com, stp_ctrl, arp, scat, stp_seq, led, stp_extd, syn_com, note,
midi, grf, syn_extd, pfm_com ... pfm_extd, lfo ... extend, pat_name, pat2_lfo ... pat2_extd, pat3_seq_com,
pat3_seq_step0-63, test groups). `gen_fw_js.py` puts the SysEx-reachable groups into `roland-system8-fw.js`
(OS_GROUPS, OS_TABLES, OS_CC, OS_LEAVES); `roland-system8-os.js` turns them into editor parameters.

| Address | Table |
|---|---|
| 0x600ED688 | group keys |
| 0x600ED8C8 | parameter names (the OS's labels) |
| 0x600F42C4 | value descriptions: the screen texts in the OS's mini language (below) |
| 0x6009D9A8 | 32-byte records: default, min, max, bias, type << 16 + struct offset, group, SysEx address (FFFFFFFF = none) |
| 0x600FB3D8 | the CC map |
| 0x600D2988 | the SysEx leaf map |
| 0x6009C538 | the parameter manager's descriptor (records, group ranges, CC map, leaf map) |

Type bits: low byte = nibbles << 4 + 4 (14h = one 7-bit byte); 100h read only; 200h stored with the bias (stored =
value + bias: perf part Octave, chord notes 0 = NONE); without it a negative range is a two's-complement number of
its nibbles (patch OCTAVE SHIFT FFFFFFFD = -3); 400h no SysEx address; 800h reserved. Checked against the factory
data and on the unit: the OS clamps DT1 data to the record's range (`tools/system8/clamp_check.py`, 2026-11-27: Patch
Tempo 0 -> 400, 3500 -> 3000; step Gate 0 -> 1, 127 -> 100; chord note 144 -> 128). The plugin scripts' ranges for
these (Patch Tempo 0-2600 default 800, step Gate 0-99 default 49) are not the unit's: factory patches with Patch
Tempo 800 play at 80.0 on the unit, step gates of 49 are 49 %. The patch struct's panel values belong to the engine:
their catalog records are the SYSTEM-1 era's (OSC variations 1-2 where the SYSTEM-8 engine has 4), so the editor keeps
the plugin's ranges there and takes only the texts.

Value descriptions (the OS formatter PRM_FormatValueText at 0x6005032E, ported in `roland-system8-os.js`): `\x01`
separates list items, `\x02` range anchors, `\x03[TAG]` a special formatter, `\x04` a first value apart from a range,
`\x05{unit}`, `\x06(n)` an offset added to the value, `\x07<n>` n decimals. Tags: [KEY] note names (`C -` ... `G 9`:
the OS prints the octave as one character, `-` = -1), [PART_LEV] the level table, [PART_BAL] LW / UP, [PAN] L / R /
CENTER, [VOC_BAL] D / W, [HI_CUT] / [LO_CUT] / [HDMP_F] / [LDMP_F] frequency tables, [DMP] 0.5 dB steps, [PRE_DLY]
0.5 ms steps, [TUNE] 430.0-450.0Hz, [OSC3_TUNE] the cent table, [BANK_NUM] MANUAL / A-1 ... H-8, [FLOAT], [4CHAR].
Where the formatter prints only a number for a scale (EXT GAIN x0 ... x4, EXT OFFSET -1.0V ... +1.0V, LFO CV GAIN x0.0
... x2.0) the editor shows the number with the anchors in the help.

What the catalog settles: the system block (below); every performance byte (above); MONO SW = POLY / MONO / UNISON;
F / A ENV VARIATION = TYPE1-3; CHORD MEMORY Form = 1-10, USER; chord notes NONE, C-1 ... G9 (stored note + 1);
CHORUS / FLANGER / MFX LFO SOURCE = INT / EXT; MFX TYPE, PARAMETER 01-16 and ASSIGN RANGE 0-255 (numbers), ASSIGN
TARGET PARAMETER 1-16; step sequencer SMOOTH AUTO / OFF / ON, DUMMY1/2 0-1; step flags and assign targets / values are
raw 32-bit words for the OS too (NOTE FLAG, SLIDE FLAG, MUTE FLAG, ASSIGN FLAG, PARAMETER ID, PARAMETER VALUE); the
effect types' short screen names (DLY, PAN, CH1 ...); the patch name area holds 64 characters (PATCH NAME 000-003 ...
060-063), the unit uses 16. The comment (patch2 leaf 9) and the rating (leaf 16) are words the OS reserves; the plugin
keeps its comment and rating there.

The SYSTEM menu (sys_com: LCD Contrast, LED Bright, Knob LED, Auto Off, Startup, Knob Mode, USB Drv, Velocity, Fixed
Velo, Velo Crv, Velo Offset, Hold / Exp Polarity, Local Sw, Master Tune, Boost Mode, OutputGain, TempoSync, Rx
StartStop, Sync Output, Click, Device ID, Remote Kbd, Omni Mode, Patch / Perf / Upper / Lower Ch, Tx / Rx Prog Chg,
Tx / Rx Bank Sel, Tx / Rx Edit Data, USBMIDI Thru, Soft Thru ...; sys_cvgate, sys_input, sys_scale, the calibration)
has no SysEx address: the unit keeps it out of the SysEx map, so no editor can read or write it over MIDI.

### System block `01 50` = Setup Common (stp_com)

| Byte | OS name: values |
|---|---|
| 00 | MODEL (Read Only): 2 = SYSTEM-8 (SYSTEM-1 / SYSTEM-1m / SYSTEM-8 = 0 / 1 / 2) |
| 01-03 | MANUAL FLAG (PATCH / PERFORM Upper / Lower): MEMORY / MANUAL |
| 04-06 | EDITED FLAG (PATCH / PERFORM Upper / Lower): NO EDITED / EDITED |
| 07 | PATCH or PERFORM (the OS name; on the unit this byte toggles 0 / 1 at every program change received in patch mode, checked 2026-11-27: an internal two-buffer flag rather than the mode) |
| 08-0D | CUR_PATCH_NUM, _UPPER, _LOWER (2 nibbles each): PLUG-OUT 0 A-1 ... PLUG-OUT 3 H-8 (slot x 64 + patch) |
| 0E | CUR_PERFORM_NUM A-1 ... H-8 |
| 0F-12 | Current Bank (PATCH, PERFORM Upper, PERFORM Lower, PERFORM): A-H |
| 13-15 | MODEL (PATCH, PERFORM Upper, Lower): PLUG-OUT 0-3 |
| 16, 17 | PANEL SELECT UPPER / LOWER; SYSTEM MODE NORMAL / TEST |
| 18-14F | reserved (39 words of 8 nibbles) |

On this unit: model 2, upper patch A-3 (bytes 0A 0B = 00 02), lower D-7 (0C 0D = 01 0E), lower bank D. The editor
reads it, shows it with these texts and sends it only on request (it is state, not settings; what writing it does is
untested).

## Value sources

| Values | Screen texts from |
|---|---|
| Patch panel values (patch struct) | names: Roland's plugin script; ranges and storage: the plugin script (the engine's); texts: the unit's region 0 lists (waves, ranges, variations, filter types, patch cords) and the OS catalog for the rest (MONO, envelope variations, LFO CV GAIN, CONDITION, arpeggio, effect / delay / reverb types, OSC3 tune ...); delay time and LFO rate synced to tempo, PORTA TYPE: the plugin's tables (the OS has none) |
| patch2 / patch3 (effects, chord memory, sensitivities, tempo, step sequencer) | the OS catalog: ranges, storage, defaults and texts (the OS clamps to them) |
| Performance, setup block | the OS catalog (CV/GATE OUT Src: the menu's list at 0x6009A9A4) |
| PLUG-OUT engines | each engine's region 0 (pages, labels, lists, ranges), its plugin script (names), the OS catalog for the values no page shows |

## PLUG-OUT library and install (phase 4: `roland-system8-install.js`)

### What the OS does (PLUGOUT_HandleInstallDT1 at 0x60006084 and its helpers, OS 1.32)

The handler keeps one transfer state (0x6044DBD4: mode, byte position, record counter, 16-bit byte sum, slot) and a
2 MB RAM buffer (0x6044DDE8):

| Message | What the OS does | Answer |
|---|---|---|
| START `70 10 00 00` [slot + flags] | slot > 3: 08. A transfer already running: drops it, answers 64h (the new one is **not** started: send START again). The screen check FUN_6001864A(0x2731) fails: 07. Else state reset, mode 1 (flags 40h: mode 2), a "receiving" message to the UI | `71 10 00 00` [code] |
| `70 30 00 nn` (2^nn bytes, 7-in-8; the length must be 2^nn / 7 + 2^nn + 1) / `70 30 01 nn` [0 / 1] | only while a transfer runs (else ignored, no answer): bytes into the RAM buffer, sum += bytes, record counter + 1; more than 2 MB: the transfer is dropped and the record refused (code 01) | refused: `71 30 00 00` [code] |
| flow control `70 30 03 00` [00] | answers the **record counter** (records received since START) | `71 30 03 00` + 4 nibbles |
| abort `70 30 02 00` [00] (also `70 40 01 00` [00]) | drops the transfer | `71 30 02 00` [00] |
| END `70 10 00 01` + 4 nibbles | slot > 3: 08; sum differs: 03; not 2 MB: 02; region 0 checksum (its header's compressed size / sum) or the unpacking (FUN_600521FE) fails: 04. Mode 1: erases and writes the slot's 2 MB of flash (table 0x60095234), then answers; mode 2: only marks the slot (0x602B91A4[slot] = 1: loaded from RAM, not written: Roland Cloud's unauthorised "try" mode, the SDK web page's flag) | `71 10 00 01` [code] |

So the flash is written only after a complete transfer passed every check: a transfer that stops early (Stop, a
refused record, a hang) leaves the slot's PLUG-OUT as it was. The editor always installs with flags 0 (mode 1,
written to the flash), as Roland's authorised plugin and `os_dump.py --install` do. The patch-bank brackets
(`70 20 01 ..`) and the `70 00 ..` queries are handled outside this handler (not traced; Roland's plugin sends the
brackets, so does the editor).

### Containers in the Branch Library (`def.files`, kind `plugout`)

"Import PLUG-OUT container..." (accept `.dat`) reads the container (`readContainer`): the chained XOR, the header
(name, model id, version), every record (Roland checksum, `70 30 00 nn` length, filler data), the flash image they
write (2 MB for the SYSTEM-8), its 16-bit sum against the END record, both regions (`SYSTEM-8:Plugout`, the
compressed bytes against the header checksum the OS checks) and the slot each region is linked for (SYNINFO init
pointer: region 0 at 61600000h + slot x 200000h, region 1 at 60800000h + slot x 200000h; JUNO-106 Code8_3.Dat:
61D1823Dh and 60E10E21h = slot 3). Refused: anything without the PLUGOUT_SYS_INF header, damaged files, SYSTEM-1
builds (the plugins' `Code1.Dat`, 2048 records, `SYSTEM-1:Plugout`), the SYSTEM-1's own `UPD_POUT_INFO` update
(START at `70 20 00 00`), regions linked for different slots, and slot 0 builds (`SYSTEM-8\Script\Code8_0.Dat`,
the engine itself). Checked on all 37 containers on this PC (`tests/roland-system8-install.test.js`). The entry is
named "JUNO-106 1.07 for PLUG-OUT 3"; Export writes the file back unchanged.

### Install (entry action "Install...", needs `sysex` = SYSTEM-8 CTRL)

1. Reads device type (2), the slot count and the four slot records; refuses an OS before 1.31, a container built for
   another slot than the one chosen ("each slot has its own build"), and a PLUG-OUT that another slot already holds
   (Roland's plugin refuses it too).
2. Asks the slot (1-3, with what each holds) and the patch bank to write afterwards: none, or a Branch Library entry
   holding the 64 complete patches of one slot (a slot backup below, or a complete dump's "PLUG-OUT n patches (64)"
   entry; a backup made from another PLUG-OUT is not offered).
3. Confirms: "PLUG-OUT n (now ...) and its 64 patches are replaced by ...; do not switch the SYSTEM-8 off".
4. A background transfer (`startTransfer`: exclusive port, progress and Stop on the Branch Library page): START [slot]
   (5 s, one try: codes 07 / 08 / 64h explained); the 4096 records exactly as stored (device ID set), paced at 32000
   bytes/s (the SDK web installer's pace: Web MIDI's send never blocks), with the flow-control query before every
   32nd record (i % 32 = 31); its reply must come within 5 s and must equal the records sent so far, else the job
   stops at once with "the SYSTEM-8 did not answer: power-cycle it, then install again" (or "records were lost"),
   never retried; `71 30 00 00` at any time stops it; END (20 s); after any stop the editor sends the abort `70 30 02
   00` [00]. Then (1 s later) the slot record must show the container's model id and version.
5. The patch bank, as Roland's plugin writes it: `70 20 01 01` [64], the 64 patches (patch, patch2, patch3 leaf by
   leaf, re-addressed to the chosen slot), `70 20 01 02` [0], at restore.py's pace (4 ms + 0.02 ms per byte, about
   50 s).

JUNO-106 1.07: 426 KB, about 14 s plus 50 s for the patch bank.

### Backing up a slot ("Back up a PLUG-OUT slot..." on the PLUG-OUT patches page, "Back up this slot" on a container)

The SYSTEM-8 cannot send a PLUG-OUT back, so a slot backup is a pair of Branch Library entries: the container of
what the slot holds (found in the library by name, model id, version and slot; else the user picks the Roland Cloud
file `C:\Program Files\Common Files\VST3\Roland\<name>\Script\Code8_<slot>.Dat`, which must match; without it
the patches alone) and "PLUG-OUT n backup <date>: <name> <version> (64 patches)": the unit's own DT1 messages (6144)
read in a background job. The notes end with "PLUG-OUT backup: slot n, model m, version vvvh", which the install
dialog uses to offer it as the patch bank.

### From the Head Library ("Install a PLUG-OUT from the Head Library..." on the PLUG-OUT patches page)

Lists the Head Library rows of kind `plugout` for the SYSTEM-8 (the "PlugOuts" sub-library that
`tools/system8/plugouts_to_library.mjs` writes: the container in `native.bytes`), reads the chosen one
(`lib.getPatch`, base64), checks it with `readContainer` and runs the same install as the Branch Library's "Install..."
(slot, patch bank, Roland's plugin rules, the background transfer). The PLUG-OUT patches object is keyed
`plugoutpatch` (was `plugout` until phase 5): the generic Head Library code loads a row into the object whose key is
the row's kind, so a `plugout` container row would have loaded into it as patch data. The generic Send-to of a
`plugout` row from the Head Library page therefore finds no object; a generic hook for file kinds is described to main
(handoff).

## PLUG-OUT engine editors (`roland-system8-engines.js`, data `roland-system8-plugouts.js`)

One catalog entry per engine (`roland-system8-jupiter8`, `-sh101`, `-juno106`, `-jx3p`, `-juno60`, `-jupiter4`,
`-promars`, `-sh2`, `-system100`: "SYSTEM-8 PLUG-OUT <name>"), generated by `tools/system8/gen_plugouts_js.py` from
each engine's region 0 image (SYNINFO model id and version; pages with the OS parameter ids, the engine's own labels,
ranges, value lists and display kinds: 0 / 2 number, 1 bipolar, 4 list, 5 variation) and its plugin's `Script.xml`
(names, ranges, defaults of the patch struct). The patch struct keeps the SYSTEM-8 layout (OS id 1741 = offset 0);
values on no page of the engine stay in "Off the panel" (raw); patch2 / patch3 are the SYSTEM-8's OS parameters. Each
editor reads and edits the temporary patch, reads / stores / recalls the patches of PLUG-OUT slots 1-3 ("Find its
slot" reads the slot records `70 00 01 00`), and translates (exact within the engine; cutoff, resonance, the two
envelopes and the LFO rate from other instruments). The unit's own 192 PLUG-OUT patches (JUPITER-8, SH-101, JUNO-106)
decode within every range (test). The images used are the Roland Cloud versions (JUPITER-8 1.08, the unit has 1.06).

## Checked on the unit in the browser (2026-11-27, SYSTEM-8 CTRL, scratch Chrome)

| Check | Result |
|---|---|
| SYSTEM-8 H-8: read, store a changed copy, read back, recall (bank 85/0 + PC), read the temporary patch, live edit (FILTER CUTOFF), store the original back | identical at every step; the temporary patch after the recall equals the stored patch struct; the live edit read back |
| Engine editors: JUPITER-8 (PLUG-OUT 1), SH-101 (2), JUNO-106 (3) H-8: the same sequence | identical at every step |
| Temporary performance: Perf Tempo, Upper Level, Perf Lev edited live and back | read back each time; the performance identical afterwards |
| Performance H-8: store a renamed copy, read back, store the original back | identical |
| "Find its slot" (engine editor), "Show the PLUG-OUT slots" | JUNO-106 in PLUG-OUT 3; OS 1.32 and the four slot records |
| "Back up this slot" (PLUG-OUT 3) | 64 patches in 10 s; equal byte for byte to backup.py's slot3.syx |
| Complete dump into the Branch Library (one step per bank) | 2 min 5 s, 6 entries (performances, 4 banks, system); every byte equal to backup.py's areas |
| PLUG-OUT install from the editor (after a power cycle): JUNO-106 1.07 (`Code8_3.Dat`) into PLUG-OUT 3 with the slot backup as patch bank | 1 min 14 s: the 4096 records in about 13 s, all 128 flow-control replies equal to the records sent, END 00 after about 5 s (the flash write), slot record JUNO-106 1.07, the 6146 patch-bank messages in about 50 s; slot 3's 64 patches read back identical to the backup |

### DT1 persistence (checked 2026-11-27 with two power cycles, `tools/system8/persist_test.py`)

| Test | Written (each read back before the power cycle) | After the power cycle |
|---|---|---|
| 1 | the whole SYSTEM-8 bank between the patch-bank brackets (`70 20 01 01` [64] ... `70 20 01 02` [1]) with H-8 renamed; then H-7 renamed by plain DT1; performance H-8 renamed by plain DT1 | all three had their old names |
| 2 | JUPITER-8 H-8 and performance H-8 renamed by plain DT1; then the SH-101 bank and the SYSTEM-8 bank, each between the brackets with **flag 0** (what Roland's plugin sends after a fresh install), H-8 renamed; then SYSTEM-8 H-7 renamed by plain DT1 | all five had their old names |

**No DT1 write into user memory survives a power cycle by itself**: the unit keeps such writes until it is switched
off; WRITE on the panel saves one patch or performance. Both tests also sent banks between the markers, but each had
writes in other slots before them; the phase-5 tests without such writes did not open the OS's receive screen either
(section "Saving over MIDI"). A PLUG-OUT install itself is kept (the OS
writes the slot's flash at END). Without MIDI, the SD-card files ("Save to SD card...") bring patches and
performances to the unit through IMPORT (then WRITE) or RESTORE.

## Plan

1. **Phase 3** (2026-11-27): OS dump complete and read; system block, performance, OS texts, CC map, install
   handler; engine editors.
2. **Phase 4** (2026-11-27): PLUG-OUT library, install and slot backup; browser checks, the first live install from
   the editor and the DT1 persistence tests (above).
3. **Phase 5** (2026-11-27): SD-card formats and "Save to SD card..."; the bank receive of the OS (read, not triggered
   on the unit: no MIDI save); PLUG-OUT install from the Head Library. Open: a RESTORE round trip (only with the user's
   OK).
