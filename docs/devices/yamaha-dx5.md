# Yamaha DX5

Definition: `js/devices/defs/yamaha-dx5.js`; the 94-byte performance shared with the TX7 and the
TX816 in `js/devices/defs/yamaha-dx-fn94.js`. **Not yet checked on a DX5.**

Source (read only, never run): DX5 v6 firmware (`z:/firmwares/Yamaha DX5 v6.zip`, one 27256 = 32 KB
at 8000h; v5's two 27128s are in `Yamaha DX5 v5.zip`). The DX5's processor is a **6809** (reset 9100:
`clra / tfr a,dp / orcc #FF / lds #8000`), not the HD6303 of the DX7 family, so it is read with
`tools/yamaha/m6809_dis.py` (listing `re/dx/dx5_v6.lst`: `python -I tools/yamaha/m6809_dis.py ROM
8000 OUT --auto tab:A264:8 A504`); strings `re/dx/dx5_v6_strings.txt`. 40x2 LCD.

## Edit parameters

Each edit parameter (panel button x 4) has a record in table **8234**: value position, label position,
length, label text. Indices 0-55 are the voice ("RD", "RC", "BP", "LC", "LD", "RS", "AM", "KV",
"OPL", "Freq", "Detune", "ALG", "FBL", "Wave", "Spd", "Dly", "PMD", "PMS", "AMD", "Sync",
"Os K Sync", "Transpose", "Voice name"; mapped to VCED by table CA2D), 56-99 the performance,
100-118 the utilities (Copy, Temp, Init, Recall, Save, Load, Format, M prot, M clear, Battery, Midi,
Status, Dump). Table **866D** gives each performance parameter's byte in the buffer (73A2h) and
maximum (bit 7 set); table **B8A7** its value display.

| Byte (A / B) | Label | Range / display |
|---|---|---|
| 0 / 30 | voice | bits 5-0 voice 1-64, bit 6 cartridge (FA9F) |
| 1 / 31 | Source | 0 the keyboard, 1-16 MIDI channel |
| 2 / 32 | Ply/Mon | Poly, Mono (BAC9) |
| 3 / 33 | PB rng | 0-12 (shows 12 while a step is set) |
| 4 / 34 | PB stp | 0-12 |
| 5 / 35 | P time | 0-99 |
| 6 / 36 | PG sw | Port, Glis (BB01) |
| 7 / 37 | P mode | Retain, Follow (poly) / Finger, FulTim (mono) (BB20) |
| 8 / 38 | Por P&K | Off, On |
| 9-16 / 39-46 | Mod, Ft., Aft, Br. ranges (0-15) and their EAP bits (E bit 2, A bit 1, P bit 0; BB4C) | Mod 9-10, Ft. 11-12, Aft 13-14, Br. 15-16 |
| 17-25 / 47-55 | (none) | never read; 0 ... 99 99 (the DX1's) |
| 26 / 56 | Att | 0-7 |
| 27 / 57 | P out | Off, On (output P, EC51) |
| 28 / 58 | Sus pdl | Off, On |
| 29 / 59 | Key sft | 0-48 = -24..+24 |
| 60 | Key assign | SNGL, DUAL, SPLT |
| 61 | Single channel | A, B (73DF: the channel that plays and is edited in single mode) |
| 62 | Detune | 0-15 (dual detune) |
| 63 | Split | 0-96, shown as the note value + 21 (C3 = 60; E0E2) |
| 64-93 | P name | 30 characters |

M tune (index 56, byte 5Eh = 7400h) is a system value, not part of the performance. INIT (SUBJOB2,
D550): bytes 1-29 of both channels from D533 (PB rng 5, Por P&K on, Mod 15 to pitch, Att 7, Sus pdl
on, key shift 0), 62 = 0, 63 = 39, blank name; the voices and bytes 60-61 are kept.

## MIDI (receiver A505, status dispatch A264)

- SysEx is taken on the Source channel of the current channel (A or B per byte 61), unless that
  channel is omni.
- Formats: 0 the current channel's voice (76C7), 1 the performance (73A2), 2 the performance
  memories (6000h, 4096 bytes), 9 32 voices (INT 01-32 when A is current, 33-64 when B). The DX5
  sends them with sub-channel 0 (F0EE, F10A) and a 7Dh "LM  DX5   " message.
- Group 0: voice parameters (DX7 numbers, below 155). Group 1 (C919, table CA40): 0-29 the current
  channel's bytes (17-25 ignored), 30 key assign, 31 single channel, 32 detune, 33 split, 34-63 the
  name.

The editor: Voice page (the current channel), Performance page (channel A, channel B, key assign;
changes to the other channel than the current one send the whole performance), MIDI channels page
(A and B with voice, Source, key shift, attenuation), translator (exact DX5 / TX7 / TX816; from other
performances: two parts, key mode, split point).

Performance memories (format 2, RAM 6000h): Format 2 (4096 bytes) is 64 memories of 64 bytes in the DX5's packing (`yamaha-dx-fn94.js`
packFn94 / unpackFn94, from the DX5 v6 pack CB27 and unpack F999; the TX7 sender E32A/E396 and the
TF1 sender D347 build the same records): 0/16 voice bits 4-0 | half B 20h | Ply/Mon 40h, 1/17 PB stp
<< 4 | PB rng, 2/18 P time, 3/19 Source << 3 | Por P&K 4 | P mode 2 | PG sw 1, 4-7/20-23 the four
controllers (EAP << 4 | range), 8-13/24-29 the DX1 bytes 17-25, 14/30 Att | P out 8 | Sus pdl 10h |
Source 16 as 20h | voice cartridge bit 40h, 15/31 Key sft | PB stp bit 3 as 40h, 32 Key assign |
Single channel << 2 | Detune << 3, 33 Split, 34-63 the name. Unpacked as the DX5 does (voice A from
1-32, B from 33-64; PB rng shown 12 while a step is set). The Branch Library splits the 64
memories into performance items (sent as format 1). The Performance page's slot list (Performance
memories 1-64) reads them (request format 2), Edits one and Stores by packing it into the editor's
copy (CB27's packing) and sending all 64 (the DX5 takes format 2 into 6000h).

## Voice value texts

The voice page uses the DX5's own displays (table B8A7, one routine per edit index of the records
8234): curves "-L", "-E", "+E", "+L" (B99C), oscillator mode "R" / "Hz" (B9CC), Detune "-7" .. "+0" ..
"+7" (B9B7), Sync and Os K Sync "Off" / "On" (BAE4, texts BAFB), Transpose "-24" .. "+0" .. "+24"
semitones (BB38; the DX7 shows a note), LFO waves (BB74), ALG + 1, BP as a key (E0E2: value + 21, the
same names as the DX7's). The frequency (B9E3) keeps the DX7's display; the EG and level values are
plain numbers on both.

## System status (7Dh) and the FUNCTION / MIDI settings

The DX5 answers `F0 43 2n 7D F7` (request handler F06F -> EFA7, only while SUBJOB4 System exclu.
communication is on) with `F0 43 0n 7D 00 10` + 16 bytes:

| Byte | Contents |
|---|---|
| 0-9 | "LM  DX5   " (F048) |
| 10, 11 | ROM bytes 8000h-8001h: 06 00 (version 6) |
| 12 | bits 0-4: RAM 76EA bits 3-7 (the play state the panel switches toggle; 08h, 10h and 20h are reported as group 1 numbers 1Dh-1Fh when they change, CA5E); bit 5: M prot (7401, "Internal memory write protect": set at every power-on 919E, refuses bulks A600); bit 6: flag 7720 (set while the routine A92D runs: MIDI and SysEx off, M tune 3Fh, a note table B708) |
| 13 | bit 0 MIDI switch (7402), 1 SUBJOB1 Basic event data output (7403), 2 SUBJOB2 Other event data output (7404), 3 SUBJOB4 System exclu. communication (7405), 4 / 5 SUBJOB5 OMNI mode A / B (7406 / 7407), 6 SUBJOB7 Prog. change mode VOICE (0) / PERFORMANCE (D99A) |
| 14 | bit 0 SUBJOB3 After touch data output (7409); bits 1-4 SUBJOB6 Transmit channel (740A, also the n of every message the DX5 sends, F052) |
| 15 | SUBJOB8 Y/N switch assign: 0 off, else the control number 64-95 (740B 1-32 + 3Fh, DA42) |

(MIDI utility pages D6CA-D830, texts DA62-DC9E.) The DX5 takes none of these over MIDI: no 7Dh bulk
(formats 0, 1, 2, 9 only) and no parameter change (groups 0 and 1 only, C7F0 / C919). M tune (7400h,
0-126 shown as -63..+63, BBF6; edit index 56) is in no message at all. So the editor's **System**
page (object `system`) only reads: Get from device asks for the 7Dh answer; the Branch Library also
takes the message as this object. Before Get it shows MIDI and SysEx on and M prot off (the user's
setting; the DX5 turns it on at power-on).

Open: a hardware check.

## DX1

No DX1 firmware or document is in the collection. The DX1 uses this performance format; its own
bytes are 17-25 of each channel, which none of the DX5, TX7 and TF1 firmwares reads.
