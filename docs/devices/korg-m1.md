# Korg M1 / M1R / M1EX / M1REX: MIDI implementation from the M1R v1.06 firmware

The editor (`js/devices/defs/korg-m1.js`) serves both catalog entries (M1 and M1R; the EX
models use the same messages). It was built from the M1R v1.06 OS, cross-checked against the
M1 keyboard rev 19 OS, and checked against an M1R over MIDI with `tools/korg/m1live.py` and
`tools/korg/m1probe.py`. Every byte of the program, combination and global dumps has the label,
range and display the M1 uses for it.

## Firmware

Two 27C512s per version: IC32 holds the even bytes, IC23 the odd ones. Interleaved they make a
128 KB image at E000:0000 (the reset vector jumps to E000:0000). The CPU is a NEC V50 (x86
real mode). The startup code sets DS = F7BF on the M1R (F75C on the M1 keyboard), so data
offsets below 8410h address the top of the ROM (image offset = 17BF0h + offset) and higher
offsets wrap into RAM. The MIDI code runs in code segment EF69 (F000:x - 970h); the edit-page
handlers run in segment E064, so a handler word h in a field record is the code at E000:h+640h.

## SysEx

`F0 42 3g 19 ff ... F7`, g = global channel. The function dispatcher is at F000:1C1A; codes
0E-1F jump through DS:8384, codes 40-51 through DS:8360.

| Code | Message | Notes |
|---|---|---|
| 10 | program dump request | reply 40, 143 bytes (program modes) |
| 19 | combination dump request | reply 49, 124 bytes (combination modes; else 24) |
| 0E bb | global request | reply 51 bb, 861 bytes; bb 0 internal, 1 card |
| 1C bb / 1D bb | all programs / all combinations | replies 4C / 4D, 100 records each |
| 0F bb / 18 bb | all data / sequence data | replies 50 / 48 |
| 12 | mode request | reply 42 mode ... |
| 4E mm bb | mode change | 0 combi play, 1 combi edit, 2 program play, 3 program edit; bb card |
| 11 bb nn / 1A bb nn | program / combination write | refused (22) while memory protect is on |
| 41 pl ph vl vh | parameter change | edit modes only; numbers 0-27, the high byte is ignored |

Without the memory byte, the bulk requests answer 26 (format error). Replies: 21 write
completed, 22 write error, 23 data load completed, 24 data load error (wrong mode), 26 format
error. Dumps are 7-in-8 packed (a byte of high bits, then 7 bytes). The M1R also answers the
universal identity request (family 19 00).

The parameter-change numbers 0-27 (found by sending each to the M1R and reading back) cover
OSC mode, both multisounds, the VDF/VDA levels and center keys, MG waveforms, controller pitch
ranges and effect types. The editor sends every edit as a whole dump (program 170 bytes,
combination 150, global 991) instead, which reaches every parameter and is heard at once.
Reads switch the M1's mode, so the editor runs them one at a time.

## Edit pages

The edit pages are lists of 16 slot pointers (slot index in DS:8EC3) to field records: a
layout word, a pointer to a descriptor `[max, min, abbreviation, label]` (or an option list),
the field's RAM address, then option lists and handler words. Program fields point into the
edit buffer at DS:9969, combination fields into DS:98EB, global fields into DS:984E; effect and
timbre pages use relative addresses that their handlers rebase (below).

## Programs (143 bytes)

| Bytes | Contents |
|---|---|
| 0-9 | name |
| 10 | OSC Mode: SINGLE, DOUBLE, DRUMS |
| 11 | bit 0 Voice Mode (POLY, MONO), bit 1 Hold |
| 12, 14 | OSC1 / OSC2 Multisound: 0-99 internal, 100 and up the PCM card's (shown C0, C1...); Drum Kit 1-4 in DRUMS mode |
| 13, 15 | Octave -1..1 (16', 8', 4') |
| 16-18 | OSC2 Interval ±12, Detune ±50, Delay Start 0-99 |
| 19, 23 | Pitch MG / VDF MG: bits 0-1 Waveform (TRIANGLE, SAW UP, SAW DOWN, SQUARE), bits 5-6 OSC/VDF Select (OFF, 1, 2, BOTH), bit 7 KeySync |
| 20-22, 24-26 | MG Frequency, Delay, Intensity 0-99 |
| 27-31 | aftertouch: Pitch ±12, Pitch MG 0-99, VDF Cutoff ±99, VDF MG 0-99, VDA Amplitude ±99 |
| 32-37 | joystick: Pitch Bend ±12, VDF Sweep Int ±99, Pitch MG Int 0-99, Pitch MG Freq 0-3, VDF MG Int 0-99, VDF MG Freq 0-3 |
| 38-62 | effect block (below) |
| 63-70 | OSC1 pitch EG: Start Level, Attack Time, Attack Level, Decay Time, Release Time, Release Level, Time Vel.Sens (69), Level Vel.Sens (70) |
| 71-77 | VDF1 Cutoff, kbd track Center Key and Cutoff, EG Intensity, kbd track EG Time, velocity EG Time, velocity EG Intensity |
| 78-85 | VDF1 EG: AT, AL, DT, BP, ST, SL, RT, RL |
| 86-91 | VDA1 OSC Level, kbd track Center Key and Amplitude, velocity Amplitude, kbd track and velocity EG Time |
| 92-98 | VDA1 EG (levels 0-99) |
| 99-102 | EG time switches for VDF kbd track, VDF velocity, VDA kbd track, VDA velocity |
| 103-142 | the same for OSC2 |

EG time switches (handlers E000:3C63/3CA4): segment n (AT, DT, ST, RT = slots 12-15 on the
page) is on with bit n and negative with bit n+4; shown as `-`, `0`, `+`. Factory programs have
sign bits set on switched-off segments, which the M1 ignores; the editor keeps them.

## Effects

The effect block (program 38-62, combination 11-35):

| Byte | Contents |
|---|---|
| 0, 1 | effect 1 / 2 type: 0 Hall ... 32 Delay/Tremolo, 33 No Effect (names at DS:6EE6) |
| 2, 3 | effect 1 DRY:EFF balance (0 DRY, 100 EFF, else `100-v:v`); single effects store one value in both bytes, the Delay/... doubles one per part |
| 4, 5 | effect 2 balance |
| 6, 7 | Out 3 / Out 4 panpot, 0-101 (0 OFF, 1 L, 101 R, else L:R) |
| 8 | bits 0-1 effect 1 on, 2-3 effect 2 on, bit 4 placement (PARALLEL/SERIAL) |
| 9-16, 17-24 | effect 1 / 2 parameters |

The page for each type comes from the table at DS:2A4C (image 1A63C); each page lists its
fields (image 1EC90-1F640). Their handlers address the block ([C34D]: 998F for the program,
98F6 for the combination) + 9 or 17 + (address - C04D) and read a signed byte, an unsigned
byte, a little-endian word (Delay Time, Time L/R, Reverb Time) or bit 0 (Waveform: SIN, TRI;
the other bits are unused and kept). Displays: Mod Speed 0-216 = 0.03-3.00 Hz in 0.03 steps,
3.1-13.0 Hz in 0.1 steps, then 14-30 Hz (E000:9C92); Reverb Time (v+2)/10 s (E000:9D68); E/R
Time (v+10)x10 ms (E000:9DAE); Feedback with a sign. Selecting a type loads that type's 8
default parameter bytes (image 1EB80), as the editor does too.

| Types | Parameters (byte: field) |
|---|---|
| Hall, Ensemble Hall, Concert Hall | 0: Reverb Time 0.2-9.9 s, 3: Pre Delay 0-200 ms, 4: E/R Level, 2: High Damp, 7/6: EQ Low/High ±12 dB |
| Room, Large Room, Live Stage | same with Reverb Time 0.2-4.9 s |
| Early Ref 1-3 | 0: E/R Time 100-800 ms, 1: Pre Delay 0-200 ms, EQ |
| Stereo Delay, Cross Delay | 0: Time L, 4: Time R (0-500 ms), 2: Feedback, 3: High Damp, EQ |
| Chorus 1, 2 | 0: Mod Depth, 1: Mod Speed, 4: Time 0-200 ms, 2: Waveform, EQ |
| Flanger, Cross Flanger | 0: Mod Depth, 1: Mod Speed, 4: Time 0-50 ms, 3: Feedback, 2: Waveform, EQ |
| Phaser 1, 2 | 4: Manual, 1: Mod Speed, 0: Mod Depth, 3: Feedback, 2: Waveform |
| Tremolo 1, 2 | 0: Mod Depth, 1: Mod Speed, 2: Waveform, 3: Shape, EQ |
| Equalizer | 7: Low Gain, 5: Low Freq (250, 500, 1K Hz), 6: High Gain, 4: High Freq (1K, 2K, 4K Hz) |
| Over Drive / Distortion | 2: Drive / Distortion 0-100, 3: Level 0-100, EQ (Distortion's page has EQ Low only) |
| Exciter | 0: Blend ±99, 1: Emphatic Point 1-10, EQ |
| Symphonic Ens | 0: Mod Depth, EQ |
| Rotary SP | 0: Mod Depth, 2: Speed Ratio ±10 |
| Delay/Hall, Delay/Room | 0: Delay Time, 2: Feedback, 3: High Damp; 4: Reverb Time, 7: Pre Delay 0-150 ms, 6: High Damp |
| Delay/E.Ref | delay as above; 4: E/R Time 100-400 ms, 5: Pre Delay 0-100 ms |
| Delay/Delay | 0: Time L, 2: Feedback L, 3: High Damp L, 4: Time R, 6: Feedback R, 7: High Damp R |
| Delay/Chorus, /Flanger, /Phaser, /Tremolo | delay as above; 4: Mod Depth, 5: Mod Speed, then 6: Waveform / 7: Feedback / 6: Feedback / 7: Shape |

## Combinations (124 bytes)

| Bytes | Contents |
|---|---|
| 0-9 | name |
| 10 | type: SINGLE, LAYER, SPLIT, VEL.SW, MULTI |
| 11-35 | effect block |
| 36 + 11t | timbre t (8 timbres) |

Timbre pages use base DS:98EB; their handlers add 36 + timbre x 11 (E000:325A):

| Byte | Contents |
|---|---|
| +0 | Program 0-99 (shown OFF when +10 bit 4 is set) |
| +1 | Output Level 0-99 |
| +2, +3 | Transpose ±24, Detune ±50 |
| +4 | Panpot 0-13: A, 9:1 ... 1:9, B, C, C+D, D (E000:339D); bit 7 = SND, set by the M1 when the timbre plays a DRUMS program (E000:3187) |
| +5, +6 | key window top / bottom |
| +7, +8 | velocity window top / bottom (1-127) |
| +9 | MIDI filtering bits 0-3: program change, damper, aftertouch, control change (DIS/ENA) |
| +10 | MIDI channel (bits 0-3); bit 4 timbre off |

Changing the type rebuilds the timbres (E000:327D): every timbre becomes the init timbre at
DS:062C (program 0, level 99, panpot 5:5, full windows, filters on, off), timbre 1 keeps its
program on the global channel, timbre 2 too for LAYER, SPLIT and VEL.SW; SPLIT splits at C4
(timbre 1 top B3), VEL.SW at velocity 63. MULTI only opens the velocity windows. The SPLIT
page's Split Point and the VEL.SW page's Vel SW Point edit timbre 2's lower limit and timbre
1's upper limit together; the editor does the same.

## Global (861 bytes)

The global dump sends RAM 984E-9852 and 9858-9867 (E000:A446); receiving one loads the first
19 bytes back (F000:23AE-23F4) and skips bytes 19-20. Memory protect (9853) and the MIDI
settings (9854-9857: global channel, clock, MIDI filtering) are not part of it.

| Byte | RAM | Contents |
|---|---|---|
| 0 | 984E | Master Tune ±50 |
| 1 | 984F | Key Transpose ±12 |
| 2 | 9850 | Damper Switch Polarity (bit 0: +, -); shown by the M1 keyboard (its RAM 9E80), kept without a page by the M1R |
| 3, 4 | 9851-2 | Pedal 1 / 2 assign: Program Up, Program Down, Seq Start/Stop, Effect 1 ON/OFF, Effect 2 ON/OFF, Volume, VDF Cutoff, Effect 1 Cntl, Effect 2 Cntl, Data Entry |
| 5 | 9858 | Scale Type: Equal Temp, Equal Temp2, Pure Major, Pure Minor, User Programable |
| 6 | 9859 | Key (C ... B) |
| 7-18 | 985A-9865 | user scale, C ... B, ±50 cents (E000:3F2D) |
| 19 | 9866 | Memory Allocation: 100PROG/100COMBI/4400SEQ or 50PROG/50COMBI/7700SEQ (read only) |
| 20 | 9867 | the selected combination (read only) |
| 21 + 7i | | drum kit instrument i (4 kits x 30) |

Drum kit instruments (RAM records of 10 bytes at A01A, converted by E000:A46E):

| Byte | Contents |
|---|---|
| +0 | Sound: 0 No Assign, 1-44 the ROM drum sounds, 45 and up the PCM card's |
| +1 | Inst Key |
| +2 | Inst Pan (same values as the timbre panpot) |
| +3 | Inst Tune ±120 ((key - RAM+5) x 10 + RAM+4 / 10 in RAM) |
| +4, +5 | Inst Level ±99, Inst Decay ±99 |
| +6 | always 0 (written by the dump code, not used) |

## MIDI channels page

The combination object has a `multi` hook, so the editor shows a MIDI channels page: one row per
timbre with its program (or OFF), MIDI channel, level, panpot, transpose and key window, a list
of who plays on each channel, a Channels in order button and a button that makes the
combination MULTI. A MULTI combination with timbres 1-3 on channels 1-3 built this way was sent
to an M1R's combination edit buffer and read back identically (`re/m1/multicheck.py`).

## Translator (Head Library)

`js/devices/defs/korg-m1-translate.js` moves programs and combinations through the shared synth
model (`docs/HEAD_LIBRARY.md`). Every program and combination keeps its exact bytes in
`common.extra` (family `korg-m1`), so the M1 and M1R take each other's sounds byte for byte.

From an M1 **program**: OSC1 (and OSC2 in DOUBLE mode) as oscillators, their multisounds as
`rom:<name>` waves, except the plain synth waves (Saw Wave, SquareWave, DWGS TRI, DWGS Sine, 25% and
10% Pulse), which are named `saw`, `square`, `triangle`, `sine`, `pulse`; DRUMS mode as
`drum-kit:<n>`. Octave and interval as semitones, the OSC2 detune as cents, the VDA levels as the
oscillator levels and balance. OSC1's pitch EG, VDF and VDA give the pitch envelope, the filter
(low pass, no resonance) and the amplifier: the 8-stage EGs read as ADSR (AT attack, DT + ST decay,
SL sustain, RT release). The pitch MG is LFO 1 (its OSC select is the pitch target), the VDF MG
LFO 2. Effects by kind: Hall ... Early Ref as reverb, Stereo/Cross Delay as delay, the rest as the
modulation effect; the Delay/... doubles give both.

Into an M1 program from another model: up to two oscillators (SINGLE or DOUBLE), waves by name
(nearest multisound by shared words, e.g. a JV-2080 "ST.Strings" finds Strings) or by shape (saw
→ Saw Wave, noise → Breath, approximated); coarse tuning in octaves (16', 8', 4') plus the OSC2
interval (±12); both VDF/VDA from the filter and amp envelopes; MONO for mono and legato. Reported
as dropped: resonance (the VDF has none), portamento, amp LFO, sync, ring and cross modulation,
tone, velocity and controller depths. Two effects at most: modulation first, then reverb; a delay
takes a free slot or joins the reverb as Delay/Hall or Delay/Room; parameters are the M1's defaults
for each type.

A **combination** reads as `keyMode` (SINGLE single, LAYER layer, SPLIT split with `splitPoint`,
VEL.SW velocity-switch, MULTI multi) and 8 `parts` (`on`, `program` 0-99, `channel`, `level`,
`transpose`, `fine`, `pan` -1..1 for A..B with `output` C/C+D/D, `low`/`high` key window,
`velLow`/`velHigh`). From another model (e.g. a JP-8080 performance, dual → LAYER) the type, the
timbre layout, levels, transpose, detune, pans and windows are set; programs are left to choose,
since another model's program numbers do not apply, and part channels are used in MULTI only.

The drum kits are part of the global dump (a settings object, not translated).
