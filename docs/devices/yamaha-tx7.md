# Yamaha TX7

Definition: `js/devices/defs/yamaha-tx7.js` over the DX family code (see `yamaha-dx7.md`). Tests:
`tests/yamaha-dx-family.test.js`. **Not yet checked on a TX7.**

## Sources

- Firmware `z:/firmwares/Yamaha TX7 (v1.4).zip`: v1.4, HD6303, 16 KB at C000h. Disassembly
  `re/dx/tx7_v14.lst` (`tools/yamaha/hd6303_dis.py`).
- The TX7 has no voice edit display, so the voice labels, ranges and value displays are the DX7
  v1.8's (`yamaha-dx7.md`). Its INIT VOICE (C4FD) is byte for byte the DX7's.

## MIDI (parser DA08)

| Message | TX7 v1.4 |
|---|---|
| bulk formats received | 0 voice (155), 1 function data (94), 2 function memories (4096), 9 32 voices (4096) |
| dump requests `F0 43 2n ff F7` | answered for ff = 0 (E152), 1 (E1F9), 2 (E32A), 9 (E1A6) and 7Dh (E2F7: "LM  8951  " and 16 bytes of system data) |
| parameter changes | group 0 voice (0-155); group 1 function data, number = byte offset (2-7, 9-16, 26 applied, DFAB); group 2 the DX7 function numbers; group 4 + 128 system settings 0-12 (pointer table C85E) |

## Function data (format 1, 94 bytes)

The DX1/DX5 performance layout: half A (0-29), half B (30-59), common (60-63), name (64-93). The
TX7 builds it in E29D/E279 from its per-voice function memory (16 bytes at 70CA/72CA) and uses:

| Byte | TX7 display | Range |
|---|---|---|
| 0 | voice number | 0-63 (I01-I32, then the DX7's cartridge numbers) |
| 2 | PLAY MODE = POLY / MONO | 0-1 |
| 3, 4 | PW RNG= , STP= | 0-12 |
| 5 | PORTA time | 0-99 |
| 6 | PRT / GLS | 0-1 |
| 7 | PORTA mode: RTN / FLW (poly), FGD / FUL (mono) | 0-1 |
| 9-16 | MW=, FC=, AT=, BC= range (0-15) and P, A, E assign bits | |
| 26 | ATTENUATION | 0-7 |

The byte order is confirmed by the DX7 v1.8, which reads the same block (EFB8) into its function
parameters 64-77. Every other byte the TX7 fills with fixed values (1: 0, 8: 1, 24-25: 99, 28: 1,
29: 24, half B a copy of half A with voice + 32, 63: 39, name " YAMAHA  TX7  FUNCTION  DATA  ")
and reads nowhere: the editor shows them read-only, named as the DX5 v6 firmware shows them
(`yamaha-dx-fn94.js`, `yamaha-dx5.md`): 1 Source, 8 Por P&K, 27 P out, 28 Sus pdl, 29 Key sft,
channel B's copy, 60 Key assign (SNGL), 61 Single channel (A), 62 Detune, 63 Split (39 = C3), the
P name. Bytes 17-25 are read by none of the DX5, TX7 and TF1 firmwares (the DX1's; no DX1 firmware
in the collection).

Function memories (format 2): the TX7 packs its 32 memories twice (E32A / E396; half B a copy of A,
Source 1, Sus pdl on, key shift 24, split 39, the name " YAMAHA  TX7  FUNCTION  DATA  "). Format 2 (4096 bytes) is 64 memories of 64 bytes in the DX5's packing (`yamaha-dx-fn94.js`
packFn94 / unpackFn94, from the DX5 v6 pack CB27 and unpack F999; the TX7 sender E32A/E396 and the
TF1 sender D347 build the same records): 0/16 voice bits 4-0 | half B 20h | Ply/Mon 40h, 1/17 PB stp
<< 4 | PB rng, 2/18 P time, 3/19 Source << 3 | Por P&K 4 | P mode 2 | PG sw 1, 4-7/20-23 the four
controllers (EAP << 4 | range), 8-13/24-29 the DX1 bytes 17-25, 14/30 Att | P out 8 | Sus pdl 10h |
Source 16 as 20h | voice cartridge bit 40h, 15/31 Key sft | PB stp bit 3 as 40h, 32 Key assign |
Single channel << 2 | Detune << 3, 33 Split, 34-63 the name. Unpacked as the DX5 does (voice A from
1-32, B from 33-64; PB rng shown 12 while a step is set).
The Branch Library splits them into function data items (the second 32 only when they differ). The
Function data page's slot list (Function memories 1-32) reads them (request format 2), Edits one, and
Stores by packing it into the editor's copy (both copies, the voice bits set to the slot: memory n
belongs to voice n) and sending all 64 records: the TX7's receiver (DE02) takes the first 32, bytes 0-7
and the attenuation of half A, into the voice's function memory (70CAh, or 72CAh while 7B37h is set),
except while RAM 7B69h is set. Play sends program change n (the voice and its function data).

## System (7Dh status, parameter changes)

A request `F0 43 2n 7D F7` is answered (E2F7) with `F0 43 0n 7D 00 10` + 16 bytes + checksum:

| Byte | Contents |
|---|---|
| 0-9 | "LM  8951  " (C0C4) |
| 10, 11 | 01, 04 (constants, C0CE) |
| 12 | flags (E442: bit = the RAM byte is not 0): bit 6 D.ENTRY RCV. (7B68), 5 MEM. PROTECT (7B69), 4 OMNI MODE (7B6A), 3 CTL.CHNG.RCV. (7B6B), 2 D.ENTRY VOL (7B6C), 1 flag 7B6D, 0 internal voice (7B6E) |
| 13 | MIDI RCV.CH. 0-15 (7B7C) |
| 14 | the battery reading (7B7D: the ADC value x 50 / 256 = 0.1 V steps, CDB9; below 17h "CHANGE BATTERY") |
| 15 | the volume level (7B7E, written inverted to the volume DAC at 4800h) |

The TX7 takes no 7Dh bulk (the bulk receiver DA89 accepts formats 0, 1, 2 and 9 only). Its settings
are changed by:

| Message | Setting (page title, RAM) |
|---|---|
| `F0 43 1n 11 pp vv F7` (group 4, number 80h + pp; handler DF0F, RAM table C85E) | pp 0 "D.ENTRY RCV." (7B68; on turns D.ENTRY VOL off, DF94), 1 "CTL.CHNG.RCV." (7B6B), 2 "D.ENTRY VOL" (7B6C; on turns D.ENTRY RCV. off, DF9D), 3 flag 7B6D (then CTL.CHNG.RCV. on, D.ENTRY RCV. and the internal flag set from it, DF68), 4 shows the CMB / IND page (3Ch / 3Dh, nothing stored), 5 key limit high and 6 low ("SP L=    ,H=    ", 74D9 / 74D8, note names C89A), 7 "MEM. PROTECT" (7B69), 8-0Ah ignored, 0Bh "LOAD FUNC ?" INT / EXT (7B37: function memories 70CAh or 72CAh), 0Ch VOICE INIT (D6EE: INIT VOICE into the edit buffer, MASTER TUNE 0) |
| group 1 number 1 (`F0 43 1n 04 01 vv F7`) | "MIDI RCV.CH." = vv - 1 (E028) |
| group 1 number 40h | "MASTER TUNE" (7B7F, shown -64..+63, D38A; cold start 40h) |
| control change 7Dh / 7Ch | "OMNI MODE" on / off (D8C0 / D8AF) |

Flag 7B6E is set by a program change for an internal voice (0-31) and cleared for a cartridge voice
(D9CE); flag 7B6D is set only by system parameter 3 and cleared at every page change (CFF7), and no
page shows it. Power-on turns MEM. PROTECT on (CD5E); the cold start (FBFE) sets channel 1, omni off,
both data entry switches off and MASTER TUNE 64.

The editor's **System** page reads the 7Dh answer (Get from device; the Branch Library also takes the
message as this object) and sends each setting as above; MASTER TUNE, LOAD FUNC and the key limits are
not in the answer, so they show the defaults (or what was sent) until changed. Actions: Send all, VOICE
INIT. MEM. PROTECT is shown OFF (the user's setting).

## Editor

Voice page and Internal voices as on the DX7, but read by request (Get from device, Edit, Read
names). Function data page: the fields above, sent as group 1 parameter changes, read and sent as
format 1. Head Library: voices load natively into the DX7 and back; function data translates as a
one-part performance (voice number, poly/mono, bend range, portamento).

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- Performance name character; the TX7 always sends " YAMAHA  TX7  FUNCTION  DATA  " (C87C).
- MASTER TUNE: shown -64..+63 (D38A); sent as group 1 number 40h (E004). Not in the 7Dh answer: the page shows what was sent.
- Data entry (control change 6, and 60h / 61h increment / decrement) received; turning it on turns D.ENTRY VOL off (DF94).
- Flag 7B6E: set when a program change selected an internal voice (0-31), clear for a cartridge voice (D9CE); the TX7 then loads the voice's function memory (D3B6).
