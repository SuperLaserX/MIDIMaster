# Alesis Quadraverb Plus: MIDI implementation from the v2.03 firmware

Source: `Alesis_QuadraVerb+_Firmware_v2.03.zip` (`qv+v203.bin`, 64 KB, "QUADRAVERB Plus (C) 1989 ALESIS",
sticker 2-31-0009 QUADRAVERB V2.03 03/10/92); the same image is in `alesis_quadraverb_plus_gt.zip`, whose
notes say the v2 EPROM also runs in v1 Quadraverbs (the Plus is the Quadraverb with the v2 software) and
that its `_usemapped` files are the dumps in CPU order (the low address lines A0-A7 reversed, as
`tools/alesis/qv_unscramble.py` does). v2.00-2.02 are in the collection too. Editor:
`js/devices/defs/alesis-quadraverb-plus.js` on the family module `alesis-quadraverb-common.js`; tables
(`alesis-quadraverb-plus-fw.js`) from the same generator as the Quadraverb:

    python -I tools/alesis/quadraverb_fw.py "<v2.03 dump .bin>" > js/devices/defs/alesis-quadraverb-plus-fw.js

**Not checked on hardware** (no Quadraverb Plus is connected); the tests use the definition's simulator.
Everything in `alesis-quadraverb.md` holds (page engine, descriptors, SysEx, MIDI page); this file lists
what v2 changes. Addresses are in the v2.03 CPU image; the generator finds them from code patterns.

## What v2 changes

- Variables moved: current function 83C0, configuration 83C4, page variants 83B5 + function, page 83C2;
  page tree at 35E1 (walker 3578), page stubs `MOV 77h,#lo / MOV 76h,#hi / LJMP 3C51`, LCD output 4130.
- Eight configurations: the five of v1 plus RING→DL→REVERB, RESONATOR→DL→REV and SAMPLING. Same
  128-byte program and the same 90-program ROM bank address (D2FE, new contents).
- The bytes v1 left spare carry the new pages: SAMPLE START / LENGTH (18, 19, 0.00-1.55 seconds), SAMPLE
  PLAYBACK (1F), AUDIO TRIGGER SAMPLING (23), MIDI TRIGGER (24) with BASE / LOW LIMIT / HIGH LIMIT (26,
  30, 31), SPECTRUM SHIFT (42-43, 1-300 Hz), RESONATOR GATE MODE (25), RESONATOR 1-5 TUNE (4B-4F, -24 to
  +36 semitones), MASTER FEEDBACK (68), TAP NUMBER (69), RING MOD. OUTPUT MIX and DEL/REVERB INPUT MIX
  (78, 79), EQ PANNING / TREMOLO SPEED and DEPTH (7A, 7B), and more mix pages (DIRECT SIGNAL with
  tremolo and panning, RING MOD. / RESONATOR / SAMPLE PLAYBACK SIGNAL LEVEL). Byte 33 only holds a tap
  (below); 7C-7F are on no page (the editor keeps them as they are).
- Delay type 3 in 5BAND EQ→PCH→DLY is a multi-tap delay: the TAP x pages (descriptor byte 80h-84h, bit 7
  = indexed) edit 8380h + 5 × TAP NUMBER + k (6CA3): DELAY TIME (two bytes, 1-1500 ms), VOLUME, PANNING,
  FEEDBACK. The eight taps are kept in 40 program bytes listed at 147A (0D 18 19 1F 22 23 24 26 2A-43
  4A-4F); 13A5 swaps them with the work area when such a program is recalled and around an edit-buffer
  dump (C003 / C095), so dumps carry the taps in those bytes. The editor shows the taps as TAP n fields
  stored there; a change sends TAP NUMBER (opcode 01) and then the field.
- MOD TARGET groups 5 and up take the delay function's variant (16C2).
- SysEx: the same header (F0 00 00 0E 02) and opcodes 01-04 (receiver BC2F). New: F0 7E <ch> 01 (Sample
  Dump Standard header) resets a packet count and up to three 02 data packets are stored at 8700h
  (BC70); what uses that buffer is not traced yet, and the editor does not send it.
- A Quadraverb program is a Plus program (configurations 0-4 are the same pages); the definitions share
  the Head Library family `alesis-quadraverb`, and a dump in RING / RESONATOR / SAMPLING goes to the Plus
  when both are mapped (`prefer`).
- Alesis program 84 (FLASHBACK) holds LOW MID EQ FREQ 600, above its page's 500: the receiver stores
  dumps without checks, so the editor sends programs as they are.

## Open

- A hardware check.
- The 7E 01 / 02 packets (BC70) and the sampler's own memory (not part of programs).
- The Quadraverb GT (model byte 07) is done on the same code: `alesis-quadraverb-gt.md`.
