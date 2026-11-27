# KEdit2000

A web-based editor and Branch Library for the Kurzweil K2000 that works entirely over MIDI.

Sound edits are sent straight into the program stored on the K2000, one small SysEx message
per change, so you hear each change on the next note. Nothing is done by simulating button
presses, except in the Front Panel, where that is the point.

## Start

1. Connect your MIDI interface both ways: interface out to K2000 MIDI In, K2000 MIDI Out to
   interface in.
2. Double-click `start.bat`. It starts a small local server and opens
   `http://localhost:8020/`. (Node.js is used if installed, otherwise Python.)
3. Use Chrome or Edge. Allow MIDI access with SysEx when the browser asks.
4. On the Connect page pick the ports and press Connect. If there is no reply, press
   Scan for device ID, or check the SysEx ID on the K2000's MIDI mode RECEIVE page.

To try the app without a K2000, open `http://localhost:8020/?demo`. A simulated K2000 with
example programs, keymaps and samples answers every message.

## What it does

| View | Purpose |
|---|---|
| Program Editor | Every parameter of a program on one screen, edited live: common and effect settings, layers, keymaps, pitch, output, velocity triggers, the algorithm and the page for each DSP function, graphical envelopes, envelope control, LFOs, ASRs and FUNs. Names, ranges and value texts are the K2000's own, taken from its OS. Undo/redo, duplicate and delete layers, save to any RAM ID, export as .syx. |
| Library | All object types. Rename, copy, move and delete; export single objects, selections or a full RAM backup to .syx; drop .syx files to load them; move or delete whole banks. |
| Samples | Inspect soundblocks, change root key, volume and loop flag live, rename sub-samples, split stereo or multisample blocks, download RAM samples as WAV and upload WAV files over MIDI Sample Dump. |
| Keymaps | Zones per velocity level, with sample, tuning and volume editable live. |
| Disk Import | Open .KRZ, .K25 and .K26 files, folders, and Kurzweil disk or CD images (.iso, .bin with .cue, .img). Pick programs, keymaps and samples (dependencies are added for you), preview samples, choose IDs, and send everything to the K2000 over MIDI. |
| Master & MIDI | Everything in the K2000 Master table, edited live: tuning, velocity, pressure and intonation maps, outputs, MIDI transmit and receive, the 16 MIDI channels, mode, song, sampling and disk settings. |
| MIDI Monitor | Every message in both directions, decoded. |

The Front Panel is a dock that opens beside any page from the Front Panel button in the top
bar or the sidebar. It mirrors the K2000 display and has every button and the alpha wheel.
Click inside it to type: arrows, digits, Enter, + and -, Esc for Exit, E for Edit, F1-F6 for
the soft keys, PageUp/PageDown for the wheel. Shortcuts only apply while the panel has focus.

An audition keyboard at the bottom plays notes on the K2000 (also from the computer keys
Z-M and Q-U), so you can hear edits without leaving the editor. Use Select on K2000 in the
editor so the K2000 plays the program you are editing.

Pattern loops a test pattern on the audition channel while you edit: a Cmaj7 chord, a bar of
eighth notes, and two glides. In each glide the second note starts half a beat before the
first ends, so a mono program with portamento or legato slides between them. The tempo
defaults to 120 BPM. The octave and velocity controls apply to the pattern too.

## Good to know

* Live editing changes the stored program immediately. Edit RAM programs (IDs 200 and up), or
  use Copy to RAM on a factory program first. Back up from the Library before experimenting.
* Keep the K2000 out of its own Program Editor while editing the same program here. The K2000
  refuses changes to an object that is open in its editor; the app tells you when that happens.
* Do not work in KEdit2000 while the K2000 loads from disk or deletes many objects. The K2000
  can lock up if MIDI arrives while it is busy.
* Samples travel at MIDI speed: about 45 seconds per second of 44.1 kHz mono audio. Uploading
  at a lower sample rate is offered to save time. Factory ROM samples cannot be downloaded.
* Disk Import sends samples as Sample Dumps, so a large library takes a long time: about a
  minute per second of 44.1 kHz audio, and hours for a full CD. The page shows an estimate
  and the free memory before you start. Samples can only land on IDs 200-999.
* The K2000 never gives sample memory back until Delete Everything or a restart, even when a
  sample is deleted. Audio from a cancelled or failed import stays allocated until then.
* K2500 and K2600 files load too. Objects only those models have (KDFX, KB3) are skipped.
  Their programs can be converted for the K2000, which drops what the K2000 lacks. Treat the
  result as a starting point.
* Every parameter page, name, value range and value text comes from the K2000 v3.87 OS, so
  values read exactly as on the K2000 display. The map was checked against 1,075 factory
  programs: 88% of the parameters read in range for every program, and the rest are mostly
  FUN inputs and effect mod targets whose ranges depend on the effect or allow inverted
  sources. "Raw segment bytes" at the bottom of the editor still shows and edits every byte.

## Undocumented K2000 features this app uses

Found by disassembling the K2000 v3.87 operating system (details in `docs/PROTOCOL.md`):

* Message 12 returns free program and sample memory.
* Message 79 splits a multi-sample soundblock into single samples.
* Message 7E names a sub-sample inside a soundblock.
* Message 7C returns an object's RAM address.
* Partial LOAD into a program swaps the edited program in and refreshes every channel
  playing it. That is what makes live editing possible.
* The K2000 answers MIDI Sample Dump requests and identity requests, but only on its own
  device ID, never on the broadcast ID 127.
* An incoming Sample Dump with sample number n is stored at ID n + 1 (200 is added below 200),
  so KEdit2000 sends ID - 1.
* Sample memory is allocated like a stack and audio never moves. Disk Import relies on this: it
  sends audio into a temporary sample, reads back where it landed, and writes the original
  soundblock with its loops and settings pointing there.

## Project layout

```
index.html, css/app.css     page and styles
js/main.js                  app shell, navigation, status bar
js/midi/                    protocol, request queue, Web MIDI, Sample Dump, demo K2000
js/model/                   object types, program/keymap/soundblock parsers, parameter map
js/ui/                      controls, envelope editor, LCD, front panel dock, audition keyboard
js/disk/                    disk images (FAT, ISO 9660, cue), KRZ/K25/K26 parser, importer
js/views/                   one module per screen
tools/extract_rom_tables.py rebuilds js/model/romtables.js from the OS EPROMs
tests/                      node --test suite (codecs, parsers, client, Sample Dump, disk import)
docs/PROTOCOL.md            protocol and firmware notes
docs/HEAD_LIBRARY.md        the Head Library (global patch store) and the Branch Library of each device
docs/MIDI_INPUTS.md         controllers connected to MIDIMaster and their mappings
```

Run the tests with `node --test tests/` (Node 20 or later). The app has no build step and no
dependencies.
