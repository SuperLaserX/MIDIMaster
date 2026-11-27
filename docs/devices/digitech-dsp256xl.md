# DigiTech DSP-256XL: MIDI implementation from its firmware

Source: `Digitech DSP_256XL_1.08.zip` (`DSP_256XL_108.bin`, 64 KB, HD6303). Its version page shows "DIGITECH D256-XL
Version 1.04"; the archive calls it 1.08. Work copy: `re/fx/digitech-dsp256xl/fw/dsp256xl_v108.bin`.

The DSP-256XL runs the DSP-256 software rebuilt (code moved to C000h-FFFF, tables to 2000h-BFFF, the RAM variables a
few bytes up), so it has the same editor (`js/devices/defs/digitech-dsp256-common.js`, thin model file
`digitech-dsp256xl.js`) and the same generator, which finds every address it uses by code pattern
(`tools/digitech/dsp256_fw.py`, `layout()`; for the DSP-256 its output is unchanged):

    python -I tools/digitech/dsp256_fw.py re/fx/digitech-dsp256xl/fw/dsp256xl_v108.bin js/devices/defs/digitech-dsp256xl-fw.js "v1.04 (archive DSP_256XL_1.08)" --vectors tests/digitech-dsp256xl.vectors.json

Everything in `docs/devices/digitech-dsp256.md` applies, with these differences:

| | DSP-256 v1.05 | DSP-256XL |
|---|---|---|
| SysEx model byte | 06 | 0B |
| Configurations | 27 | 28: Room Simulator added as 7 (Room Size, Decay Time, Position, Damping Factor, Reverb Level, Dry Level); the later ones move up by one |
| 41h dump | 08CEh-1F23h, 5718 bytes | 08DCh-1F4Bh, 5744 bytes (one more configuration memory, four more link bytes) |
| Settings | 1E20h program, 1E21h channel, links 1E22h (93), map 1E7Fh, 1EFFh, 1F00h-1F23h | 1E44h program, 1E45h channel, links 1E46h (97), map 1EA7h, 1F27h, 1F28h-1F4Bh |
| Linked to CC | 90 named parameters | 94 |
| Factory presets | Echoing Chorus ... | Left in Hall, Fat Animation, ... (128, its own) |
| Hand / Foot Controller after the first power-up | Hand Controller (FFh) | Foot Controller (0, D1CF) |
| Utility pages | 12 | 14: "Dump Program n as m" (sends user program n under number m) added |

Room Simulator's Decay Time is the one page whose texts follow another byte: the texts for each Room Size (byte 1)
were made by running the page for every pair (`by` / `ts` in the generated table); every other page was run with
other values in the other bytes and does not change.

The 01h program request has the same `JSR $42` as the DSP-256 (jumps to RAM 0042h), so the editor reads programs
from the 41h dump.

The translator keeps a program exact between the two models when the configuration (by name) has the same pages.

**Not checked on hardware** (no DSP-256XL is connected).

## Open

- A hardware check; which firmware version the archive really is (1.04 on the screen, 1.08 in the archive name).
- The "Dump Program n as m" pages (a unit-side send) are not offered by the editor.
