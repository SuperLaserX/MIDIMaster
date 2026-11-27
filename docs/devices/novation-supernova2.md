# Novation SuperNova II (Rack and Keyboard): MIDI implementation from the Rack OS 2.0 firmware

The editor (`js/devices/defs/novation-supernova2.js`, option lists in
`novation-supernova2-fw.js`, translator in `novation-supernova2-translate.js`) was built from the
SuperNova II Rack OS 2.0 image, cross-checked against the Keyboard OS 2.0 image and the OS 2.0
manual (its controller and NRPN tables), and checked against a SuperNova II Rack on MIDI port
`2- SuperNova` (global channel 16, OS 2.0, identity `F0 7E 0F 06 02 00 20 29 01 00 24 00 28 00 00 00 F7`).

## Firmware

One 27C801 per version (`re/sn2/eprom`: Keyboard OS 1.5 and 2.0, Rack OS 1.3, 1.5 and 2.0). The
CPU is a Hitachi H8/300H in advanced mode; the image is linear from 000000. Ghidra has no H8
language, so the work used `re/sn2/work/h8dis.py` (disassembler; `sweep.py` pickles a whole image),
`emu.py` (emulates the menu-ID switch at 2193A, which turns a menu field into its CC/NRPN for the
selected oscillator, LFO or envelope) and `menu.py` (menu field records 6A000-76000: label, field
id, display descriptor `[min, max, flags, width, list pointer]`, edit routine).

Novation's OS updates (`.mid` files of SysEx, `F0 00 20 29 01 mm 7F 7F/7E/7D ...`) decode with
`tools/novation/os_mid.py`: the format is in the loader at 000E1C-000F3A of the Keyboard OS 2.0
image (7 16-bit words per 8 two-byte 7-bit words, packet and image checksums), and the decoded
`SIIKos2.MID` equals the Keyboard OS 2.0 EPROM byte for byte (509824 bytes). The same tool gave the
first SuperNova's OS 4.1, the Nova's OS 4.1 and the Nova II Keyboard OS 2 (`re/novfw/`, not in git;
their editors: `novation-supernova.md`, `novation-nova.md`, `novation-nova2.md`). They were used for
the bytes below ("Not identified yet").

RAM used below (Rack): the global block 34654-346B5 (34656-34665 are the 16 settings of message
0F, 34666 is Memory protect, 346A2-346B5 the OS 2 settings of message 15), program edit buffers at
6590A + 11Eh x part (message 00 data), their OS 2 blocks at 673E4 + 58h x part (message 1E data),
the performance's OS 2 block at 66E54 (message 20 data).

## SysEx

`F0 00 20 29 01 mm dd tt ... F7`. mm is the model: 22 Keyboard, 24 Rack; the receiver (1B34A)
accepts 20-25, so dumps of the other models of the family are read (20 SuperNova, 21 Nova, 23 Nova
II Keyboard, from their own OS images). dd is the global
MIDI channel 0-15 or 7F (any unit); otherwise the unit shows "Not global MIDI ch." Data bytes are
plain 7-bit values. The dispatcher is at 1B6B0 (handler table 1B6E6); the expected length of each
type is the word table at 65216. Types 01 02 06 07 0B 0C 0F 15 16 1C 1F 21 write memory and are
refused while Memory protect is on (RAM 34666 = 78h, check at 1B69C; the unit only shows "Memory
protect on.").

| Type | Length | Message |
|---|---|---|
| 00 pp | 296 | program into the edit buffer of part pp (0-7, 8 = program mode, 9 = the current part) |
| 1E pp | 98 | the OS 2 block of that program (88 bytes) |
| 02 bb nn / 1F bb nn | 297 / 99 | program nn of bank bb (5-12 A-H, 18-25 drum maps a-h: 50 programs each) |
| 05 / 1B / 20 | 381 / 25 / 473 | current performance: 372 + 16 + 464 bytes |
| 07 bb nn / 1C / 21 | 383 / 27 / 475 | performance nn of bank bb (1-4 A-D) |
| 0F / 15 | 281 / 297 | global data (0F: 16 settings + the program change map; 15: 32 OS 2 settings + the map again) |
| 0A pp | 204 | user arpeggio pattern edit buffer: pattern number pp (0-63 mono, 64-127 poly) + 194 bytes |
| 0B | 9 | write the pattern edit buffer into the user bank (memory write) |
| 0C / 22 | 204 / 205 | user arpeggio pattern into memory |
| 01 / 06 | 12 / 11 | program / performance select |
| 03, 08, 10 | 9 | current program / current performance (8 x (00, 1E), 05, 1B, 20) / global request |
| 04, 09, 0E, 11 | 9 | all programs / all performances / all arpeggio patterns / total data request |
| 12 bb, 13 bb nn | 10, 11 | bank request, single request (replies 02/1F or 07/1C/21) |
| 0D, 14, 16 | 9, 10, 11 | pattern requests and pattern bank |

Receiver details that matter to an editor:

- A message 0F with model 20 carries the program change map; for the SuperNova II models (22,
  24) the map in 0F is ignored and the one in message 15 is used (1C08C). The 0F transmitter
  sends banks 13 and up (arpeggio banks, drum maps) as (0, slot) (1D9FA), so the editor edits
  message 15's copy and derives 0F's from it the same way. (NRPN 122 MSB 13 sets a drum map as
  the bank of the map entry being edited: found when the program-mode sweep changed the global.)
- Message 15 byte 2 (breath mode) is ORed into RAM 34660 instead of 34661 (1C454): a global write
  clears breath mode and disturbs breath sensing. **Write global settings** therefore sends packed
  NRPN 1 (breath sensing) and packed NRPN 113 (breath mode) on the global channel afterwards.
- A model 20/21 message 15 gets OS 2 defaults for bytes 15-23 and 28-31 (1C48A).

## Programs (374 bytes: 286 of message 00, then 88 of message 1E)

The controller map at 6525C gives the program byte of every CC and NRPN; the menu pages give the
labels and displays. Packed NRPNs (0, 1, 84, 100, 109, 110, 113) carry several parameters in one
number (Novation's tables are in the manual); the NRPN 120/122 families select a parameter with
the MSB. The editor shows every parameter with the label the SuperNova's menu uses.

| Bytes | Contents |
|---|---|
| 0-15 | name |
| 16 | vocoder balance (program mode) |
| 17 | category (list 69BE8) |
| 18-21 | panel selections kept with the program: selected oscillator/mixer source, osc/filter mod. source, selected LFO and envelope |
| 22-123 | oscillators 1-3, 34 bytes each: wave (packed NRPN 0 10n+0..4), octave, semitone, fine tune, bend range, pitch level and five mod. amounts (wheel, Env 2, Env 3, LFO 1, LFO 2), harden, width (pulse width) and sync with their mod. amounts, sync key follow and skew, formant width |
| 124-159 | mixer: osc 1-3, ring 1*3, ring 2*3, noise: level and five mod. amounts each |
| 160-181 | LFO 1/2 (delay, wave, offset, speed, mods, sync, triggering, delay trigger), LFO ranges |
| 182-200 | Env 3, Env 2, Env 1 (amplitude): delay, ADSR, velocity, Env 1 wheel/aftertouch |
| 201-206 | noise harden and its mods |
| 207-230 | filter: type, slope, width step (derived), overdrive, cutoff, resonance, tracking, mods, Q normalise |
| 231-238 | portamento, glide, porta type/mode, envelope triggering, program level, voice bits (osc mode, poly mode, **polyphony** 238 bits 0-1 (Mono/Poly), drum one-shot, **constant gate** bit 3, unison, unison mode, OS 2 marker bit 6) |
| 239 | **arpeggio speed in program mode** (CC 9; setter F196 writes the program byte in program mode, the performance byte otherwise) |
| 240-253 | arpeggiator (pattern bank/number, velocity, fill-in/ordering, quantize, octaves, **latch** 247 (CC 65), latch type, mute and notes-to bits in 249 (with the **vocoder input** of program mode in bit 1 and an OS 2 marker in bit 2), **arpeggiator on/off in program mode** 250 (NRPN 1 72/73 stored as sent, CFF4), real-time transpose, sync, OS 1 gate time) |
| 254-285 | effects (distortion, EQ, comb filter, panning, reverb, chorus, delay, configuration): used when a part's Effects used is Program |
| 1E 0-41 | OS 2: LFO slew, unison detune, FM / LFO fade / filter bypass bits, envelope key track, filter width, VCO drift, A-D repeat, sustain time/rate, level track/note, osc start phase, drum played as, overdrive curve (30), arp output channel, arp gate time, digital-input waves (33-35), digital vocoder input (36), env/LFO delay sync, LFO delay mode |
| 1E 42-55 | reserved: the transmitter (1D410) clears them before every 1E dump |
| 1E 56-75 | OS 2 effect settings (bypass, chorus types 4-5, distortion, comb, chorus LFO; 71 = digital pass to effects) |
| 1E 76-87 | reserved: cleared by the transmitter |

Digital I/O option card: with the card fitted (RAM 692BE = 1) a wave, the vocoder input and pass
to effects can also be a digital input; the getters at 14B9E and 14C04 add these bytes to the
lists ("Dig in (n)", "Digital input (n)", "Digital in (n) only" / "Prog & digital (n)", strings at
32407-32BFF). Choosing an ordinary wave, input or pass-to setting clears them (C97A, E806, EB0E).

Bytes 238 bit 6 and 249 bit 2 are set by the transmitter before every program dump (1D3E8); the
SuperNova and Nova OS 4.1 set them too (SuperNova 15568), and 249 bit 2 marks a program in the OS 4
value scale (the Nova converts a program without it, 176D2/1763C). Byte 209 (filter width step, VCO
drift on) is derived by the SuperNova II; the editor shows it read-only. On OS 4.1 those bits are the
Filter width itself (00-56) and DCO / VCO mode.

## Performances (852 bytes: 372 of message 05, 16 of 1B, 464 of 20)

| Bytes | Contents |
|---|---|
| 0-15 | name |
| 17 | arpeggio speed (CC 9 in performance mode, shown + 64 b.p.m.) |
| 18 | current part |
| 20 + 44n | part n: program, bank, MIDI channel (0-15, 16 Omni, 17 Global), outputs, Sus/sw2, semitone, detune, velocity curve, key range, byte 10 (polyphony, MIDI filters, arpeggiator, effects used), part level; then its 32-byte effect block |
| 1B 0 | 28h (format marker written by the transmitter 1D612) |
| 1B 1-7 | vocoder input, insert, width, balance, sibilance level/type |
| 20 + 40n | part n OS 2 settings: 0-19 effect settings as in the program's 1E 56-75 (15 = digital pass to effects), 33 switches (pedal/breath, arp bank & pattern used from), **34/35 the part's own arp pattern bank and number** (used instead of the program's when byte 33 bit 6 is set: 15EC2), 36/37 Sw1/Sw3; 38-39 cleared by the transmitter (1D714) |
| 20: 320-453 | SuperNova II **Keyboard** performance settings: External Parts 1-8 (16 bytes each: MIDI channel, Tx options, bank MSB/LSB, program, key range, velocity range, volume, semitone, wheel assignment, default velocity, MIDI stream), then byte 448, the arp transpose zone (449-452) and ext song select (453). Placed from the Keyboard OS 2.0 NRPN 120 MSB 16-111 and 122 MSB 64-87 handlers (tables 11FD2/12AFE there); the Rack keeps them but does not use them (it only reads 452 back, 1516C) |
| 20: 454-463 | reserved: cleared by the transmitter |

The `multi` hook gives the MIDI channels page (bank/program, channel, polyphony, level, pan,
key range, semitone per part; a part plays drums when its bank is a drum map).

## Global (560 bytes: 272 of message 0F, 288 of message 15)

Message 0F is RAM 34656-34665 as stored, except that bytes 10, 11 and 13 carry only their low
bits (the 0F transmitter at 1D980 masks them); message 15 (transmitter 1DA5A) carries the high bits
of those bytes in its bytes 1-3 and then RAM 346A2-346B5. Every bit was placed by sending each
global NRPN/CC to the unit and reading the global back (`re/sn2/work/globprobe.py`, `ccglob.py`),
except Incoming control change (not sent: Disabled would stop all NRPNs; placed from the NRPN 110
handler at E350 and the manual's table) and the digital I/O settings (the unit has no card).

| Byte | Contents |
|---|---|
| 0F 0 | global MIDI channel |
| 0F 1 | Sysex transmission: NRPN 84 88-127 store the OS 1 choices, NRPN 120 MSB 126 0-21 the drum map and pattern bank choices; the getter at 145C8 maps them onto the 62-entry menu list |
| 0F 2, 3 | master tune, pedal/breath (list of 128: Off, MW, A/T, CC3-CC119, Bend, Bend+, Bend-, N75-N77, N95, N96) |
| 0F 4 | arp transpose channel: 7Fh Off, 0-15 = 1-16 (NRPN 118 0 stores 7Fh) |
| 0F 5-9 | arp transpose reference, MIDI clock (105-107), master volume, user pattern edit number, program change map location |
| 0F 10-14 | **power-up sound**: mode (bits 0-1: 1 program, 2 performance), program bank (bits 0-3, +13 when 15 byte 14 bit 6 is set: drum maps), program, performance bank, performance. Written from the current sound when the global settings are written (12662), read at power-up (AD10). On the test unit: performance B000, the performance it was in |
| 0F 15 | Sysex reception: NRPN 109 66-79, NRPN 120 MSB 125 0-10 stores 80-90 (getter 14950) |
| 0F 16-271 | program change map: 128 x (bank, program) |
| 15 0 | 28h |
| 15 1 | bit 2 local control (set = Off; CC 122), bits 3-6 breath sensing (0 Norm, 1-5 = +1..+5, 6-10 = -5..-1) |
| 15 2 | bits 4-5 breath mode |
| 15 3 | bits 4-6 arp pattern editing via MIDI |
| 15 4-11 | zero: the transmitter clears its buffer (1DA46) and the receiver ignores them |
| 15 12 | Pedal/sw 3 (12-15; the receiver raises lower values to 12) |
| 15 13 | 5Fh from the defaults (1F334); no code of the Rack or Keyboard OS 2.0 reads it. It is the Nova's Headphones out (OS 4.1: 92-95, 5Fh = Mix) |
| 15 14 | bits 0-1 incoming program change, 2 incoming control change (set = Disabled), 3 vel sensing (set = Soft), 4 knob mode (set = Pickup), 5 cleared on global write and never read, 6 the power-up program bank is a drum map |
| 15 15 | the Keyboard keeps its favourites slot here; the Rack only defaults it |
| 15 16 | flags, set = Off: 0 finder demos, 1 program change Tx, 2 controllers Tx, 3 aftertouch Tx, 4 key velocity Tx, 5 arp kbd notes Tx (3-5: Keyboard only, its NRPN 122 MSB 44-46), 6 button clicks |
| 15 17, 18 | Input/sw 1, Input/sw 2 |
| 15 19, 20, 21 | Sysex Tx delay (ms), temporary display time, user pattern bank U/V/W |
| 15 22, 23 | digital I/O card: sample rate, sync, optical/electrical in and out (handlers 1217A-12308, active only with the card) |
| 15 24, 25 | the transmitter writes 40h; stored in RAM 346AE-AF, which nothing reads. They are the Nova's Trim1/Trim2 (OS 4.1: 54-74 = -10..+10) |
| 15 26, 27 | input gains 1/2: 56-124 = -8..+60 dB |
| 15 28-31 | the transmitter writes 0; stored in RAM 346B2-B5, which nothing reads |
| 15 32-287 | the program change map again |

**Memory protect** (RAM 34666: 78h On, 79h Off; packed NRPN 1 120/121) is not in either message;
the Global page has buttons for it. The user keeps it Off (the factory setting is On); the test
unit was set Off on 2026-11-25 and that was proven by a global write that was accepted.

## Arpeggio patterns

The **Arp patterns** page edits a user pattern: number (000-063 mono, 064-127 poly), No of steps, and
64 steps in a step grid / tracker (note, velocity, gate). A pattern is 194 bytes (receivers 1CC98
mono / 1CD0C poly, transmitters 1D840 / 1D8B6):

| Bytes | Contents |
|---|---|
| 0 | mono: the highest note number a sounding step uses (recomputed by 18FD2 after each edit; the editor recomputes it before sending); poly: 0 |
| 1 | No of steps 1-64 (NRPN 126; RAM byte 1 of a mono pattern, byte 0 of a poly one) |
| 2 + 3s | step s: note (mono 1-12 = the n-th held note, NRPN 124; poly 28-100 = 64 + semitones -36..+36), then the gate/velocity byte as two nibbles: bits 0-6 velocity (NRPN 125, 1-127), bit 7 a flag |

Gate (packed NRPN 1 94-97, setters D16C and D1D2): Rest = velocity 0 without the flag, Tie =
velocity 0 with it (the display shows "---"), Norm = a velocity without the flag, Glide = with it.
Choosing Norm or Glide on a rest or tie gives it the last velocity used.

| Message | |
|---|---|
| 0A pp <194> | the pattern edit buffer; pp becomes the global User pattern edit number (an edit buffer, not a memory write) |
| 0D | request it (reply 0A) |
| 0B | write the edit buffer into the user bank set by the global User pattern bank (memory) |
| 0C pp <194> | pattern pp of bank U, or V/W when Sysex reception is "All patts to user (V)/(W)" (memory) |
| 22 bb pp <194> | pattern pp of bank bb (15 U, 16 V, 17 W) (memory) |
| 16 bb pp | store the edit buffer into bank bb, pattern pp (memory) |
| 13 bb pp | single request (bb 15-17): replies 0C for U, 22 for V/W; the Mono (13) and Poly (14) preset banks do not answer |
| 14 pp | request pattern pp of bank U (reply 0C) |
| 0E | all patterns request |

Checked on the Rack: the edit buffer (0D/0A) and U000, V000, W005 (13 bb pp) read in Chrome; an
edited pattern (a Tie and a velocity 77) sent to the edit buffer read back exactly, and the original
was sent back and verified byte for byte (global unchanged).

## Rack and Keyboard

The Global and Performance pages have a **Model** choice (Rack 24h / Keyboard 22h; a read from the
unit sets it). With Rack, the Keyboard-only settings (aftertouch / key velocity / arp kbd notes Tx,
the External Parts and transpose zone bytes) are hidden; they stay in the data.

## Keyboard and other operating systems

The Keyboard OS 2.0 uses the same message formats (its global 15 transmitter at 21F84 matches the
Rack's byte for byte); it adds the External Parts, the transpose zone and the Tx flags described
above. Their displays come from the Keyboard OS 2.0 menus (records 74A18-7830A there, found with
`re/novwork/menux.py`): Ext part MIDI ch (Off, 1-16), Ext bank MSB/LSB, program, volume (0-127),
Ext lowest/highest note, Ext velocity min/max and Default velocity (1-127), transpose (4-124 shown
signed), Mod wheel Tx CC, MIDI Stream byte (1-12), Kbd t-zone hi/lo (notes), zone detune (signed).
The Tx option bits (menu "PBMWAVSN": prog change, bank change, mod wheel, pitch bend, aftertouch,
volume, sustain, kbd notes), the stream bytes, byte 448 and the transpose zone switch stay typed
values. The Nova II Keyboard (model 23, `novation-nova2.md`) uses these formats as well. Older OS versions (1.x) do not have messages 1B, 1C, 1E, 1F, 20, 21 or 15: the editor
still reads their 00/02/05/07/0F messages (the missing parts stay at their defaults).

## Translator

Programs and performances have `toCommon` / `fromCommon`. Another SuperNova II gets the exact
bytes (`extra.program` / `extra.performance`); other models get OSC 1-3 (waves, pitch, width,
sync), the oscillator balance, filter (type, slope, cutoff, resonance, Env 2 depth and envelope),
Env 1 as the amplifier, LFO 1/2, EQ, chorus, delay and reverb sends, with a report of what was
approximated. Categories map to the Head Library's.

## Live checks (2026-11-25, Rack OS 2.0)

- Captured first (`re/sn2/live/s2/cap_*.syx`): identical to the 2026-11-19 captures.
- Global: every global NRPN and CC 122 sent with each value and read back (`gprobe1.jsonl`,
  `gprobe2.jsonl`); everything returned to the captured values and checked byte for byte.
- Program mode: the unit was switched to program A000 (bank select 5, program change 0; its edit
  buffer then equalled stored A000) and every CC, every packed NRPN value and every NRPN 120/122
  MSB the firmware handles (key tables 11065 and 11402; the handlers ignore other MSBs, which the
  sweep of MSBs 4, 5, 12 and 15-30 confirmed) was sent to it (`re/sn2/work/progsweep.py`,
  `sweep1.jsonl`, `sweep2.jsonl`, `sweep3.jsonl`), the program sent back after each. That found the
  program-mode arpeggio speed, latch and arpeggiator bytes.
- In Chrome (`tools/browser/cdp.mjs`): the editor connected to the port and read the current
  program, performance and global, each equal to the captures byte for byte; the Global page
  showed the unit's values (e.g. Arp trans chan Off, Power-up Performance B, Local control Off);
  the MIDI channels page listed the 8 parts; **Send to SuperNova** sent the performance and it read
  back unchanged.
- Afterwards the unit was put back in performance B000 and its captured edit buffers sent back;
  performance, current program and global were compared with the captures byte for byte.
- Later the same day (part mute test for performance byte 19): the performance and global read first
  (equal to the captures), part 1's Sus/sw2 set to Part mute in the edit buffer (message 05), CC 64
  127/0 sent on the global channel, the performance read back (only the Sus/sw2 byte had changed),
  the captured 05 sent back; performance, program and global then equalled the captures byte for
  byte (`re/sn2/live/s2/mute_*.syx`). No memory writes; Memory protect untouched (still Off).

## Not identified yet

Searched in every image (SuperNova II Rack 1.3/1.5/2.0, Keyboard 1.5/2.0, Nova II Keyboard 2,
SuperNova and Nova OS 4.1) for setters **and readers** (loads of the byte followed by a test of its
bits, the edit-buffer and RAM-copy accesses, the new-program and dump routines), and in the factory
sounds (SuperNova II Keyboard OS 2 zip: 1274 programs, 256 performances; the Nova `total.mid`).
Scripts: `re/novwork/readers.py`, `blockrd.py`, `factory.py`. What was found:

- **238 bits 0-1 = Polyphony (program mode)**: menu field "polyphony" (6E2E4, values 1-2 Mono/Poly).
  The setter E590 writes them in program mode and a part's Part polyphony (part byte 10 bits 0-1) in
  performance mode; Off and 3 are refused for a program; read at E63A, 104C0, 105AE. Now a named
  parameter.
- **Part byte 10 bit 5** is the Nova's Expression pedal (OS 4.1 setter B492, values 118/119); no
  SuperNova II or Nova II OS sets or reads it: shown read-only with that note. Global 15 13 and 24-25
  are the Nova's Headphones out and Trim1/Trim2 (table above).
- **Panel state** (shown read-only as numbers, no display text exists): 19 bits 0-2, 20 bits 0-3 and
  21 bits 0-1 are written by the front-panel button table (SuperNova OS 4.1: records 38BE8-38E68
  call setters 1C998, 1CB9C, 1CA1E with a mask and a value: 19 bits 0-2 = 0-4 from buttons 0Eh-12h,
  20 bits 0-3 = 0/1 from buttons 20h/21h, 21 bits 0-1 = 0-2 from buttons 0Bh-0Dh; the same table
  gives the mod. source buttons in panel order LFO 1, LFO 2, Env 2, Env 3, Wheel). 237 bits 4-6 is
  a remembered page of a panel section: the Nova OS 4.1 (1971A) and the Nova II (24B14) read it when a
  program loads and index their page-pointer table (RAM 38E92 / 5F5A4) with it; the SuperNova II OS
  only masks it off (and #0Fh). Factory values: 19 0-4, 20 0-1, 21 0-2, 237 bits 4-6 0-5.
- **1E 9-12**: the new-program routine writes 64, 60, 36, 76 (Rack 1F4CE-1F4F6, Keyboard 23A62,
  Nova II 235B8, the same in OS 1.5); the same four values initialise a RAM block (Rack 1.5 57F2F-
  57F32, checked at 1F0A8) and a block at +1D0 of another structure (1F608). No reader was found
  (the OS 2 block at 673E4 + 58h x part is reached through pointers; no absolute-indexed access to
  these offsets in any image). Factory programs: 1E 9 = 61-66, 1E 10-12 = 60, 36, 76 in all. Read-only.
- **0 in every factory sound and no setter or reader**: 1E 75, 249 bits 3-4, effect byte 21 bit 3,
  1E 3 bit 6, 1E 41 bits 2-6, 1E 56 bits 2-6, 209 bit 4, 19 bit 6, 21 bit 6; 1B 8-15; part OS 2 block
  19-32, block 0 bits 2-6 and block 33 bits 0-2 and 4-5. Whole bytes are shown read-only (group
  Reserved); bits inside named bytes are kept by every edit.
- **Performance 16** = 2Fh in every factory performance (SuperNova II and Nova); **19** is 0 or a
  single bit (1, 2, 4, 8, 16, 64) in a few: perhaps the part mutes the manual says a performance
  stores, but muting part 1 on the Rack (Sus/sw2 = Part mute, CC 64, edit buffer only) did not change
  it. **1B 5** is 3 or 4 in the Nova's factory performances, 0 on the SuperNova II. All read-only.
- **Keyboard External Parts**: the Keyboard NRPN 120 MSB 16-111 handlers are 12 field groups x 8
  parts (MSB 16 + 8 x field + part); they share code by falling through, so the order of the Tx
  option bits (menu "PBMWAVSN") and the stream bytes inside the 16-byte part is not placed yet: those
  stay typed values, as do byte 448 and the transpose zone switch.

## Open items

1. Names for the read-only bytes above: 1E 9-12 (the voice engine's pointer-based reads of the OS 2
   block are the next place to look), the panel states (need the panel layout), performance 16/19.
2. The External Parts' Tx option bits and stream bytes (Keyboard), byte 448, the transpose zone
   switch: typed values until the fall-through NRPN 120 handlers are traced field by field.
3. SuperNova II units on OS 1.x are out of scope (the user's decision): the editor reads their
   messages, but nothing is done or checked for them.
