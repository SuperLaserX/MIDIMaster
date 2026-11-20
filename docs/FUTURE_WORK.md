# Future work

Requests and ideas not finished yet. Each item says what is wanted and what is known so far.

## Roland JV-2080

- **Only list waves that can sound.** The Tone page's wave lists offered every number for
  every group, including expansion boards that are not installed and PCM card groups. Lists
  should hold the 255 INT-A and 193 INT-B waves, the installed boards' waves, and PCM card
  waves only when a card is known to be in the slot.
- **Names for the internal waves.** They are in the wave ROM, not the flash, so they were shown
  as numbers. The owner's manual lists them (Waveforms, pages 182-183).
- **Rhythm sets.** The rhythm set page only offered the performance's part 10 and the two user
  sets. The JV-2080 also has two in each preset group (PR-A, PR-B, PR-C, PR-D GM, PR-E), card
  sets, and the expansion boards' sets (1 or 4 per board, from the board ROMs). They are
  selected with bank select and program change on part 10's channel (manual page 184).
- **Part 10 plays rhythm sets.** Choosing a patch for part 10 (MIDI channel 10 by default)
  should offer rhythm sets, not patches. Other romplers have the same kind of drum part; the
  MIDI channels page should know which parts are drum parts.
- **Adding new waves.** The JV-2080 cannot load samples: its waves come from the internal wave
  ROM, SR-JV80 expansion boards and SO-PCM1 PCM cards, all read-only. The DATA card slot holds
  patches, performances and rhythm sets, not waves. New waves would need new hardware: an
  SR-JV80-compatible board (or PCM card) with a ROM image built in Roland's format. The board
  format is mostly understood already (`tools/roland/srjv80_rom.py` unscrambles and parses the
  sample, wave, patch and rhythm tables), so building such an image is possible in principle;
  still unknown are the sample encoding details, the checksum (if any) and the board's chip and
  bus wiring.
- **Board rhythm set names.** The board ROMs hold rhythm sets (count known); their names are
  read from the unit when the bank is scanned, not yet parsed from the ROM.

## All devices

- **Drum demo.** Play a rhythm set or drum kit with a standard 4/4 pattern using the General
  MIDI drum notes (bass drum, snare, low/mid/high tom, rim shot, hand clap, closed and open
  hi-hat, crash, ride), on MIDI channel 10 by default.
- **Reset controllers.** A button on the Controllers page that puts every controller back to its
  default value.

## Korg M1

- **Program names on start.** The program memory names should be read when the M1 connects.
