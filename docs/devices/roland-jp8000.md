# Roland JP-8000: MIDI implementation from the OS v1.05 firmware

The editor (`js/devices/defs/roland-jp8000.js`) is the JP-8000 model config over the code it
shares with the JP-8080 editor (`roland-jp.js`). Its tables are in `roland-jp8000-fw.js`, which
`tools/roland/jp8080_fw.py` regenerates from `jp8000_v1.05.bin`. Read
[roland-jp8080.md](roland-jp8080.md) first: everything there applies unless it is listed below.

**Not checked on a JP-8000.** No unit was available. The SysEx format is the JP-8080's, which was
checked on hardware.

## Firmware

Hitachi H8/300H. The image is loaded at 0, with plain 32-bit vectors (reset at 200h).

| Table | Address | Note |
|---|---|---|
| SysEx dispatcher | `05880` | |
| Address decoder | `2C6EE` | |
| SysEx parameter table | `6D830` | 190h entries |
| UI table | `72F88` | Patch class 3 |
| Knob descriptors | `70B04` | |
| Menu records | `6E4F0` | 2Ch bytes each, not 2Eh |
| Option lists | `73E10`, offsets at `753FE` | |
| Format handlers | `6FF30` | |
| Per-byte CC table | `53E8C` | Knob flag 81h, switch 82h (not 82h/83h) |
| Bank select MSB table | `6E278` | FF 50 51 FF |
| Preset patches | `562B6` | A0h bytes each, 128 records |
| Preset performances | `5B2B6` | 180h bytes each, 64 records |

`re/jp8080/work/extract2.py jp8000` prints the joined tables.

## SysEx

`F0 41 dev 00 06 ...`, with the same RQ1 (11h), DT1 (12h) and identity request as the JP-8080.
There is no 3Ah channel-message message.

| Address | Size | Block |
|---|---|---|
| 00 00 00 00 | 17h | System |
| 00 00 10 00 | 30h | RPS pattern loop length per key, C#2-C6 (1-4 measures; menu "Loop Length") |
| 00 00 20 00 | 4 | Motion A[1] A[2] B[1] B[2] loop length, 1-8 measures |
| 00 00 30 00 | 2Ah | Tx/Rx CC per knob (MODE2), Control Up/Down |
| 01 00 00 00 | 24h | Temporary performance, common |
| 01 00 10 00 / 11 00 | 7 | Upper / lower part (no Patch group byte) |
| 01 00 40 00 / 42 00 | F0h | Upper / lower patch (the JP-8080 adds F0h-F7h) |
| 02 nn mm 00 | F0h | User patch n, 0-127 |
| 03 nn 00 00 | | User performance n, 0-63 |
| 09 00 ... 0A 40 | | Motion data, the same format as the JP-8080 |

There is no voice modulator (01 00 08 00).

## Labels that differ from the JP-8080

- **Ribbon instead of Control.** The depth matrix (patch 4Ah-9Ah) is "Ribbon", the JP-8000's
  ribbon controller. Patch 98h is PITCH BEND (Ribbon), the ribbon's pitch bend switch.
- **Chorus Type** (patch 3Dh) has 12 types; the JP-8080's Multi-FX Type has 13.
- **Env Type in Mono** (patch EFh) is RESET or FLOWING.
- **Pedal Assign** (performance 1Ch) and **Remote Ctrl CH** (system 09: 1-16, ALL, OFF) have
  JP-8000 menus. **Motion Set** (system 0Dh) has a menu on both models.
- **OSC2 waveform** has three values: SQUARE, TRIANGLE, SAW.
- **The patch and performance bank** is USER or PRESET. PRESET is the ROM set: the same 128
  patches as JP-8080 PRESET 1, and the same 64 performances as JP-8080 PRESET 1.
- **Display formats.** The JP-8000's format codes 11h, 13h and FFh are the JP-8080's 1Ah (remote
  channel), 1Ch (OSC2 range) and 18h (input quantize).

Panel switches show no text on the JP-8000 either, so they take the names of the same bytes in
Roland's JP-8080 address map. Bend Range Up/Down (patch 43h/44h) have no JP-8000 menu. They are the
same bytes, with the same 0-24 range, as on the JP-8080.

**System 12h-16h** appear in no menu of either firmware. Roland's JP-8080 map calls them JP-8000
settings. They are shown as typed values. The JP-8000 owner's manual would name them, but its
ManualsLib copy has no readable text.
