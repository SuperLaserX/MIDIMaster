# Roland JP-8080: MIDI implementation from the OS v1.04 firmware

The editor (`js/devices/defs/roland-jp8080.js`: the model config over the code it shares with the
JP-8000 in `roland-jp.js`, with the tables in `roland-jp8080-fw.js` and the Motion page in
`roland-jp8080-motion.js`) was built
from the JP-8080 OS v1.04 image (`jp8080_v1.04.zip`) and checked against a JP-8080 on MIDI port
`MIDI (OCTA-CAPTURE)`. `tools/roland/jp8080_fw.py` regenerates the tables from the image. The work
files (image, analysis scripts, live captures) are in the gitignored `re/jp8080/`.

## Firmware

Hitachi H8/300H in advanced mode. Ghidra 12.1.4 has no H8 language, so the analysis used the
SuperNova II tools (`re/sn2/work/h8dis.py`) and a recursive-descent script, `re/jp8080/work/jpan.py`.

- **Load address.** The 896 KB file is the flash image loaded at CPU 10000h: CPU block n is file
  block n-1 (the JSR targets prove it). CPU 0-FFFFh is a boot ROM that is not in the file and
  holds the compiler runtime (prologue A0AA, epilogue A0D2, multiply/divide). The 5Ah entries at
  file offset 0 are the jump table the boot ROM vectors call.
- **RAM** is at 200000h. The temporary patches are at 202000h + part × 100h.
- **MIDI in.** SCI0 receive (FFFFB5h) goes into a 2 KB ring at 200468h. `11C46` takes the next
  byte; it handles thru echo and the F8/FA/FB/FC real-time bytes.

All addresses below are CPU addresses.

## SysEx

`F0 41 dev 00 06 cmd ... F7`. The device ID is 10h by default (System: Device ID). The dispatcher
at `121B0` ignores other device IDs.

| Message | Handler | Notes |
|---|---|---|
| `11` RQ1 aa aa aa aa ss ss ss ss cs | `11F76` | Address below 0B 00 00 00. The reply is DT1, at most FEh data bytes per message (`45A9C`). Addresses from 08 00 00 00 up return 7-in-8 packed data (`45934`). |
| `12` DT1 aa aa aa aa data cs | `12052` | Each byte goes through `3E45C`; values outside the SysEx table's range are refused (`3C180`). |
| `3A 12 st d1 d2` | `120E2` | A channel message carried in SysEx (note-on with velocity 0 becomes note-off). |
| `F0 7E dev 06 01` | `1D8A2` | Identity request. The reply (`45CDC`) is `F0 7E dev 06 02 06 01 00 00 00 03 00 00 F7`: **the firmware leaves out Roland's 41h**, and the unit sends exactly that. Generic decoders read the next byte, 06, as the maker (Lexicon); the editor describes it as Roland (family 06 01, model 00 00, version 00 03 00 00). |

### Address map (decoder `45556`, table `D251E`)

Addresses use 7-bit arithmetic. Each parameter's internal ID, range and sub-byte come from the
6-byte entries of `D251E`. The editor shows every byte with the label, range and display the
JP-8080 uses for it (see "Labels and displays").

| Address | Size | Block | Table index |
|---|---|---|---|
| 00 00 00 00 | 19h | System | F8-110 |
| 00 00 20 00 | 4 | Motion loop length A[1] A[2] B[1] B[2] | 141-144 |
| 00 00 30 00 | 2Ah | Tx/Rx setting: the CC of each knob (MODE2), then Control Up/Down | 145-16E |
| 01 00 00 00 | 25h | Temporary performance, common | 177-19B |
| 01 00 08 00 | 29h | Voice modulator | 19C-1C4 |
| 01 00 10 00 / 11 00 | 8 | Upper / lower part | 16F-176 |
| 01 00 40 00 / 42 00 | F8h | Upper / lower temporary patch | 0-F7 |
| 02 00 00 00 + n × 100h | F8h | User patch n (0-127: A11-B88) | 0-F7 |
| 03 nn 00 00 | as 01 | User performance nn (0-63: 11-88), with its two patches at 40 00 / 42 00 | |
| 08-0A | packed | Pattern and motion data (`45444`) | |

**Two-byte values.** Some entries carry sub 1/2: these are a high byte (0-1) and a low byte
(0-127), value = high × 128 + low. They are the performance's Indiv Trig Source Note
(0-128, where 128 = ALL) and TEMPO, and all 75 Control and Velocity depths in the patch
(0-254, where 127 = 0). The editor treats each pair as one parameter and sends both bytes.

## Labels and displays

Each SysEx byte has an internal ID. The UI table at `DE1CA` (8 bytes per UI ID: internal ID, -, -,
class) links UI IDs to internal IDs. The labels and displays come from two descriptor tables that
name UI IDs:

- **Knob descriptors** at `D81BC`, 22h bytes each: label pointer, then fields
  [columns, type, format, argument, UI ID]. The firmware has four sets: the plain knob, Control:,
  Velocity: and (Edit).
- **Menu records** at `D3364`, 2Eh bytes each: header, label pointer, then three fields of the
  same shape.

The value formats are handled by the table at `D61C2`:

| Format | Display |
|---|---|
| 1 / 2 | Performance number 11-88 / patch number A11-B88 |
| 3 | value − argument, shown with a sign (40h → ±64, 32h → ±50, 18h → ±24, 7Fh → ±127) |
| 4 | Option list number *argument*: blob `DF6D4`, offsets in `E2CF8` |
| 5 | Note name C-1 to G9. The table `D6143` uses a flat glyph: Eb, Bb. |
| 6 | Tempo sync: OFF, then the note glyphs at `D80E8` (16th to double whole note, plain, dotted or triplet: table `D615E`), then 3-8 MEASURES and LFO1 (`5DE14`) |
| 7 | Plain number |
| 8 | Note name, or ALL |
| 9 | value + 1 |
| A | MIDI channel 1-16, or OFF |
| D | Motion loop length: PLAY ONCE, then 1-8 |
| 10 / 15 | Bend down shown as −n / bend up shown as +n |
| 18 | Input quantize: OFF, 1/16 triplet, 1/16, 1/8 triplet, 1/8, 1/4 triplet, 1/4 |
| 1A | Remote keyboard channel 1-16, or ALL |
| 1C | OSC2 range: −WIDE, −24 to +24 (value − 25), +WIDE |

**Waveform order.** The OSC1 and OSC2 waveform orders come from the Control1/Control2 label
tables at `5E0C0` and `5E130`, which are indexed by waveform:

- OSC1: SUPER SAW, TRIANGLE MOD, NOISE, FEEDBACK OSC, SQUARE, SAW, TRIANGLE.
- OSC2: SQUARE, SAW, TRIANGLE, NOISE.

**Tx/Rx slots.** Slot s of 00 30 xx is internal ID F6h+s. Its UI ID is E9h + the physical knob
number in the knob table at `DF06C`. Slots follow patch order, and pseudo-knobs 37-39 are the three
LFO2 depths.

### Bytes without JP-8080 screen text

Some bytes appear on no JP-8080 screen. Each takes its name from the best source that exists:

- **Panel switches** light LEDs and have no LCD text. Table `8D30C` flags them (83h), and the
  firmware's own tables fix a few value orders: the OSC1 waveforms (from the Control labels at
  `5E0C0`) and the patch bank (bank select table `D30B4`). Names and the other value orders come
  from Roland's parameter address map in the JP-8080 owner's manual (MIDI implementation, pages
  200-205 of the ManualsLib copy).

  | Byte | Name | Values |
  |---|---|---|
  | Patch 10h | LFO1 waveform | TRI, SAW, SQR, S/H |
  | Patch 14h | LFO2 depth select | PITCH, FILTER, AMP (the knob the LFO2 DEPTH control edits) |
  | Patch 15h | Ring modulator switch | OFF, ON |
  | Patch 18h | LFO1 & envelope destination | OSC1+2, OSC2, X-MOD DEPTH |
  | Patch 21h | OSC2 waveform | SQUARE, TRIANGLE, SAW, NOISE |
  | Patch 22h | OSC2 sync switch | OFF, ON |
  | Patch 27h | Filter type | HPF, BPF, LPF |
  | Patch 28h | Cutoff slope | -12, -24 dB/oct |
  | Patch 3Ah | Auto/manual pan | OFF, AUTO PAN, MANUAL PAN |
  | Patch 45h | Portamento switch | OFF, ON |
  | Patch 47h | Mono switch | OFF, ON |
  | Patch 48h | Legato switch | OFF, ON |
  | Patch 49h | Oscillator shift | -2 to +2 octaves |
  | Patch 9Bh | Velocity switch | OFF, ON |
  | Patch F1h | OSC2 external input switch | OFF, ON |
  | Patch F2h | Voice modulator send switch | OFF, ON |
  | Patch F3h | Unison switch | OFF, ON |
  | Performance 10h | Key mode | SINGLE, DUAL, SPLIT |
  | Performance 12h | Panel select | UPPER, LOWER, UPPER & LOWER |
  | Performance 17h | Arpeggio switch | OFF, ON |
  | Performance 18h | Arpeggio mode | UP, DOWN, UP&DOWN, RANDOM, RPS |
  | Performance 1Ah | Arpeggio octave range | 1-4 octaves |
  | Performance 1Bh | Arpeggio hold | OFF, ON |
  | Performance 24h | Vocal/upper input jack | REAR, FRONT |
  | Voice modulator 00 | Voice modulator switch | OFF, ON |
  | Voice modulator 01 | Voice modulator panel mode | OFF, ON |
  | Part 00 | Patch bank | IN PERFORMANCE, USER, PRESET, CARD |
  | Part 07 | Patch group | Group 1-64 |
  | System 00 | Performance bank | USER, PRESET, CARD |
  | System 17h | Performance group | Group 1-64 |

  The OSC2 waveform order is from the address map. The firmware's OSC2 label table leaves SAW and
  TRIANGLE blank, so it cannot tell them apart.

- **JP-8000 settings** are kept so that JP-8000 data loads. Roland's map marks them "---" (ignored
  by the JP-8080). The names come from the JP-8000 OS v1.05 menus, which use the same table layout
  (SysEx table `6D830`, UI table `72F88`, menu records of 2Ch bytes; see
  `re/jp8080/work/extract2.py`). The values are the JP-8080's own option lists.
  - System 09: Remote Ctrl CH (always 17).
  - System 0D: Motion Set, list 18: SET A, SET B. The address map lists it as a JP-8080 setting
    too.
  - System 12h-16h: no menu in either firmware.
  - Performance 1Ch: Pedal Assign, list 4: OFF, MODULATION, PANPOT, EXPRESSION, the 40 knobs,
    RIBBON UP, RIBBON DOWN.
- **Patch F0h** is reserved and always 0.
- **Patch ECh-EEh** are the "active indicators" of the Bend, Velocity and Control assignments.
  The JP-8080 sends them but ignores them when received, so the editor shows them read-only.

The OSC2 Range and OSC2 Fine/Wide depths are limited to -50..+50 and -100..+100 (patch 62h/64h
and B4h/B6h).

## Channel messages

The control change handler is at `47248`. These CCs are fixed:

| CC | Function |
|---|---|
| 0, 32 | Bank select. Stored only when Tx/Rx ProgChg SW is BANK SEL + PC. |
| 1 | Modulation |
| 5 | Portamento time |
| 6, 38 | Data entry |
| 7 | Volume |
| 10 | Pan |
| 11 | Expression |
| 64 | Hold |
| 65 | Portamento switch |
| 84 | Portamento control |
| 98-101 | NRPN and RPN numbers |
| 120-127 | Mode messages |

Every other CC from 0 to 95 goes to `47186`. On a part's MIDI channel it drives the knobs assigned
to that CC; the lists are built at `20780`.

- **Tx/Rx Edit SW OFF**: no knob is assigned to a CC.
- **MODE1**: the fixed CCs from table `8D30C`, byte 6 of each entry:

  | Knob | CC |
  |---|---|
  | LFO1 RATE | 16 |
  | LFO2 RATE | 17 |
  | OSC X-MOD DEPTH | 70 |
  | OSC BALANCE | 8 |
  | OSC LFO1 DEPTH | 18 |
  | OSC1 CONTROL1 / CONTROL2 | 4 / 76 |
  | OSC2 FINE / CONTROL1 / CONTROL2 | 77 / 78 / 79 |
  | FLT CUTOFF FREQ | 74 |
  | FLT RESONANCE | 71 |
  | FLT LFO1 DEPTH | 19 |
  | FLT ENV DEPTH / ATTACK / DECAY | 81 / 82 / 83 |
  | AMP LEVEL | 7 |
  | AMP LFO1 DEPTH | 80 |
  | AMP ENV ATTACK / DECAY / RELEASE | 73 / 75 / 72 |
  | TONE CTRL BASS / TREBLE | 92 / 95 |
  | MULTI-FX LEVEL | 93 |
  | DELAY TIME / FEEDBACK / LEVEL | 12 / 13 / 94 |
  | PORTAMENTO TIME | 5 |

- **MODE2**: the user table at 00 00 30 xx. Its factory values are byte 5 of the same table and
  match what the unit holds.

The Control Up and Control Down CCs (00 00 30 28/29) step the Control knob.

**RPN.** No parameter is reachable by NRPN.

| Channel | RPN | Effect |
|---|---|---|
| Perform Ctrl channel | 1 (fine tune) | Master Tune, ±50 |
| Part channel | 0 (bend sensitivity) | Sets both Bend Range Up and Down (patch 43h/44h) |
| Part channel | 1 (fine tune) | Part detune |
| Part channel | 2 (coarse tune) | Part transpose, ±24 |

**Program change** (`473A2`, `43368`) follows Tx/Rx ProgChg SW (OFF, PC, BANK SEL + PC):

- On the Perform Ctrl channel (system 02) it selects a performance.
- On a part's channel (part byte 02) it selects that part's patch.
- Bank MSB 50h = user, 51h = preset (LSB 0-2), 52h = card (LSB = card bank).

Part bytes 00, 07 and 01 hold the bank, group and number that were selected.

Writing a part's Patch bank, group or number by DT1 loads that patch into the part, replacing the
temporary patch. IN PERFORMANCE (bank 0) cannot be written: only selecting a performance sets it.

## Presets

The ROM holds the preset records with their names (`tools/roland/jp8080_fw.py` extracts them):

- **Patches** at `8FFE2`, B0h bytes each.
- **Performances** at `A63A2`, 1E0h bytes each (the name, then the upper and lower patch).

Each table starts with INIT, "<< No Card >>" and "<< Empty >>", then banks of 128 patches or 64
performances. PRESET 1-3 are ROM banks 1-3: selecting them on the unit gave PRESET 1 A11
"Spit'n Slide Bs", PRESET 1 B88 "Template 2", PRESET 3 B88 "Pulsing Sweep", performance PRESET 1-11
"Chariots", PRESET 2-11 "Sand Storm" and PRESET 3-88 "Octopus Garden". ROM bank 4 is a further set
(probably the factory user data) that no bank select reaches.

## Motion control data and RPS patterns

| Address | Contents |
|---|---|
| 09 00, 09 40, 0A 00, 0A 40 | Motion A[1], A[2], B[1], B[2] |

**Transfer.** A motion is an event list of varying length. RQ1 (handler `45934`, events from
`383D6`) answers with DT1 messages of up to E7h bytes in 7-in-8 packing: a flag byte holding bit 7
of the six bytes after it, which make one 6-byte event. DT1 to the same addresses (`3E45C` →
`3840C`) writes it back, one event per 7 bytes; the first group starts a new list. An empty motion
sends nothing.

**Event format.** From the player `351E8`, the apply routine `398D0` and the erase routine
`35DB6`:

| Byte | Meaning |
|---|---|
| 0 | Ticks to wait after the event |
| 1 | Not read by the player; the unit keeps whatever the recorder left there |
| 2 | 81h knob event; 80h empty event (time only) |
| 3 | Knob slot 00-27h: the Tx/Rx slots in patch order (slot 4 OSC BALANCE, 10h FLT CUTOFF FREQ, ...) |
| 4 | Value 0-127 |
| 5 | 0 |

- The first event is a header: type 80h, bytes 3-5 = 02 0E 2A.
- Erasing a knob (Motion Erase) turns its events into 80h and leaves their slot and value bytes
  behind.
- The unit pads a motion to its full length with C0 FF 80 00 00 00. All four motions on the test
  unit (loop length 4) total exactly 10368 ticks.
- The factory motions are in the ROM at `8E6E0`-`8FFE1`, each ending with six FFh bytes (the same
  data is in the JP-8000 ROM).

**Time and length** (traced 2026-11-25). Ticks are MIDI clocks: 24 a beat, 96 a measure.
- **Loop point.** The Loop Length of a motion (System 00 00 20 00 + motion: 0 PLAY ONCE, 1-8
  measures; factory setting 4) sets the point where the player starts again: `3A11C` stores the
  setting and passes Loop Length x 96 to `3A484`, which keeps it per motion in the table at
  `214874` (PLAY ONCE stores 2520h = 9504, no loop).
- **The empty motion** the unit makes (`356DC`, mode 1) is the header and 50 empty events of 192
  ticks (`5A714` appends them), 9792 ticks.
- **A recording** goes in front of it: knob events inside the loop, the last one waiting until 192
  ticks past the loop end. Every factory motion and every motion on the test unit (loop length 4)
  has its knob events before tick 384 and the recording ends at 384 + 192 = 576, then the empty
  motion follows (its header event, then the 50 C0 events): 10368 ticks. So a motion's length is
  Loop Length x 96 + 192 + 9792, and only the loop plays; the rest is never reached.
- The other Loop Length in the menus (Pattern REC, record 154) belongs to RPS patterns.

**Motion page.** The Motion page reads a motion and shows each knob's curve.
- **The loop:** the canvas shows the part that plays, the motion's Loop Length (read with the
  System page) in measures, with lines at beats (24 ticks) and measures (96 ticks), and says how
  many events lie after the loop end (they never play). **Show the whole motion** shows all of it,
  with the part after the loop shaded.
- **Draw:** pick a knob and draw on the canvas with the mouse. Freehand follows the stroke; Line
  draws a ramp from press to release; Erase clears a range. A stroke replaces only that knob's
  events inside the range it covers, as one event every 1-48 ticks ("Resolution": 1/32, 1/16,
  1/8, triplets...), with repeated values left out.
- **Fill:** puts a ramp, triangle, sine, square or random steps over a chosen part of the loop (or
  of the whole motion).
- **Edit:** add, change or delete single events, or erase a whole knob.
- **New empty motion:** starts a motion without reading one from the unit, as long as the unit
  makes one for the motion's Loop Length (Loop Length x 96 + 192 + 9792 ticks; 10368 at 4, and for
  PLAY ONCE or when the System page has not been read).
- **Send** rebuilds the motion in the unit's own layout (header, knob events, C0h empty events for
  gaps). Motions can also be saved to and loaded from .syx files.


**Checked on the unit.** Motion B[1] sent back unchanged read back identical (1393 bytes). The
same motion rebuilt by the editor with one value changed (1400 bytes) was stored exactly and kept
its 147 events and 10368 ticks. The original was then restored.

**RPS patterns** (the 48 keys C#2-C6) are event lists of the same kind inside the unit. The note
player `39574` and its voice timer `397F8` give the format:

| Byte | Meaning |
|---|---|
| 0 | Wait in ticks, at 24 ticks per quarter note (input quantize table `D24BA`: 1, 4, 6, 8, 12, 16, 24) |
| 2 | Note number, or 80h for an erased note (Note Erase, `36A2C`) |
| 3 | Velocity |
| 4-5 | Gate time in ticks, big-endian |

OS 1.04 has no SysEx for patterns:

- The RQ1 reader `45444` returns nothing below 09 00 00 00.
- The DT1 writer handles only 09-0A. A test pattern written to 08 00 00 00 did not read back.
- The Bulk Dump menu has no pattern entry, and Roland's address map lists only Motion Control
  Data.

Patterns move only to and from a memory card.
## Checked on the unit

- The identity reply, and RQ1 of every block: `re/jp8080/live/baseline.txt`.
- The temporary patch decodes as expected: preset "Den U", OSC1 FEEDBACK OSC, LPF, DEEP PHASING
  SLW, PANNING R->L.
- The live Tx/Rx table equals the firmware's factory MODE2 values.
- DT1 writes to the temporary patch (a single byte, and a two-byte depth) read back and were
  restored.
- The preset bank layout (see Presets), checked with bank select and program change.
- The motion data reads. A drawn motion (a sine on FLT CUTOFF FREQ and a ramp on FLT RESONANCE,
  310 events) was stored exactly on A[2], then the original was put back.
- **Complete dump** (Branch Library), run with the same requests the editor sends:

  | Step | Messages | Bytes | Time |
  |---|---|---|---|
  | System | 3 | 107 | |
  | Temporary performance, both patches | 8 | 686 | |
  | User patches | 256 | 34816 | 42 s |
  | User performances | 512 | 43904 | 79 s |
  | Four motions | 42 | 9450 | |
  | **Total** | **821** | **88963** | **147 s** |

  The Branch Library splits it into 200 items. A user patch is two address steps (00 00 02 00), so
  "All user patches" requests 00 02 00 00 bytes: requesting 00 01 00 00 returns only A11-A88.

**Restoring after a test.** The temporary performance matched stored user performance U:68, so
selecting U:68 again (bank 50h/00, program 2Fh on the Perform Ctrl channel, channel 3 on this unit)
put everything back, including the part banks. Compare with `re/jp8080/work/cmpstored.py` before
relying on this.

**Browser check** (2026-11-25, Chrome, unit on `MIDI (OCTA-CAPTURE)`): the Patch, Performance,
System, MIDI channels and Motion pages load without errors, the editor's patch, performance and
system data equal a fresh read from the unit byte for byte, user patch and performance names fill
the lists, and the Motion page reads motion A[1] and shows its loop. Found and fixed: the two
System settings both labelled "Metronome" are the Pattern REC menu's (byte 10h, record 157) and
the Motion REC menu's (byte 11h, record 150): they are now "Metronome (pattern recording)" and
"Metronome (motion recording)". The unit's motion A[1] held 142 events on FLT CUTOFF FREQ and
FLT RESONANCE spread over the whole 10368 ticks (drawn before the editor showed the loop; saved as
`re/jp8080/live/motion_a1_drawn_2026-11-25.bin`); at the user's request the recorded original
(`motion_a1.bin`, 176 events) was written back and read back identical (2800 bytes).

## Open items

None for the JP-8080. (JP-8000: system 12h-16h and a hardware check, see its doc.)
