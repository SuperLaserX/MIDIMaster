# Yamaha TX802

Definition: `js/devices/defs/yamaha-tx802.js` (built on the DX7II definition, `yamaha-dx7ii.md`).
**Not yet checked on a TX802.**

Sources (read only, never run):

- Program ROM v1.5 (XB224, 32 KB at 8000h): `z:/firmwares/Yamaha_TX802_ROM_v1.5.zip`; listing
  `re/dx/tx802.lst` (`python -I tools/yamaha/hd6303_dis.py ROM 8000 OUT --auto`: the `--auto`
  option follows the firmware's jump tables), strings `re/dx/tx802_v15_strings.txt`. v1.1 (from
  `Yamaha TX802_XB223_XB224.zip`), v1.3, v1.4 are also in the collection.
- Data ROM (XB536, 32 KB): the screen texts, value names, maxima, INIT data and the preset voices.
  It is bank-switched into 6000h-7FFFh (write 10h to 1200h: file 0000h-1FFFh; 11h: 2000h-3FFFh).
  The collection has an alternate XB536-B image (`Yamaha_TX802-jp_XB536-B.zip`, two of its voice
  banks replaced by user voices); its texts are the ones the v1.5 program ROM addresses (text table
  at 7100h, shown by FDE6). Strings: `re/dx/tx802_xb536_strings.txt`. The 8 KB XB223 is another
  processor's code, not used here.
- The TX802 has a 40x2 LCD; its menus are 40-character lines such as "******   PERFORMANCE EDIT MENU
  *******" / "rcvch vol  out  lmt shft mtt# dtune name".

## Voice

The DX7II voice formats (VCED + ACED, VMEM + AMEM) and the DX7II labels: the TX802's voice pages
(data ROM texts 70-96, "OP    Osc    >Mode  >Coarse>Fine >Detune", "LFO  >Wave>Speed>Delay>Mode>Pmd
>Amd>Sync", "Mod. wheel   >Pmod >Amod >EGbias"...) use the same words. Differences, all from the
firmware:

| What | TX802 | Evidence |
|---|---|---|
| ACED bytes 39-48 (foot control 2, MIDI IN control, unison detune, FC1 as CS1) | not used: sent as 0, ignored when received | sender A915 (39 bytes, then ten zeros), receiver A12E (stores bytes 1-39 only); VOICE EDIT(II) MENU "mode bend rpch prta wheel foot brth aftr" has no FC2 / MIDI IN page |
| Pitch bend mode (ACED 18) | none (maximum 0) | ACED maximum table, data ROM 0D34 |
| Key mode (ACED 15) | poly / mono (bit 0) | F2B3: "polymono" at F2D5 |

The editor shows those as read-only (kept for DX7II voices).

### 64 voices, program changes and the slot list

The TX802 keeps 64 internal voices in two blocks (VMEM at 6000h and 7000h of its voice RAM page).
System byte 2, "Voice data receive block" (SYSTEM4, RAM 565Fh, also parameter change `19 4D`, A779),
names the block for both directions: a received 32-voice bulk goes into it (receiver 9F77 / 9F94 adds
10h to the page) and a request for the voices (format 9) or their AMEM (format 6) is answered from
it (request handler ABF3 copies 565Fh into RAM FBh; senders A9AB 6000h / 7000h, A974 39E6h / 3D26h).
UTIL1 "Transmit 1-32 voice data" / "Transmit 33-64 voice data" set FBh themselves (A81C).

Program change (J99E6): on the "Perform select channel" (system byte 0; 17 = all) it selects a
performance (with the assign table, 56E4h). Otherwise, with "Program change" receive (byte 3) at norm,
it reaches every TG that starts a group on the message's channel (the channel map 3888h, built by CCCA;
omni TGs on every channel); at "G n" a program change on channel n reaches every group (mask 5987h).
Each TG keeps the bank of its voice (I, C, A, B: bits 7-6 of the performance's voice byte, FECF) and
takes voice (program AND 3Fh) + 1 of it (9A42): programs 0-63 select voices 1-64, 64-127 the same again.
So a program change cannot move a TG to another bank; the voice parameter of the performance
(`1A 10+t hi lo`) can.

The editor's Voices slot list (voice page): INTERNAL I01-I32 and I33-I64 (Get / Read names switch the
receive block to the block, request the AMEM and the voices, and set it back; Store sends the AMEM and
voices with the same switch around them), CARTRIDGE C01-C64, PRESET A01-A64 and B01-B64 (the data
ROM's banks). Play sets the voice of each group on the editor's channel through the performance
(exact bank) when the performance was read; otherwise it sends the program change, and the TG keeps its
bank. Edit and Read names of any bank put the voice into one TG (the first group on the editor's
channel, else TG1) with that voice parameter and read the TG's voice back (the parameter change makes
it the TG being edited, A6F4; the voice requests answer that TG through D614, A93C / A915), so that TG's
voice in the performance edit buffer is replaced. A 32-voice bulk the TX802 sends by itself (UTIL1) is
taken as the block the receive block names (the menu's choice is not in the message).

## Performance ("LM  8952PE", 116 bytes)

Eight tone generators (TG1-8) of two notes each: the parameter is stored for TG1-8 one after the
other (byte = parameter x 8 + TG), then the 20-character name. The parameter-change receiver
(A6E2) takes the same numbering; the edit pages are E849-EB40; maxima table 8F6E; INIT data ROM
0E00h (UTIL5 "Initialize perf. edit buffer": the same twelve values for every TG and "Init perf").

| Bytes | Parameter | Range | Screen |
|---|---|---|---|
| 0-7 | TG link: the number of the TG whose group this TG is in (its own: it starts a group) | 0-7 | the play screen shows a voice only for each group's first TG (E180); rule 8DED: a TG starts a group or joins the group before it |
| 8-15 | Receive channel | 0-15 = 1-16, 16 = omni ("om") | PERF.EDIT1 "Receive channel (►Altr asgn)" |
| 16-23 | Voice | bits 7-6 I, C, A, B; bits 5-0 voice 1-64 | "ICAB" (FECF) |
| 24-31 | Detune | 0-14 = -7..+7 | PERF.EDIT7 "Performance detune" |
| 32-39 | Volume | 0-99 | "vol" page (numbers and bars, E8FD) |
| 40-47 | Output assign | off, I, II, I+II | PERF.EDIT3 "Output assign" (E8F1) |
| 48-55 | Note limit low | C-2..G8 (data ROM 2400h) | PERF.EDIT4 "Note limit low" ("alt" in alternate assign) |
| 56-63 | Note limit high | C-2..G8 | PERF.EDIT4 "Note limit high" |
| 64-71 | Note shift | 0-48 = -24..+24 | PERF.EDIT5 "Midi note shift" |
| 72-79 | EG forced damp | off / on | PERF.EDIT1 "EG forced damp" |
| 80-87 | Alternate assign | off / on | the "►" mark of "Altr asgn" on PERF.EDIT1 and the play screen |
| 88-95 | Micro tuning | see below | PERF.EDIT6 "Micro tuning" |
| 96-115 | Name | 20 characters | PERF.EDIT8 "Performance name" |

Micro tuning value (EA6E-EB40): high nibble = table, named from data ROM 1F00h ("Equal tmpr",
"Pure/major", "Pure/minor", "Mean tone", "Pythagorean", "Werckmeistr", "Kirnberger",
"Vallotti&Y", "1/4 shift", "1/4 tone", "1/8 tone"), low nibble = the key of the pure, mean tone and
Pythagorean tables (major key names data ROM 1090h "C Db D ... B", minor 10A8h "A A# B ... G#");
B0h-B1h the internal tables 1-2; C0h-FEh the cartridge's 1-63 (maximum FEh).

Links: a link change sent as a parameter change toggles whether the TG starts a group (the value
byte is ignored, AD83/B3DF), then the TX802 applies rule 8DED, so the TGs after it follow. The
editor offers each TG "starts a group" or "joins TG n" and applies the same rule. Only the group's
first TG plays its voice on its channel (channel map CCCA, note count CC89: two notes per TG);
alternate assign rejects note limit changes (A73D) and the TX802 shows "alt" for them.

### Messages

| Message | Bytes |
|---|---|
| Edit buffer | `F0 43 0n 7E 01 68 "LM  8952PE" <232> cs F7`: the 116 bytes as ASCII hex, two characters "0"-"9" "A"-"F" a byte, high digit first (D70E; decoder D652). The count is the data only (0168h = 232), unlike the other 7Eh dumps whose count includes the header; the checksum covers header and data (A9DD, 9FA4). |
| Memories | 64 messages `F0 43 0n 7E 01 28 "LM  8952PM" <168> cs F7`, performances 1-64 in order, each the 84-byte packed form as ASCII hex (AA0B). |
| Parameter | `F0 43 1n 1A pp vv F7`, pp = byte number (0-73h). Voice and micro tuning (pp 10h-17h, 58h-5Fh) carry two data bytes `hi lo` (hi = bit 7) (A6E2, A35C). |
| Requests | `F0 43 2n 7E "LM  8952PE" F7` / `"LM  8952PM"` / `"LM  8952S "`. |

Packed memory (84 bytes, pack C84F, unpack C921): 0-7 link << 5 | receive channel, 8-15 voice,
16-23 micro tuning, 24-31 volume, 32-39 detune << 3 | alternate assign << 2 | output, 40-47 note
limit low, 48-55 note limit high, 56-63 EG forced damp << 6 | note shift, 64-83 name.

The editor: the Performance page (one section per TG), the MIDI channels page (link, voice,
channel, volume, note limits, note shift, output per TG; a TG plays when it starts a group),
Branch Library (edit buffer and the 64 memories, unpacked), translator (exact TX802 to TX802; from
other performances: the eight TGs shared out between the parts).

## System setup ("LM  8952S ", 263 bytes)

An edited object (System page). RAM 565Dh (internal memory protect, 565Ch, is not in it);
receiver 9FD6 (count 0211h with the header), sender AA58. The SYSTEM SETUP MENU pages (data ROM
11C8h "midi ctrl pfrm syex bank mted mtun prtct") are shown by table E1FD and edited through BDCA,
whose byte index lists (BE0C, BEA8, BEB8, BF42) point into the maxima 8F8B; INIT DBC2, with the
control number table 8E06 and the program table 8E27 (UTIL6).

| Bytes | Page | Values |
|---|---|---|
| 0 | SYSTEM3 Perform select channel | off, 1-16, all (FB1C) |
| 1 | SYSTEM4 System exclusive device number | off, 1-16, all |
| 2 | SYSTEM4 Voice data receive block | 1-32, 33-64 (also parameter change 19h 4Dh, A779); also the block a voice or AMEM request is answered from (ABF3) |
| 3, 4, 5, 12 | SYSTEM1 Midi message receive switch: Program change, After touch, Pitch bend, Control change | off, norm, G1-G16 (E25D) |
| 6 | SYSTEM1 Note on/off | all, odd, even |
| 7 | SYSTEM3 Perform select assign table | off, on |
| 8-10 | SYSTEM5 Cartridge bank select: TX802, Frac.scaling, M.tuning | 1-16 |
| 11 | SYSTEM7 Master tuning | 64 = centre (parameter change 04h 40h, A4FB) |
| 13-134 | SYSTEM2 Control number assign, controls 0-121 | off, Mod. wheel, Breath control, Foot control, Portamento time, Volume, Sustain switch, Portamento sw (data ROM 1000h), stored as their usual numbers 0, 1, 2, 4, 5, 7, 64, 65 (BE98) |
| 135-262 | SYSTEM3 Perform select number assign, programs 1-128 | INT01-64, CRT01-64 |

The TX802 takes no other system parameter change (group 19h only 4Dh; 1Bh the panel switches
41h-60h, 40h a reset), so the editor sends the whole setup for any other change.

## Micro tuning and fractional scaling (per TG)

Both are edited objects (the DX7II's, `yamaha-dx7ii-data.js`, with a TG choice). The TX802 keeps them
per tone generator and applies dumps, requests and key changes to the TG being edited (RAM 596Bh),
which any performance parameter change for a TG selects (A6F4: TG = pp & 7):

| What | TX802 | Evidence |
|---|---|---|
| Micro tuning "LM  MCRYE " (256 bytes: 128 keys, hi / lo of the 14-bit value as on the DX7II) | the TG's table, RAM 3000h + TG x 100h (kept as value x 4 inside) | sender AB04, receiver A039, key change `18 7E kk hh ll` A7AB |
| Internal tables "LM  MCRYM" 00h / 01h | RAM 5764h + n x 100h, shared | sender AB43, receiver A050 |
| Fractional scaling "LM  FKSYE " (246 bytes as two characters 30h + nibble) | the TG's voice buffer 2000h + TG x 200h, from offset FEh | sender A8E2 (SADE0), change `18 7F` A7BB |

The pages choose a TG: with the performance read from the TX802 they first send that TG's receive
channel again (unchanged, `1A 08+t ch`) so the TX802 edits it; without it, they address the TG the
TX802 is editing. The Equal temperament action writes the DX7II's table (its 1/1024-octave steps,
DX7II 84C0); the TX802's own preset tables were not found in its program or data ROM in that form.

## AMEM

The TX802 handles the DX7II's 32-voice additional data (format 6, 32 x 35 bytes): it sends each
voice's 26 bytes (ACED 0-38) from RAM 39E6h (block 1-32) or 3D26h (33-64) followed by nine zeros
(A974), keeps bytes 1-26 of each 35 when receiving (9F40, A195), answers its request (AC0B) and sends
it before the 32 voices (A961). The editor's bank reads and writes it as on the DX7II.

Also open: selecting a performance memory from the editor (the TX802 selects them with program
changes on its "Perform select channel"); the cartridge tables ("LM  MCRYC", "LM  FKSYC") are read
by the Branch Library only.
