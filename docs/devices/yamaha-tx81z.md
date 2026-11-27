# Yamaha TX81Z (and the 4-operator DX family)

Definition: `js/devices/defs/yamaha-tx81z.js` over the 4-operator code `yamaha-dx4.js` (voice
format, packing, the 8 algorithms, parameters, builder, translator), shared with the DX11
(`yamaha-dx11.md`), DX21 (`yamaha-dx21.md`) and DX100/DX27 (`yamaha-dx100.md`). Graphics:
`yamaha-dx-draw.js` (algorithm diagram and chooser; a 4-op EG graph). Tests:
`tests/yamaha-dx4.test.js`, `tests/yamaha-tx81z.test.js`. **Not yet checked on a TX81Z.**

## Sources: firmware and documents

- TX81Z v1.6 (`z:/firmwares/Yamaha_TX81Z_ROM_v1.6 _03-Feb-88.zip`, 64 KB, two 32 KB banks; file
  offsets below; v1.0-v1.5 and Yamaha's 1987 change log are also in the collection).
- **From the firmware:** the maximum of every VCED, ACED and PCED byte (table at 05F1: the 13 operator
  maxima, the 25 voice maxima, the 5 + 3 ACED maxima, the 12 instrument and 4 common PCED maxima), the
  INIT VOICE (packed, 0088), the labels of the edit screens (2849-2BE5: ALG, Feedback(OP4), Wave, Speed,
  Delay, P Mod Depth, A Mod Depth, Sync, P Mod Sens., AMS, EBS, KVS, Fix Range, CRS, FIN, OSW, DET, AR,
  D1R, D1L, D2R, RR, SHFT, OUT, RS, LS, Middle C, Poly/Mono, P Bend Range, Full Time/Fingered, FC Volume,
  P. Bias, EG Bias, Reverb Rate...), the value texts (saw up, square, triangl, S/Hold; norm/altr; delay,
  pan, chord; the micro tuning names 2EB5-2F57; MAX NOTES, RECEIVE CH, LIMIT/L, LIMIT/H, INST DETUNE,
  NOTE SHIFT, OUT ASSIGN, LFO SELECT, MICTUN= 2E5B-2EAD), the bulk headers ("LM  8976AE", "PE", "PM",
  "S0"-"S2", "LM  MCRTE0/1", "LM  976CRT") and the packing of the additional data in the voice memory
  (routine 8431: SHFT<<4 | FIX<<3 | FIXRG, then OSW<<4 | FINE per operator). The voice memory layout
  was checked against the 128 preset records (e.g. LatelyBass: PMS 5 in byte 45, transpose 12) and the
  init voices of the TX81Z, DX11 and DX100 (all packed) and the DX21 (in edit form, which fixes the
  VCED byte order).
- The DX100 v1.1 firmware's SysEx parser (B0D5): sub-status 0 bulk, 1 parameter change (12h voice),
  2 dump requests answered for formats 3 and 4.
- **From the TX81Z's MIDI code and screens (2026-11-26, third session)** — the lower bank (CPU
  8000-FFFF, file 0000-7FFF) holds the screens and the packing, the upper bank (file 8000-FFFF) the
  MIDI code; each calls the other through 8039 (index in RAM 40h; lower table 8202, upper table 8264).
  Listings: `python -I tools/yamaha/hd6303_dis.py lower.bin 8000 OUT 8039 tab:8202:13 tab:A184:31
  sw:B54A bt:B563 bt:B55E --auto` and `... upper.bin 8000 OUT 8039 tab:8264:30 E246 E28B E2C2 E2D9
  E306 E3EB E456 E4C3 E543 E5BE E62A E635 sw:AB7C bt:AB95 bt:AB90 --auto` (`bt:` is new: a routine
  followed by an inline table of byte offsets). Screen strings end in a display-type byte (< 20h) and
  use word tokens (>= 80h, dictionary ABF0); the display routines are the table A184.
  - **Frequency display** (type 3, A1E0; the DX11 has the same code at its 3600): RATIO: CRS indexes
    table B4EA, bits 0-1 pick 1 / sqrt 2 / pi/2 / sqrt 3 (A2A8: 100, 141, 157, 173), bits 2-5 a step
    n; ratio = (16 n + FIN) x multiplier / 16 (n = 0: 8 + FIN), with roundings for sqrt 2 (FIN 0) and
    0.70 / 0.86 -> 0.71 / 0.87; shown "CRS(RATIO)=1.06". FIX: ((CRS & 3Ch) x 4, or 8) + FIN, shifted
    left by the fix range: "FIN(FIX)=  440Hz". Fix range (A494): 255Hz, 510Hz, 1KHz ... 32KHz. FIN
    0-15 is accepted at every CRS (the receive check 8645 uses the maximum 15).
  - **Performance memory** (PMEM, RAM 6E45, 24 x 76): packing 8509 / unpacking 846B of the lower bank
    (per instrument OUT<<5 | voice bit 7<<4 | MAX NOTES, voice, LFO SELECT<<5 | RECEIVE CH, LIMIT/L,
    LIMIT/H, DETUNE, MICROTUNE<<6 | NOTE SHIFT, volume; MICTUN; key<<3 | effect<<1 | assign; name).
    The bulk "LM  8976PM" (sender E246) holds 32 records: 1-24, then eight copies of the SINGLE
    template (AF13). Init templates (87A6 ...): singl, dual, split, mono8, poly4. The PCED bulk
    (sender E383) is the RAM copy in order with the voice number split into its bit 7 and the rest.
  - **System** ("LM  8976S0", 27 bytes, sender E4C3): RAM 7565-756F (Master Tune, Basic Rcv.Ch,
    Transmit Ch, P.Change, Cont.Change, Pitch Bend, Note on/off, Exclusive, Mem Protect, Combine,
    A.Touch -> BC: labels in the order of the page table B5E5 and the screen records 20-23, 75-82 of
    A76C) and the 16-character power-on message (7740, "<Good morning!!>" at cold start, shown under
    UTILITY MODE). Value texts: omn (Basic Rcv.Ch 16), off/com/ind, off/norm/G1-G16, all/odd/even.
  - **Program change table** ("LM  8976S1", sender E543): 128 entries sent as bit 7 then the low
    seven bits; 0-159 voices, A0h-B7h PF01-PF24 (display A13A); cold start PGM n = voice n.
  - **Effects** ("LM  8976S2", 55 bytes, 75F1): Delay Time ((v+1)/100 s), Pitch Shift (-24..+24),
    Feedback, Effect Level, Select (LFO/velocity/note), Direction, Pan Range (maxima C7BB), then 12
    keys x 4 chord notes (key's note + value - 24, 49 = none "*"; display A098); cold start 99C9.
  - **Micro tuning** ("LM  MCRTE0" 12 keys from C3, "LM  MCRTE1" 128 keys): per key note 13-108 and
    fine 0-63 (64ths of a semitone; check C7A1); display A051 shows the nearest note with +0..+32 or
    the next note -31..-1.
  - **Parameter changes** (receiver D8DD): group 10h = PCED (0-109), 12h = VCED (0-86 and 93), 13h =
    ACED (0-22; 40h-4Bh are panel switches), and longer messages under 10h: `7B pp vv` system,
    `7C pp vv` effects, `7D kk note fine` octave micro tuning, `7E kk note fine` full micro tuning,
    `7F pp hh ll` program change table.
- **From Yamaha's 4-op data format:** the operator order OP4, OP2, OP3, OP1 in the data, the parameter
  change numbers (voice 12h, additional data 13h, performance 10h), and the PCED byte order (matches
  the firmware's maximum table: 8, 159 over two bytes, 16, 127, 127, 14, 48, 99, 3, 3, 1). Both are
  now confirmed by the firmware's receiver D8DD and the PCED sender E383 (below).

## Objects

- **Voice** (116 bytes: VCED 93 + ACED 23): per operator AR D1R D2R RR D1L LS RS EBS AME KVS OUT
  CRS DET and FIX, Fix Range, FIN, OSW (W1-W8), SHFT; voice ALG, Feedback, LFO, sensitivities,
  Middle C, Poly/Mono, P Bend Range, portamento, sustain/portamento switches, controllers, name;
  Reverb Rate, FC Pitch/Amplitude. CRS and FIN are labelled and valued as the TX81Z shows them:
  "CRS(RATIO)" / "FIN(RATIO)" with the ratio including FIN, "CRS(FIX)" / "FIN(FIX)" with the frequency
  in Hz (CRS in brackets, four CRS values per step); Fix Range as 255Hz-32KHz. The DX11 shares this.
  Read by request ("LM  8976AE" then format 3); parameter changes 12h / 13h.
- **32 internal voices** (format 4, VMEM): kept by the editor, read by request; Edit, Store (whole
  bank), Play (program change).
- **Performance** (PCED, "LM  8976PE", 110 bytes): eight instruments (MAX NOTES, voice I01-I32 or
  A-D presets over two bytes, RECEIVE CH 1-16/omni, LIMIT/L-H, INST DETUNE, NOTE SHIFT, volume, OUT
  ASSIGN, LFO SELECT, MICROTUNE) and MICTUN table, Assign, Effect, micro tune key, name. The
  **MIDI channels** page lists the eight instruments with voice and channel. The initial
  performance is the firmware's SINGLE template; Init offers the five templates.
- **24 performance memories** (PMEM, "LM  8976PM"): the performance page's slot list (PF01-PF24):
  Get 24 performances / Read names, Edit (unpacks a memory), Store (packs into the editor's copy and
  sends all 32 records), Send memories. No Play: a memory is selected through the program change table.
- **System setup** ("LM  8976S0"): the UTILITY and MIDI control pages and the power-on message
  (Message action); changes as `10 7B pp vv`. Init: the firmware's values with Mem Protect off.
- **Program change table** ("LM  8976S1"): PGM 1-128 -> I01-D32 or PF01-PF24; changes `10 7F`.
- **Effects** ("LM  8976S2"): delay, pan and the chords of the twelve keys; changes `10 7C`.
- **Micro tuning** octave ("LM  MCRTE0") and full keyboard ("LM  MCRTE1"): note and fine per key;
  changes `10 7D` / `10 7E`; Init = equal temperament. Head Library: as a tuning (cents per key).
- Branch Library: the memories become 24 performances, the other dumps their objects. The effects and
  the program change table travel exactly between TX81Zs only (no shared form).

## Head Library

Family `yamaha-dx` with `ops: 4`: TX81Z / DX11 / DX21 / DX100 voices load into each other exactly
(the models without additional data drop it, reported). A 6-operator voice is reduced to four
operators (carriers and modulators by role and level, the 4-op algorithm with the same number of
carriers; reported), and a 4-operator voice goes onto a DX7 as OP3-OP6 of the 6-op algorithm with the
same connections. Other families build on algorithm 5 (two FM pairs).

## Open

- VCED parameter 93 (accepted by the receiver, not in the bulk: the operator on/off switches in
  Yamaha's 4-op lists) is not offered; the panel switch messages (13h 40h-4Bh) are not offered.
- The pan Direction's second glyph is a custom LCD character (taken as output II).
- The DX11 keeps PMEM / system / tables / effects / micro tuning as data (its firmware has the same
  headers but its layouts are not compared yet).
- Not checked on a TX81Z.
