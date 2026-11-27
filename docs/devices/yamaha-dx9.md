# Yamaha DX9

Definition: `js/devices/defs/yamaha-dx9.js`: the DX7 definition (`yamaha-dx7.md`) with the DX9's
parameters marked. **Not yet checked on a DX9.**

## From the firmware

`z:/firmwares/Yamaha-DX9-IG11470-YA3128.zip` (Intel HEX, converted to `re/dx/fw/dx9/dx9.bin`,
16 KB at C000h; listing `re/dx/dx9.lst`):

- The DX9 sends a voice as the DX7's single-voice bulk (F231 with the header at F262:
  `F0 43 00 00 01 1B`, then the 155 bytes it builds at 0DCA, checksum) and its memory as the DX7's
  32-voice bulk (header at F27A: `F0 43 00 09 20 00`, 4096 bytes from 0F00; 20 voices used). The
  channel byte is fixed: it always sends on MIDI channel 1.
- Table F0B9 maps each DX9 parameter to a DX7 parameter number (used for its parameter-change
  messages): DX7 operators 6, 5, 4 and 3 (EG rates and levels, R SCALE DEPTH, RATE SCALING,
  A MOD SENS., OUTPUT LEVEL, F COARSE, F FINE, OSC DETUNE), and ALGORITHM, FEEDBACK, OSC KEY SYNC,
  LFO SPEED, DELAY, PM DEPTH, AM DEPTH, WAVE, P MOD SENS. and MIDDLE C. Its screens (E7AD-EA4E)
  name the same things (ALGORITHM, FEEDBACK, A MOD SENS., P MOD SENS., F COARSE, OUTPUT, MIDDLE C,
  OSC KEY SYNC, TRIANGLE, SAW DWN...).

## Editor

The DX7 voice page, with every DX7 parameter the DX9 does not use marked "Not used by the DX9"
(operators 1-2, break point, left depth and the curves, key velocity, oscillator mode, the pitch EG,
LFO KEY SYNC), so a DX9 voice is edited exactly and still loads into a DX7. Voices and the bank are
received when the DX9 sends them (it answers no requests in this editor; not checked), and sent as
DX7 messages.

## Algorithms and receiver (2026-11-26)

- ALGORITHM 1-8 are DX7 algorithms 1, 14, 8, 7, 5, 22, 31 and 32 (table D0D4: the sender F34A
  converts the DX9's own number, the receivers F576 / F6B2 look a received DX7 number up in it). The
  editor's algorithm list names them "1 (DX7 1)" ... "8 (DX7 32)"; the algorithm card picks only
  those (the other 24 stay listed as DX7-only, for DX7 voices kept as they are).
- Receiver (SysEx states C5B8, switch helper DC32: `hd6303_dis.py dx9.bin C000 OUT sw:DC32 --auto`):
  status 0n / 1n on the DX9's MIDI CH (15D7h); 2n (dump requests) is refused. Bulks (format 0 with
  count 011Bh, format 9 with 2000h) need SYS INFO AVAIL (15D8h), the 32 voices also MEM. PROTECT off
  (15DAh). Parameter changes: group 0 (voice, with SYS INFO AVAIL, F495), groups 1-2 ignored, group 3
  handled by F59C / F5C7 (not named).
- Its screens (E7AD-E96B) use the DX7's words (ALGORITHM, FEEDBACK, A MOD SENS., P MOD SENS., F
  COARSE, F FINE, OSC DETUNE, OUTPUT, MIDDLE C, OSC KEY SYNC), so the DX7 labels stay.

## Open

- Group 3 parameter changes (F59C / F5C7) not named.
- Not checked on a DX9.
