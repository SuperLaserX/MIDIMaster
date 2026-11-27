# Access Virus TI family: the models sharing the TI2 editor

The Virus TI (2004) and Virus TI2 (2009) come as Desktop, Keyboard (61 keys) and Polar (37 keys). The editor for
all six is the TI2 editor (`js/devices/defs/access-virus-ti2.js`, documented in `access-virus-ti2.md`); the other
five are thin files (`access-virus-ti-desktop.js`, `-ti-keyboard.js`, `-ti-polar.js`, `-ti2-keyboard.js`,
`-ti2-polar.js`) made with `tiModel()`, which changes only the name and the note on what was checked.

## Evidence (Virus TI Software Suite 5.1.7, `firmware_bin`)

| What | Finding |
|---|---|
| OS images | `vti.bin` (the first TI) and `vti_2.bin` (TI2); one image per generation for Desktop, Keyboard and Polar |
| Host OS (8051, `F000`-`F013`) | identical except one byte at 000A: 07 in `vti.bin`, 05 in `vti_2.bin` (data between the interrupt vectors; `re/virusti/fw/ti1host/` = the TI's banks). So the parameter tables, value lists, SysEx receiver, knob table and remote templates are the same |
| DSP code (`F020`-`F035`), USB code (`F060`, `F061`) | identical |
| ROM banks (`P064`...) | the same number of sections; the TI's hold its own factory sounds (format 8; `BackupTIROMA`-`Z` in the suite), which the OS converts when they arrive (`upgradeSingle`) |
| Virus Control | one description, "Virus TI Desktop/Polar/Keyboard", for all six |
| USB | one MIDI driver (`vtimidi.inf`: USB 133E:0815, interface 3) naming the ports "Virus TI MIDI" and "Virus TI Synth" |

Keyboard and Polar add a keyboard; its global settings (Global Keyboard Parameters) are in the shared
description and sent the same way. Whatever differs in the hardware of the first TI and the TI2 does not show
in the OS images; nothing in the SysEx differs.

## DIN and USB

The same for all six (one host OS): see access-virus-ti2.md, "DIN and USB". Over USB the editor uses "Virus TI
Synth"; "Virus TI MIDI" is the Virus's own MIDI sockets and never reaches the synth; through a MIDI interface on
the MIDI In / Out sockets everything works while the Virus's USB MIDI is off (global "USB MidiPort active" No, play
mode not Remote; the pages say so while the connection is DIN). Not checked over DIN on any model.

## Not checked

Only a TI2 Desktop was connected: nothing was checked on a first TI or on a Keyboard or Polar. The Snow runs
another host build (`vti_snow.bin`: 4 parts, banks of 64 sounds) and has its own device over the shared code:
`access-virus-snow.md`.
