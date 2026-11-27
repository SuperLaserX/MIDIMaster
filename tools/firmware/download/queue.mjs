// Unattended firmware download queue (tools/firmware/download). Works through queue.jsonl one job at a time with the
// same checks and rules as `fw.mjs get` (it uses fw.mjs's functions), records each job's state in queue_state.json so
// a restart skips finished jobs and retries failed ones, and when the queue is done (or stopped) rewrites the
// manifests, regenerates the checklist rules and docs, and writes queue_report.md.
//
//   node tools/firmware/download/queue.mjs [options]      run the queue (start it in the background; it logs to queue.log)
//   node tools/firmware/download/queue.mjs --status       progress from the state file (safe while a run is going)
//   node tools/firmware/download/queue.mjs --dry-run      what a run would do now (no network, nothing written)
//   node tools/firmware/download/queue.mjs --stop         ask a running queue to stop after the current file
//   node tools/firmware/download/queue.mjs --post         only rewrite manifests/rules/docs and the report
//
// Options: --queue <file> (default queue.jsonl next to this script), --budget <GB> (stop once this run has downloaded
// more than this, default 50), --delay <s> (pause between two requests to the same host, default 5), --retries <n>
// (attempts per job, default 3), --reserve <GB> (free space to keep on z: and on the temp drive, default 20),
// --max-gb <GB> (size limit per file unless the job says big: true, default 2), --linger <min> (when the queue is
// empty, wait this long for new jobs before finishing, default 0), --retry-failed (give failed jobs a new set of
// attempts), --recheck (download even when the URL is already in dl_log.jsonl), --no-post (skip the post-processing).
//
// Queue lines (JSON, one per line; blank lines and lines starting with # or // are ignored):
//   {"maker":"Strymon","model":"TimeLine","version":"1.85","url":"https://...","name":"file.syx","folder":"sub",
//    "note":"shown in the manifest","source":"archive it came from","ua":"Mozilla/5.0","htmlOk":false,"big":false,
//    "haveNote":"why"}   (haveNote: once the file is in the collection, record a note with status have for maker + model,
//                         which replaces an earlier none/skipped note in the manifest)
//   Updates (a newer version of firmware the collection already has): add "current":true and "supersedes":"what the
//   collection had" (optionally "currentKey":"product line" when one model folder holds several products); the manifest,
//   DOWNLOADS.md and the device report (currentVersion) then show the file as the current version. Older files stay.
//   {"note":{"maker":"Pearl","model":"Mimic Pro","status":"none","why":"pearldrum.com ..."}}   (status: none|skipped|have)
// A job is identified by its content (maker, model, version, url, name, folder; for notes all four fields), so lines
// can be appended while a run is going (the runner re-reads the file before every job) and a changed line is a new job.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { get, note, manifest, readLines, human, LOG, NOTES, FW, TMP, UA } from './fw.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const flag = (k) => argv.includes(k);
const QUEUE = path.resolve(opt('--queue', path.join(HERE, 'queue.jsonl')));
const base = QUEUE.replace(/\.jsonl?$/i, '');
const STATE = base + '_state.json', LOCK = base + '.lock', STOP = base + '.stop', QLOG = base + '.log', REPORT = base + '_report.md';
const GB = 1024 ** 3;
const BUDGET = Number(opt('--budget', 50)) * GB;
const DELAY = Number(opt('--delay', 5)) * 1000;
const RETRIES = Math.max(1, Number(opt('--retries', 3)));
const RESERVE = Number(opt('--reserve', 20)) * GB;
const MAXFILE = Number(opt('--max-gb', process.env.FW_MAX_GB || 2)) * GB;
const LINGER = Number(opt('--linger', 0)) * 60000;
const BACKOFF = [2, 10, 30, 60].map((m) => m * 60000); // wait before attempt 2, 3, 4, ...

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => { const line = `${now()} ${s}`; console.log(line); try { fs.appendFileSync(QLOG, line + '\n'); } catch {} };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const hostOf = (u) => { try { return new URL(u).host; } catch { return '?'; } };
const isNote = (j) => !!j.note && typeof j.note === 'object'; // a download job's "note" is the text shown in the manifest
const keyOf = (j) => crypto.createHash('sha1').update(JSON.stringify(isNote(j)
  ? ['note', j.note.maker, j.note.model, j.note.status, j.note.why]
  : [j.maker, j.model, j.version || '', j.url, j.name || '', j.folder || '', j.ua || '', j.big ? 'big' : ''])).digest('hex').slice(0, 12);
const label = (j) => (isNote(j) ? `note ${j.note.maker} / ${j.note.model} (${j.note.status})` : `${j.maker} / ${j.model} ${j.version || ''}`.trim());

function readQueue() {
  if (!fs.existsSync(QUEUE)) return { jobs: [], bad: [] };
  const jobs = [], bad = [], seen = new Set();
  fs.readFileSync(QUEUE, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    let j; try { j = JSON.parse(line); } catch { bad.push({ line: i + 1, why: 'not JSON (yet?)' }); return; }
    const why = isNote(j)
      ? (!j.note.maker || !j.note.model || !['none', 'skipped', 'have'].includes(j.note.status) || !j.note.why) && 'note needs maker, model, status (none|skipped|have), why'
      : (!j.maker || !j.model || !/^https?:\/\//.test(j.url || '')) && 'download needs maker, model, url (http/https)';
    if (why) { bad.push({ line: i + 1, why }); return; }
    j.key = keyOf(j); j.line = i + 1;
    if (seen.has(j.key)) { j.dupOf = true; } seen.add(j.key);
    jobs.push(j);
  });
  return { jobs, bad };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { jobs: {}, runs: [] }; }
}
let state = loadState();
let lastSave = 0;
function saveState(force) {
  if (!force && Date.now() - lastSave < 5000) return;
  lastSave = Date.now();
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE);
}

function freeBytes(p) { try { const s = fs.statfsSync(p); return s.bavail * s.bsize; } catch { return Infinity; } }
function spaceProblem(need = 0) {
  for (const [what, p] of [['z: (collection)', FW], ['temp drive', TMP]]) {
    const free = freeBytes(p);
    if (free < need + RESERVE) return `low disk space on ${what}: ${human(free)} free, need ${human(need)} + ${human(RESERVE)} reserve`;
  }
  return '';
}

/** URL -> logged record whose file is still in the collection (a re-queued download is skipped without fetching). */
function loggedUrls() {
  const m = new Map();
  for (const r of readLines(LOG)) {
    const p = path.join(FW, r.file);
    let ok = false; try { ok = fs.statSync(p).size === r.size; } catch {}
    if (!ok) continue;
    for (const u of [r.url, r.finalUrl]) if (u) m.set(u, r);
  }
  return m;
}
const noteKey = (n) => [n.maker, n.model, n.status, n.why].join('\u0000');

// ---------------------------------------------------------------------------------------------
// --status / --dry-run / --stop
// ---------------------------------------------------------------------------------------------
function summary(jobs) {
  const c = { total: jobs.length, ok: 0, have: 0, skipped: 0, noted: 0, failed: 0, retry: 0, pending: 0, duplicate: 0 };
  for (const j of jobs) {
    const s = state.jobs[j.key];
    if (j.dupOf) { c.duplicate++; continue; }
    if (!s || s.status === 'pending' || s.status === 'running') c.pending++;
    else if (s.status === 'failed') { if (s.final) c.failed++; else c.retry++; }
    else c[s.status] = (c[s.status] || 0) + 1;
  }
  return c;
}

function status() {
  const { jobs, bad } = readQueue();
  const c = summary(jobs);
  let lock = null; try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch {}
  const running = lock && alive(lock.pid);
  const run = state.runs?.[state.runs.length - 1];
  console.log(`queue ${QUEUE}`);
  console.log(running ? `RUNNING (pid ${lock.pid}, since ${lock.started})` : `not running${run ? ` (last run ${run.started} .. ${run.ended || '?'}: ${run.reason || 'killed?'})` : ''}`);
  if (fs.existsSync(STOP)) console.log('stop requested (queue.stop exists)');
  console.log(`jobs ${c.total}: downloaded ${c.ok}, already in collection ${c.have}, skipped ${c.skipped}, notes ${c.noted}, failed ${c.failed}, waiting to retry ${c.retry}, pending ${c.pending}${c.duplicate ? `, duplicate lines ${c.duplicate}` : ''}`);
  if (run) console.log(`this run: ${run.files || 0} files, ${human(run.bytes || 0)} downloaded (budget ${human(run.budget || BUDGET)})`);
  if (running && state.current) {
    const cur = state.current;
    console.log(`now: ${cur.label} ${cur.url} ${human(cur.bytes || 0)}${cur.len ? ' of ' + human(cur.len) : ''} (started ${cur.started})`);
  }
  const fails = jobs.map((j) => [j, state.jobs[j.key]]).filter(([, s]) => s?.status === 'failed');
  for (const [j, s] of fails.slice(-10)) console.log(`  failed${s.final ? '' : ` (retry after ${s.nextTry})`}: ${label(j)} — ${s.error}`);
  for (const b of bad) console.log(`  line ${b.line}: ${b.why}`);
  if (state.post) console.log(`last post-processing ${state.post.at}: ${state.post.checklist || ''}; ${state.post.report || ''}`);
}

function dryRun() {
  const { jobs, bad } = readQueue();
  const logged = loggedUrls();
  const noted = new Set(readLines(NOTES).map(noteKey));
  for (const j of jobs) {
    const s = state.jobs[j.key];
    let what;
    if (j.dupOf) what = 'duplicate of an earlier line';
    else if (s && s.status !== 'pending' && !(s.status === 'failed' && (!s.final || flag('--retry-failed')))) what = `done: ${s.status}${s.error ? ' — ' + s.error : s.file ? ' — ' + s.file : ''}`;
    else if (isNote(j)) what = noted.has(noteKey(j.note)) ? 'note already recorded' : 'would record the note';
    else if (logged.has(j.url) && !flag('--recheck') && !j.recheck) what = `would skip: already downloaded as ${logged.get(j.url).file}`;
    else what = `would download${s?.status === 'failed' ? ` (attempt ${s.attempts + 1}, last: ${s.error})` : ''}${j.big ? ' (big allowed)' : ''}`;
    console.log(`${String(j.line).padStart(4)} ${label(j)}: ${what}${isNote(j) ? '' : ' ' + j.url}`);
  }
  for (const b of bad) console.log(`line ${b.line}: invalid: ${b.why}`);
  console.log(`(${jobs.length} jobs; nothing was fetched or written)`);
}

// ---------------------------------------------------------------------------------------------
// post-processing: manifests, rules, checklist, wanted list, report
// ---------------------------------------------------------------------------------------------
function runNode(script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8', timeout: 30 * 60000 });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function post(reason) {
  const P = { at: now(), reason };
  try { P.manifest = manifest([], { quiet: true }).msg; } catch (e) { P.manifest = 'manifest failed: ' + e.message; }
  if (fs.existsSync(LOG) && readLines(LOG).length) {
    const g = runNode(path.join(HERE, 'gen_rules.mjs')); P.rules = g.out;
  } else P.rules = 'skipped: no download log';
  const c = runNode(path.join(REPO, 'tools/firmware_checklist.mjs'));
  P.checklist = c.out.split('\n').find((l) => /firmwares/.test(l)) || c.out.slice(0, 300);
  P.checklistWarnings = c.out.split('\n').filter((l) => /^warning/.test(l));
  P.notIdentified = Number((/(\d+) not identified/.exec(c.out) || [])[1] ?? NaN);
  const m = runNode(path.join(REPO, 'tools/firmware/midi_devices_report.mjs'), ['--match']);
  P.report = m.out.split('\n').find((l) => /checklist devices not matched/.test(l)) || m.out.slice(0, 300);
  P.reportWarnings = m.out.split('\n').filter((l) => /^!/.test(l));
  P.notMatched = Number((/checklist devices not matched: (\d+)/.exec(m.out) || [])[1] ?? NaN);
  state.post = P; saveState(true);
  writeReport();
  say(`post-processing done: ${P.manifest}; ${P.checklist}; ${P.report}`);
}

function writeReport() {
  const { jobs, bad } = readQueue();
  const c = summary(jobs);
  const rows = jobs.filter((j) => !j.dupOf).map((j) => ({ j, s: state.jobs[j.key] || { status: 'pending' } }));
  const by = (st) => rows.filter((r) => r.s.status === st);
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const okBytes = by('ok').reduce((n, r) => n + (r.s.size || 0), 0);
  const P = state.post || {};
  const run = state.runs?.[state.runs.length - 1] || {};
  const L = ['# Firmware download queue report', '',
    `Written ${now()} by \`node tools/firmware/download/queue.mjs\` (queue: \`${path.relative(REPO, QUEUE).replace(/\\/g, '/')}\`).`, '',
    `- Last run: ${run.started || '?'} to ${run.ended || '(running)'}, ended because: ${run.reason || (run.ended ? '?' : 'still running (waiting for new jobs)')}; ${run.files || 0} files, ${human(run.bytes || 0)} downloaded (budget ${human(run.budget || BUDGET)}).`,
    `- Jobs: ${c.total}: **${c.ok} downloaded** (${human(okBytes)}), ${c.have} already in the collection, ${c.skipped} skipped, ${c.noted} notes, **${c.failed} failed**, ${c.retry} waiting to retry, ${c.pending} pending${c.duplicate ? `, ${c.duplicate} duplicate lines` : ''}.`,
    `- Checklist (\`node tools/firmware_checklist.mjs\`): ${P.checklist || 'not run'}. Not identified: **${Number.isNaN(P.notIdentified) || P.notIdentified === undefined ? '?' : P.notIdentified}**${P.notIdentified === 0 ? ' (every file is filed under a device)' : ''}.`,
    `- Device list (\`midi_devices_report.mjs --match\`): ${P.report || 'not run'}. Collection devices not matched to the device list: **${Number.isNaN(P.notMatched) || P.notMatched === undefined ? '?' : P.notMatched}**${P.notMatched === 0 ? ' (0 unmatched)' : ''}.`,
    `- Rules (\`gen_rules.mjs\`): ${cell((P.rules || 'not run').split('\n')[0])}${(P.rules || '').split('\n').length > 1 ? ` (${(P.rules || '').split('\n').length - 1} problems, listed below)` : ''}.`, ''];
  const table = (title, list, cols, fmt) => {
    if (!list.length) return;
    L.push(`## ${title} (${list.length})`, '', `| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`);
    for (const r of list) L.push(`| ${fmt(r).map(cell).join(' | ')} |`);
    L.push('');
  };
  table('Downloaded', by('ok'), ['Maker', 'Model', 'Version', 'File', 'Size'], ({ j, s }) => [j.maker, j.model, j.version, s.file, human(s.size || 0)]);
  table('Failed', by('failed').filter((r) => r.s.final), ['Maker', 'Model', 'URL', 'Reason', 'Attempts'], ({ j, s }) => [j.maker, j.model, j.url, s.error, s.attempts]);
  table('Failed, waiting to retry', by('failed').filter((r) => !r.s.final), ['Maker', 'Model', 'URL', 'Reason', 'Next try'], ({ j, s }) => [j.maker, j.model, j.url, s.error, s.nextTry]);
  table('Skipped', by('skipped'), ['Maker', 'Model', 'URL', 'Reason'], ({ j, s }) => [j.maker, j.model, j.url, s.error || s.result]);
  table('Already in the collection', by('have'), ['Maker', 'Model', 'URL', 'Where'], ({ j, s }) => [j.maker, j.model, j.url, s.file || s.result]);
  table('Notes recorded', by('noted'), ['Maker', 'Model', 'Status', 'Why'], ({ j, s }) => [j.note.maker, j.note.model, j.note.status, j.note.why + (s.result === 'already recorded' ? ' (already recorded)' : '')]);
  table('Still queued', rows.filter((r) => r.s.status === 'pending' || r.s.status === 'running'), ['Line', 'Job', 'URL'], ({ j }) => [j.line, label(j), j.url || '']);
  const probs = [...(P.rules || '').split('\n').slice(1), ...(P.checklistWarnings || []), ...(P.reportWarnings || []), ...bad.map((b) => `queue line ${b.line}: ${b.why}`)].filter(Boolean);
  if (probs.length) { L.push(`## Problems reported by the tools (${probs.length})`, ''); for (const p of probs) L.push(`- ${cell(p)}`); L.push(''); }
  fs.writeFileSync(REPORT, L.join('\n'));
}

// ---------------------------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------------------------
async function runQueue() {
  // one runner per queue: a lock file with the pid (a stale lock from a killed run is taken over)
  try {
    const l = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (l.pid !== process.pid && alive(l.pid)) { console.log(`already running (pid ${l.pid}, since ${l.started}); use --status`); process.exit(1); }
  } catch {}
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: now() }));
  if (fs.existsSync(STOP)) fs.rmSync(STOP);
  fs.mkdirSync(TMP, { recursive: true });
  const run = { pid: process.pid, started: now(), bytes: 0, files: 0, budget: BUDGET };
  state.runs = [...(state.runs || []).slice(-19), run];
  // a job left "running" by a killed run is retried; --retry-failed gives failed jobs a new set of attempts
  for (const s of Object.values(state.jobs)) {
    if (s.status === 'running') { s.status = 'failed'; s.error = 'interrupted'; s.final = s.attempts >= RETRIES; s.nextTry = now(); }
    if (flag('--retry-failed') && s.status === 'failed') { s.attempts = 0; s.final = false; s.nextTry = now(); }
  }
  delete state.current; saveState(true);
  const ac = new AbortController();
  let stopReason = '';
  const onSig = () => { stopReason ||= 'stopped (signal)'; ac.abort(); };
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig);
  const lastHit = new Map();
  let logged = loggedUrls();
  let changed = false, lingerUntil = 0;
  say(`queue start (pid ${process.pid}, budget ${human(BUDGET)}, delay ${DELAY / 1000} s, retries ${RETRIES}, reserve ${human(RESERVE)}, file limit ${human(MAXFILE)})`);

  // wait up to ms, waking early for a stop request or a change of the queue file
  const nap = async (ms) => {
    const t0 = Date.now(); const m0 = fs.existsSync(QUEUE) ? fs.statSync(QUEUE).mtimeMs : 0;
    while (Date.now() - t0 < ms && !stopReason) {
      if (fs.existsSync(STOP)) { stopReason = 'stopped (--stop)'; break; }
      if ((fs.existsSync(QUEUE) ? fs.statSync(QUEUE).mtimeMs : 0) !== m0) return true;
      await sleep(Math.min(5000, ms));
    }
    return false;
  };

  while (!stopReason) {
    if (fs.existsSync(STOP)) { stopReason = 'stopped (--stop)'; break; }
    const { jobs } = readQueue();
    const t = Date.now();
    const ready = (j) => {
      if (j.dupOf) return false;
      const s = state.jobs[j.key];
      return !s || s.status === 'pending' || (s.status === 'failed' && !s.final && Date.parse(s.nextTry || 0) <= t);
    };
    const job = jobs.find(ready);
    if (!job) {
      const waits = jobs.map((j) => state.jobs[j.key]).filter((s) => s?.status === 'failed' && !s.final).map((s) => Date.parse(s.nextTry));
      if (waits.length) { const ms = Math.max(1000, Math.min(...waits) - Date.now()); say(`waiting ${Math.round(ms / 1000)} s for ${waits.length} job(s) to retry`); await nap(ms); continue; }
      if (LINGER) {
        if (changed) { post('queue empty'); changed = false; }
        if (!lingerUntil) lingerUntil = Date.now() + LINGER;
        if (Date.now() < lingerUntil) { if (await nap(lingerUntil - Date.now())) lingerUntil = 0; continue; }
      }
      stopReason = 'finished';
      break;
    }
    lingerUntil = 0;
    if (run.bytes > BUDGET) { stopReason = `budget reached (${human(run.bytes)} > ${human(BUDGET)})`; break; }
    const s = (state.jobs[job.key] ||= { status: 'pending', attempts: 0 });
    s.line = job.line; s.label = label(job);

    if (isNote(job)) {
      const n = job.note;
      const have = new Set(readLines(NOTES).map(noteKey));
      if (have.has(noteKey(n))) Object.assign(s, { status: 'noted', result: 'already recorded', at: now() });
      else { note(n.maker, n.model, n.status, n.why); Object.assign(s, { status: 'noted', result: 'recorded', at: now() }); changed = true; }
      say(`NOTE ${n.maker} / ${n.model}: ${n.status} (${s.result})`);
      saveState(true);
      continue;
    }

    const prev = logged.get(job.url);
    if (prev && !flag('--recheck') && !job.recheck) {
      Object.assign(s, { status: 'have', result: 'URL already downloaded', file: prev.file, at: now() });
      say(`HAVE ${label(job)}: already downloaded as ${prev.file}`);
      saveState(true);
      continue;
    }
    const sp = spaceProblem(0);
    if (sp) { stopReason = sp; break; }
    // polite delay per host
    const host = hostOf(job.url);
    const wait = (lastHit.get(host) || 0) + DELAY - Date.now();
    if (wait > 0) await nap(wait);
    if (stopReason) break;

    s.status = 'running'; s.attempts = (s.attempts || 0) + 1; s.started = now();
    state.current = { key: job.key, label: label(job), url: job.url, started: s.started, bytes: 0, len: 0 };
    saveState(true);
    say(`GET ${label(job)} (attempt ${s.attempts}) ${job.url}`);
    const max = job.big ? Infinity : MAXFILE;
    let res;
    try {
      res = await get(job.maker, job.model, job.version || '', job.url, {
        name: job.name, note: job.note, folder: job.folder, source: job.source, htmlOk: !!job.htmlOk,
        current: !!job.current, supersedes: job.supersedes, currentKey: job.currentKey,
        ua: job.ua || UA, maxBytes: max, signal: ac.signal,
        checkSpace: (len) => spaceProblem(len),
        onProgress: (b, len) => { state.current.bytes = b; state.current.len = len; saveState(false); },
      });
    } catch (e) { res = { status: 'fail', msg: `FAIL ${e.message} ${job.url}`, bytes: 0, permanent: false }; }
    lastHit.set(host, Date.now());
    run.bytes += res.bytes || 0;
    delete state.current;
    s.finished = now(); s.bytes = res.bytes || 0;
    if (res.status === 'ok') { Object.assign(s, { status: 'ok', file: res.rec.file, size: res.rec.size, error: undefined }); run.files++; changed = true; logged = loggedUrls(); }
    else if (res.status === 'have') Object.assign(s, { status: 'have', result: 'same file already in the collection', file: path.relative(FW, res.dup).replace(/\\/g, '/'), error: undefined });
    else if (res.status === 'skip') Object.assign(s, { status: 'skipped', error: res.msg.replace(/ https?:\S+$/, '') + ' (add "big": true to the job to allow it)' });
    else if (res.status === 'space') { s.status = 'pending'; s.attempts--; stopReason = res.msg; }
    else if (res.stopped || stopReason) { s.status = 'pending'; s.attempts--; }
    else {
      const err = res.msg.replace(/^FAIL /, '').replace(/ https?:\S+$/, '');
      const final = res.permanent || s.attempts >= RETRIES;
      const back = res.retryAfter ? res.retryAfter * 1000 : BACKOFF[Math.min(s.attempts - 1, BACKOFF.length - 1)];
      Object.assign(s, { status: 'failed', error: err, final, nextTry: final ? undefined : new Date(Date.now() + back).toISOString() });
    }
    // "haveNote": a note with status have for this maker + model, written once the file is in the collection
    if (job.haveNote && (s.status === 'ok' || s.status === 'have')) {
      const n = { maker: job.maker, model: job.model, status: 'have', why: job.haveNote };
      if (!new Set(readLines(NOTES).map(noteKey)).has(noteKey(n))) { note(n.maker, n.model, n.status, n.why); changed = true; }
    }
    say(`${res.msg}${s.status === 'failed' ? (s.final ? ' [final]' : ` [retry after ${s.nextTry}]`) : ''}`);
    saveState(true);
  }

  run.ended = now(); run.reason = stopReason || 'finished';
  delete state.current; saveState(true);
  say(`queue end: ${run.reason}; ${run.files} new files, ${human(run.bytes)} downloaded this run`);
  if (!flag('--no-post')) post(run.reason); else writeReport();
  try { const l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (l.pid === process.pid) fs.rmSync(LOCK); } catch {}
  if (fs.existsSync(STOP)) fs.rmSync(STOP);
}

if (flag('--status')) status();
else if (flag('--dry-run')) dryRun();
else if (flag('--stop')) { fs.writeFileSync(STOP, now()); console.log(`stop requested: the runner stops after the current file (${STOP})`); }
else if (flag('--post')) { post('--post'); }
else await runQueue();
