# Access Virus TI2

Definition: `js/devices/defs/access-virus-ti2.js` (tables `access-virus-ti2-fw.js`, translator
`access-virus-ti2-translate.js`), tests `tests/access-virus-ti2.test.js`, tools `tools/virus/`.
Checked on a Virus TI2 Desktop over USB (2026-11-25).

## Sources

| What | Where | Used for |
|---|---|---|
| Virus TI Software Suite 5.1.7.00 (64-bit MSI) | `z:\firmwares\Virus TI Software Suite 5.1.7.00 64-bit (1).msi`, already unpacked as `z:\firmwares\VirusTI2\` (file names like `firmware_bin`, `viruscontrol_dll64`) | everything below |
| Virus Control's device description | XML embedded in `viruscontrol_dll64`: `<Remotedevice name="Virus D Series" device="Virus TI Desktop/Polar/Keyboard" version="7.2 111" releasedate="15.05.2012">` (a twin for the Snow, and an older "Virus Control" one) | every parameter: name, range, default, value texts, conditions, the MIDI message and index that edits it, the single and multi dump layouts |
| TI OS images | `firmware_bin`: an IFF `FORM` holding a file table, LCD bitmaps, `vti.bin` (TI), `vti_2.bin` (TI2), `vti_snow.bin`, HTML | the TI2 host OS strings; the code is the next step (below) |
| Manuals | `PDF_VirusTI_Reference`, `PDF_Addendum`, `PDF_Changelog` (text with `pdftotext`) | behaviour notes (ports, dump options) |

`tools/virus/vc_xml.py` pulls the description out of the DLL (read as bytes) into
`re/virusti/vc/ti.json`; `tools/virus/gen_fw.py` writes `access-virus-ti2-fw.js` from it.
`tools/virus/vtilive.py` talks to the unit (python-rtmidi): requests and edit-buffer messages only.

### The OS images (`vti_2.bin`)

Each image is a `FORM` of 32 KB sections: an id (`S002`-`S009` presets, `F000`-`F061` code, `P064`-
`P121` ROM banks), a length (8C02h), 1024 records of a 3-byte address and 32 data bytes, and a 2-byte
check. `re/virusti/scripts/sections.py` writes each section's data to a file.

- `F000` (address 000000) starts with 8051 vectors (`LJMP 4EE8` reset, interrupts at 03, 0B, 23, 2B,
  43, 4B): the host controller is an ST uPSD3212 (8051 core). `F000` is the common half of the code
  space (0000-7FFF); `F001`-`F013` are the banks mapped at 8000-FFFF (`re/virusti/fw/host/bankNN.bin` =
  common + bank NN, ready for a disassembler). `F010`/`F011` hold the display texts (parameter names,
  value lists, menu texts, e.g. "Tape Clocked", "Ping Pong 4:3", "Store To RAM!").
- `F020`-`F035`: DSP56367 code (24-bit words); `F060`/`F061`: the USB controller's code.
- The TI2 build strings: "7.2 116", "11.01.2013", "B5.1.7.00".
- `vti.bin` (the first TI) has the same host code as `vti_2.bin` except one byte at 000A (07 there, 05 in the
  TI2 image; data between the interrupt vectors), the same DSP code (`F020`-`F035`) and USB code, and other
  ROM banks (`P064`...). `vti_snow.bin` is a different host build (reset at 4C38) with the same display texts
  (banks 4, 10-13 identical). Host banks for both: `re/virusti/fw/ti1host/`, `re/virusti/fw/snowhost/`.

## USB ports

| Port | What it is |
|---|---|
| **Virus TI Synth** | the synth engine: every SysEx below is answered here, parameter messages and dumps are taken here |
| **Virus TI MIDI** | the Virus's MIDI In/Out sockets as a USB MIDI interface ("the external MIDI ports can be used as a MIDI interface", Virus Control tutorial): what is sent to it leaves the MIDI Out socket, never reaching the synth (see "DIN and USB") |

The definition uses "Virus TI Synth" for both input and output (`def.ports` picks it first). No identity
reply (F0 7E 7F 06 01 gets no answer on either port). Virus Control itself talks over its own USB driver
(`virususb.sys`), not these ports; its device description still names the same MIDI messages.

## DIN and USB

The host OS has one MIDI parser for every source and one switch, bit 24h ("USB MIDI mode"), that decides
where the synth listens and where it answers. Nothing the editor sends is refused because of where it came
from. Listings: `re/virusti/din/` (headless Ghidra on `re/virusti/ghidra/vti2host`,
`sh re/virusti/p2/gh.sh 01 OUT lin:A:B`; the USB controller's code disassembled with `tools/alesis/i8051.py`:
section F060 without its 12-byte header).

| Source / path | What the host OS does |
|---|---|
| MIDI In socket (UART0, receive at 2CFA) | USB MIDI mode **off**: each byte goes to both DSPs (FF FF xx at their host ports, XRAM 0005-0007 / 0105-0107: they play notes and controllers), into the parser's ring (6400h, 277C) and, with Soft Thru On (bit 32h: set from global 120 at start-up, 5329, and by its handler, bank 2 A8F0), on to the MIDI Out (24FE). USB MIDI mode **on**: only to the computer, packed as USB cable 0 (23B9 -> 22B0 -> UART1), i.e. the input "Virus TI MIDI"; the synth does not see it and Soft Thru does nothing (the manual: "no effect when working with Virus Control") |
| USB (the USB controller, TI "tusb037" firmware in section F060, on UART1, ISR 3288: 4-byte USB-MIDI packets, the 9th bit marks a packet's first byte, flow control on P1.1) | by cable (28E7 / 2940): 0 ("Virus TI MIDI" out) only to the MIDI Out ring (6000h, 281B); 1 ("Virus TI Synth"; also 2, 6, 7) to the parser and the DSPs (2988); 3 to the parser only (2953), 5 to the DSPs only (2973), 4 the USB controller's own messages (286D: parameter sets as F6 pp ii vv into the parser, code memory reads). In the MIDI REMOTE play mode (bit 13h, the mode Virus Control's initialisation sets) cable 1 is dropped (2878): "Virus TI Synth" reaches nothing then. Internal page G 86 (XRAM 04D6, bit 2Bh at 1746) copies cables 1-7 to the MIDI Out as well |
| What the Virus sends: dumps 10, 11, 13, 14, 15 (header 3A84, called from 3950, 397D, 3A2A / 3A6B, 39FB, 38B7; data 45B3), parameter messages (6561), remote template strings (DB95) | all through 1FD9. USB MIDI mode on: to USB (22D9) on the cable of global 58 Output Sounddump Cable Number (59 Output MIDI Data Cable Number for the remote strings; 1 = "Virus TI Synth"). Off: to the MIDI Out socket (28E7 -> 281B), not to USB |
| The parser (3AE4, called from the main loop at 1591) | requests 30-3B, dumps 10 / 11 / 13, parameter messages 6E-74, controllers, poly pressure and program changes come from the one ring: nothing checks the source. Receive Dump (global 99) gates dumps from every source (3F4A singles, 4238 multis). Only USB MIDI mode adds a short form (F0 cc ... without 00 20 33 01 dd: state 3E47 -> 3E8F), which the editor does not use |

**USB MIDI mode** (bit 24h):
- set by the handler of global 82 "USB MidiPort active" for any value but No (bank 2 A835: internal parameter
  41Dh, the class 4 handler table at A548), and in the MIDI REMOTE play mode (global 122 = 3, 05F7);
- cleared when global 82 goes back to No (A849 -> 6387, which also sets the cable numbers 58-60 back to 1),
  and when the play mode leaves Remote with global 82 No (05C8);
- the start-up code writes global 82 = No (535B); the USB controller sends 73 52 00 and 73 53 00 to the host
  when its USB state changes (F060 code 038E; global 83's handler, A85D, also sets play mode Single and 82 No);
- Virus Control's initialisation sets global 82 = 1 (its "GlobalInit" list, which also sets play mode MIDI
  REMOTE, Soft Thru Off, Receive Dump Enable and sounddump cable 3).
- on the user's TI2 it is on while connected to the computer with no Virus Control running (checked, phase 5
  below); what turns it on then (the driver, the USB controller, a value kept since Virus Control ran) is not traced.

The Snow's host build routes the same way (USB MIDI mode is bit 25h: set by the global 82 handler at bank 2
A839, cleared at 12E5 / 61F3; MIDI In receive at 2A5D).

**What works where:**

| Connection | What reaches the synth | Where the answers go |
|---|---|---|
| "Virus TI Synth" (USB) | everything, except in the play mode Remote (nothing) | "Virus TI Synth" (USB MIDI on) |
| "Virus TI MIDI" (the Virus's own sockets as a USB interface) | nothing: it leaves the MIDI Out socket | - |
| a MIDI interface on the MIDI In / Out sockets (DIN), USB MIDI off | everything: requests 30-3B, dumps 10 / 11 / 13, parameter messages 6E-74, controllers, program changes, notes | the MIDI Out socket |
| the same, USB MIDI on (connected to the computer) | nothing: the MIDI In goes to the computer ("Virus TI MIDI") | USB |

So over DIN every function of the editor works (singles, multis with the arrangement, banks and names, stores,
the global page, remote templates read and written, the complete dump, live edits) while the Virus's USB MIDI
is off. No function is USB-only: the requests 39-3B also answer through 1FD9 (Virus Control's code reads by
cable 4 are the USB controller's own path, not SysEx). Live edits stay SysEx over DIN (11 bytes, 3.5 ms at
31250 baud; SysEx is taken whatever Low Page / High Page say), so they do not depend on those globals.

**Global settings DIN needs** (the editor cannot read them: no global request; every page shows them as a
warning while the connection is DIN): USB MidiPort active **No** and play mode **not Remote** (USB MIDI off);
Receive Dump **Enable** to send or store sounds (Disable refuses dumps; To Bank A-D force the bank, To Edit
Buffer keeps them in the edit buffer, Verify only compares); Soft Thru **Off** (On sends everything the editor
sends back to the interface: harmless for reads, the generic code ignores echoes of what it sent, but confusing
in a recording); Device ID Omni or the editor's (as on USB).

**Timing over DIN:** the Virus sends one dump a second whatever the link (the OS's own pace, measured over USB;
the same code sends over DIN). A single (524 bytes) takes 168 ms at 31250 baud, well within the second, so a
bank still takes about 128 s and the complete dump the same 13 min (1 h 9 min with the ROM banks); a remote
template record adds about 24 ms of wire time to the Virus's 0.11 s. Towards the Virus the MIDI In ring (1 KB
at 6400h) has no flow control (USB has: the controller waits while it is full, 3288 / 1553), so messages must
not come faster than the wire carries them: the editor paces SysEx at the DIN default (150 ms apart, 3125
bytes a second) or at the speed measured on that port (Connect page); a whole bank of singles is about 22 s of
wire time (about 42 s at the DIN default pace).

**The editor** (`def.link` = `tiLink()` from the open ports' names; `TI_CONNECTION` in the definition, also used
by the thin TI model files and the Snow):

| Ports (output / input) | Link | What is enabled |
|---|---|---|
| "Virus TI Synth" / "Virus TI Synth" | `usb` | everything |
| "Virus TI Synth" / another or none | `usb-out` | live edits, Send to Virus, Store, Write to the Virus; reads, names, Play, requests and the complete dump disabled (the answers are missing) |
| "Virus TI MIDI" / any | `thru` | nothing: every button disabled with the reason, nothing sent (the generic `sendOut` drops it) |
| another port / another port | `din` | everything, with the DIN warning on every page |
| another port / "Virus TI Synth", "Virus TI MIDI" or none | `din-out` | as `usb-out`, with the warning |

Capabilities: the generic `sysex`, `cc`, `nrpn`, `pc`, `notes`, and `reply` (the Virus's answers reach the
editor). Objects, slots (`needs`; `recallNeeds`: Play reads the slot first; `storeNeeds`), Send to Virus, Write
to the Virus and `requestNeeds` (Branch Library requests and complete dump) declare them. `def.ports` picks
"Virus TI Synth" when no ports are remembered (the generic choice would prefer the name with "MIDI"). The
editor cannot tell from the port names whether a DIN-connected Virus is in USB MIDI mode: the link allows
everything, the reads time out, and the warning says why. The complete dump needs no DIN variant: all its
steps work over DIN. Tests: `tests/access-virus-ti-link.test.js`.

**Checked and unchecked:**
- Checked on the TI2 over USB (2026-11-27, requests only, `re/virusti/din/t_usbmode.py`; see "Checked on the
  unit", phase 5): "Virus TI MIDI" does not reach the synth, and the Virus is in USB MIDI mode while connected
  (the short form F0 30 00 40 F7, taken only with bit 24h set, was answered; no Virus Control running).
- Not checked: anything over DIN (no interface is cabled to the TI2's sockets), the Snow, and what turns USB MIDI
  mode on without Virus Control. Steps for a hardware check:
  1. Loop, USB connected as now (one MIDI cable, no interface): cable the Virus's MIDI Out to its own MIDI In.
     With Chrome not holding the ports, `python -I tools/virus/vtilive.py raw F0 00 20 33 01 10 30 00 40 F7 --port
     "Virus TI MIDI"`. Expected (USB MIDI on): the request comes back unchanged on the input "Virus TI MIDI" and no
     single dump arrives on either input (the synth does not see its MIDI In). Remove the cable.
  2. DIN, USB MIDI off: unplug the Virus's USB cable and switch it off and on. Cable the interface (e.g.
     OCTA-CAPTURE MIDI OUT -> Virus MIDI IN, Virus MIDI OUT -> OCTA-CAPTURE MIDI IN). In the editor choose "MIDI
     (OCTA-CAPTURE)" as input and output (the status shows DIN, each page the warning). Check: Single page Get from
     device; change a list parameter (e.g. Patch Category), read it back and set it back; RAM A Read names (about
     2 min); the MIDI channels page (arrangement, about 17 s); Remote templates Get from device; Branch Library,
     Send request and record "Single edit buffer"; Connect page, Measure speed. No store unless the user allows
     one (RAM A 001 and RAM multi 001 were allowed before). Afterwards Memory Protect Disabled (Global page), and
     the USB cable back in.
  3. DIN, USB MIDI on: the same cabling with the USB cable in and the Virus switched on with the computer: Get
     from device over the interface must time out, and the request must show on the input "Virus TI MIDI".

## SysEx

`F0 00 20 33 01 dd cc ... F7`: 00 20 33 Access, 01 Virus, `dd` device ID (00-0F, 10 omni; the unit
answers requests sent with 10 and replies with its own ID, 00 here).

| cc | Message | Checked |
|---|---|---|
| 10 bb pp | single: 256 bytes (pages A, B), checksum, 256 bytes (pages C, D), checksum. Checksum 1 = sum of bytes 5-264 & 7F, checksum 2 = sum of bytes 5-521 & 7F (Virus Control: `add7`). bb 0 = an edit buffer (pp 40 single mode, 00-0F a multi part), 1-4 RAM A-D, 5-30 ROM A-Z | yes: edit buffer, parts, RAM A/B, ROM A |
| 11 bb pp | multi: 256 bytes, checksum (5-264). The edit buffer comes back as bb 00 pp 7F; RAM multis are bank 1. Sent to 00 7F it replaces the multi edit buffer only: the 16 part singles stay as they were. A store takes bank **32h** for slots 0-15 (multis 001-016) and bank 1 for 16-127 only: the receiver (state 1A/1B at 41CA/41E0) refuses 11 01 00-0F | read: yes; 11 00 7F: yes; store to RAM multi 001 (11 32 00): yes (2026-11-25) |
| 30 bb pp / 31 bb pp | single / multi request | yes |
| 32 bb / 33 bb | single / multi bank request: 128 dumps | 32: yes |
| 34 00 | arrangement request: the multi edit buffer (11 00 7F) then the 16 part singles (10 00 00-0F) | yes |
| 37 00 pp | controller dump request: edit buffer pp as CC / poly pressure on the global channel | yes |
| 38 tt kk | remote template tt (0-31), record kk: knob 0-31 answered with 13 tt kk, the knob name (10 bytes), 22 bytes as 44 nibbles (low first) and a checksum; kk 32: 13 tt 20 with the template name record (17 bytes as they are); kk 16 gets no answer (see "Remote templates"). One request at a time (about 0.13 s each): of 33 requests sent together the TI answered 10 | yes: all 32 x 33 (2026-11-26) |
| 39 bb | answered with 14 bb 00 + 256 bytes + checksum: the same page for bb 1-4 (7-bit packed memory; Virus Control internal), no answer to 00 or 7F | yes |
| 3A xx yy | answered with 15 xx yy + 64 nibbles (32 bytes, low nibble first) of the data memory at xx yy: 3A 7F 7F reads "Remote 3..." (template memory), 00 00 reads FFh | yes |
| 3B xx yy | answered with 17 xx yy + 64 nibbles of the host's code memory: 3B 00 00 reads 02 4E E8 (LJMP 4EE8, the reset vector) | yes |
| 35, 36 | global / total request: **not in the TI OS** (see the receiver below); no answer | - |
| 70 / 71 / 6E / 6F pp ii vv | single parameter, page A / B / C / D: byte 128 x page + ii of edit buffer pp | yes, all four pages, single mode and part 16 |
| 72 pp ii vv | multi parameter: ii < 32 common, 32-47 part pp's value at 32 + 16 x (ii - 32) + pp, 72-78 part pp's switches (bit ii - 72 of byte 240 + pp) | yes (part volume, part enable) |
| 73 00 ii vv | global parameter (Virus Control's "Bank F") | yes: Device ID (93) changed and restored, its effect read from the replies; Memory Protect Disabled sent |
| 74 pp ii vv | Virus Control's internal page ("Bank G": display, dump-by-request, OS versions) | not used |

**The receiver** (host OS, common code; `re/virusti/fw/dec/sysex_states*.c`, Ghidra project
`re/virusti/ghidra/vti2host`): the MIDI byte handler at 3AE4 runs a state machine whose data-byte
states are in the table at 3C76 (state in IRAM 52h). F0 00 20 33 01 dd are checked by states 0A-0E
(the device ID must be 10h or the unit's own, read with 0172(5Dh)); the command state at 3E8F takes
10, 11 (dumps), 12 (followed by 02), 13 (bank, slot), 16 (00, 31h-37h), 30-34 and 37-3B (requests;
the request kind goes to internal page G index 46 through 00B3: 30 -> 0, 32 -> 1, 31 -> 2, 33 -> 3,
34 -> 4, 37 -> 5, 38 -> 6, 39 -> 8, 3A -> 9, 3B -> 10; 46AC then sets G 45, which starts the dump) and 6E-74 (parameters: part 7F = the current part, 40 or 0-0F, then index and
value, handled by 62E0 / 135F). 12 and 16 are not used by the editor (unknown; never sent). The
parameter transmitter is at 654A (F0 00 20 33 01 dd page part index value F7).

The TI answers dump requests slowly: about one dump a second, also inside a bank dump (a bank takes
about two minutes). Measured 2026-11-26 on a TI2 Desktop over USB, on both ports ("Virus TI Synth" and
"Virus TI MIDI"): 1.0 s between dumps whether a bank or single slots are asked for; requests sent
together are not queued (only the first and last of 16 were answered). This pace is the OS's own (a
dump timer), not the link: the complete dump runs at it (about 1 h 9 min with the 26 ROM banks, 13 min
without). Remote template records come faster but are also paced by the Virus: 126 ms a record with the
measured 20 ms request gap, 150 ms with the DIN default of 150 ms (12 records each, 2026-11-26), so the
measured pace saves about 25 s on the 1024 records.

Because the TI keeps only the latest request, a request from another page during a complete dump would
cut the dump's bank short. The dump runs as a background job of the device (`js/devices/generic/dumpjob.js`):
- **Requests:** while it runs, the client refuses requests that wait for a reply (with a message saying why); live edits still go out.
- **Pages:** they skip their automatic reads.
- **Replies:** each step records only its own replies (`accept` in `fullDump`).
- **Saving:** it saves itself in the Branch Library when it is done.

Taking data is fast (Connect page, "Measure speed", `js/devices/generic/speedtest.js`, same day):
parameter changes back to back with none lost; whole singles need 20 ms each (three sent with no gap:
only one arrived). The editor then sends at the definition's 20 ms minimum instead of the DIN-MIDI
defaults (150 ms plus 3125 bytes/s for a 524-byte single), so storing a bank goes from about 42 s to
about 5 s. The single edit buffer was restored byte for byte after the test.

Pages A and B can also travel as CC and poly pressure (global Low Page / High Page); SysEx is always
accepted, so the editor sends SysEx only (also over DIN, see "DIN and USB").

### Status bytes the Virus keeps

No screen shows them (internal parameters 1 and 345h of the OS, host-only; a parameter message to index 1
reaches the modulation wheel, not this byte). The editor shows them read-only with the bits named.

- Single byte 1 ("Status"): the OS code that writes internal parameter 1 (bank 1 common code;
  `re/virusti/p2/g_flags*.txt`): **bit 0** edited (set by an edit; cleared at 6054 when the OS reloads the
  stored sound, and set from a comparison at 40BA after a load), **bit 1** compare (toggled by the Compare
  routine at 60C8, which swaps in the stored sound), **bit 2** loaded (set when a sound arrives by SysEx
  (1D5F), from memory (40BE, 5596) or by Compare (6102); cleared at 2C11 once the sound engine has it),
  **bit 3** multi loading (set for all 16 parts at 1DD7; a part with it set skips loading, 1CF2 / 1E02),
  **bit 4** loaded as a part of a multi (1F04), **bit 5** only found in stored sounds (32 in 1380 of the
  6588 factory sounds; the OS only clears it, at 40B7), **bit 6** never touched by the code. On the unit:
  parts read 10h, 11h after an edit, 05h after a single arrived by SysEx; the single-mode buffer 01h;
  storing a sound writes 00h into the slot.
- Multi byte 1 ("Status"): 00 -> 01 after any multi parameter edit, 05 after a multi dump into the edit
  buffer (bit 2, as for singles); 72 00 01 00 does not clear it.

What sets and clears them (host OS, phase 3; `re/virusti/p3/g_ms.txt`):

| Where | What |
|---|---|
| 1DC7-1DE0 | loading a stored multi (panel or program change in multi mode): multi status 04h, every part 08h (multi loading) |
| 1F04 | each part of that multi as it loads: 10h (14h when bit 13h is clear: bit 2 = still to load) |
| 1DB2 | a multi number with no stored multi: the multi is initialised (4B18), status 00h |
| 42A2-42AD | a multi dump into the edit buffer (11 00 7F): bit 2 and bit 0 (from 65FB) set: 05h on the unit |
| 2BF9 (2C25-2C5F) | the OS hands the edit buffers to the sound engine: in single mode only the single-mode buffer; in multi / sequencer mode the multi (if its bit 2 is set) or else each part with bit 2: bit 2 cleared |
| 6027 (from 1D23, 1EA7, 1F1F) | a program load that replaces an edited part first reloads its stored copy: bit 0 cleared |

So the multi status goes back to 00h only by loading a stored multi (04h, then 00h once the engine has it);
a part's 10h only comes from loading a stored multi (1F04). No message does it: dumps set bits 0 and 2,
parameter messages cannot reach byte 1 (index 1 of page A is the modulation wheel; 72 pp 01 is ignored for
it). Switching the TI to multi or sequencer mode would clear bit 2 only (05h -> 01h). On the unit the multi
edit buffer stays 05h and part 16 05h (00h and 10h before phase 1): nothing else differs, and neither byte
changes the sound. Reloading the stored multi (which replaces the multi edit buffer) was not done.

### The OS's parameter tables

`tools/virus/os_tables.py` reads them from the host OS banks into `js/devices/defs/access-virus-ti2-os.js`:

| Where | What |
|---|---|
| bank 2, 8000-86FF | per page 6E-74 (C, D, A, B, multi, global, internal) and index 0-127: the internal parameter (2 bytes; FFFF = none). The parameter handler at 62E0 looks the index up here; FFFF is ignored |
| bank 2, from 8701 | per internal parameter class 00-07: a count byte, then each parameter's page and index (index bit 7: kept by the host, not sent to the sound engine). Several internal parameters share one byte where Virus Control lists several meanings (oscillator models, vocoder, chorus and delay types) |
| bank 1, from D720 | per class: a count byte, then each parameter's display list (a bank 4 list number) |
| bank 4, from 8000 | offsets of the display lists: a count, then 16-bit half-addresses of the texts (bank 10 + (h >> 14), at 8000 + 2 x (h & 3FFF)); 206 lists, e.g. 26 the arpeggiator labels ("... Length, Velocity, Bitfield"), 78 the dump types, 99 the MIDI controller names |
| bank 2, from 8D16 | per class: a count byte, then each parameter's reordering table (FFh none); read by 630B (display position -> stored value, when a value is set from the screen, 1119) and 6336 (stored value -> position, to show it) |
| bank 2, 9025 + 100h x n | reordering table n (128 bytes: the stored value at each display position), at 90A5 + 100h x n its inverse. Used: 0 categories, 1 distortion types, 2 modulation sources, 3 modulation / LFO assign destinations, 8 soft knob names, 9 soft knob destinations, 11 LFO clocks, 12 arpeggiator clock, 13 delay / reverb clocks. 4, 6, 7 belong to output-select variants: internal parameters 0441/0443/0445 (list 117, table 4), 035D/0361 (list 119, table 6) and 035F (list 121, table 7) share the bytes of 0440 (global outputs, list 116) and 035C/035E/0360 (part output, lists 118/120) with "Out2"/"Out3" in parentheses or greyed at the end. The TI2's menu pages (banks 8-9) show only 035C, 0440 and 0444; the Snow image's pages show 035D and 0441 instead (the Snow has one analog output pair): they are the Snow's (phase 5) |
| bank 2, from BB6D | per class / parameter the address of its range routine (through 578E, called by the screen code at 0B75): MOV R4, R5, R6, R7 + SETB C + RET, R6/R7 = the first / last display position, R5 = the range type (below). Seven routines depend on other settings: Reverb Predelay's last position by Reverb Type (C493: 92 / 74 / 55 / 28 for Ambience / Small Room / Large Room / Hall), the outputs by USB audio and Virus Control's third USB pair (C4D9, C503, C52D, C557: global 9 at XRAM 409), the banks by the number of ROM banks (C5A6), one internal page entry (C581) |
| bank 1, 8000 + 100h x n | knob range type n (0-77): the value at each of 256 knob steps (0-127, 0-126, ... 0-1, 64: 0-127 centred, 65: 16-112, 67-74: 1-x, 75: 32-126, 76: 0-127, 77: switch) |

**Value lists (phase 3).** `os_tables.py` matches each Virus Control parameter (pages A-D, 72, 73) to the
internal parameter at its page and index, choosing among the parameters that share a byte by comparing the
value texts (stored value r shows display list entry inv[r] when the parameter has a reordering table), and
writes `PARAM` (internal parameter, list, reordering table, first and last position), `REORDER` and the lists'
screen texts (padding removed, the font's "^" as the degree sign, the "-G" mark of a greyed entry as
"(greyed)"). All 568 parameters have their OS list; 542 have the same texts as Virus Control in every value.
The differences (`re/virusti/vc/os_vs_vc.txt`): the modulation destinations call value 96 "FreqShifter Freq"
(Virus Control: "Filterbank Freq"), the soft knob destinations 88 "FreqShifter Frequency" and 127 "Freq
Shifter Mix" (Virus Control: "Filterbank Frequency", "Filter Bank Mix"); the destinations' range 0-121 is in
display positions: the screen offers 122 entries in alphabetical order, stored values 122-127 (Slot 6 Amount
1, Osc 1/2 F-Shift, Osc 1/2 F-Spread, Distortion Mix) included and the six "-reserved (n)-" values (73, 74,
88, 107, 112, 119) not, where Virus Control's 0-121 is in stored values. Other ranges the OS sets differently:
Distortion Tone 0-127 (Virus Control's Tone64 variant 0-64), Virus Control's "Backup" parameters Arpeggiator
Mode (C 123) 1-6, Oscillator 3 Mode (C 124) 0-66, Key Mode (C 122) 0-4, LFO 2/3 Shape (C 111, 112) 0-67, multi bank 0-29
(RAM-A ... ROM-Z), names 32-126, USB cable numbers 0-15, Edit Mode 0-2 (Easy, Expert, Knobs). The editor shows
every list in the screen's order with its texts and range (`screenEntries()` in the definition); amounts stay
knobs with the screen's text.

The single bytes with an internal parameter are exactly the 387 sound bytes Virus Control describes
plus byte 0 (internal parameter 0, the format). Page A 1-16, 64-66, 122, 123 are the performance
controllers (class 5: modulation wheel, breath, foot, data, volume, balance, expression, hold,
portamento and sostenuto pedals, local, all notes off), not part of the sound. The multi indexes with a
parameter are 1, 3-13, 15, 29, 32-41, 43, 72-75, 77, 78 (Virus Control's set).

### Reserved bytes

The 124 single bytes Virus Control does not describe (except byte 0) and 123 have no sound parameter
in the OS: no screen can show them and parameter messages to them change nothing (checked: 70/71/6E/6F
to A 92, A 97, A 4, B 0, B 22, C 31, D 96, D 127 left the dump as it was), while a single that arrives by
SysEx keeps whatever they hold (checked with values in A 4, A 92, A 97, B 0, B 22, C 31, D 96, D 127).
The editor shows them read-only:

- **Older places of moved parameters**: formats 8 and 9 kept Ring Modulator Volume at A 38, Unison
  Mode / Detune / Pan Spread / LFO Phase and Input Mode / Select at A 97-102 (the OS's controller list
  still names them "RingmodVol", "UnisonMode" ... "InputSel") and Arpeggiator Mode at B 1 (129). When such
  a sound arrives the OS copies them to 50, 504-509 and 143 and leaves the old bytes (checked; 101 -> 508
  was 0 in every sound tried).
- **Controller bytes** (A 4, 6-9, 11-16, 32, 64-66, 92, 95, 96, 120-127): MIDI controller numbers; older
  sounds stored the controllers' values there (e.g. 127 at A 11, Expression, in 4142 factory sounds; 127
  at A 64 when the hold pedal was down). Named from the OS's controller list where it has a name.
- **Reserved** (the rest): 0 in every OS 5 sound (55 in the suite's OS 5 set); older sounds carry values in
  some (A 92 = 1 and B 22 = 127 in 2307 of the 3019 format-8 factory sounds, B 59, B 125, B 126, C 11,
  D 127 ...), which the OS neither uses nor clears. B 0 (128) gets 64 when the OS converts a format 8/9
  sound.

Statistics: `re/virusti/p2/romstats.py` / `romfmt.py` over the 6588 singles of the Software Suite's
backups (`BackupTIROM*` format 8, `BackupTI2ROM*` format 9, `PAOS45FeaturesDemo` format 11,
`PAOS5FeaturesDemo` format 12).

### Remote templates

Remote mode turns the TI's knobs into a MIDI controller (Virus Control's Remote page writes the templates;
the Software Suite ships 35 template files, `*_vrt`: chunks RMOT / RSET / MIDI holding the 13 messages).
The template memory (host OS 6168: memory bank F, 8000 + 400h x template + 20h x record) holds 32
templates of 32 records of 32 bytes:

| Record bytes | Meaning (host OS code) |
|---|---|
| knob k (0-31, not 16): 0-9 | the knob's name (the soft knobs show it) |
| 10 | value range: the OS's knob range type (0-77, bank 1 8000 + 100h x n; CE00 from 0D19 refuses 78 and more): the values the knob sends over its travel. Virus Control's list ("Val Remote Template Knob Behaviours", 62 entries) is an older numbering: its 52 "Bipolar -64 - +63" is the OS's 64, its 1 "Unipolar 0-122" the OS's 4; its template files hold its own numbers (52 for bipolar knobs), which the OS 5 reads as its own (52 = 0-12). **Virus Control does not convert them** (static analysis of `viruscontrol_dll64`, below) |
| 11 | not read by the OS: 1 in most of Virus Control's files (0 or 13 in some), FFh in the OS's initial templates |
| 12-31 | the MIDI string: raw MIDI bytes, FFh = the knob's value, FEh ends it (compiled at 206D into USB-MIDI events, at most 20 bytes; sent by bank 1 DB95) |
| record 16: 0-15, 16 | the template name (16 characters) and the channel switch: 1 = every channel message of the strings goes out on the global Remote Channel (F 123, XRAM 47B; bit 3E set at 6255, used at DB95), 0 = on the channel written in the string (Virus Control's "MIDI Channel Behaviour") |

Request 38 tt kk reads one record (13 tt kk); 13 tt kk sent to the unit writes it, in the same format as the
answer (receiver states 1E-23, `re/virusti/p4/g_431b.txt`: 4308 template < 20h, 4313 record, 431B the raw
bytes (17 for record 20h, 10 for a knob), 4350/4369 22 bytes as low / high nibbles (each < 10h), 4395 the
checksum (sum from the device byte, & 7Fh; a wrong one is ignored), then 43C0 / 48E8 copy 17 or 32 bytes into
template memory; 6168 refuses record 16 and templates 32 and up; when tt is the template Remote mode uses
(global 108) the strings are compiled again (206D) or the channel switch re-read (6255)). The bulk "Remote
Patches" transmit (global Transmit Dump) walks internal page G 47 (template) and 48 (record) at 3860. The OS
initialises them at 4B30: knob k "Remote " + hex(20h + k), range 0, byte 11 FFh, string B0 (20h + k) FF (CC
32 + k with the knob's value); template 0 "Init Template", 1-31 "Template Set 01" ... "31". The unit holds
exactly these (all 1024 records read, `re/virusti/p3/templates_all.syx`).

**Records are panel knobs** (phase 4; `re/virusti/p4/knobs.mjs` -> `knobs.txt`). The knob handler (bank 1
0A8B, knob number in IRAM 2Dh) looks the knob up in four bank 1 tables of 32 entries: D014 a list of
conditions (bank 2 C616 + c: terms [internal parameter, range], checked in order by 47F6; the first that holds
picks the entry), D3FE the entry's function (through DA2E: 0 edit internal parameter D209[k][i] (0B00), 1
Remote mode: record k of the template global 108 (Remote Patch) selects (0D09 -> 6168, range from byte 10 at
0D1E), 2-4 the menu's soft knob 1-3 assignment, 5-7 soft knob 1-3 by the global Soft Knob Mode 1-3 (0C32,
0CA7, 0CD8: F 110, 111, 114)), D614 the name the display shows (display list 45, "Filter 1 Cutoff", "Lfo 1
Rate" ...). Knob 16 is Master Volume and has no Remote entry: that is why record 16 holds the template name.
`os_tables.py` writes the table as `PANEL_KNOBS`; Virus Control's Remote page (its editor XML, "Remote
Templates/Selected Knob" buttons on the panel picture) places the same record numbers on the same knobs
(e.g. the amplifier envelope row 22, 29, 13, 1 = Attack, Decay, Sustain, Release):

| Area | Records (panel order) |
|---|---|
| Soft knobs (list 39 "Soft Knob 1-3") | 0, 12, 26 |
| LFO and oscillators | 19 Lfo 1 Rate (Clock, Contour, LFO 2/3), 27 Oscillator 1 Shape (models, Osc 2/3), 31 Oscillator 1 Wave select (PulseWidth, ...), 23 Oscillator 1 Semitone (Osc 2/3, Portamento), 7 Oscillator 2 Detune (Osc 3, Unison Detune), 3 Oscillator FM Amount (FM Mode, Osc Sync Frequency) |
| Mixer | 11 Oscillator Balance (Panorama), 15 Sub Oscillator Volume (Oscillator 3 Volume), 18 Oscillator Volume (Saturation Type), 30 Noise Volume (Ring Modulator) |
| Filters | 6 Filter 1 Cutoff, 2 Filter 2 Cutoff (Offset), 10 Filter 1 Resonance (2, 1+2), 17 Filter 1 Envelope Amount (2, 1+2, Key Follow), 9 Filter Balance (Unison Spread); each also a vocoder parameter |
| Envelopes | 14, 25, 21, 5 Filter Envelope Attack, Decay, Sustain (Slope), Release; 22, 29, 13, 1 Amplifier Envelope Attack (Patch Volume), Decay, Sustain (Slope), Release (Master Tempo) |
| Effects | 20 Distortion Type (Analog Boost Frequency, chorus, phaser), 4 Distortion Intensity (Drive, ...), 28 Delay Send (Reverb Send, EQ gains), 24 Delay Time (Reverb Time, colours, EQ frequencies), 8 Delay Feedback (Damping, Reverb Feedback, EQ Mid Q-Factor) |

Each record is labelled with the list 45 text of its knob's first-selection parameter; the others are in its help.

**Virus Control and the knob behaviour numbers** (phase 4, static analysis; Ghidra project
`re/virus/ghidra_vc`, script `re/virus/ghscripts/VcRefs.java` via `re/virus/vc.sh`, output `re/virus/vc_dec*.txt`):
the Remote page's parameters are built in FUN_180089bf0 ("Knob Behaviour" 0-127 with the list "Val Remote
Template Knob Behaviours", "Knob Template" 0-34 with presets such as "Control Change Portamento Time" / "B0 05
FF"). When one changes, FUN_18008b020 writes it into the record's 13 message and sends it: the name with
strncpy at message byte 9, **the behaviour value as it is** (`value & 0Fh` to byte 19, `value >> 4 & 0Fh` to
byte 20, i.e. record byte 10), the MIDI string as nibbles from byte 23. There is no conversion table (a search
of the DLL for the mapping 0, 4, 7, 8, 10, ... as bytes, words or dwords found none). So a template made in
Virus Control 5.1.7 gets its older numbers on an OS 5 unit (a "Bipolar -64 - +63" knob sends 0-12). The editor
shows byte 10 as the OS reads it and converts when it imports a .vrt file (Virus Control number i -> the OS
range with the same values, `vcBehaviourToOs`).

The editor's Remote templates page (object key `setup`) reads one template (32 requests) and shows the name,
channel switch and per panel knob (grouped by panel area) its name, value range (the OS's range with Virus
Control's name for it), byte 11 and the MIDI string ("B0 20 *: Control Change ch 1 CC 32"). The channel
switch, ranges and byte 11 are edited in the cards, names and MIDI strings with "Edit knob..." / "Rename
template..."; "Import .vrt..." loads a Virus Control file (behaviours converted), Export / Import .syx keep the
32 messages; "Write to the Virus" sends the 32 records (name first, through the client's queue with its 150 ms gap) into the chosen template after
a confirmation. Nothing is sent while editing. The complete dump reads all 1024 records.

### Older sound formats

Byte 0 is the format: 8 (the TI ROM backups), 9 (TI2 ROM), 11 (OS 4.5 demo sounds), 12 (OS 5). The
unit sends RAM/ROM slots as stored (ROM A-Z hold format 9), but converts a sound when it arrives in an
edit buffer (checked with formats 8, 9 and 11, `re/virusti/p2/t_conv*.py`): format 12; for 8 and 9 the
moves above, Chorus Type 1, Chorus Mix2 127, B 0 64, Filter Bank Resonance 64, Distortion Quality 127 /
Tone 64, the Oscillators page select 127 -> 0; for 8 also the tape delay, filter bank, formant shift and
distortion mix defaults (267-270, 276-280, 298, 318, 328); for 8, 9 and 11 Envelope 3 and 4 (336-345:
20, 70, 64, 70 / 20, 70, 64, 70). Byte 3 becomes the edit buffer's patch number; byte 1 the status.
`upgradeSingle()` in the definition does the same for slots read from the unit and for .syx files, so
the editor shows what the unit plays (the Branch Library keeps the messages as they came).

## Data

### Single (512 bytes)

Virus Control describes 388 bytes (434 meanings: some bytes mean different things with the
oscillator model, the vocoder, the chorus/delay type or the filter bank type; its conditions choose,
and so does the editor's `dynamic`). Bytes 240-249 are the name, 251/252 the categories, 384-479 the
arpeggiator user pattern (32 steps of length, velocity and "Bitfield"), 383 its length.

**Bytes without a sound parameter**: see "Reserved bytes" above.

### Multi (256 bytes)

0 (02), 1 flags, 3 original patch, 4-13 name, 15 clock tempo, 29 panel part; per part (16 bytes each
from 32): bank (0 RAM A ... 29 ROM Z), patch, MIDI channel, low key, high key, transpose, detune,
volume, init volume, output, (42: not described), panorama; 224-239 (not described: 79 in every part
read); 240-255 the part switches (bit 0 part enable, 1 MIDI volume, 2 hold pedal, 3 keyboard to MIDI,
5 voice steal priority, 6 program change; bit 4 not described). Not described: 0, 2, 14, 16-28, 30,
31, 192-207, 224-239, bit 4 of 240-255. None of these has a parameter in the OS (page 72 indexes 0, 2,
14, 16-28, 30, 31, 42, 44, 76 are FFFF in its table); 72 messages to 0, 2, 14, 20, 30, 42, 44 and 76
changed nothing (checked). The editor shows them read-only ("Reserved bytes"); byte 0 as the format (2).

The MIDI channels page shows each part's Sound: the name of the single in the part's edit buffer, from
the arrangement request (34 00) that Get from device sends (the multi and the 16 part singles, about
17 seconds).

The multi edit buffer read on the unit had every part pointing at bank 0 patch 0 while the parts'
edit buffers held other singles: the parts' sounds live in their own edit buffers (sequencer mode).

### Global

Virus Control lists 84 global parameters (page F, indexes 5-127: MIDI, USB, inputs, soft knobs,
keyboard, LCD/LED, Memory Protect at 118, play mode at 122...). The TI OS has no request that sends
them (no 35/36 in its receiver), so the editor shows Virus Control's defaults and sends each change
(checked with Device ID, below);
Memory Protect is shown Disabled (the user's setting). (Virus Control does the same: its
initialisation list sets a dozen globals and never reads them.)

## Checked on the unit (2026-11-25)

- Single edit buffer, the 16 part edit buffers, the multi edit buffer, RAM A/B and ROM A slots and
  bank dumps read; the dumps rebuild byte for byte (`tests/access-virus-ti2.test.js` uses
  `re/virusti/live/before/*.syx` when present).
- A parameter on each page A-D to the single-mode edit buffer, read back, restored with the captured
  dump: byte for byte. The same on part 16 (page A): content restored exactly, but its status byte 1
  went from 10h to 05h (the Virus sets it when a single arrives by SysEx; see above).
- Multi: part 16 volume, part enable and panorama (byte 223: every part read 0, Virus Control's
  "L< 100.0 %") by 72, read back, restored by 72: exact except the multi's status byte 1 (00 -> 01).
- Requests 34 00 (arrangement), 37 00 40, 38 00 00, 39 01, 3A 00 00, 3B 00 00 answered as listed
  above.
- The browser's MIDI channels page shows the multi read from the unit.
- In the browser (tab `?tab=virus`): the Single page reads the edit buffer, a list change (Patch
  Category 2) is sent, read back and restored; RAM A names arrive one by one.
- (Phase 1) Nothing was stored. One global parameter was sent at the end: Memory Protect = Disabled
  (73 00 76 00, the user's setting; it cannot be read back).

Phase 2 (2026-11-25; everything captured first in `re/virusti/live/p2before/`, scripts in `re/virusti/p2/`):

- Reserved bytes: parameter messages to them change nothing; a single that arrives keeps them (above).
  Older formats 8, 9, 11 sent to the single-mode edit buffer and read back (the conversion above); the
  edit buffer restored byte for byte afterwards.
- Multi dump into the edit buffer (11 00 7F, the phase-1 original with status 00): the multi took it
  (status then 05h), the 16 part singles did not change.
- Global: Device ID (73 00 5D 01): replies then carried device byte 01 and a request addressed to 00 got
  no answer; 73 00 5D 00 put it back (replies 00 again). Memory Protect Disabled (73 00 76 00) sent before
  and after the store test.
- Store (the user allowed RAM A 001 only): RAM A 001 ("LEADS") saved (`re/virusti/live/store/`), the
  editor's Store wrote the single edit buffer ("Hypersaw") into it from the browser, read back identical
  except byte 1 (01h -> 00h: storing clears the status); the saved original sent back (10 01 00) and read
  back identical to the saved message, byte for byte.
- Multi store (the user allowed RAM multi 001): saved it ("Nnit Multi"); the editor's Store first sent
  11 01 00, which the TI ignores (also with device byte 00): the receiver takes bank 1 only for slots
  16-127 and bank 32h for 0-15 (the single receiver: bank 0-4 any slot, 20h-2Fh slots 0-15, and it
  refuses every dump while global 99, MIDI Dump RX, is 0). With 11 32 00 the test multi (the edit
  buffer "Trance !") read back identical except byte 1 (05h -> 00h); the editor now sends 11 32 pp for
  slots 1-16 and stored it again from the browser, same result. The saved original was stored back
  (11 32 00) and read back identical to the saved message, byte for byte; the multi edit buffer did not
  change. Memory Protect Disabled sent after.
- The MIDI channels page (browser) shows the part names read by the arrangement request.
- Requests 38 00 00-20, 39 00-7F, 3A, 3B with several addresses (above).

Phase 3 (2026-11-26; read requests only):

- Remote templates: all 32 x 33 records requested one at a time (38 tt 00-20): 1024 answers, record 16 never
  answers; the editor's Remote templates page read template 3 in the browser.
- The browser's Single page shows the modulation destinations in the screen's order (Off, Amp Env Attack,
  Amp Env Decay, ...) with the edit buffer's values.
- Memory Protect Disabled (73 00 76 00) sent at the end. Nothing else was sent.

Phase 4 (2026-11-26):

- Remote template records tied to the panel knobs (OS knob table, above); Virus Control's behaviour numbers
  shown to go out unconverted (static analysis); template writes implemented in the editor (checked with the
  simulator: write, read back, compare).
- Template write (the user allowed template 31, "Template Set 31", only; `re/virusti/p4/t_tpl31.py`, files in
  `re/virusti/live/`): its 32 records read and saved (`tpl31_before.syx`, read twice: identical; the OS's initial
  contents); in the browser the editor read it, renamed it "MM Write Test", set the channel switch, and record 6
  (Filter 1 Cutoff) to "TestCutoff", range 64, byte 11 = 1, string B0 4A *; "Write to the Virus" sent the 32
  records; read back: identical to the expected messages (`tpl31_expected.syx` / `tpl31_written.syx`) byte for
  byte. (Record 6 was also written once on its own from Python, same bytes: the browser's first write paced its
  messages with page timers, which Chrome slows to one a minute in a background tab, so the first read-back came
  before record 6 had gone out; the editor now queues the 32 messages at once.) The saved records written back
  (13 1F kk) and read back: identical to `tpl31_before.syx`, byte for byte. Memory Protect Disabled sent at the
  end. Nothing else was written.

Phase 5, DIN and USB (2026-11-27; requests only, `re/virusti/din/t_usbmode.py`, nothing else open on the ports):

- F0 00 20 33 01 10 30 00 40 F7 on "Virus TI Synth": the single edit buffer (524 bytes) on "Virus TI Synth". The same
  on "Virus TI MIDI": no answer on either input (it leaves the MIDI Out socket).
- The short form F0 30 00 40 F7 (no 00 20 33 01 dd; the OS takes it only in USB MIDI mode, 3E47 -> 3E8F) on "Virus TI
  Synth": answered with the same 524 bytes, so the TI2 is in USB MIDI mode while connected (no Virus Control
  running): over DIN its MIDI In would go to the computer. On "Virus TI MIDI": no answer.
- Memory Protect Disabled (73 00 76 00) sent at the end. Nothing else was sent; no global or memory changed.

## Next steps

See `intdocs/FUTURE_WORK.md`, "Access Virus TI 2".

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- Multi slot: The slot this multi was loaded from (internal parameter 346h), written by the Virus
