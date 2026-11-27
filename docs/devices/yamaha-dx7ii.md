# Yamaha DX7II-D / DX7II-FD

Definition: `js/devices/defs/yamaha-dx7ii.js` (`buildDX7II`, also used by the DX7s) over the DX
family code (`yamaha-dx7.md`). Firmware tables: `yamaha-dx7ii-fw.js` (`tools/yamaha/dx_fw.py dx7ii`).
Tests: `tests/yamaha-dx-family.test.js`. **Not yet checked on a DX7II.**

## Sources: firmware and documents

- Firmware: `z:/firmwares/Yamaha_DX7II_ROM_V1.9.zip` (v1.9, 64 KB: two 32 KB banks seen at
  8000h; addresses below are file offsets). Also in the collection: v1.8, DX7IID v1.3, the
  third-party Grey Matter E! and the FD service manual.
- **From the firmware:** every label (the 40-character edit screens at F39F-F990, e.g.
  "Osc >Mode >Coarse >Fine >Detune", "Peg >Rng >Vel >Rs", "Pitch bend >Range >Step >Mode"), every
  value list (80h-separated texts F9F7-FD28: lin/exp, ratio/fixed, the LFO waves, single/multi,
  polyphonic .. unison mono, normal/low/high/key on, the portamento modes, 8/2/1/1/2, the PAN
  modes, LFO/Velocity/Note number, single/dual/split), the maximum of every VCED, ACED and PCED
  byte (tables EC4E, ECE9, ED1A), the initial voice, additional data and performance (0163,
  0200, 0231: INIT VOICE, INIT PERF), the fixed-frequency table (EE60), the 106 continuous slider
  destinations (names at 0E88, pointer table after them) and the 7Eh bulk headers with their
  byte counts (8686: MCRYE/MCRYM/MCRYC 266, FKSYE/FKSYC 502, 8973PE 61, 8973PM 1642, 8973S 95).
- **From the firmware's MIDI code** (2026-11-26): the two banks call each other through a
  trampoline at 8039 with an index in RAM 87h (lower bank table 8053, 136 entries; upper bank
  table E983, 61 entries); `hd6303_dis.py` follows them with `tab:8053:136` / `tab:E983:61`, the
  inline switch tables of the lower bank's BADE (`sw:BADE`) and the upper bank's indexed jumps
  (`ix:DB0A`, `tab:F088:32 tab:F0C8:176`). Listings: `re/dx/dx7ii_lower.lst`, `re/dx/dx7ii_upper.lst`
  ("L" and "U" below). The SCI interrupt (vector FFF0 -> L A180) fills a ring buffer (5BC9-5CC9);
  L A20F parses it; SysEx states at L A6F2. From there:
  - **Parameter changes** (byte after 1n): 00/01 = VCED 0-155 (L A985); 04 40 = master tuning
    (L A8ED; sent by L B268); 18 = ACED, numbers 0-26h for bytes 0-38 and **40h-49h for bytes
    39-48** (L A93B, U E5EC/E672); 18 7E kk hh ll = micro tuning key kk (L AA5A); 18 7F oo pp hh ll =
    fractional scaling (L AA77); 18 5A = a reset (L F528); **19 = performance bytes 0-32h** (U E6AF)
    and system bytes 40h-52h, 53h memory protect, 54h a panel toggle (L A9C4); 1B = panel
    switches 0-2Dh (2Eh restarts the unit, L A904). The DX7II needs Device number on and the
    matching channel for group 18/19 changes and for dump requests (L A750, A944).
  - **Dump requests** (L A776): format 0 (VCED, L B4B9), 5 (ACED, L B5D2), 6 (AMEM, L B609),
    9 (VMEM of the MIDI out bank, L B46E); 7Eh with any of the nine headers (L ABFB, answers
    through table 870D).
  - **Bulk receive**: format 5 to the edit buffer's ACED (L AF1A), 6 = AMEM 32 x 35 (L AF38),
    9 = VMEM into the receive block (L AAE4); a VMEM with no AMEM just before it gets its
    additional data made by L BD88 (INIT VOICE's, with each operator's DX7 Ams). 7Eh headers
    through table 86FB (L AB14).
  - **AMEM**: RAM 4000h (26 bytes a voice) and 4680h (9 bytes), packed by U DCC0/DD40 and
    unpacked by U E01A/E0D6 (values held to the maximum table): byte 0 scaling modes (bit 0 =
    OP6), 1-3 Ams pairs (OP6 | OP5 << 3 ...), 4 Peg Rng | LFO mode << 2 | Peg Vel << 3 | random
    pitch << 4, 5 key mode | pitch bend range << 2, 6 bend step | bend mode << 4, 7 portamento
    mode | step << 1, 8-24 ACED 22-38, 25 unused, 26-33 ACED 39-46, 34 unison detune | FC1 as CS1
    << 3.
  - **System setup** (RAM 5000h, 85 bytes; screens U D2D9 / D615, maxima U ED39, initial L 8CA4):
    0-1 transmit channel and on, 2-3 receive channels A/B (16 = off), 4 omni messages, 5-6 MIDI
    IN control A/B numbers (11-31), 7-8 CS1/CS2 numbers (5-31), 9 note on/off (all/odd/even), 10
    PC trns mode (off/normal/programmable), 11 local, 12 MIDI out voice bank, 13 receive block,
    14-15 device number and on, 16-18 cartridge banks (voice & perf., fractional SC., micro
    tuning), 19 not found (max 3), 20 master tuning, 21-84 the program change table (64
    memories). Memory protect is not in it (RAM 5494h bits 0-1).
  - **Micro tuning** (RAM 58D5h edit buffer, 56D5h/57D5h the two user tables): 128 keys x 14 bits
    (two 7-bit bytes) in 1/1024 octave, 0 = C#-2; the page (L 9C5F, 9E0A) shows the nearest note
    and the distance; the panel stops at 2A2Ah. Preset 1 = table L 84C0 over the octaves (L 9858;
    C-2 takes C-1, L 9C4E). Table names L 859C. "LM  MCRYM" + 00h/01h = user tables 1/2;
    "LM  MCRYC " = 63 cartridge tables, one message each.
  - **Fractional scaling** (RAM 5CCAh / 5DC0h for voices A / B): 41 bytes an operator (OP6
    first): an offset ("Ofst", +n stored 80h + n, -n stored n) and 40 key groups (C-2-C-1, then
    three keys each, L 9444) holding 255 minus the level (L 93D3); sent as two characters 30h +
    nibble a byte (L ADA9, B86B); "LM  FKSYC " = 32 cartridge sets.
  - **Performance**: byte 10 = foot switch Sustain / Portamento / Key hold / Soft (texts FD7C,
    U BFD3), byte 12 = the soft pedal range 0-7, shown only for Soft (U C057).
  - **Program change and the 64 voices**: L A3F6 takes the program change (ignored while RAM 536Dh
    bit 7 is set) and queues an event for the upper bank through SBC0B (index into table E983): 0Bh
    in single mode (U 8309), 15h/16h for voice A/B in dual or split mode (U 83E1 / 840D: receive
    channel A, and B when it differs), 17h while the panel selects performances (RAM 536Eh bit 0, set
    at U 8890; U 8EE7 takes 0-31 as performance 1-32, 32-63 as the cartridge's). In voice mode 0-63
    select I01-I64 and 64-127 C01-C64 (bit 6 = cartridge, kept as the voice number in 5056h/5057h);
    a cartridge voice with no cartridge in is refused (U 84DD -> 8B36) and the voice stays. The
    internal voices are 64 x 128 bytes at RAM 2000h (I01-I32) and 3000h (I33-I64), their AMEM at
    4000h/4680h and 4340h/47A0h: the 32-voice bulk and the AMEM a request answers come from the bank
    of system byte 12 (L B520, B561), a received one goes to that of byte 13 (L AF74, AFB4). Parameter
    change 19h 4Ch / 4Dh writes those bytes directly (L A9F5).
- **From Yamaha's DX7II MIDI data format**: the order of the ACED and PCED bytes (checked against
  the maximum tables and initial values, and now against the code above), the format numbers.

## Objects

| Object | Bytes | Messages |
|---|---|---|
| Voice | VCED 0-155 (DX7 layout, `yamaha-dx7.md`) + ACED 156-204 | edit buffer: ACED (format 5) then VCED (0); requests 5 and 0; parameter changes group 0 / 18h (ACED 39-48 as 40h-49h) |
| 64 voices | 2 x (VMEM + AMEM) | AMEM (format 6) first, then VMEM (9), per bank of 32 (system bytes 12/13 switched by 19h 4Ch/4Dh): Get 64 voices, Store, Send bank, bank files |
| Performance | PCED 51 | "LM  8973PE"; request with the header; parameter change 19h |
| System setup | 85 | "LM  8973S "; 19h 40h-52h, master tuning 04h 40h, the rest as the whole setup; Memory protect off (19h 53h 0) |
| Micro tuning | 256 (128 keys) | "LM  MCRYE "; 18h 7Eh kk hh ll; Get / Send as user table 1-2 ("LM  MCRYM" 0/1) |
| Fractional scaling | 246 (6 x 41) | "LM  FKSYE " (492 characters); 18h 7Fh oo pp hh ll |

ACED (49): 0-5 Scaling mode OP6-OP1 (normal / fractional); 6-11 Ams OP6-OP1 (0-7); 12 Peg Rng
(8, 2, 1, 1/2 octaves); 13 LFO Mode (single, multi); 14 Peg Vel; 15 Key mode; 16-18 Pitch bend
Range, Step, Mode; 19 Random pitch; 20-22 Portamento Mode, Step, Time; 23-25 Modulation wheel
Pmod/Amod/EGbias; 26-29 Foot control 1 Pmod/Amod/EGbias/Vol; 30-33 Breath control and 34-37 After
touch Pmod/Amod/EGbias/Pbias; 38 Peg Rs; 39-42 Foot control 2; 43-46 MIDI IN control; 47 Unison
detune; 48 Foot control 1 as CS1. The DX7 voice's own Ams (VCED, 0-3) is kept for DX7
compatibility ("Ams (DX7 voice)").

PCED (51): 0 Voice mode, 1-2 Voice A/B (I01-I64, C01-C64), 3 Micro tuning table (Preset 1-11,
User 1-2, CRT 1-62 with the table names), 4 key, 5 A B switch, 6 Dual detune, 7 Split point, 8 EG
forced damp, 9 Sustain foot switch, 10 Foot switch select (Sustain, Portamento, Key hold, Soft =
controls 64-67), 11 Foot switch A B, 12 soft pedal range, 13-14 Note shift A/B, 15 Balance, 16 Total
volume, 17-18 Continuous slider 1/2 destination, 19 slider switches, 20-22 PAN Mode/Range/Select,
23-30 PAN EG, 31-50 name.

## Branch Library and Head Library

Voices (ACED + VCED pairs), 32-voice banks (VMEM with the AMEM before or after it; without one,
the additional data the DX7II itself would make), performances (single and the 32 of
"LM  8973PM"), the system setup, micro tuning tables (edit buffer, user tables, cartridge
tables) and fractional scaling (edit buffer, cartridge sets) are split into items for their
objects. Slot Edit selects the voice (program change) and reads the edit buffer, so it is exact;
offline it unpacks the voice's AMEM entry.

The slot list has three banks: INTERNAL I01-I32 and I33-I64 (program change 1-32 and 33-64) and
CARTRIDGE C01-C64 (65-128). Get 64 voices reads the system setup, then each internal bank with
system byte 12 (MIDI out voice bank, 19h 4Ch) pointed at it, and sets the byte back. Store and Send
bank write the editor's copy of a bank with byte 13 (Receive block, 19h 4Dh) pointed at it when it
points at the other, then back. A bulk the DX7II sends by itself is filed under its MIDI out voice
bank (as the System page last read it). The cartridge's voices have no bulk dump: Play and Edit
select them by program change, Read names reads each through the edit buffer, Store is not offered. Translator: a DX7 voice loads exactly (VCED) with the
DX7II's initial additional data (reported); a DX7II voice loads into a DX7 without its additional
data (reported); a performance is a one- or two-part performance; a micro tuning is shared as the
pitch of each key in cents (kind 'tuning'); fractional scaling travels only between DX7II-family
models.

## Open

- No MIDI channels page: voices A and B take their channels from the system setup (System page).
- System byte 19 (max 3) and parameter 54h (a panel toggle, bit 6 of RAM 536Eh): not named.
- The preset micro tuning tables other than Equal temperament (L 84DA-8582 and the key rotation
  L 9BE0-9C3A) are not offered as presets.
- Not checked on a DX7II: everything above.
