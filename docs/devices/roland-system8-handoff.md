# Roland SYSTEM-8: work handoff

Running notes for the multi-phase SYSTEM-8 editor job. Update after every milestone.
Device documentation proper: [roland-system8.md](roland-system8.md).

## State of the unit (keep this current)

| When | What | Restore |
|---|---|---|
| 2026-11-26 | Phase 1: only reads (RQ1) and the PLUG-OUT info queries (`70 00 0x xx` DT1, answered with `71 ..`). **Nothing written.** | nothing to restore |

Unit as found (2026-11-26, read over `SYSTEM-8 CTRL`): OS 1.32 (engine interface `0x136E`), 4 slots, 8 x 8 = 64 patches
per slot:

| Slot | Plug-out | Model id | Version | Exact container on this PC |
|---|---|---|---|---|
| 0 | SYSTEM-8 | 5 | 1.20 | the 1.32 updater (`p1y01_p0m/p0s.bin`); Roland Cloud has 1.21 (`SYSTEM-8/Script/Code8_0.Dat`) |
| 1 | JUPITER-8 | 6 | 1.06 | factory preload in the 1.32 updater (`p1y01_pl1m.bin`); Roland Cloud has 1.08 |
| 2 | SH-101 | 1 | 1.07 | `C:\Program Files\Common Files\VST3\Roland\SH-101\Script\Code8_2.Dat` (identical version) |
| 3 | JUNO-106 | 7 | 1.07 | `C:\Program Files\Common Files\VST3\Roland\JUNO-106\Script\Code8_3.Dat` (identical version) |

Memory Protect: the SYSTEM-8 has no memory-protect setting (none in the manual's SYSTEM menu).

## Backup

`re/system8/backup/20261126-initial/` (gitignored), made by `tools/system8/backup.py` before anything was written:

* `info.json` - device type, counts, the four 48-byte slot records.
* `system.syx`, `edit.syx`, `perf.syx`, `slot0.syx` ... `slot3.syx` - every DT1 the unit sent, as received.
* `backup.json` - `{address: hex}` of every leaf; `all.syx` - everything in arrival order.

Restore: send the `.syx` files back to `SYSTEM-8 CTRL` (they are DT1 messages to the same addresses, the form the
plug-out software writes), one message at a time with ~5 ms gaps; then verify with `backup.py` into a new folder and
compare `backup.json` byte for byte (`tools/system8/compare_backup.py`, to be written in phase 2 with the restore
script). The PLUG-OUT firmware itself cannot be read back over MIDI (no read command exists in the protocol);
slots 2 and 3 can be reinstalled exactly from the Roland Cloud containers above.

## Done (phase 1)

* Firmware unpacked: `tools/system8/unpack_fw.py` (tar -> `p1y01_*.bin`; LZSS regions; checksums verified).
* Plug-out containers decoded: `tools/system8/codedat.py` (chained XOR, START/END/DATA records, 7-in-8 blocks,
  flash image, END sum, both regions + SYNINFO). All 11 Roland Cloud `Code8_*.Dat` on this PC verify.
* Patch layout from the Roland Cloud plugins' `Script.xml`: `tools/system8/script_layout.py` ->
  `re/system8/layout/<plugin>.json` (patch 640 B / 114 values, patch2 3975 B / 522, patch3 15580 B / 3524; the
  same layout for every plug-out, names and ranges differ).
* Live: port roles, address map scan (`tools/system8/scan_map.py`), complete backup (`tools/system8/backup.py`).

## Scripts (run with `python -I`, close the browser app first: Windows MIDI ports are exclusive)

| Script | What |
|---|---|
| `tools/system8/s8midi.py` | helpers: ports, RQ1/DT1 builders, parser |
| `tools/system8/probe_ports.py` | identity request + device-type query on both ports |
| `tools/system8/scan_map.py OUT.json` | read-only address map (RQ1 size 16 at every `b0 b1 00 00`) |
| `tools/system8/backup.py [OUTDIR]` | complete backup (about 8 minutes) |
| `tools/system8/unpack_fw.py SYSTEM8_UP.BIN OUTDIR` | unpack the system update |
| `tools/system8/codedat.py FILE.Dat [--image PREFIX]` | decode a PLUG-OUT container |
| `tools/system8/script_layout.py Script.xml OUT.json` | layout JSON from a plugin script |

## Open questions

* Performance (`04`, `10`-`17`, 12 leaves, 2709 bytes) and system (`01 50 00 00`, 336 bytes) structures are not in
  any plugin script: they must be decoded from the OS (parameter tables) or by live experiments.
* `03`/`05`/`06` temporary areas exist at `b1 = 00, 20, 30`: probably patch mode, upper, lower (to confirm).
* Display texts: the OS (`App1_Main`) is 3DES-encrypted; its plaintext can only be dumped from the unit with a
  region-0 hook (the SDK's `examples/midi_send/init_bulk.s`, needs a temporary custom plug-out in a slot).

## Next steps

See the plan at the end of [roland-system8.md](roland-system8.md) (to be written) and below.
