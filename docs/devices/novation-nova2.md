# Novation Nova II Keyboard: MIDI implementation from its Keyboard OS 2 image

The Nova II Keyboard editor (`js/devices/defs/novation-nova2.js`) is the SuperNova II definition
(`novation-supernova2.js`) with model byte 23 and the Nova II's banks, parts and lists. It is made
from Novation's `nova-ii-keyboard-os2.zip` → `nv2kos2/n2kos2.mid`, decoded with
`tools/novation/os_mid.py` (`re/novfw/novaii_kbd_os2.bin`, 442176 bytes, "NOVATION S2 NOVA 4OCT
KBD", not in git). **No Nova II was available: nothing here is checked on a unit.** Novation
published no Nova II rack or desktop OS; only the keyboard is covered.

## Same formats as the SuperNova II OS 2

- Receiver 1F1EE: model bytes 20-25; its length table (5C452) is the SuperNova II OS 2.0's for
  types 00-22 (1D: 0), so programs are 286 + 88 bytes (00 + 1E), performances 372 + 16 + 464 (05,
  1B, 20), global 272 + 288 (0F, 15), patterns 194.
- The controller map (5C498) is the SuperNova II Rack OS 2.0 table (6525C) word for word.
- The CC, NRPN and packed-NRPN setters (C7C6, CF34, D302, 15B6A) are the SuperNova II Keyboard OS
  2.0's handler for handler; of NRPN 120 (11E7C) and 122 (129EE), the Nova II lacks NRPN 122 MSB
  49-57 (the digital I/O option card: sample rate, sync, optical/electrical in and out), NRPN 122 MSB
  86-87 and NRPN 120 MSB 22-23, 46-47, 54-55, 62-63 and 125 (Keyboard performance and Sysex settings
  the SuperNova II Keyboard has more of). `re/novwork/n2_diff.txt` lists them.

The editor therefore takes the SuperNova II's pages, with the Keyboard settings always shown and no
Rack/Keyboard choice, and leaves out the Digital I/O option group.

## What the Nova II menus change (records 61E0A-69876, `re/novfw/novaii_vs_sn2kbd.txt`)

| Menu | Nova II | SuperNova II |
|---|---|---|
| Program banks / drum maps | A-D (5-8), a-d (18-21) | A-H, a-h |
| Performance banks | A-B | A-D |
| User pattern banks, Pattern bank | U, V | U, V, W |
| Performance parts (1 prog to, Part outputs, Voc input, Voc insert) | 6 (outputs 1 & 2 to 5 & 6) | 8 |
| Unison mode | 2-6 voice (83-87) | 2-8 voice |
| Keyboard octave | -3..+4 | -3..+3 |

The editor trims those option lists and bank lists; parts 7-8 of a performance are shown read-only
(the message keeps 8 slots). The Nova II has **6 External Parts**: its NRPN 120 table (11E7C) has the handlers MSB 16 + 8 x field
+ part for parts 1-6 only, in all 12 field groups (the SuperNova II Keyboard has 8); External Parts
7-8 are shown read-only. Their menus are the SuperNova II Keyboard ones (Ext part MIDI ch, bank,
program, notes, velocities, MIDI stream byte).

## Open

1. Checks on a Nova II (none available).
2. The SuperNova II Keyboard open items (External Parts Tx option bits and stream bytes).
3. Message 1D has length 0 here (not accepted).
