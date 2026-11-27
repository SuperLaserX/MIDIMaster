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
| `also.json` | Folders that serve several devices: `"<Maker dir>/<folder>": ["Model", ...]`; an entry may name another maker's device as `"Maker:Model"`. Retrofit-kit folders (third-party kits that add MIDI, e.g. `Tubbutec/uniPulse`) are written `{ "factory": false, "devices": [...] }`: for the host devices (TR-808, ...) their files are kit firmware, not factory firmware, so `midi_devices_report.mjs --match` gives such a host `kitInCollection` instead of `inCollection` and keeps it in `intdocs/FIRMWARE_WANTED.md` until its own ROM is found (a device whose only firmware is the kit's, such as the CPU-less Korg Mono/Poly, still counts). |
| `jsonfix.mjs` | Applies corrections (e.g. wrong `officialDownload` flags) to `tools/firmware/midi_devices.json` from a small JSON list, saving it in the report script's format. |
| `roland.mjs`, `korg.mjs`, `yamaha.mjs`, `waldorf.mjs`, `probe.mjs`, `*.sh` | Per-maker listers used to find the download links. |
| `roland_region.mjs`, `yamaha_region.mjs`, `eventide.mjs` | Listers added 2026-11-26: Roland/Boss regional support sites (`roland.com/us` keeps old system updates the global site dropped; files on `static.roland.com/assets/media/zip/`), Yamaha's regional download search (publication ids: US 152, JP 143, UK 117, EU 113, DE 118; JP has old OS updaters), Eventide download pages (each redirects to the file). |
| `links.mjs`, `anchors.mjs` | `node links.mjs <url> [regex]` lists a page's links matching a regex (default: firmware-like files); `node anchors.mjs <url> <href-regex>` shows each matching link with its text and the text before it (to tell which file is which). |
| `cdx.mjs` | `node cdx.mjs <site/prefix/> [regex]`: files the Wayback Machine archived under a URL prefix (newest capture each, with `id_` download URLs), for makers' own files that are gone from their sites. Query one site at a time: parallel queries get "Temporarily Offline". |
| `iafiles.mjs`, `iamatch.mjs`, `iamodels.mjs` | archive.org: original files of items (`iafiles.mjs <id> ...`), files of an item that name a device still missing in `midi_devices.json` (`iamatch.mjs <id>`), and a title search for the missing models (`iamodels.mjs [maker-regex]`). Check every match by hand: substrings give false hits (R-880 vs DR-880, microWave vs Wave). |
| `checkbatch.mjs` | `node checkbatch.mjs <batch.jsonl> [--append]`: checks a batch of queue lines (JSON, maker/model known to `midi_devices.json`) and appends it to `queue.jsonl`. |
| `*_b*.txt` | The batches of `fw.mjs get` lines run per maker before the queue existed. |
| `rm_nomidi.mjs` | Removed the devices without MIDI from `tools/firmware/midi_devices.json`. |
| `musictribe.mjs` | Music Tribe brand sites (behringer.com, tcelectronic.com, tchelicon.com, klarkteknik.com, midasconsoles.com): `page <url>` (download rows of one product page), `crawl <host> <out.jsonl>` (every `/en/products/` page of the site's sitemap, politely, resumable), `list <out.jsonl> [name-regex]` (firmware/software rows with their `cdn-media.empowertribe.com` file URLs). See "Behringer and the other Music Tribe brands" below. |
| `appread/` | Python readers for installer/app containers, used to read Behringer's SynthTribe app as data (never run anything from it): `inno.py` (Inno Setup 6.5+ setup data: header blocks, LZMA/LZMA2 chunks), `innocall.py` (undoes Inno's CALL/JMP address transform; the result matches the SHA-256 in the installer's file entry), `evb.py` (Enigma Virtual Box file table: list/extract the packed files), `rcc.py` (Qt rcc resources compiled into a binary: list/extract), `strs.py` (ASCII/UTF-16 strings matching a regex). Run them with `python -I`, on copies in a new empty scratch folder. |

After adding firmware by hand: `node tools/firmware_checklist.mjs`, then `node tools/firmware/midi_devices_report.mjs --match`
(the queue does both itself).

`node fw.mjs local <Maker> <Model> <version> <file> --url <container-url#member> [--note ..] [--source ..]` files a file
that was read out of a downloaded container (e.g. a firmware image embedded in a maker's updater app) with the same checks
as `get` (hash, same file anywhere in the collection, never overwriting); the log's `url` names the container and member.

## Updates: newer versions of firmware already in the collection

When a newer OS/firmware version turns up for a device the collection already has, fetch it like any other file (the old
files are never touched) and mark it as the current version: queue jobs (and `fw.mjs get`/`local`) take
`"current": true`, `"supersedes": "<what the collection had>"` and, when one model folder holds several products or
parts, `"currentKey": "<product line>"` (e.g. "KDFX" / "without KDFX"). The flags go into `dl_log.jsonl`, and then:
- the maker's `MANIFEST.md` shows the version in bold with "(current; supersedes ...)" and lists it under "Current versions (updates)";
- `z:\firmwares\DOWNLOADS.md` has an "Updates: current versions" table;
- `midi_devices_report.mjs --match` gives the device `current: [{version, file, line?, date, supersedes?}]`, marks the
  matching `inCollection` file entry with `current`, and `intdocs/MIDI_DEVICE_LIST.md` shows "current: <version>".

A later record marked current for the same maker + model + folder + currentKey replaces the earlier one. Where to look
for updates of devices that are already in the collection (earlier official-site passes only looked at missing devices):
the newest DBWBP Synth EPROM Pack (archive.org `synth-eprom-repack-dbwbp.-com_202403`, zip view lists members:
`https://archive.org/download/<id>/<zip>/`), the makers' live pages (Roland `roland.mjs list`, Yamaha
`yamaha_region.mjs`, nordkeyboards.com `legacy-products/<slug>/downloads`, Music Tribe sites with `musictribe.mjs`),
Kurzweil's FTP mirror on the Wayback Machine, and the Wayback copies of makers' CDNs (`cdx.mjs`).

## Behringer and the other Music Tribe brands

behringer.com (and tcelectronic.com, tchelicon.com, klarkteknik.com, midasconsoles.com) is a server-rendered Next.js
site since 2026: `https://<host>/sitemap.xml` lists every product as `/en/products/<SKU>` (behringer.com: 1413), and each
product page carries its downloads in the page's flight data (`self.__next_f.push(...)`): rows with `resourceType`
(firmware, software, driver, user_manual, ...), `name`, `version` and `files[{url, type, platform}]`. The files are plain
public links on `https://cdn-media.empowertribe.com/<32-hex>/<file name>`. `musictribe.mjs crawl` + `list` collects them;
the old `mediadl.musictribe.com` and `cdn.mediavalet.com` links are gone (Wayback only).

### SynthTribe: how Behringer's synth firmware is delivered

SynthTribe (Behringer's editor/updater for its synths and drum machines; current version on the product pages, 3.3.3 in
2026-11) does not take firmware files from the user. Read as data (2.8.5 and 3.3.3):

- Packaging: 2.8.5 is a zip with one Enigma Virtual Box exe (32-bit Qt 5; `appread/evb.py` lists the packed files);
  3.3.3 is an Inno Setup 6.7 installer (`Synthtribe-Setup-3.3.3.exe`) holding one LZMA2 chunk with `Synthtribe.exe`
  (64-bit Qt, again Enigma-packed): `appread/inno.py <exe> <out> blocks`, then `chunk 0 <compressed size>` (size from the
  89-byte file-location record in block 2), then `appread/innocall.py` (the installer applies Inno's CALL/JMP transform).
- Devices: `Devices/<name>/config.json` in the Enigma file system, one per supported unit, with `cloudfamily` and
  `cloudmodel` (e.g. RD-8: `rd8`/`rd8`, TD-3: `td-3`, Pro-800: `pro800`, UB-Xa: `ub-xa16`, LM Drum: `lm-drum`, Wave:
  `wave`, 2600: `2600`, `2600-blue-marvin`, `2600-gray-meanie`, MS-1: `ms-1`, `ms-101`, `ms-1-mk-ii`, JT-4000: `jt-4000-micro`,
  `jt-4000m`, Kobol Expander: `kobol-expander`). The brand segment is `behringer`. Some configs also give the flash
  layout of the update (`bootAddress`, `QSPIAddress`, `INTAddress`, `lastVersion`).
- Cloud API (`CMusicGroupCloud`; the 2.8.5 app even ships its own `cmusicgroupcloud.cpp` as a Qt resource):
  1. `POST https://cloud.midasconsoles.com/api/v2/auth/tokens` with `{"client": "<client id>"}`; the server answers with
     `client.{proof, proofSalt, salt}`, `responsePath` and `user.method`; the app checks the server's proof and posts
     `clientResponse` = SHA-256 of (client secret + salt) to `responsePath`, which returns `{success, token, uuid}`.
     The client id and secret are compiled into the app: this is a login, so later runs must not replay it.
  2. `GET https://cloud.midasconsoles.com/api/v2/firmware/behringer/<cloudfamily>/<cloudmodel>/latest` with
     `Authorization: Bearer <token>` returns the firmware detail: `version`, `brand`/`family`/`model`, `bytes`, `checksum`
     (MD5) and either `binaries[{filename, downloadUrl, checksum, bytes}]` (each `downloadUrl` is then fetched without
     the token; `.db` files are UB-Xa databases, not firmware) or a single file, fetched via
     `GET .../firmware/behringer/<family>/<model>/<version>/60` (Bearer) which returns `{"s3Url": ...}` (a short-lived
     signed link, 60 s).
  3. Without a token the API answers HTTP 400 "Authorization header missing from request" (checked 2026-11-27 for
     `rd8/rd8/latest`). The Wayback Machine has no captures of the API or of any `downloadUrl`. So the per-device
     firmware of the SynthTribe synths is **not publicly reachable**; the `where` texts in `midi_devices.json` say so.
- Firmware inside the app: SynthTribe 2.8.5 carries some images as Qt resources (`appread/rcc.py`): `:/firmware/RD-8.bin`
  (RD-8 firmware 2.0.6, unencrypted, used by its RD-8 updater) and, for its developer "local update" path,
  `:/bin/<MODEL>_{INTFLASH,QSPI}[_CRY]_V<ver>.bin` (encrypted images: JT-4000 1.15, JT-4000M 1.16, Pro VS Mini 1.15,
  Grind 1.07, Victor 1.06, CZ-1 Mini 1.01, Vocoder VC16 1.03/1.04, Brains 1.03, GO MIDI Host 0.0.4). The images for
  devices on the device list are in the collection (`fw.mjs local`, url = the 2.8.5 zip + `#qrc:/...`). SynthTribe
  3.3.3 has no embedded images any more (cloud only).
- The app's own update check (`checkVersion`) scrapes a Behringer download page for "Behringer SYNTHTRIBE for Windows"
  followed by `<td>V<version>`; in practice the current installer is on every SynthTribe product page of behringer.com.
  The product pages still link older builds too (2.9.0 Mac, 2.9.6, 3.2.3-3.2.7, 3.3.0, 3.3.2): 2.9.6 (the last 2.x)
  still carries the firmware images, with newer ones than 2.8.5 (Pro VS Mini 2.02, CZ-1 Mini 1.02); 3.2.3 and 3.3.3 have none.
- ControlTribe (Behringer's app for Swing and other controllers; NSIS installer with a JUCE `ControlTribe.exe`) uses the
  same cloud API (`cloud.midasconsoles.com/api/v2` + `/firmware/`), so Swing's firmware is token-gated as well.

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
