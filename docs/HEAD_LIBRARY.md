# Main Library

One place for the patches of every device. Each patch is a readable JSON file with the device it
came from, the device's type, a sound category and every setting by name. Sub-libraries live in a
folder the user picks, open in any device's Librarian, and a patch loads into another model when a
translator exists. Today that means JP-8080 ↔ JP-8000; other devices store and load their own patches
exactly.

| Where | What |
|---|---|
| `js/core/mainlib/format.js` | Patch and sub-library files, base64, index rows |
| `js/core/mainlib/store.js` | `MainLibrary`: folder, cache, sub-libraries (create, edit, merge, remove), patches, samples |
| `js/core/mainlib/dedup.js` | Duplicate search (by name, or deep by settings) and removal |
| `js/core/mainlib/importers.js` | Files → patches (`importFiles`, `importSysex`) |
| `js/core/mainlib/categories.js` | The 38 Roland categories and the name rules |
| `js/core/mainlib/devicetypes.js` | Device types (Synthesizer, Rompler, Sampler...) |
| `js/core/mainlib/common.js` | The shared synth model (documentation and unit helpers) |
| `js/core/midi/smf.js` | SysEx from Standard MIDI Files; `sysexMessages` (any file); `repairSmfLengths` |
| `js/core/disk/zip.js` | ZIP archives (stored and deflated entries) |
| `js/devices/patches.js` | Device objects ↔ patches (`patchFromObject`, `objectFromPatch`, `loadMode`) |
| `js/devices/defs/roland-jp-common.js` | JP translator, JP-8000/8080 detection, WinJPLib `.pat`/`.pfm` reader |
| `js/devices/defs/roland-vsynthxt-translate.js` | V-Synth XT translator (zone 1 ↔ shared model) |
| `js/devices/kurzweil-k2000/disk/mainlib.js` | K2000 programs with keymaps and samples ↔ patches |
| `js/core/ui/mainlib.js` | UI pieces shared by the page and the Librarian panel |
| `js/shell/mainlibrary.js` | The Main Library page (`#/library`) |
| `js/devices/generic/views/mainlib-panel.js` | The Main Library panel of every device's Librarian |

## Patch file (`midimaster-patch`, version 1)

`patches/<id>.json`:

```json
{
  "format": "midimaster-patch", "version": 1, "id": "…", "name": "BA ActuallySkrlx", "kind": "patch",
  "device": { "id": "roland-jp8000", "maker": "Roland", "model": "JP-8000", "types": ["Synthesizer", "Virtual analog"] },
  "category": { "id": "synth-bass", "label": "Synth Bass", "source": "name-prefix" },
  "tags": [], "notes": "",
  "source": { "file": "Alan_M_JP80x0_v1.0.pat", "slot": "User patch A11", "imported": "2026-11-23T…" },
  "settings": { "LFO1": { "LFO1 waveform": "TRI" }, "OSC1": { "OSC1 waveform": "SUPER SAW" } },
  "params": { "PATCH_10": 0, "PATCH_1e": 0 },
  "native": { "object": "patch", "bytes": "<base64>" },
  "common": { "model": "common", "version": 1, "…": "…", "extra": { "family": "roland-jp", "…": "…" } },
  "samples": [],
  "links": [{ "role": "Upper", "id": "…", "name": "…", "kind": "patch" }]
}
```

| Field | Meaning |
|---|---|
| `kind` | The device object's key (`patch`, `performance`, `program`, `system`...). `data` = stored SysEx no object reads (motions, all-data dumps, unmapped devices); `sample` = audio only. |
| `settings` | Group → label → the value as the device shows it (`formatParam`). For people; nothing reads it back. |
| `params` | Raw value of every parameter, by key. |
| `native` | The exact data: `{object, bytes}` (an editor object), `{object: null, syx}` (stored SysEx), `{object: 'krz', objects: [{type, id, name, data}]}` (Kurzweil objects). Same model → bit-exact restore. |
| `common` | The shared synth model, only for objects with a translator (`obj.toCommon`). |
| `samples` | `[{id, file, name, rate, soundblock?, words?}]`; the audio is `samples/<id>.wav`, its info `samples/<id>.json`. |
| `links` | Patches carried inside this one, kept as patches of their own (the two patches inside a JP performance): `{role, id, name, kind, sub?}`; `sub` only when the patch is in another sub-library (after a duplicate was removed). |

Category `source`: `device` (the device's own category, e.g. the JV-2080 Category parameter),
`name-prefix` (`BA `, `PD:`, `SQ-`...), `name-word` (Bass, Pad, Lead...), `performance` (a part patch
took its performance's category), `manual`, or `none`.

## Folder layout

```
<Main Library>/mainlibrary.json             {format: "midimaster-library", version, sublibraries: [{id, name, path} | {id, name, external, folder}]}
<Main Library>/<sub-library>/sublibrary.json {format: "midimaster-sublibrary", version, id, name, created, notes, device, devices, patches: [index rows]}
<Main Library>/<sub-library>/patches/<id>.json
<Main Library>/<sub-library>/samples/<id>.wav + <id>.json
```

An index row is `{id, name, kind, device, model, types, category, tags, samples, native, hasCommon, links}`,
enough to list, filter and badge patches without reading every file.

**A sub-library's device** (`device: {id, maker, model}`, also kept in `mainlibrary.json`) says which
instrument it holds sounds for. It is set when the sub-library is made from a device's Librarian
(or the K2000 Library), when an import names the device, or when everything imported came from one
device; it can be changed with **Edit**. `devices` lists the models its patches actually come from.

**Storage.** The folder is the library's home (File System Access API; the handle is kept in
IndexedDB, store `mainlib` of DB `midimaster` v2). An IndexedDB cache mirrors the JSON so the library
opens before the browser grants the folder again; writes made while the folder is unreachable are
kept as pending and written on Reconnect. Before a folder is chosen, everything lives in the cache.
Sample audio is cached only while pending.

- **Change location:** *Move* copies every sub-library to the new folder (the old one is left as
  it is); *Open* switches to the library already in that folder.
- **Register a folder:** a sub-library folder from elsewhere (it keeps its own handle).
- **Merge:** tick two or more sub-libraries; their patches and samples move into the one chosen,
  and the others are removed (an internal one's folder is deleted, an external one is unregistered).
- **Search and sort:** the sub-library list has the patch filters (name, device, type, category,
  kind): it then lists only the sub-libraries with matching patches and their match counts, and a
  click opens the matches. Sort by name, device, patch count, matches, newest or oldest.
- **Unregister:** removes a sub-library from `mainlibrary.json` and the cache; its files stay on
  disk. A sub-library that exists only in the browser (no folder chosen yet) is deleted, and the
  page says so.

## Importing

`importFiles(files, {onProgress, hint})` → `{patches, samples, report}`.

| Files | How |
|---|---|
| `.syx`, `.j8k` | `splitSysex`, then `importSysex` |
| `.zip` | Every importable file inside (also images, and archives one level deep); `__MACOSX` and `._` files skipped |
| `.mid`, `.midi` | SysEx events of the SMF (`smf.js`), then `importSysex` |
| `.pat`, `.pfm` | JP-8000 WinJPLib files, through the JP-8000 definition's `readFile` |
| `.krz`, `.k25`, `.k26` | Programs with their keymaps and soundblocks; RAM audio becomes WAV |
| `.wav` | A sample |
| `.json` | Main Library patch files (one or an array) |
| `.iso`, `.img`, `.bin` (+`.cue`) | Every importable file inside the image |

`importSysex` leaves out request messages (identity requests and each definition's `isRequest`,
e.g. RQ1 echoed by MIDI thru), lets each definition claim messages (`recognise`), gives messages
claimed by several definitions to the best `prefer` score (JP-8000 and JP-8080 share model ID
00 06; the layout decides), splits them into objects (`libraryItems` + `fromSyx`) and keeps the
rest as `data` patches. SysEx no definition reads is kept, grouped by manufacturer, with the
catalog's candidate models in `notes`.

Also:

- **Messages cut out of a MIDI file as raw SysEx** (older Librarian entries stored whole `.mid`
  files) carry each event's length after F0, where the maker ID belongs: a 19-byte message reads as
  maker 13h (Digidesign), a 48-byte one as 30h (Dynacord). `repairSmfLengths` removes those lengths
  when every message has one that matches its size and the definitions then read more messages.
  Every place that reads a file now uses `sysexMessages` (MIDI file or raw SysEx).
- **Damaged messages** of a known device (checksum errors, cut short in the file) are recognised by
  `def.isOwn` and kept as that device's `data`, named "Damaged <model> messages".
- **The device a dump came from** (`opts.device`: the Librarian's device, or the import's "from"
  choice) is also the hint, and SysEx of its maker that no editor reads is kept as its data instead
  of an unknown device's.

The import report lists, per file and device, what was read and what was skipped and why.

## Duplicates

**Find duplicates...** on the Main Library page (`dedup.js`), in one sub-library or all:

| Match | How |
|---|---|
| Same name | Case and spacing ignored, same kind (and device, unless unticked). Each group is also compared by settings: groups whose sounds differ are marked and left unticked. |
| Same settings (deep scan) | Same device: every parameter except the name bytes (found by testing which bytes change `obj.name()`); stored SysEx, Kurzweil objects and sample audio by their bytes. Any model: the translator's `common.extra.match` (what the family's models share), else the shared model without `extra`. |

The first imported copy is kept (or the chosen model's, for any-model groups); every group's kept
patch can be changed before deleting. Performances whose `links` pointed at a deleted patch are
pointed at the kept one.

## Loading into a device

`loadMode(entry, def, obj, patch)`:

- `native`: same device (or one in `def.deviceIds`, e.g. M1 and M1R) and the patch has `native.bytes`;
  the data is restored exactly.
- `translate`: the patch has `common` and the object has `fromCommon`. The result comes with a
  report: `{mapped, approximated, dropped}`.
- `null`: no translator yet (the panel shows "no translator").

The Librarian panel shows every sub-library's patches with that badge. **Load** puts the patch in
the editor page (nothing is sent; a lossy translation asks first and shows the report), **Store
to...** writes it into a memory slot (`obj.slots.store`), **Send** sends a `data` patch's SysEx.
**Add editor data...** and a dump's **Add to Main Library** go the other way.

The K2000 uses its own pages: **Library → Add to Main Library** reads programs with the RAM keymaps
and soundblocks they use (ROM objects are only referenced) and, if chosen, the RAM audio by Sample
Dump. **Load from Main Library...** rebuilds a Kurzweil file in memory (`krzFromPatches`: the
objects plus a sparse sample area made of the WAVs, placed at each sample's `words`) and opens it on
the Disk Import page, which assigns IDs and sends objects and audio as for a file from disk.

## Definition hooks

All optional. A definition without them still gets native import and export through `libraryItems`
and the objects' `fromSyx`.

| Hook | Used for |
|---|---|
| `def.recognise(raw)` | This definition reads the message (Main Library import) |
| `def.isOwn(raw)` | The message is this device's, readable or not (damaged messages are kept as its data) |
| `def.isRequest(raw)` | The message is a request, not data (left out of imports) |
| `def.prefer(msgs)` | How well a set of messages fits this model when several definitions claim it |
| `def.deviceIds` | Catalog ids sharing this definition's native format (load natively) |
| `def.libraryParts(item)` | Objects carried inside an item: `[{role, object, msgs}]`, imported as linked patches |
| `def.readFile(name, bytes)` | A file format of the device's own: `[{object, data, label, parts}]` or null |
| `obj.category(data)` | The device's own category for the data (a `categories.js` id) |
| `obj.toCommon(data)` | Data → shared model |
| `obj.fromCommon(common, base)` | Shared model → `{data, report}` |
| `obj.patchKinds` | Patch kinds the object accepts (default `[obj.key]`) |
| `obj.setName(data, name)` | Write a name: a translated patch keeps the Main Library patch's name |
| `obj.setCategory(data, id)` | Write the device's nearest category for a Main Library category id |
| `common.extra.match` | Set by a translator: equal for the same sound on every model of its family (duplicate search) |

## Every device needs a translator

Moving sounds between instruments is the point of the Main Library, so **every new device
definition comes with `obj.toCommon` / `obj.fromCommon` for each object that holds a sound**
(patch, program, performance, combination, rhythm set...; device settings such as `system`,
`global` or `master` are exempt). The test "Every device definition translates its sounds" in
`tests/mainlib.test.js` fails for a definition without one. Its `BACKLOG` lists the definitions
made before this rule (Matrix-1000, JV-2080, M1/M1R); take an entry off once its translator exists,
and never add one. The K2000 (its own module, not a definition) is on the same backlog in
`docs/FUTURE_WORK.md`.

## The shared synth model

`common.js` documents it. Continuous amounts are 0..1 (`unit`) or -1..1 (`bipolar`); pitches in
semitones and cents; times as the device's own 0..1 curve until a device with real times needs
more. Sections: `voice`, `osc` (array), `mix`, `pitch`, `filter`, `amp` (each with its envelope),
`lfo` (array), `tone`, `effects`, `velocity`, `controller`, and `extra` (a family's exact data).
Waves are named (`saw`, `supersaw`, `noise`...) or `rom:<name>` / `sample:<id>` for sample-based
instruments.

**Same family, exact:** `extra` carries the family's own fields (the JP family keeps the whole
patch), so JP-8080 → JP-8000 → JP-8080 returns identical bytes for everything both models have.
**Other families:** only the semantic sections are used. A new translator:

1. `toCommon`: fill the semantic sections; put anything exact in `extra` with your `family` name.
2. `fromCommon`: if `common.extra.family` is yours, copy what fits; otherwise map the semantic
   sections. List every value that was approximated or dropped in the report.
3. Add a round-trip test like "JP-8080 <-> JP-8000 through the shared model" in
   `tests/mainlib.test.js`.

## Tests

- `tests/mainlib.test.js`: categories, device types, base64, SMF and its repair, the store (cache,
  folder, permission lapse, move, register, unregister, a sub-library's device, merge), imports
  (complete dumps, JV, JP-8000 vs JP-8080, unmapped and damaged SysEx, the device a dump came from,
  ZIP, KRZ audio exact to the sample, `.pat`/`.pfm`/`.j8k`), JP translation, duplicates (name,
  settings, any model, links), and the translator rule.
- `tests/mainlib-ui.test.js`: the page and the Librarian panel on a small fake DOM
  (`tests/helpers/fakedom.js`): list, open, edit, filter, bulk delete, import by drop, merge,
  find and delete duplicates, translated load, store to slot, add a dump (and its new sub-library's
  device), and the Librarian showing an entry stored as a whole MIDI file.
- `tests/disk.test.js`: K2000 programs with samples → library → import job on the mock K2000 →
  read back.

Files under `D:/midi` and `re/jp8080/live` are used when present and skipped otherwise.
