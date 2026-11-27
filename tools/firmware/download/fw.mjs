// Firmware download helper (tools/firmware/download; the log dl_log.jsonl and notes dl_notes.jsonl are kept here).
//   node fw.mjs get <Maker> <Model> <version> <url> [--name file] [--note text] [--folder sub] [--source text] [--html-ok]
//                   [--current] [--supersedes "what the collection had"] [--current-key "product line"]   (an update: newest version)
//   node fw.mjs local <Maker> <Model> <version> <file> --url <container-url#member> [same options as get]
//                   files a file read out of a downloaded container (e.g. firmware embedded in a maker's app)
//   node fw.mjs head <url>                      status, type, length, final URL
//   node fw.mjs note <Maker> <Model> <status> <why>   status: none | skipped | have
//   node fw.mjs manifest [Maker ...]            rewrite MANIFEST.md of those makers (all with log entries if none) and DOWNLOADS.md
// Every download goes to its own new temp folder, is checked (HTTP status, size, type, zip listing), hashed,
// compared with what the collection already has, then copied to z:/firmwares/<Maker>/<Model>/ (never overwriting).
// The same functions are exported for queue.mjs (the unattended queue runner): get, head, note, manifest.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = HERE; // the download log and notes live next to the scripts (tools/firmware/download)
export const LOG = path.join(SCRATCH, 'dl_log.jsonl');
export const NOTES = path.join(SCRATCH, 'dl_notes.jsonl');
// downloads are untrusted: each goes to its own new folder outside the repo, in the system temp folder
export const TMP = path.join(os.tmpdir(), 'midimaster-fw-dl');
export const FW = 'z:/firmwares';
export const UA = process.env.FW_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
export const MAX = Number(process.env.FW_MAX_GB || 2) * 1024 ** 3;
export const MAKER_DIR = { Korg: 'korg' };
const MAKER_NOTES = {
  Roland: "Found through roland.com support pages (Updates & Drivers). Those pages ask you to accept Roland's software license before downloading; the files are the same static.roland.com links the pages use. Read the license and the update procedure (in each zip) before installing.",
  Boss: "Found through boss.info support pages (Updates & Drivers). Those pages ask you to accept the software license before downloading; the files are the same static.roland.com links the pages use.",
  Korg: "Found through korg.com/us/support/download (product download pages); files from cdn.korg.com. The Windows package was taken where Korg offers separate Windows and Mac files. This list is separate from MANIFEST.md, which the Korg System Updater script writes.",
  Yamaha: "Found with the download search of usa.yamaha.com (consumer and pro-audio); files from usa.yamaha.com/download/files/<id> (served by data.yamaha.com).",
  Clavia: "Nord OS updates from nordkeyboards.com (product download pages). Each zip holds the Nord updater program for Windows (the OS is inside it).",
  Moog: "The current moogmusic.com has no firmware pages; these files are the maker's own downloads as archived by the Wayback Machine (web.archive.org).",
  "Mutable Instruments": "Maker's files from mutable-instruments.net as archived by the Wayback Machine (the live site now redirects).",
  Tubbutec: "Third-party MIDI retrofit kits (they add MIDI to synths and drum machines built without it). Firmware from the tubbutec.de firmware-update pages: the files the Tubbutec Firmware Updater flashes (Juno-66, SH-1oh1, ModyPoly, Modysix, uniPulse) and the MC-2oh2 SysEx updates. The TR-6oh6 and TR-8oh8 updates live inside Tubbutec's web configurators and are not plain files.",
  "Encore Electronics": "Third-party MIDI retrofit kits. Firmware from encoreelectronics.com/cont_soft.html (Software Updates): EPROM code (Intel HEX) for the JP8MK, SMK and OB8MK kits, and the flash update (standard MIDI file) for the OB-Xa kit.",
  Waldorf: "From the download links on the waldorfmusic.com FAQ pages (Waldorf's Nextcloud at downloads.waldorfmusic.com). Note: waldorf-music.com (with a hyphen) no longer belongs to Waldorf.",
};

export const safe = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+$/, '').replace(/\.+$/, '');
export const readLines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
export const human = (n) => (n >= 1 << 30 ? (n / 2 ** 30).toFixed(2) + ' GB' : n >= 1 << 20 ? (n / 2 ** 20).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B');
/** The collection folder a download for this maker/model (or folder) goes to. */
export const destDir = (maker, model, folder) => path.join(FW, MAKER_DIR[maker] || safe(maker), safe(folder || model));

export function zipMembers(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size; const len = Math.min(size, 65557);
    const tail = Buffer.alloc(len); fs.readSync(fd, tail, 0, len, size - len);
    let e = -1; for (let i = len - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) return null;
    let cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if ((cdOff === 0xffffffff || cdSize === 0xffffffff) && e >= 20 && tail.readUInt32LE(e - 20) === 0x07064b50) {
      const z = Buffer.alloc(56); fs.readSync(fd, z, 0, 56, Number(tail.readBigUInt64LE(e - 12)));
      if (z.readUInt32LE(0) === 0x06064b50) { cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48)); }
    }
    if (cdOff + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const flags = cd.readUInt16LE(p + 8), n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
      out.push({ name: cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + n), size: cd.readUInt32LE(p + 24) });
      p += 46 + n + x + c;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

export function kindOf(file) {
  const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd);
  const s = b.toString('latin1');
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (s.startsWith('Rar!')) return 'rar';
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc) return '7z';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (s.startsWith('MZ')) return 'exe';
  if (s.startsWith('%PDF')) return 'pdf';
  if (s.startsWith('MThd')) return 'midi';
  if (b[0] === 0xf0) return 'sysex';
  if (/^\s*<(!doctype|html|\?xml)/i.test(s)) return 'html/xml';
  if (b.readUInt32BE(0) === 0x78617221) return 'xar (pkg)';
  if (s.startsWith('koly') || b.readUInt32BE(0) === 0x7801730d) return 'dmg';
  return 'binary';
}

export function sha256(file) {
  const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20);
  let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd); return h.digest('hex');
}

let sizeIndex = null;
export function sameSizeFiles(size) {
  if (!sizeIndex) {
    sizeIndex = new Map();
    const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4 && e.name !== '_work') walk(p, depth + 1); continue; }
      const s = fs.statSync(p).size; if (!sizeIndex.has(s)) sizeIndex.set(s, []); sizeIndex.get(s).push(p);
    } };
    walk(FW, 0);
  }
  return sizeIndex.get(size) || [];
}

export async function head(url, { ua = UA, timeoutMs = 60000 } = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': ua }, redirect: 'follow', signal: ac.signal });
    const out = `${r.status} ${r.headers.get('content-type')} ${r.headers.get('content-length')} ${r.url}`;
    try { r.body?.cancel(); } catch {}
    return out;
  } finally { clearTimeout(t); }
}

/**
 * Download one file and file it into the collection. Never throws for network/HTTP problems: returns
 *   { status: 'ok' | 'have' | 'skip' | 'fail' | 'space', msg, bytes, http?, permanent?, rec?, dup? }
 * msg is the line the CLI prints. Options: name, note, folder, source, htmlOk, ua, maxBytes (default FW_MAX_GB),
 * timeoutMs (until the response headers, default 60 s), idleMs (no data for this long aborts, default 120 s),
 * signal (AbortSignal from the caller), checkSpace(len) (return an error text to refuse a file of that size),
 * onProgress(bytesSoFar, contentLength).
 */
export async function get(maker, model, version, url, opts = {}) {
  const { name, note, folder, source, htmlOk, ua = UA, maxBytes = MAX, timeoutMs = 60000, idleMs = 120000, signal, checkSpace, onProgress, current, supersedes, currentKey } = opts;
  fs.mkdirSync(TMP, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(TMP, 'x-'));
  const clean = () => fs.rmSync(tmp, { recursive: true, force: true });
  const ac = new AbortController();
  let why = '';
  const abort = (w) => { if (!why) why = w; ac.abort(new Error(w)); };
  const onOuter = () => abort('stopped');
  if (signal) { if (signal.aborted) onOuter(); else signal.addEventListener('abort', onOuter, { once: true }); }
  let timer = setTimeout(() => abort('timeout waiting for the server'), timeoutMs);
  const idle = () => { clearTimeout(timer); timer = setTimeout(() => abort(`timeout: no data for ${Math.round(idleMs / 1000)} s`), idleMs); };
  let got = 0;
  try {
    let r;
    try { r = await fetch(url, { headers: { 'User-Agent': ua, Accept: '*/*' }, redirect: 'follow', signal: ac.signal }); }
    catch (e) { clean(); return { status: 'fail', msg: `FAIL ${why || errText(e)} ${url}`, bytes: 0, permanent: false }; }
    if (!r.ok) {
      try { r.body?.cancel(); } catch {}
      clean();
      // 4xx other than timeout/rate limit will not change on a retry
      const permanent = r.status >= 400 && r.status < 500 && ![408, 425, 429].includes(r.status);
      return { status: 'fail', msg: `FAIL ${r.status} ${url}`, bytes: 0, http: r.status, permanent, retryAfter: Number(r.headers.get('retry-after')) || undefined };
    }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > maxBytes) { try { r.body?.cancel(); } catch {} clean(); return { status: 'skip', msg: `SKIP too big ${human(len)} ${url}`, bytes: 0, size: len }; }
    const spaceErr = checkSpace?.(len);
    if (spaceErr) { try { r.body?.cancel(); } catch {} clean(); return { status: 'space', msg: `STOP ${spaceErr} ${url}`, bytes: 0 }; }
    const cd = r.headers.get('content-disposition') || '';
    const cdName = (/filename\*=UTF-8''([^;]+)/i.exec(cd) || [])[1] || (/filename="?([^";]+)"?/i.exec(cd) || [])[1];
    let fname = name || (cdName && decodeURIComponent(cdName)) || decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'download');
    fname = safe(path.basename(fname)) || 'download';
    const tf = path.join(tmp, fname);
    const ws = fs.createWriteStream(tf);
    try {
      idle();
      if (r.body) for await (const chunk of r.body) {
        got += chunk.length; idle(); onProgress?.(got, len);
        if (got > maxBytes) break;
        if (!ws.write(chunk)) await new Promise((res) => ws.once('drain', res));
      }
    } catch (e) {
      await new Promise((res) => ws.end(res)); clean();
      return { status: 'fail', msg: `FAIL ${why || errText(e)} after ${human(got)} ${url}`, bytes: got, permanent: false, stopped: why === 'stopped' };
    }
    await new Promise((res) => ws.end(res));
    clearTimeout(timer);
    if (got > maxBytes) { clean(); return { status: 'skip', msg: `SKIP too big ${url}`, bytes: got }; }
    const encoded = (r.headers.get('content-encoding') || 'identity') !== 'identity'; // fetch unpacks gzip: the length header is the packed size
    if (len && got !== len && !encoded) { clean(); return { status: 'fail', msg: `FAIL partial ${got}/${len} ${url}`, bytes: got, permanent: false }; }
    if (!got) { clean(); return { status: 'fail', msg: `FAIL empty ${url}`, bytes: 0, permanent: false }; }
    const kind = kindOf(tf);
    if (kind === 'html/xml' && !htmlOk) { clean(); return { status: 'fail', msg: `FAIL got HTML/XML instead of a file (${human(got)}) ${r.url}`, bytes: got, permanent: true }; }
    let members = null;
    if (kind === 'zip') { members = zipMembers(tf); if (!members) { clean(); return { status: 'fail', msg: `FAIL zip has no readable directory ${url}`, bytes: got, permanent: false }; } }
    const hash = sha256(tf);
    const dup = sameSizeFiles(got).find((p) => sha256(p) === hash);
    if (dup) { clean(); return { status: 'have', msg: `HAVE same file already: ${dup}`, bytes: got, dup, sha256: hash }; }
    const dir = destDir(maker, model, folder);
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, fname);
    if (fs.existsSync(dest)) { const p = path.parse(fname); dest = path.join(dir, `${p.name} (${hash.slice(0, 8)})${p.ext}`); }
    if (fs.existsSync(dest)) { clean(); return { status: 'fail', msg: `FAIL ${path.relative(FW, dest)} exists (not overwritten) ${url}`, bytes: got, permanent: true }; }
    fs.copyFileSync(tf, dest, fs.constants.COPYFILE_EXCL); clean();
    sizeIndex?.get(got)?.push(dest) ?? sizeIndex?.set(got, [dest]);
    const rec = { maker, model, folder: folder || undefined, version, file: path.relative(FW, dest).replace(/\\/g, '/'), size: got, sha256: hash, kind, url, finalUrl: r.url !== url ? r.url : undefined, date: new Date().toISOString().slice(0, 10), note, source: source || undefined };
    if (members) rec.members = members.length;
    // an update: this file is now the device's current version (supersedes: what the collection had before)
    if (current) rec.current = true;
    if (supersedes) rec.supersedes = supersedes;
    if (currentKey) rec.currentKey = currentKey; // product line within the model folder (e.g. "X-Touch One"), for several current files
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
    const show = members ? ` [${members.length} members: ${members.slice(0, 4).map((m) => m.name).join(', ')}${members.length > 4 ? ', ...' : ''}]` : '';
    return { status: 'ok', msg: `OK ${rec.file} ${human(got)} ${kind}${show}`, bytes: got, rec };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onOuter);
    if (fs.existsSync(tmp)) clean();
  }
}

/**
 * File a local file into the collection with the same checks as get() (type, zip listing, SHA-256, same file anywhere
 * in the collection, never overwriting). For firmware read out of a downloaded container (e.g. an image embedded in a
 * maker's updater app): url names the container and the member, e.g. "https://.../app.zip#qrc:/bin/fw.bin".
 */
export function addLocal(maker, model, version, src, opts = {}) {
  const { name, note, folder, source, url, current, supersedes, currentKey } = opts;
  if (!url) return { status: 'fail', msg: 'FAIL local needs --url (container URL#member)' };
  const got = fs.statSync(src).size;
  const kind = kindOf(src);
  let members = null;
  if (kind === 'zip') { members = zipMembers(src); if (!members) return { status: 'fail', msg: `FAIL zip has no readable directory ${src}` }; }
  const hash = sha256(src);
  const dup = sameSizeFiles(got).find((p) => sha256(p) === hash);
  if (dup) return { status: 'have', msg: `HAVE same file already: ${dup}`, dup, sha256: hash };
  const fname = safe(path.basename(name || src)) || 'file';
  const dir = destDir(maker, model, folder);
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, fname);
  if (fs.existsSync(dest)) { const p = path.parse(fname); dest = path.join(dir, `${p.name} (${hash.slice(0, 8)})${p.ext}`); }
  if (fs.existsSync(dest)) return { status: 'fail', msg: `FAIL ${path.relative(FW, dest)} exists (not overwritten)` };
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  sizeIndex?.get(got)?.push(dest) ?? sizeIndex?.set(got, [dest]);
  const rec = { maker, model, folder: folder || undefined, version, file: path.relative(FW, dest).replace(/\\/g, '/'), size: got, sha256: hash, kind, url, date: new Date().toISOString().slice(0, 10), note, source: source || undefined };
  if (members) rec.members = members.length;
  if (current) rec.current = true;
  if (supersedes) rec.supersedes = supersedes;
  if (currentKey) rec.currentKey = currentKey;
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
  return { status: 'ok', msg: `OK ${rec.file} ${human(got)} ${kind}`, rec };
}

/** Record a device checked without a download (status: none | skipped | have). */
export function note(maker, model, status, why) {
  const rec = { maker, model, status, why, date: new Date().toISOString().slice(0, 10) };
  fs.appendFileSync(NOTES, JSON.stringify(rec) + '\n');
  return rec;
}

const errText = (e) => e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.cause?.message || e?.message || String(e);

const OWN_HEADER = / firmware downloads\s*$/; // the first line manifest() writes; any other MANIFEST.md is left alone

/** A log record marked current that is still the newest current record of its maker + model + folder (a later update replaces it). */
export function isCurrent(r, log) {
  if (!r.current) return false;
  const key = (x) => x.maker + '\u0000' + x.model + '\u0000' + (x.folder || '') + '\u0000' + (x.currentKey || '');
  const later = log.filter((x) => x.current && key(x) === key(r));
  return later[later.length - 1] === r;
}

export function manifest(makers = [], { quiet = false } = {}) {
  const log = readLines(LOG);
  // a later note for the same maker + model replaces an earlier one (e.g. "skipped" followed by "have")
  const notes = [...new Map(readLines(NOTES).map((n) => [n.maker + '\u0000' + n.model, n])).values()];
  const all = [...new Set([...log.map((r) => r.maker), ...notes.map((n) => n.maker)])].sort();
  const written = [];
  for (const mk of makers.length ? makers : all) {
    const rows = log.filter((r) => r.maker === mk); const ns = notes.filter((n) => n.maker === mk);
    const dir = path.join(FW, MAKER_DIR[mk] || safe(mk));
    const file = path.join(dir, mk === 'Korg' ? 'MANIFEST_WEB.md' : 'MANIFEST.md');
    if (!rows.length && !fs.existsSync(dir)) continue;
    if (fs.existsSync(file) && !OWN_HEADER.test(fs.readFileSync(file, 'utf8').split('\n')[0])) { if (!quiet) console.log(`! ${file} was not written by fw.mjs: left alone`); continue; }
    fs.mkdirSync(dir, { recursive: true });
    const L = [`# ${mk} firmware downloads`, '', 'Fetched for the MIDIMaster firmware collection. Files keep their original names; nothing was run or unpacked.',
      'Source URLs are the maker\'s own download links unless the source column says otherwise.', '', ...(MAKER_NOTES[mk] ? [MAKER_NOTES[mk], ''] : [])];
    if (rows.length) {
      L.push('| Model | Version | File | Size | SHA-256 | Source | Date |', '|---|---|---|---:|---|---|---|');
      for (const r of rows.sort((a, b) => a.model.localeCompare(b.model, 'en', { numeric: true }) || a.file.localeCompare(b.file))) {
        const ver = isCurrent(r, log) ? `**${r.version || ''}** (current${r.supersedes ? '; supersedes ' + r.supersedes : ''})` : (r.version || '');
        L.push(`| ${r.model} | ${ver} | \`${path.basename(r.file)}\`${r.note ? ' (' + r.note + ')' : ''} | ${r.size} | \`${r.sha256}\` | ${r.url}${r.source ? ' (' + r.source + ')' : ''} | ${r.date} |`);
      }
      L.push('');
      const ups = rows.filter((r) => isCurrent(r, log));
      if (ups.length) {
        L.push('## Current versions (updates)', '', 'Newer firmware fetched for devices that were already in the collection; the older files stay where they are.', '');
        for (const r of ups.sort((a, b) => a.model.localeCompare(b.model, 'en', { numeric: true }))) L.push(`- **${r.model}**: ${r.version} (\`${r.file}\`, ${r.date})${r.supersedes ? '; before: ' + r.supersedes : ''}`);
        L.push('');
      }
    }
    const none = ns.filter((n) => n.status !== 'have');
    if (none.length) {
      L.push('## Checked, not downloaded', '');
      for (const n of none.sort((a, b) => a.model.localeCompare(b.model, 'en', { numeric: true }))) L.push(`- **${n.model}**: ${n.status === 'none' ? 'no public download found' : 'skipped'}; ${n.why}`);
      L.push('');
    }
    fs.writeFileSync(file, L.join('\n'));
    written.push(file);
  }
  // top-level summary
  const byMk = new Map();
  for (const r of log) { const m = byMk.get(r.maker) || { files: 0, size: 0, models: new Set() }; m.files++; m.size += r.size; m.models.add(r.model); byMk.set(r.maker, m); }
  const total = log.reduce((n, r) => n + r.size, 0);
  const D = ['# Firmware downloads', '', 'Official OS/firmware files (and some archived ones) fetched for the devices in `intdocs/FIRMWARE_WANTED.md` of MIDIMaster.',
    'Each maker folder has a `MANIFEST.md` (Korg: `korg/MANIFEST_WEB.md`) with versions, sizes, SHA-256 and source URLs, and the devices checked',
    'that have no public download.', '', `Total: ${log.length} files, ${human(total)}, ${new Set(log.map((r) => r.maker + '/' + r.model)).size} devices.`, '',
    '| Maker | Devices | Files | Size | Manifest |', '|---|---:|---:|---:|---|'];
  for (const [mk, m] of [...byMk].sort((a, b) => a[0].localeCompare(b[0]))) D.push(`| ${mk} | ${m.models.size} | ${m.files} | ${human(m.size)} | \`${MAKER_DIR[mk] || safe(mk)}/${mk === 'Korg' ? 'MANIFEST_WEB.md' : 'MANIFEST.md'}\` |`);
  D.push('');
  const ups = log.filter((r) => isCurrent(r, log));
  if (ups.length) {
    D.push('## Updates: current versions', '', 'Newer OS/firmware versions fetched for devices that were already in the collection (queue jobs with `"current": true`).',
      'The new file is the current version; the older files were kept.', '', '| Maker | Model | Current version | File | Before | Date |', '|---|---|---|---|---|---|');
    for (const r of ups.sort((a, b) => a.maker.localeCompare(b.maker) || a.model.localeCompare(b.model, 'en', { numeric: true }))) D.push(`| ${r.maker} | ${r.model} | ${r.version} | \`${r.file}\` | ${r.supersedes || ''} | ${r.date} |`);
    D.push('');
  }
  const noFolder = [...new Set(notes.map((n) => n.maker))].filter((mk) => !byMk.has(mk)).sort();
  if (noFolder.length) {
    D.push('## Makers checked without a download', '', 'No files were fetched for these makers, so they have no folder; what was checked:', '');
    for (const mk of noFolder) {
      const ns = notes.filter((n) => n.maker === mk);
      const whys = [...new Set(ns.map((n) => n.why))];
      D.push(`- **${mk}** (${ns.map((n) => n.model).join(', ')}): ${whys.join('; ')}`);
    }
    D.push('');
  }
  fs.writeFileSync(path.join(FW, 'DOWNLOADS.md'), D.join('\n'));
  const msg = `manifests written; total ${log.length} files ${human(total)}`;
  if (!quiet) console.log(msg);
  return { files: log.length, bytes: total, written, msg };
}

// --- command line (only when run directly, not when imported by queue.mjs) ---
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = (k) => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
  const cmd = args.shift();
  fs.mkdirSync(TMP, { recursive: true });
  if (cmd === 'head') console.log(await head(args[0]));
  else if (cmd === 'get') {
    const name = opt('--name'), noteText = opt('--note'), folder = opt('--folder'), source = opt('--source'), htmlOk = flag('--html-ok');
    const supersedes = opt('--supersedes'), currentKey = opt('--current-key'), current = flag('--current') || !!supersedes;
    const [maker, model, version, url] = args;
    try { console.log((await get(maker, model, version, url, { name, note: noteText, folder, source, htmlOk, current, supersedes, currentKey })).msg); } catch (e) { console.log(`FAIL ${e.message} ${url}`); }
  } else if (cmd === 'local') {
    const name = opt('--name'), noteText = opt('--note'), folder = opt('--folder'), source = opt('--source'), url = opt('--url');
    const supersedes = opt('--supersedes'), currentKey = opt('--current-key'), current = flag('--current') || !!supersedes;
    const [maker, model, version, file] = args;
    console.log(addLocal(maker, model, version, file, { name, note: noteText, folder, source, url, current, supersedes, currentKey }).msg);
  } else if (cmd === 'note') {
    const [maker, model, status, ...why] = args;
    note(maker, model, status, why.join(' '));
  } else if (cmd === 'manifest') manifest(args);
  else console.log('usage: see header');
}
