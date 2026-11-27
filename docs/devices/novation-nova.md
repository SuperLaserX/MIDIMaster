# Novation Nova (desktop and Laptop): MIDI implementation from its OS 4.1 image

The editor (`js/devices/defs/novation-nova.js`, built with the first SuperNova on
`novation-os4.js`) is made from the Nova's OS 4.1, decoded from Novation's update
`nova-laptop-os3.zip` → `nova4.1/novaos41.mid` with `tools/novation/os_mid.py` (format and checks:
`docs/devices/novation-supernova.md`, "Firmware"; image `re/novfw/nova_os41.bin`, 260736 bytes, not in
git). **No Nova was available: nothing here is checked on a unit.**

## One OS for the desktop and the Laptop

Novation published one Nova OS. The image ("NOVATION NOVA" at 110h) has no model or keyboard check
and no keyboard-only menu field (no keyboard octave, aftertouch or key velocity Tx, unlike the
SuperNova II Keyboard OS), so the Nova desktop/rack and the Nova Laptop keyboard share one editor; the
Laptop's keys simply play. The readme and the update addendum also speak of "the Nova" only.

## SysEx

`F0 00 20 29 01 21 dd tt ... F7`. The receiver (15A32) accepts model bytes 20-25 and types 00-1D;
lengths (table 36D4C) are the SuperNova's plus:

| Type | Length | Message |
|---|---|---|
| 1B | 25 | the current performance's vocoder settings (16 bytes) |
| 1C bb nn | 27 | the vocoder settings of performance nn of bank bb (memory) |
| 1D | 10 | data byte 7F: copy program banks A-B into C-D and performance bank A into B (below) |

Memory protect: RAM 27498 (78h = On). Banks offered by the menus: programs A-B (5-6), performance
bank A (1); the Sysex transmission list (25614) goes to program bank D and performance bank B
(stored values 88-115), reception 66-73. The editor reads and stores performances as 05 + 1B and
07 + 1C.

## Message 1D: copy banks

Handler 1675A. It acts only when the data byte is 7F, the model byte is 21, the CC 99 handler
(C8CA) has just seen CC 99 = 127 (it sets RAM 2743B), and RAM 27487 is not FFh. It then sets 27487 to
FFh (so it works once), copies program banks A-B (5-6) into banks C-D (7-8), 128 programs each, and
performance bank A into bank B. The Nova menus never offer banks C-D or performance bank B, but the
Sysex transmission list names them: the memory is there. The Global page has **Copy banks (message
1D)** (asks first; sends CC 99 = 127 and then 1D 7F). Nothing reads 1D back; no Nova was available to
see it.

## Arpeggio patterns

As on the SuperNova (`novation-supernova.md`, "Arpeggio patterns"): the SuperNova II pattern format,
user bank U, the same **Arp patterns** page (generic step grid; gates shown as Norm/Tie/Rest/Glide).

## Programs, performances, global

Programs are the SuperNova's OS 4.1 format: the Nova's CC, NRPN and packed-NRPN setters are the
SuperNova's handler for handler (`re/novwork/stores.py`), so everything in
`novation-supernova.md` ("Programs") applies; in addition the Nova's menus have **Constant gate**
(237 bit 3, values 79/80), and filter fields with short labels (*cutoff, *type 6-14, *width 00-56).

Performances: **6 parts** (part menus Pt1-Pt6, Part outputs 1 & 2 / 3 & 4 / 5 & 6); the message keeps
8 part slots, parts 7-8 are shown read-only. Sustain includes Voc freeze (77-90). Found in the
Nova only:

- **Expression pedal** per part (Off/On, values 118/119): part byte 10 bit 5 (setter B492). No
  SuperNova II or Nova II OS sets or reads that bit.
- Vocoder (message 1B): Voc input (18-25: Input (1)/(2), Part 1-6; the receiver limits it to 25,
  1761C), Voc insert (28-33, limited to 33), Vocoder width (112-127), balance, Sibilance level
  (96-111) and type (16/17). Byte 0 is 21h; byte 5 (3 or 4 in the factory data) and 8-15 have no menu
  field or setter: read-only.

Global (0F 272 + 15 288 bytes, the SuperNova II RAM order from 27488): as the SuperNova, plus

| Message 15 byte | Nova menu |
|---|---|
| 12 | **Pedal mode**: Off, Breath-R, Breath-T, Sustain, Sustain-I (11-15, stored as sent, B750) |
| 13 | **Headphones out**: 1 & 2, 3 & 4, 5 & 6, Mix (92-95, BCBC; 5Fh = Mix is the default) |
| 24, 25 | **Trim1**, **Trim2**: 54-74 shown -10..+10 (handler ABC4: values 37-57 → Trim1, 58-78 → Trim2) |

These explain three SuperNova II bytes that its own OS never reads (15 byte 13 = 5Fh, bytes 24-25 =
40h, part byte 10 bit 5).

## Translator

Programs: exact copy to and from the SuperNova (same OS 4.1 format); a SuperNova II converts them
with 1DE84 (it does so for model 21 too). Performances through the SuperNova II's model.

## Factory data

`total.mid` in the update (the same file as in the SuperNova update) holds 256 programs, 128
performances with their vocoder blocks, 128 arpeggio patterns and the global, all with model 21.
It was used to check the defaults (global 0F/15, vocoder block) and the reserved bytes.

## Open

1. Checks on a Nova (none available).
2. Whether banks C-D / performance bank B can be read or selected over MIDI (not offered by the menus).
