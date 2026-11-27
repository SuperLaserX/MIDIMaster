# Yamaha DX7s

Definition: `js/devices/defs/yamaha-dx7s.js` (+ `yamaha-dx7s-data.js`): the DX7II definition
(`yamaha-dx7ii.md`) with one voice per performance, the DX7II's micro tuning and fractional scaling
objects, and the DX7s's own labels, value texts, ranges, performance and system pages. Tests:
`tests/yamaha-dx7ii.test.js` ("DX7s: ...").
**Not yet checked on a DX7s.**

The DX7s v1.3 firmware (`z:/firmwares/Yamaha DX7S V1.3 with service manual - 27C256.zip`, 32 KB,
with the service manual) holds the same bulk headers as the DX7II ("LM  8973PE", "LM  8973PM",
"LM  8973S ", "LM  MCRYE", "LM  MCRYM", "LM  MCRYC", "LM  FKSYE", "LM  FKSYC" at 4CB5) and has no
dual or split voice mode texts, so it reads and sends the DX7II's voice, additional data and
performance formats; a performance from another model loads with voice mode single (reported).

Its MIDI receiver (listing `re/dx/dx7s.lst`: `python -I tools/yamaha/hd6303_dis.py ROM 8000 OUT
sw:A97B --auto`; SCI vector BE8B, SysEx states BF45, parameter groups C273) takes the same
parameter changes as the DX7II v1.9: 00/01 the voice, 04 the master tuning, 18h the additional data
(numbers 0-49h, so bytes 39-48 as 40h-49h; 7Eh micro tuning key, 7Fh fractional scaling; 5Ah a
reset), 19h the performance (0-34h, stored from 2FF2h) and the system setup (40h-52h from 3058h, 53h
memory protect), 1Bh the panel switches. Its screens use shorter words ("Osc detune =", "Unison
detune=", "Master tune =", "Omni mode   :", "Local       :", "Note on/off:", "Program SW [  ] Trns
#", "Device number=", ">Micro tune<", "Soft"); the labels here are the DX7II's longer ones.

Its 64 internal voices are kept as the DX7II keeps them (VMEM at 2000h and 3000h): a request answers
with the bank of system byte 12 (3064h, sender CA0D), a received bulk goes to that of byte 13 (3065h,
C256; refused while memory protect is on, 30BEh), and a program change in voice play mode (RAM 3192h
= 0, routine 8A1C from C022) selects I01-I64 with 0-63 and C01-C64 with 64-127 (bit 6 = cartridge;
in performance play mode, 3192h = 1, bit 5 is the cartridge's performances). So the slot list is the
DX7II's: I01-I32, I33-I64 and C01-C64, the banks switched with 19h 4Ch / 4Dh.

## Its own pages (v1.3)

Each edit page has a number (RAM 36A1h) and a sub-page (319Fh + page - 6, or - 12 from 10h on).
Table 9B1C gives, per page, the list of bytes it edits; 99A5 resolves an entry: pages 6-0Ch to the
voice (28C6h, operator entries 0-14h + 21 x operator; on the scaling page entry 0, the sensitivity
page's "A mod sens.", the LFO page's mode and the first three PEG entries to the additional data at
2961h instead), 10h-19h to the additional data (group 18h, entries above 26h numbered + 19h, so
47 = 48h), 1Ah-1Ch to the performance (2FF2h, group 19h) and 1Eh-1Fh to the system setup (3058h, 19h
40h + byte). Table 9BCD / 9BED gives the maxima in the same order, and each label group is followed
by its pointer table:

| Page | Bytes (9B1C) | Labels |
|---|---|---|
| 6 common | VCED 134, 135, 136, 144, 145 | DEA9: Algorithm select, Feedback, Osc key sync, Middle C, Name |
| 7 oscillator | op 17, 18, 19, 20 | "Frequency(Ratio)" / "Fixed freq (Hz)" (D1B0), DEF3: F-coarse, F-fine, Osc detune |
| 8 EG | op 0 (rates), 4 (levels), 13 | DF14: EG-R, EG-L, Rate scaling |
| 9 scaling | ACED 0-5, op 16, 8, 11, 12, 9, 10 | DF76: Scal. mode (nomal / frac.), Output level, Break point, L-curve, R-curve, L-depth, R-depth (curves -LIN -EXP +EXP +LIN, DF98) |
| 0Ah sensitivity | op 15, ACED 6-11, VCED 143 | DFDD: Key velocity, A mod sens. (the additional data's Ams 0-7), P mod sens. |
| 0Bh LFO | VCED 141, 142, 137, 138, ACED 13, VCED 139, 140 | E041: LFO key sync, LFO wave (Triangl, Saw dwn, Saw up, Square, Sine, S/Hold), LFO speed, LFO delay, LFO mode (Single / Multi, D39B), LFO PM depth, LFO AM depth |
| 0Ch pitch EG | ACED 12, 14, 38, VCED 126, 130 | E0C3: PEG range (8oct, 2oct, 1oct, 1/2oct), PEG velocity, PEG scaling, PEGR, PEGL |
| 16h key mode | ACED 15, 47 | E21A: KeyMode (Poly, Mono, Uni Poly, Uni Mono), Unison detune |
| 17h bend, portamento | ACED 18, 16, 17, 20, 22, 21, 19 | E2F1: PB mode (Normal, Lowest, Highest, Key-on), P-bend range, P-bend step; portamento mode "Sus-key p" retain / follow (poly) or Fingerd porta / Full time porta (mono, D8A3); E2F9: Porta time, Porta step, Random pitch |
| 18h controllers | ACED 23-25, 30-37 | E399: MW / BC / AT PM depth, AM depth, EG-bias, P-bias |
| 19h controllers | ACED 48, 26-29, 39-46 | "FC1 -> CS1 :", FC1 / FC2 / MC PM depth, AM depth, EG-bias, volume |
| 1Ah performance | PCED 10, 12, 17, 18 | E4C9: FS (sustain, portamento, key hold, Soft), FS soft, CS1, CS2 (destinations E92E: 22 names, then six per operator name, D7CF) |
| 1Bh | PCED 16, 8 | E517: Total volume, Forced damp |
| 1Ch | PCED 1, 3, 13, 31 | Voice number, >Micro tune< (D6A6: 1-11 by name, then User 1-2 [INT], User 3-65 [CRT 1-63]; Key for tables 1-4, flats from C, Pure(minor) sharps from A), Key shift, Name |
| 1Eh Midi edit | system 0, 2, 4, 11, 5, 7, 8, 9, 10, 21+ | E69E: Trns ch (off = 16 in byte 0, 8750), Recv ch, Omni mode, Local, IN control#, CS1 control#, CS2 control#, Note on/off, PC trns (off, Normal, Memory), Program SW [n] Trns #; "After touch" is RAM 3E9Fh, not in the setup |
| 1Fh Exclusive | system 15, 14, 13, 12 | E76E: Exclusive, Device number, Recv block, Trns block (1-32 / 33-64) |

Every maximum is the DX7II's except the micro tuning table (4Bh: the DX7II stops at 4Ah, CRT 62).
When it loads a performance the DX7s sets voice mode 0, the micro tuning / sustain / foot switch A/B
bytes 5, 9, 11 to 1 and the slider switches (19) to 5 (8C91); bytes 2, 6, 7, 14, 15 and 20-30 are
never read. The system setup's bytes 1, 3, 6 and 19 have no page and no reference (initial values
B186: byte 19 = 1; program change table 0-63, B178). The editor shows the unused bytes read-only.

Open: check on a DX7s.
