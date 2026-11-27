# Yamaha TX816 (TF1 modules)

Definition: `js/devices/defs/yamaha-tx816.js`. **Not yet checked on a TX816.**

The TX816 is a rack of eight TF1 modules; each is a DX7 tone generator with its own MIDI IN / OUT /
THRU, its receive channel (panel MIDI CH, or omni) and 32 voices. The editor reaches a module by
its channel: the Voice and Function data pages work on the channel in the top bar, the Modules page
and its MIDI channels page send each module's settings on that module's channel.

Source (read only, never run): TF1 firmware `z:/firmwares/Yamaha_TF1_iN0104-2.zip` (HD6303, 16 KB
at C000h); listing `re/dx/tf1.lst` (`python -I tools/yamaha/hd6303_dis.py ROM C000 OUT --auto`),
strings `re/dx/tf1_strings.txt`. (The other archive, `Yamaha TF1 TX816 (MBM27128-25) CA00H.rar`, is
not unpacked.) The TF1 has only a two-digit LED display (F9B7 drives it), so the voice labels are the
DX7's (`yamaha-dx7.md`) and the function data's the DX5's (`yamaha-dx5.md`).

## Messages (SysEx receiver CFC0)

| What | Message | Firmware |
|---|---|---|
| Voice | format 0 (155 bytes) at 52F3; request answered | D0C2, sender D238 |
| Function data | format 1 (94 bytes) at 538F; request answered | D0DE, sender D280 |
| Function memories | format 2 (4096 bytes; 32 x 16 packed at 5080) | D0F7, sender D347 |
| 32 voices | format 9 (4096 bytes) at 4000; refused while memory protect is on | D0FF, sender D2F0 |
| Status | request `F0 43 2n 7D F7` answers `F0 43 00 7D 00 10 "LM  8950  " 01 01 ff cc xx 00 cs F7`: ff = 0Ah + 10h omni + 20h memory protect, cc = channel | D49F |
| Group 1 | 1 = MIDI channel (1-16, the module moves to it), 2-16 and 26 the function data bytes (maxima EB69), 64 = master tune (53FB, 64 = 0; the DX7 function number) | EA8E |
| Group 4 (+128) | 5 / 6 key limit low / high, 7 memory protect (0 off, 7Fh on), 8 = 7Fh initialise ("TF1 INITIALIZED") | ED7C |
| Program change | voice 1-32, which also recalls the voice's function memory | CD9A |

## Function data

The DX1/DX5 performance format (`yamaha-dx-fn94.js`, names from the DX5 firmware). The TF1 reads
channel A's bytes 2-16 and 26 (group 1 numbers; maxima EB69), takes channel B instead when byte 61
(single-mode channel) is B (D1A8), and keeps its key limits in the name: it sends
`"NN VOICENAME  Lo:C -2 Hi:G 8 "` (D826: voice number, the voice's name, the limits as note and
octave texts D8BD / D8D5) and reads the limits back from those characters (D980; no text: 0 and 127).
The rest it sends as constants and never reads (D7F0: byte 1 = 0, 8 = 1, 17-25 = 0 ... 99 99,
27-29 = 0 1 24, 60-63 = 0 0 0 39; channel B = channel A): those show read-only. The key limit fields
edit the name text and send group 4 numbers 5-6.

## Modules page

One section per module: MIDI channel (a change is sent on the module's old channel as group 1
number 1), voice (program change), key limits (group 4, 5-6), master tune (group 1, 64),
attenuation (group 1, 26) and memory protect (group 4, 7; the user keeps it off). **Find modules**
asks channels 1-16 for the 7Dh status and fills the modules' channels in the order they answer (only
modules whose MIDI OUT reaches the computer can answer). The MIDI channels page shows the eight
modules with voice, channel, key limits, attenuation and master tune.

Translators: function data (exact TX816 to TX816; a TX7 / DX5 function data keeps its bytes and gets
the TF1 name text), Modules (eight parts: channel, voice, key limits, attenuation).

Function memories (format 2): the TF1 keeps each memory as the 16 bytes of one half of the packed
record (5080h) and sends 64 records, its 32 twice (D347: half B a copy of A, Por P&K on, Sus pdl on,
split 39, name "               Lo:     Hi:   "); on receipt it takes half A, or half B when the record
is in single mode on channel B (D151). Format 2 (4096 bytes) is 64 memories of 64 bytes in the DX5's packing (`yamaha-dx-fn94.js`
packFn94 / unpackFn94, from the DX5 v6 pack CB27 and unpack F999; the TX7 sender E32A/E396 and the
TF1 sender D347 build the same records): 0/16 voice bits 4-0 | half B 20h | Ply/Mon 40h, 1/17 PB stp
<< 4 | PB rng, 2/18 P time, 3/19 Source << 3 | Por P&K 4 | P mode 2 | PG sw 1, 4-7/20-23 the four
controllers (EAP << 4 | range), 8-13/24-29 the DX1 bytes 17-25, 14/30 Att | P out 8 | Sus pdl 10h |
Source 16 as 20h | voice cartridge bit 40h, 15/31 Key sft | PB stp bit 3 as 40h, 32 Key assign |
Single channel << 2 | Detune << 3, 33 Split, 34-63 the name. Unpacked as the DX5 does (voice A from
1-32, B from 33-64; PB rng shown 12 while a step is set). The Branch Library splits them into function
data items.
The Function data page's slot list (Function memories 1-32, one copy per module) reads them
(request format 2, D05C), Edits one and Stores by packing it into the editor's copy (both copies, the
voice bits set to the slot) and sending all 64 records (taken by D151 into 5080h + 16 x memory). Play
sends program change n, which recalls voice n with its function memory (CD9A).

Open: the module's omni switch (panel only) and its status byte 14 (5407h) are not named.

## Firmware references from the editor's former page texts

The page texts were rewritten in plain language (2026-11-27); these details they held are kept here.

- The channel the module listens on (its panel MIDI CH). A change is sent on the old channel as group 1 number 1 (EB44).
