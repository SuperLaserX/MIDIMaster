# Novation SuperNova (the first model): MIDI implementation from its OS 4.1 image

The editor (`js/devices/defs/novation-supernova.js`, built with the Nova on `novation-os4.js`)
treats the first SuperNova (1998; rack; 16 or 32 voices; 8-part performances) as its own device.
It is made from the SuperNova's own operating system, OS 4.1, the last one Novation published for
it. **No SuperNova was available: nothing here is checked on a unit.** Novation published no other
SuperNova OS (no keyboard version: the SuperNova is a rack).

## Firmware

`supernova-os2.zip` (Novation's download) holds `SNV4.1 Folder/snvos41.mid`, an OS update sent
as SysEx (`F0 00 20 29 01 20 7F tt ...`). `tools/novation/os_mid.py decode` turns it into the
image (`re/novfw/sn1_os41.bin`, 261184 bytes, not in git). The format was read from the loader of
the SuperNova II Keyboard OS 2.0 EPROM (000E1C-000F3A, "Waiting for midi O/S"); decoding the
SuperNova II Keyboard update the same way gives its EPROM image byte for byte, and every packet and
image checksum of the SuperNova file matches:

- message 7F starts (version bytes 21 64, packet count, image length), 7E carries a packet,
  7D ends (image checksum: the sum of the image's 16-bit words);
- a packet holds 32 groups; a group is 8 words of two 7-bit bytes (low first) and gives 7 16-bit
  words of the image: `out[k] = (w[k] >> 2k) | (w[k+1] << (14 - 2k))`.

The image is H8/300H code linear from 0 ("NOVATION SUPERNOVA" at 110h), the same code base as the
SuperNova II. The folder's `total.mid` (factory data) is the Nova's file byte for byte (model 21).

## SysEx

`F0 00 20 29 01 20 dd tt ... F7`, dd the global MIDI channel or 7F. The receiver (143FA) accepts
model bytes 20-25 and types 00-16 (no vocoder messages); the length table is at 36A7C:

| Type | Length | Message |
|---|---|---|
| 00 pp | 296 | program into the edit buffer of part pp (9 = the current part) |
| 02 bb nn | 297 | program nn of bank bb (5-12 A-H) |
| 05 / 07 bb nn | 381 / 383 | performance (372 bytes) / performance nn of bank bb (1-4 A-D) |
| 0F / 15 | 281 / 297 | global data: 16 settings and the program change map / 32 more settings and the map again |
| 0A pp, 0C pp | 204 | arpeggio pattern (194 bytes) |
| 01 / 06 | 12 / 11 | program / performance select |
| 03, 08, 10, 13 bb nn | 9-11 | current program, current performance, global, single requests |
| 04 09 0B 0D 0E 11 12 14 16 | 9-11 | the SuperNova II's other requests and pattern messages |

Types 01 02 06 07 0B 0C 0F 15 16 write memory and are refused while Memory protect is on (RAM 23496 =
78h). Message 15 starts with 21h (transmitter 1591E; the SuperNova II writes 28h).

Banks: the menus default to programs A-D and performances A-B; the Sysex transmission/reception
lists (2119A, 21D41) also name program banks E-H and performance banks C-D (the 1024-program
SuperNova), so the editor offers A-H and A-D.

## Programs (286 bytes)

The controller map (CC/NRPN → program byte, 36AAA) is the SuperNova II Rack OS 2.0 table (6525C)
word for word, and the CC (87C2), NRPN (8E86) and packed-NRPN setter tables (921E, D3AC) write
the same bytes and bits as the SuperNova II's (C01C, C768, CB36, 1354A), compared handler by handler
(`re/novwork/stores.py`; the getter tables D97A and DC6E match too). The exceptions: CC 9 does not store the program-mode
arpeggio speed (239), NRPN 102 (program vocoder balance, byte 16) has no handler, NRPN 1 59-69 and
94-97 do nothing (breath sensing and pattern gates on the SuperNova II). So the program layout is
the SuperNova II's first format (`docs/devices/novation-supernova2.md`); labels, ranges and lists are
the SuperNova's menus (3A944-3F88A, `re/novwork/menux.py`). Where the menus differ:

| Byte | OS 4.1 menu |
|---|---|
| osc +2 | Coarse tune (45-69: -12..+12) |
| osc +13..18 | Soften level / Soften mod. (the SuperNova II calls them Harden) |
| 17 | Category: ... Organ, User 1-5 (the SuperNova II has Brass and User 1-4) |
| 209 bits 0-2 | **Filter width** 00, 08 ... 56 (menu values 102-109). The SuperNova II derives this byte from its own 0-127 filter width |
| 209 bit 3 | **DCO / VCO mode** (92/93). On the SuperNova II it follows VCO drift |
| 240 | Pattern bank: Mono, Poly, User (76-78) |
| 244 | Fill in: Off/On - Up/Down/Played in one list (122-127) |
| 243 | Key reset (the SuperNova II's Keysync) |
| 249 bit 0 | Mute status: Sounding / Muted |
| 253 | Gate time: 25, 50, 75, 99% (menu 5-8) |
| 275 bits 0-1 | Chorus type: Quad chorus, Chorus/flanger, Phaser (52-54; the SuperNova II's list starts with Phaser for the same values) |
| chorus | Speed, Chorus wheel (the SuperNova II's Speed 1, Wheel level) |

Parameters without a menu field on OS 4.1 but with the same setter (oscillator waves, glide,
arpeggio notes-to, pass to effects, part velocity curve) keep the SuperNova II's names; drum one-shot,
constant gate and unison detune-style OS 2 settings are left out (no OS 4.1 menu). 238 bit 6 and 249 bit 2 (format markers) are set before a program is sent (15568), as on
the SuperNova II; 249 bit 2 marks the OS 4 value scale. Byte 16 is shown read-only (no handler);
239 is kept editable: the OS 4.1 CC 9 handler does not write it, but the factory programs carry
values there.

## Performances (372 bytes) and global (272 + 288 bytes)

Performances: the SuperNova II's message 05 layout (8 parts of 44 bytes from 20; MIDI channels
page). Sustain (77-89: no Voc freeze), Midi channel, Part outputs 1 & 2 to 7 & 8. Bytes 16 and 19 are
shown read-only: no OS 4.1 menu field or setter was found (factory data: 16 = 2Fh in every
performance; 19 = 0 or a single bit).

Global: the SuperNova II's RAM order (0F = RAM 23486-23495, message 15 bytes 12-31 from 234D2). On
OS 4.1: global channel, Sysex transmission (stored 88-127) and reception (66-79) in the order of
the OS 4.1 string lists, master tune, Breath control (the SuperNova II's Pedal/breath), breath
mode/sensing, arp transpose, MIDI clock Int/Ext, master volume, user pattern number, power-up
sound, local control, incoming program change / control change, vel sensing, knob mode, finder
demos, program change / controllers Tx, arp pattern editing via MIDI, the program change map
(edited in message 15's copy, 0F gets the same). The transmitter writes 0Bh and 5Fh into 15 bytes
12 and 13, 40h into 24-27, 0 into 28-31; bytes 17-23 are copied from RAM but no OS 4.1 menu field
uses them: all shown read-only. The SuperNova II's breath-mode receive bug is not in OS 4.1 (the
Nova receiver ORs message 15 byte 2 into the right byte), so no repair NRPNs are sent.

## Arpeggio patterns

The pattern messages have the SuperNova II's lengths (0A pp / 0C pp: 204 bytes, 194 bytes of
pattern) and the 128 factory patterns in `total.mid` follow its format (byte 0 the highest note of a
mono pattern, byte 1 the number of steps, then note and gate/velocity nibbles per step; see
`novation-supernova2.md`, "Arpeggio patterns"). The OS 4.1 has one user bank (U: Pattern bank
"User"; no V/W). The **Arp patterns** page is the SuperNova II's (the generic step grid): the edit
buffer (0D request, 0A send), patterns of bank U read with message 14 pp (reply 0C) and stored with
0C pp (a memory write).

## Translator

The program format is shared with the Nova (`OS4_MODELS` in `novation-supernova2-translate.js`):
exact copy between them. To and from a SuperNova II the conversion a SuperNova II applies to model
20/21 programs (1DE84: overdrive, program level, filter LFO mods, comb boost, saw width, distortion
drive) and its inverse; the Nova OS 4.1 applies that inverse itself to programs from SuperNova II
models (1763C), which confirms the direction. Performances go through the SuperNova II's
performance model.

## Not covered / open

1. Checks on a SuperNova (none available): everything above.
2. The arpeggio pattern page is checked only against the factory patterns (no unit).
3. Program category User 1-5 is passed to the Head Library with the SuperNova II's numbering.
