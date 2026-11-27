# Firmware downloads

Helpers used since 2026-11-25 to fetch official firmware into `z:\firmwares\<Maker>\<Model>\`
(see `z:\firmwares\DOWNLOADS.md` and each maker folder's `MANIFEST.md`).

| File | What |
|---|---|
| `queue.mjs` | **Unattended download queue** (below): works through `queue.jsonl` with the same checks as `fw.mjs get`, resumable, then rewrites manifests, rules and docs and writes `queue_report.md`. |
| `fw.mjs` | `get` downloads one file into its own temp folder (system temp, never the repo), checks it (HTTP status, size, type, zip listing), hashes it and copies it into the collection without overwriting; `note` records a device checked without a download; `manifest` rewrites the maker manifests and `DOWNLOADS.md` (a `MANIFEST.md` it did not write is left alone). Usage in its header. Its functions are exported for `queue.mjs`. |
| `dl_log.jsonl`, `dl_notes.jsonl` | Every download and every "checked, no download" note. Keep them: `gen_rules.mjs` needs the log. A note with status `have` for the same maker + model replaces an earlier `none`/`skipped` note in the manifests. |
| `FW_UA`, `FW_MAX_GB` | Environment overrides for `fw.mjs`: the User-Agent (some servers refuse the default Chrome string; `FW_UA=Mozilla/5.0` works there) and the size limit in GB (default 2). |
| `gen_rules.mjs` | Rebuilds the generated `NEW_DEVICES` and `RULES` blocks in `tools/firmware_checklist.mjs` from `dl_log.jsonl` (and `also.json`). **Do not run it without the log**: it would empty both blocks. |
| `also.json` | Folders that serve several devices: `"<Maker dir>/<folder>": ["Model", ...]`; an entry may name another maker's device as `"Maker:Model"`. Retrofit-kit folders (third-party kits that add MIDI, e.g. `Tubbutec/uniPulse`) are written `{ "factory": false, "devices": [...] }`: for the host devices (TR-808, ...) their files are kit firmware, not factory firmware, so `midi_devices_report.mjs --match` gives such a host `kitInCollection` instead of `inCollection` and keeps it in `docs/FIRMWARE_WANTED.md` until its own ROM is found (a device whose only firmware is the kit's, such as the CPU-less Korg Mono/Poly, still counts). |
| `jsonfix.mjs` | Applies corrections (e.g. wrong `officialDownload` flags) to `tools/firmware/midi_devices.json` from a small JSON list, saving it in the report script's format. |
| `roland.mjs`, `korg.mjs`, `yamaha.mjs`, `waldorf.mjs`, `probe.mjs`, `*.sh` | Per-maker listers used to find the download links. |
| `roland_region.mjs`, `yamaha_region.mjs`, `eventide.mjs` | Listers added 2026-11-26: Roland/Boss regional support sites (`roland.com/us` keeps old system updates the global site dropped; files on `static.roland.com/assets/media/zip/`), Yamaha's regional download search (publication ids: US 152, JP 143, UK 117, EU 113, DE 118; JP has old OS updaters), Eventide download pages (each redirects to the file). |
| `links.mjs`, `anchors.mjs` | `node links.mjs <url> [regex]` lists a page's links matching a regex (default: firmware-like files); `node anchors.mjs <url> <href-regex>` shows each matching link with its text and the text before it (to tell which file is which). |
| `cdx.mjs` | `node cdx.mjs <site/prefix/> [regex]`: files the Wayback Machine archived under a URL prefix (newest capture each, with `id_` download URLs), for makers' own files that are gone from their sites. Query one site at a time: parallel queries get "Temporarily Offline". |
| `iafiles.mjs`, `iamatch.mjs`, `iamodels.mjs` | archive.org: original files of items (`iafiles.mjs <id> ...`), files of an item that name a device still missing in `midi_devices.json` (`iamatch.mjs <id>`), and a title search for the missing models (`iamodels.mjs [maker-regex]`). Check every match by hand: substrings give false hits (R-880 vs DR-880, microWave vs Wave). |
| `checkbatch.mjs` | `node checkbatch.mjs <batch.jsonl> [--append]`: checks a batch of queue lines (JSON, maker/model known to `midi_devices.json`) and appends it to `queue.jsonl`. |
| `*_b*.txt` | The batches of `fw.mjs get` lines run per maker before the queue existed. |
| `rm_nomidi.mjs` | Removed the devices without MIDI from `tools/firmware/midi_devices.json`. |

After adding firmware by hand: `node tools/firmware_checklist.mjs`, then `node tools/firmware/midi_devices_report.mjs --match`
(the queue does both itself).

## The queue (`queue.mjs`)

Add jobs to `queue.jsonl` (one JSON object per line; blank lines and lines starting with `#` are ignored), then start the
runner in the background and leave it:

```
node tools/firmware/download/queue.mjs            # run (logs to queue.log; safe to start again at any time)
node tools/firmware/download/queue.mjs --status   # progress: counts, current file, failures (works while it runs)
node tools/firmware/download/queue.mjs --dry-run  # what a run would do now, without network or writes
node tools/firmware/download/queue.mjs --stop     # stop after the current file (then it still post-processes)
node tools/firmware/download/queue.mjs --post     # only rewrite manifests, rules, checklist, wanted list and the report
```

Job lines:

```
{"maker":"Erica Synths","model":"LXR-02","version":"1.6.1","url":"https://...","name":"file.img","folder":"sub","note":"text for the manifest","source":"archive the file came from","ua":"Mozilla/5.0","htmlOk":false,"big":false}
{"note":{"maker":"Pearl","model":"Mimic Pro","status":"none","why":"pearldrum.com refuses scripts (403)"}}
```

`maker`, `model` and `url` are required; `version` should be given. `name` overrides the file name, `folder` the model
folder, `ua` the User-Agent for that job, `htmlOk` accepts an HTML/XML file, `big: true` lifts the per-file size limit,
`source` (for files from archives such as archive.org) is shown in the manifest's source column, `haveNote` records a
note with status `have` once the file is in the collection (it replaces an earlier `none` note for that device). A note job writes
`dl_notes.jsonl` like `fw.mjs note` (status `none`, `skipped` or `have`); an identical note is not written twice.

How it runs:
- One download at a time, with a pause of `--delay` seconds (default 5) between requests to the same host; timeouts
  (60 s for the response, 120 s without data).
- Every file gets the `fw.mjs get` treatment: own temp folder, HTTP/size/type/zip checks, SHA-256, compared with the
  collection (same file anywhere in `z:\firmwares` = "already in the collection"), copied without overwriting, logged
  to `dl_log.jsonl`. A job whose URL is already in the log (and whose file is still there) is skipped without fetching
  (`--recheck` fetches anyway, the hash comparison then finds it).
- Files over 2 GB (`--max-gb`) are skipped unless the job says `"big": true`. The run stops once it has downloaded more
  than `--budget` GB (default 50), or when z: or the temp drive would drop below `--reserve` GB free (default 20);
  free space is checked before each file and again once its size is known.
- State per job (keyed by its content) is kept in `queue_state.json`: a restart skips finished jobs and retries failed
  ones. Failures are retried up to `--retries` times (default 3) after 2, 10, 30 minutes (or the server's Retry-After);
  HTTP 4xx errors (other than 408/429) and "got HTML instead of a file" fail at once. `--retry-failed` gives failed jobs
  a new set of attempts. Lines added while it runs are picked up (it re-reads the file before each job); `--linger <min>`
  keeps it waiting for new lines when the queue is empty.
- When the queue is done or stopped it rewrites all manifests and `DOWNLOADS.md`, runs `gen_rules.mjs` (only when the
  log exists), `node tools/firmware_checklist.mjs` and `node tools/firmware/midi_devices_report.mjs --match`, and writes
  `queue_report.md`: downloaded, failed (with reasons), skipped, already present, notes, still queued, the totals, and
  the "not identified" / "not matched" counts of the checklist and the device list.
- `queue.lock` holds the pid of the running runner (a second start refuses; a stale lock is taken over); `queue.stop` is
  the stop request.
