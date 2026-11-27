# Roland SYSTEM-8: MIDI implementation, PLUG-OUT format and firmware

Status (2026-11-26): phase 1 of the editor job (inventory, protocol, live backup). Work notes and the unit's
state are in [roland-system8-handoff.md](roland-system8-handoff.md). Work files (firmware, Roland Cloud plugin
scripts, decoded images, backups) are in the gitignored `re/system8/`; scripts in `tools/system8/`.

## Sources

| Source | What it gives |
|---|---|
| System program 1.32 (`z:\firmwares\Roland System 8_sys_v132 .zip`, `system8_sys_v132.zip` on static.roland.com; the newest on Roland's support page, 2026-11-26) | OS (encrypted), the SYSTEM-8 engine (slot 0) and the factory PLUG-OUT images |
| Roland Cloud plugins installed on this PC (`C:\Program Files\Common Files\VST3\Roland\<name>\Script\`) | `Script.xml` = the device memory map with names, ranges and defaults; `Code8_<slot>.Dat` PLUG-OUT containers (SYSTEM-8 itself, JUPITER-8, JUNO-106, JX-3P, JUNO-60, JUPITER-4, PROMARS, SH-101, SH-2, SYSTEM-100); banks in `C:\ProgramData\Roland Cloud\<name>\` |
| Roland manuals (static.roland.com): `SYSTEM-8_reference_eng04_W.pdf`, `SYSTEM-8_eng02_W.pdf`, `SYSTEM-8_MIDI_Imple_Chart_e01_W.pdf`, the JUPITER-8 / JUNO-106 / JX-3P parameter correspondence tables | menus, value ranges, CC list, bank select (MSB 85, LSB 0 SYSTEM-8, 1-3 PLUG-OUT 1-3) |
| `SYSTEM-8_Sound_Bank_For_V120.zip` | the `.s8p` export format (see below) |
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
the performance, system and step-sequencer menus are in the encrypted OS.

## MIDI ports

| Port (Windows) | Role | Answers |
|---|---|---|
| `SYSTEM-8` | normal MIDI: notes, CC (MIDI implementation chart), program change, bank select, clock, start/stop | no SysEx reply (Identity Request is not answered on any port, nor on DIN) |
| `SYSTEM-8 CTRL` | editor / PLUG-OUT port: Roland SysEx model `00 00 7E`, RQ1 and DT1 to the whole memory, PLUG-OUT install | every request below |

## SysEx

`F0 41 dev 00 00 7E cmd a1 a2 a3 a4 ... sum F7`, `dev` = 10h (Device ID 17, SYSTEM: Device ID 17-32).
`cmd` 11 = RQ1 (`size` as 4 x 7-bit bytes), 12 = DT1. The Roland checksum covers address and data.
Addresses and sizes are 7-bit packed (each byte 0-7F). The unit answers an RQ1 with one DT1 per leaf (sub-block)
inside the requested range, splitting leaves longer than 240 bytes into 240-byte messages. An RQ1 whose start is
not the start of a leaf gets no answer. Replies to the edit-buffer areas take more than 50 ms.

### Address map (scan of every `b0 b1 00 00`, `tools/system8/scan_map.py`)

| Address | Block | Leaves / size |
|---|---|---|
| `01 50 00 00` | system settings (not in the plugin scripts; to decode) | 2 (240 + 96 bytes) |
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
| `70 10 00 00` [slot or 40h] | `71 10 00 00` = 00 | START of an install |
| `70 30 00 09` + 586 bytes | (`71 30 00 00` = error) | one 512-byte flash block, 7-in-8 (bit j of the first byte = bit 7 of byte j) |
| `70 30 01 09` [01] | | an erased block (filler) |
| `70 30 03 00` [00] | 4 bytes | flow control, before every 32nd record |
| `70 10 00 01` + 4 nibbles | `71 10 00 01` = 00 | END: 16-bit sum of the 2 MB flash image |
| `70 20 01 01` [n] / `70 20 01 02` [0/1] | | patch bank start / end (the plugin writes its 64 patches between them) |

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

## `.s8p` patch export (SD card, `ROLAND/SYSTEM-8/EXPORT/PATCH`)

48-byte header `"S8P "`, version 3; chunks of 0x20-byte headers (`tag`, size, count, entry size, 8-byte hash):
`NAME` (64 x 16), `PLG ` (64 x 32), `PATs` (64 x 16808). Not decoded further yet.

## Plan

1. **Phase 2**: decode the performance (`04`, `10`-`17`) and system (`01 50`) blocks; confirm the three
   temporary-patch copies; restore script + byte-for-byte compare; dump the OS plaintext from the unit with the
   SDK's region-0 bulk hook (needs a temporary custom PLUG-OUT in slot 2 or 3, restored from the Roland Cloud
   container afterwards) to read the OS menus and parameter labels.
2. **Phase 3**: editor definitions: `roland-system8.js` (patch, patch2 effects/chord, step sequencer, performance,
   system, slots, fullDump, libraryItems, translator) and one engine definition per PLUG-OUT (labels and value
   lists from each region 0, layout from `Script.xml`).
3. **Phase 4**: PLUG-OUT library: import `Code8_*.Dat` / plugin folders / SDK builds, show their identity, install
   into a slot from the editor (Web MIDI SysEx on `SYSTEM-8 CTRL`), back up slot patches; simulator; live checks;
   restore and verify the unit.
