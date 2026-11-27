# Yamaha DX21

Definition: `js/devices/defs/yamaha-dx21.js` over `yamaha-dx4.js` (see `yamaha-tx81z.md` for the format). **Not yet checked on a DX21.**

From the DX21 v1.5 firmware (`z:/firmwares/Yamaha DX21 Firmware v1.5.zip`, v1.4 also present): the INIT VOICE in edit form (3CB6; it fixes the VCED byte order, including the pitch EG at 87-92), the coarse frequency ratio table (7587) used for the CRS display of every 4-op model, and the labels and value texts of its own screens (zero-terminated texts): the voice edit texts F614-F772 ("ALGORITHM SELECT", "FEEDBACK", "LFO WAVE:", "LFO SPEED", "LFO DELAY", "LFO PMD", "LFO AMD", "P MOD SENS.", "A MOD SENS.", "E BIAS SENS.", "KEY VELOCITY", "FREQUENCY =", "DETUNE    =", " EG  AR" ... " EG  RR", "OUTPUT LEVEL", "RATE SCALE", "LEVEL SCALE", "PEG RATE 1-3", "PEG LEVEL 1-3", "SAW UP", "SQUARE", "TRIANGL", "S/HOLD", "LFO SYNC : ") and the function texts FECE-FFD9 ("Poly Mode" / "Mono Mode", "P Bend Range", "Fingered Porta" / "Full Time Porta", "Porta Time", "Foot Volume", "Foot Sustain:", "Foot Porta  :", "MW Pitch", "MW Amplitude", "BC Pitch", "BC Amplitude", "BC Pitch Bias", "BC EG Bias", "Middle C = ", "Chorus      :"). AME has no own text and keeps the TX81Z's.

Message formats: the DX21's own parser (v1.5, listing `re/dx/dx21_v15.lst`: `python -I tools/yamaha/hd6303_dis.py DX21romv15.BIN 8000 OUT sw:B676 --auto`; SysEx states E20A, the bytes after F0 in RAM DDh-E2h) takes:

- `F0 43 0n 03 00 5D` + 93 bytes: the voice edit buffer (to RAM 1920h, E5FE); `F0 43 0n 04 20 00` + 4096 bytes: 32 voices, refused while Mem Protect is on (RAM 53h bit 0, E2CA). The 32 voices are kept as 73 bytes each at 1000h-191Fh; the sender (E947) pads each to 128 with zeros.
- `F0 43 2n 03 F7` / `F0 43 2n 04 F7`: requests, answered with the edit buffer (E8DF) or the 32 voices (B338, while Sys Info is on, 275Dh). Channel n is checked against Midi Recv Ch (26BFh, 0 = omni).
- `F0 43 1n 12 pp vv F7` (E2F0): 0-56h and 57h-5Ch the voice (VCED byte pp, so 87-92 the pitch EG), 5Dh the operator on/off switches (RAM 1C69h, not stored with the voice), 5Eh the operator being edited, 5Fh-64h panel switches (codes 24h, 26h, 21h-23h, 25h, table E5A0), 65h-7Ch the function settings (below); `F0 43 1n 08 ss vv F7`: panel switch ss (0-2Fh) pressed (vv 0 = released).

MIDI gates (DFD6, E000, E008): with Midi Switch OFF the DX21 ignores every MIDI message, with Sy Info OFF every SysEx; with a receive channel set (not omni) it takes 0n/1n/2n messages only on that channel.

## Function settings (parameter changes 65h-7Ch)

The editor's **Function** page (object `system`, sent only: no message reads these values, so the page
shows the firmware's defaults until a value is changed there). Receiver E4AF writes the RAM address of
table E5CE and shows the FUNCTION CONTROL page of table E5B6 (RAM 1C6Ch); the page texts FD2F-FFCF are
drawn by F7BA-FBC9, the data entry takes each page's maximum from B653 + page (slider B1BD, +1 B2DD,
-1 B5A7; pages 2Fh/30h use entries 21h/22h), the value pointers are FC03.

| pp | Screen text | RAM | Values |
|---|---|---|---|
| 67h | "Master Tune =" (page 1) | 2758h | 0-127, shown -64..+63 (F7C7); cold start 40h (A492) |
| 65h | "Dual Detune" (page 2) | 2759h | 0-99 (B655; times A5h into the detune of DUAL play, CC49) |
| 68h | "Midi Switch :" (page 3) | 275Bh | OFF / ON (texts F34A / F347) |
| 6Ah | "Midi Omni : ON" (page 4) | 26BFh | value XOR 1: 1 = omni (26BFh 0), 0 = receive channel 1 |
| 6Ch | "Midi Recv Ch =" (page 4) | 26BFh | value + 1: 0-15 = channel 1-16 (page maximum 16, 0 = omni) |
| 6Bh | "Midi Trns Ch =" (page 5) | 26C0h | 0-15 = 1-16 |
| 69h | "Midi Ch Info:" (page 6) | 275Ch | OFF / ON |
| 6Dh | "Midi Sy Info:" (page 7) | 275Dh | OFF / ON |
| 6Eh | "Midi Transmit ?" (page 8) | - | action: sends the 32 voices (B338) when the value is not 0 |
| 6Fh | "Recall Edit ?" (page 9) | - | action (B35D) |
| 70h | "Init. Voice ?" (page 0Ah) | - | action (B3A2) |
| 71h-76h | (tape and group pages) | - | ignored (page table entry 0) |
| 77h | "Mem Protect:" (page 10h) | 53h | OFF / ON; set ON at every power-on (A998) |
| 78h | "Key Shift = " (page 30h) | 275Ah | 0-48 = -24..+24 (FBAD); set from a key: note - 36 (BE5D) |
| 7Ch | "Bend Mode = " (page 2Fh) | 1EECh | 0-2: "Low", "Hi", "Kon" (pointer table FBF2) |
| 7Ah | (Key Shift switch) | 57h | OFF / ON: the panel switch of page 30h (AB4F); while on the notes move by Key Shift (D486) and the screen's first character is "K" (AAAB) |
| 79h | (Bend Mode switch) | 80h | OFF / ON: the switch of page 2Fh (AB1A); while on the bend reaches only the voice Bend Mode picks (C436, D55E) |
| 7Bh | (EDIT COMPARE) | 1C6Ah | action: 1 = compare (while edited), 0 = back to the edit (AC54) |
| 66h | (split point, "SP:" screen) | 1EDBh | the MIDI note, shown as a number on the SPLIT play screen (EF15); set by a key (BE51) |

When they are taken (RAM 1C65h = the display mode, 0 DUAL, 1 SPLIT, 2 EDIT, 3 SINGLE, 4 FUNCTION, 5
performance memory; switch EE96): 65h, 67h-78h and 7Ch only in EDIT or FUNCTION (E4BE), 79h not in
EDIT, FUNCTION or SPLIT, 7Ah not in EDIT or FUNCTION (E482), 66h only in SPLIT (E4A7), 7Bh in EDIT or
FUNCTION (E578). The DX21 sends 65h, 67h, 78h and 7Ch itself when they change on its panel (E867-E883,
while Midi Switch and Sy Info are on); the page takes them back. Defaults on the page: the cold start
(A480: Master Tune 64, A5BA: MIDI ON, Ch Info ON, Sy Info ON, omni, transmit channel 1) and the INIT
performance (A5DB: Dual Detune 20, split point 60, Bend Mode Low); Key Shift 0, both switches off, Mem
Protect OFF (the user's setting; the DX21 itself turns it on at power-on). The page also offers the
actions (Midi Transmit, Recall Edit, Init. Voice, Compare on / off) and "Send all".

The FUNCTION pages 11h-1Fh (Poly Mode, P Bend Range, porta, foot switches, MW / BC, Chorus, Middle C)
edit the voice (VCED 63-76), on the Voice page. Their screen shows BC Pitch Bias as the plain number
0-99 (page 1Ch, maximum B66F), and so does the Voice page.

There is no 7Eh ("LM  ...") format and no other bulk: the DX21 sends and takes nothing else over MIDI. The voice has the pitch EG and chorus; no additional data (TX81Z/DX11 data loads without it, reported).

## Performance memories (PMEM)

32 memories of 16 bytes at RAM 1C89h-1E88h (1E89h = the one selected; "Performance Mode Store
PMEM ?" F195, display F0A4): byte 0 bits 5-6 the play mode (SI, DU, DU, SP: pointer table F184, F0D1), bytes 1-3
voice numbers and settings (byte 1 bit 4 = bank B, F12F; bytes 2-3 shown by F11F / F123), byte 5 bits 0-5 Key Shift (24 = none, FBAD) and bits
6-7 Bend Mode (texts FBF2), bytes 6-15 the name. The parser above has no format for them, so they
travel only on cassette (Save to Tape); the editor cannot read or write them. Dual Detune, Key Shift
and Bend Mode of the performance being played can be set with parameter changes 65h, 78h and 7Ch.

PMEM byte 0 bits 0-4 hold the receive channel (26BFh), byte 2 Dual Detune, byte 3 the split point, byte
4 Midi Switch / Ch Info / Sy Info (bits 6-4) and the transmit channel (bits 0-3), byte 5 bits 6-7 Bend
Mode (packing B6F0, unpacking B775).

Open: a hardware check (none of this was tried on a DX21).

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- Every change is a parameter change (12h); voices and the 32-voice bank are read by request (formats 3 and 4; the DX21 answers while Sys Info is on). Its performance memories (PMEM) have no MIDI format: they go to tape only.
