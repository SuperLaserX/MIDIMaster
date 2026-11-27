// Disk Import: load programs, keymaps and samples from .KRZ/.K25/.K26 files and from
// Kurzweil disk and CD images (.iso, .bin + .cue, .img), then send them to the K2000.

import { h, clear, toast, confirmDialog, pickFiles } from '../../../core/ui/dom.js';
import { T, typeName } from '../model/types.js';
import { Soundblock } from '../model/soundblock.js';
import { BlobSource } from '../../../core/disk/source.js';
import { openImage, IMAGE_FILE, CUE_FILE } from '../../../core/disk/image.js';
import { parseCue, firstDataTrack } from '../../../core/disk/cue.js';
import { readKrz, readAudio, findKurzweilFiles, KURZWEIL_FILE } from '../disk/krz.js';
import { describeObjects, closure, buildPlan, createImportJob } from '../disk/importer.js';
import { buildDemoKrz } from '../demo.js';

const ACCEPT = '.krz,.k25,.k26,.iso,.bin,.cue,.img,.ima';
const MODES = [
  { value: 'keep', label: 'Keep the IDs from the file' },
  { value: 'free', label: 'Use the next free IDs from 200' },
  { value: 'bank', label: 'Move to bank...' },
];

// Kept between visits so loaded files and a running import survive page changes.
const session = {
  sources: [],
  current: null, // {label, krz, items, selected:Set}
  options: { mode: 'keep', bank: 2, convert: false },
  existing: null, // Map type -> Set of RAM IDs
  existingNames: new Map(),
  filter: '',
  typeFilter: 'all',
  job: null,
  jobState: null, // {total, index, fraction, text, log: [], result}
  nextId: 1,
  openNext: null, // source id to open when the page is shown (Head Library hand-over)
};

/**
 * Add a Kurzweil file built in memory (from Head Library patches, see disk/mainlib.js) to the
 * sources; it opens when the Disk Import page is shown next.
 */
export function addMemorySource(name, krz) {
  const s = { id: session.nextId++, kind: 'memory', status: 'ready', files: [], name, path: `Head Library: ${name}`, krz, size: krz.size + krz.objects.reduce((n, o) => n + o.data.length, 0) };
  session.sources.push(s);
  session.openNext = s.id;
  return s;
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 104857600 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const fmtTime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);
const objTypeName = (type) => (type >= 140 && type < 150 ? `K2600 type ${type}` : typeName(type));

let preview = null; // {node, key}
let audioCtx = null;
function stopPreview() {
  try { preview?.node.stop(); } catch { /* already stopped */ }
  preview = null;
}

export function diskImportView(root, app) {
  let alive = true;
  const left = h('div.col.imp-sources');
  const right = h('div.col.imp-detail');
  const dropzone = h('div.dropzone.imp-drop', 'Drop .KRZ, .K25, .K26, .iso, .bin + .cue or .img files here');

  root.append(
    h('h1', 'Disk Import'),
    h('div.sub', 'Load programs, keymaps and samples from Kurzweil files and disk or CD images on this computer, choose what you need, and send it to the K2000 over MIDI. Samples travel as Sample Dumps, which take about a minute per second of 44.1 kHz audio.'),
    h('div.card.row', { style: { marginBottom: '12px' } },
      h('button.btn.primary', { onclick: openFiles }, 'Open files...'),
      h('button.btn', { onclick: openFolder, title: 'Scan a folder (and its subfolders) for Kurzweil files and disc images' }, 'Open folder...'),
      app.demo ? h('button.btn', { onclick: () => addFiles([{ file: buildDemoKrz(), path: 'DEMO.KRZ' }]), title: 'A small generated file for trying the import in demo mode' }, 'Load demo file') : null,
      dropzone),
    h('div.imp-grid', left, right));

  // ------------------------------------------------------------ adding sources
  async function openFiles() {
    const files = await pickFiles(ACCEPT, true);
    if (files?.length) addFiles([...files].map((f) => ({ file: f, path: f.name })));
  }

  async function openFolder() {
    if (window.showDirectoryPicker) {
      let dir;
      try { dir = await window.showDirectoryPicker({ mode: 'read' }); } catch { return; }
      const found = [];
      const walk = async (handle, path, depth) => {
        if (depth > 8 || found.length > 5000) return;
        for await (const entry of handle.values()) {
          const p = path ? `${path}/${entry.name}` : entry.name;
          if (entry.kind === 'directory') await walk(entry, p, depth + 1);
          else if (KURZWEIL_FILE.test(entry.name) || IMAGE_FILE.test(entry.name) || CUE_FILE.test(entry.name)) found.push({ file: await entry.getFile(), path: p });
        }
      };
      toast(`Scanning ${dir.name}...`, 'info', 1500);
      await walk(dir, dir.name, 0);
      if (!found.length) { toast('No Kurzweil files or disc images in that folder', 'warn'); return; }
      addFiles(found);
      return;
    }
    // Fallback for browsers without the File System Access API.
    const inp = h('input', { type: 'file', multiple: true });
    inp.webkitdirectory = true;
    inp.onchange = () => addFiles([...inp.files].filter((f) => KURZWEIL_FILE.test(f.name) || IMAGE_FILE.test(f.name) || CUE_FILE.test(f.name))
      .map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
    inp.click();
  }

  root.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) dropzone.classList.remove('over'); });
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addFiles(files.map((f) => ({ file: f, path: f.name })));
  });

  async function addFiles(list) {
    const cues = list.filter((x) => CUE_FILE.test(x.file.name));
    const used = new Set();
    const lower = (s) => s.toLowerCase();
    // Pair each cue sheet with its .bin by file name (cue paths are from the ripping machine).
    for (const c of cues) {
      let text = '';
      try { text = await c.file.text(); } catch { continue; }
      const track = firstDataTrack(parseCue(text));
      const wanted = track ? lower(track.fileName) : lower(c.file.name.replace(/\.cue$/i, '.bin'));
      const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/') + 1) : '';
      const bin = list.find((x) => !used.has(x) && lower(x.file.name) === wanted && (x.path.startsWith(dir) || !dir))
        || list.find((x) => !used.has(x) && lower(x.file.name) === wanted);
      if (!bin) { toast(`${c.file.name}: add ${track?.fileName || 'its .bin file'} together with the cue sheet`, 'warn', 6000); continue; }
      used.add(bin);
      addSource({ kind: 'image', name: c.file.name.replace(/\.cue$/i, ''), path: c.path, file: bin.file, cueText: text });
    }
    for (const x of list) {
      if (used.has(x) || CUE_FILE.test(x.file.name)) continue;
      if (KURZWEIL_FILE.test(x.file.name)) addSource({ kind: 'krz', name: x.file.name, path: x.path, file: x.file });
      else if (IMAGE_FILE.test(x.file.name)) addSource({ kind: 'image', name: x.file.name, path: x.path, file: x.file });
    }
    renderSources();
  }

  function addSource(src) {
    if (session.sources.some((s) => s.file && s.path === src.path && s.file.size === src.file.size)) return;
    const s = { id: session.nextId++, status: src.kind === 'image' ? 'scanning' : 'ready', files: [], expanded: true, ...src };
    session.sources.push(s);
    if (s.kind === 'image') scanImage(s);
  }

  async function scanImage(s) {
    try {
      const img = await openImage(s.file, { cueText: s.cueText, name: s.name });
      s.volume = img.volume;
      s.layout = img.layout;
      s.files = await findKurzweilFiles(img.volume);
      s.status = 'ready';
    } catch (err) {
      s.status = 'error';
      s.error = err.message;
    }
    if (alive) renderSources();
  }

  // ------------------------------------------------------------ source list
  const filterInp = h('input', {
    type: 'text', placeholder: 'Filter files', value: session.filter,
    oninput: () => { session.filter = filterInp.value; renderSources(); },
  });

  function renderSources() {
    if (!alive) return;
    const f = session.filter.trim().toLowerCase();
    const match = (s) => !f || s.toLowerCase().includes(f);
    const rows = [];
    for (const s of session.sources) {
      const remove = h('button.icon-btn.small', {
        title: 'Remove from the list',
        onclick: (e) => { e.stopPropagation(); session.sources = session.sources.filter((x) => x !== s); if (session.current?.sourceId === s.id) session.current = null; renderSources(); renderDetail(); },
      }, '×');
      if (s.kind === 'memory') {
        if (!match(s.path)) continue;
        rows.push(h('div.imp-src' + (session.current?.key === `m${s.id}` ? '.sel' : ''), { onclick: () => openKrz(`m${s.id}`, s.path, { parsed: s.krz }, s.id), title: `${s.path}
From the Head Library` },
          h('span.imp-ico', '❖'), h('span.grow.imp-name', s.name), h('span.small.muted', fmtBytes(s.size)), remove));
        continue;
      }
      if (s.kind === 'krz') {
        if (!match(s.path)) continue;
        rows.push(h('div.imp-src' + (session.current?.key === `k${s.id}` ? '.sel' : ''), { onclick: () => openKrz(`k${s.id}`, s.path, new BlobSource(s.file, s.name), s.id), title: s.path },
          h('span.imp-ico', 'K'), h('span.grow.imp-name', s.name), h('span.small.muted', fmtBytes(s.file.size)), remove));
        continue;
      }
      const files = s.files.filter((x) => match(x.path) || match(s.name));
      if (f && !files.length && !match(s.name)) continue;
      const info = s.status === 'scanning' ? 'scanning...'
        : s.status === 'error' ? s.error
          : `${s.volume.kind}${s.volume.label ? ` "${s.volume.label}"` : ''}, ${s.files.length} Kurzweil file${s.files.length === 1 ? '' : 's'}`;
      rows.push(h('div.imp-src.imp-image', { onclick: () => { s.expanded = !s.expanded; renderSources(); }, title: `${s.path}${s.layout ? `\n${s.layout.description}` : ''}` },
        h('span.imp-ico', s.expanded ? '▾' : '▸'), h('span.grow.imp-name', s.name, h('div.small.muted', info)), h('span.small.muted', fmtBytes(s.file.size)), remove));
      if (s.expanded && s.status === 'ready') {
        for (const x of files.slice(0, 2000)) {
          const key = `i${s.id}:${x.path}`;
          rows.push(h('div.imp-src.imp-child' + (session.current?.key === key ? '.sel' : ''), {
            title: x.path,
            onclick: () => openKrz(key, `${s.name}: ${x.path}`, s.volume.fileSource(x.entry), s.id),
          }, h('span.grow.imp-name', x.path), h('span.small.muted', fmtBytes(x.entry.size))));
        }
        if (files.length > 2000) rows.push(h('div.small.muted', `${files.length - 2000} more; use the filter.`));
      }
    }
    clear(left).append(
      h('div.card.col',
        h('div.row', h('h2.grow', 'Files'), filterInp),
        rows.length ? h('div.imp-list', rows) : h('div.empty.small', session.sources.length ? 'Nothing matches the filter.' : 'Open .KRZ, .K25 or .K26 files, or a disc image. Folders are scanned for both.')));
  }

  // ------------------------------------------------------------ one file
  async function openKrz(key, label, src, sourceId) {
    if (session.job) { toast('Wait for the import to finish', 'warn'); return; }
    stopPreview();
    session.current = { key, label, loading: true, sourceId };
    renderSources();
    renderDetail();
    try {
      const krz = src.parsed || (await readKrz(src));
      const items = describeObjects(krz);
      // Start with everything that can be imported selected.
      const selected = new Set(items.filter((i) => i.status === 'ok').map((i) => i.key));
      if (session.current?.key === key) session.current = { key, label, krz, items, selected, sourceId };
    } catch (err) {
      if (session.current?.key === key) session.current = { key, label, error: err.message, sourceId };
    }
    renderDetail();
    if (app.online && !session.existing) checkK2000();
  }

  async function checkK2000() {
    if (!app.online) { toast('Connect to the K2000 first', 'warn'); return; }
    try {
      const existing = new Map();
      for (const type of [T.PROGRAM, T.KEYMAP, T.SOUNDBLOCK, T.SETUP, T.EFFECT]) {
        const list = await app.client.dirBank(type, 127, true);
        existing.set(type, new Set(list.filter((m) => m.inRam !== false).map((m) => m.id)));
        for (const m of list) session.existingNames.set(`${type}:${m.id}`, m.objName);
      }
      session.existing = existing;
      await app.refreshMemory();
    } catch (err) { app.error(err, 'Reading the K2000'); }
    if (alive) renderDetail();
  }

  async function play(it) {
    if (preview?.key === it.key) { stopPreview(); renderDetail(); return; }
    stopPreview();
    try {
      const b = new Soundblock(it.data);
      const hs = (b.stereo ? b.headers.slice(0, 2) : b.headers.slice(0, 1)).filter((hd) => hd.inRam);
      if (!hs.length) { toast('This soundblock uses ROM sample data; there is no audio in the file.', 'info'); return; }
      const rate = hs[0].rate || 44100;
      const frames = Math.min(...hs.map((hd) => hd.end - hd.start + 1), rate * 30);
      audioCtx = audioCtx || new AudioContext();
      const ctx = audioCtx;
      if (ctx.state === 'suspended') await ctx.resume();
      const buf = ctx.createBuffer(hs.length, frames, rate);
      for (let c = 0; c < hs.length; c++) {
        const pcm = await readAudio(session.current.krz, hs[c].start, frames);
        const ch = buf.getChannelData(c);
        for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      }
      const node = ctx.createBufferSource();
      node.buffer = buf;
      const hd = hs[0];
      if (hd.looped && hd.loopStart > hd.start && hd.loopStart - hd.start < frames) {
        node.loop = true;
        node.loopStart = (hd.loopStart - hd.start) / rate;
        node.loopEnd = frames / rate;
      }
      node.connect(ctx.destination);
      node.start();
      if (node.loop) node.stop(ctx.currentTime + Math.max(3, frames / rate));
      preview = { node, key: it.key };
      node.onended = () => { if (preview?.node === node) { preview = null; if (alive) renderDetail(); } };
      renderDetail();
    } catch (err) { app.error(err, 'Preview'); }
  }

  function itemInfo(it) {
    if (it.audio) {
      if (it.audio.romOnly) return 'uses ROM sample data';
      return `${it.audio.seconds.toFixed(2)} s, ${it.audio.rate} Hz${it.audio.stereo ? ', stereo' : ''}${it.audio.headers > (it.audio.stereo ? 2 : 1) ? `, ${it.audio.headers} sub-samples` : ''}, ${fmtBytes(it.audio.words * 2)}`;
    }
    if (it.type === T.KEYMAP) return it.refs?.length ? `samples ${it.refs.map((k) => k.split(':')[1]).join(', ')}` : '';
    if (it.type === T.PROGRAM) return it.refs?.length ? `keymap${it.refs.length > 1 ? 's' : ''} ${it.refs.map((k) => k.split(':')[1]).join(', ')}` : '';
    return '';
  }

  function renderDetail() {
    if (!alive) return;
    clear(right);
    const cur = session.current;
    if (session.jobState) right.append(renderJob());
    if (!cur) {
      if (!session.jobState) right.append(h('div.card', h('div.empty', 'Choose a file on the left to see what it contains.')));
      return;
    }
    if (cur.loading) { right.append(h('div.card', h('div.empty', `Reading ${cur.label}...`))); return; }
    if (cur.error) { right.append(h('div.notice.bad', `${cur.label}: ${cur.error}`)); return; }
    const { krz, items, selected } = cur;
    const need = closure(items, selected);
    const counts = (pred) => items.filter(pred).length;
    const groups = [
      ['all', 'All', () => true],
      ['program', 'Programs', (i) => i.type === T.PROGRAM],
      ['keymap', 'Keymaps', (i) => i.type === T.KEYMAP],
      ['sample', 'Samples', (i) => i.type === T.SOUNDBLOCK],
      ['other', 'Other', (i) => ![T.PROGRAM, T.KEYMAP, T.SOUNDBLOCK].includes(i.type)],
    ].filter(([k, , p]) => k === 'all' || counts(p));
    const groupPred = (groups.find(([k]) => k === session.typeFilter) || groups[0])[2];
    const visible = items.filter(groupPred);

    const head = h('div.card.col',
      h('div.row', h('h2.grow', cur.label),
        h('span.badge', `${items.length} objects`),
        krz.audioBytes ? h('span.badge', `${fmtBytes(krz.audioBytes)} of audio`) : null,
        krz.osVersion ? h('span.badge', `saved by OS ${krz.osVersion.toFixed(2)}`) : null),
      ...krz.warnings.map((w) => h('div.small', { style: { color: 'var(--warn)' } }, w)),
      h('div.tabs', { style: { marginBottom: 0 } }, groups.map(([k, label, p]) => h('button' + (k === session.typeFilter ? '.active' : ''),
        { onclick: () => { session.typeFilter = k; renderDetail(); } }, `${label} (${counts(p)})`))));

    const allBox = h('input', { type: 'checkbox', title: 'Select or clear the visible rows' });
    const selectable = visible.filter((i) => i.status !== 'unsupported');
    allBox.checked = selectable.length > 0 && selectable.every((i) => selected.has(i.key));
    allBox.onchange = () => { for (const i of selectable) if (allBox.checked) selected.add(i.key); else selected.delete(i.key); renderDetail(); };

    const rows = visible.map((it) => {
      const box = h('input', { type: 'checkbox', checked: selected.has(it.key), disabled: it.status === 'unsupported' });
      box.onchange = () => { if (box.checked) selected.add(it.key); else selected.delete(it.key); renderDetail(); };
      let status;
      if (it.status === 'unsupported') status = h('span.small', { style: { color: 'var(--bad)' }, title: it.issue }, it.issue);
      else if (it.status === 'convert') status = h('span.small', { style: { color: 'var(--warn)' }, title: it.issue }, `needs conversion: ${it.issue}`);
      else if (!selected.has(it.key) && need.has(it.key)) status = h('span.small', { style: { color: 'var(--info)' } }, 'needed by the selection');
      else status = h('span.small.muted', it.external?.length ? `also uses ${it.external.length} object${it.external.length > 1 ? 's' : ''} not in this file` : '');
      const playing = preview?.key === it.key;
      return h('tr' + (selected.has(it.key) || need.has(it.key) ? '.sel' : ''),
        h('td', box),
        h('td', objTypeName(it.type)),
        h('td.mono', String(it.id)),
        h('td', it.name || h('span.muted', '(no name)')),
        h('td.mono.small', fmtBytes(it.size)),
        h('td.small', itemInfo(it)),
        h('td', status),
        h('td', it.audio && !it.audio.romOnly && it.status !== 'unsupported'
          ? h('button.btn.small', { onclick: () => play(it), title: 'Listen on this computer' }, playing ? '■' : '▶') : null));
    });

    right.append(head,
      h('div.table-wrap.imp-table', h('table.list',
        h('thead', h('tr', h('th', allBox), h('th', 'Type'), h('th', 'ID'), h('th', 'Name'), h('th', 'Size'), h('th', 'Details'), h('th', 'Status'), h('th', ''))),
        h('tbody', rows))),
      renderPlan(cur));
  }

  // ------------------------------------------------------------ plan and send
  function renderPlan(cur) {
    const opt = session.options;
    const plan = buildPlan(cur.items, cur.selected, { ...opt, existing: session.existing || new Map() });
    const modeSel = h('select', { onchange: () => { opt.mode = modeSel.value; renderDetail(); } },
      MODES.map((m) => h('option', { value: m.value, selected: m.value === opt.mode }, m.label)));
    const bankSel = h('select', { onchange: () => { opt.bank = Number(bankSel.value); renderDetail(); } },
      [2, 3, 4, 5, 6, 7, 8, 9].map((b) => h('option', { value: b, selected: b === opt.bank }, `Bank ${b} (${b}00-${b}99)`)));
    const convert = h('input', { type: 'checkbox', checked: opt.convert, onchange: () => { opt.convert = convert.checked; renderDetail(); } });

    const mem = app.memory;
    const sampleFree = mem ? mem.sampleFreeK * 1024 : null;
    const progFree = mem ? mem.programFreeK * 1024 : null;
    const tooBig = sampleFree !== null && plan.audioBytes > sampleFree;
    const progTooBig = progFree !== null && plan.objectBytes > progFree;
    const samples = plan.steps.filter((s) => s.sample).length;
    const lines = [];
    lines.push(`${plan.steps.length} object${plan.steps.length === 1 ? '' : 's'} to send${samples ? `, ${samples} with audio (${fmtBytes(plan.audioBytes)})` : ''}. About ${fmtTime(plan.seconds)}.`);
    if (mem) lines.push(`K2000 free memory: ${fmtBytes(sampleFree)} sample RAM, ${fmtBytes(progFree)} program RAM.`);
    else lines.push('Free memory on the K2000 is unknown. Use "Check K2000" before sending.');

    const notes = [];
    if (tooBig) notes.push(h('div.notice.bad', `The audio (${fmtBytes(plan.audioBytes)}) does not fit in the free sample RAM (${fmtBytes(sampleFree)}).`));
    if (progTooBig) notes.push(h('div.notice.bad', `The objects (${fmtBytes(plan.objectBytes)}) may not fit in the free program RAM (${fmtBytes(progFree)}).`));
    if (plan.replacements.length) {
      notes.push(h('div.notice.warn', `Replaces ${plan.replacements.length} object${plan.replacements.length === 1 ? '' : 's'} in K2000 RAM: `,
        plan.replacements.slice(0, 12).map((s) => `${typeName(s.type)} ${s.newId}${session.existingNames.get(`${s.type}:${s.newId}`) ? ` "${session.existingNames.get(`${s.type}:${s.newId}`)}"` : ''}`).join(', '),
        plan.replacements.length > 12 ? ', ...' : '', '. Choose free IDs or another bank to keep them.'));
    }
    if (plan.skipped.length) {
      notes.push(h('div.notice', `Not sent (${plan.skipped.length}): `,
        plan.skipped.slice(0, 8).map((s) => `${objTypeName(s.item.type)} ${s.item.id} "${s.item.name}" (${s.reason})`).join('; '),
        plan.skipped.length > 8 ? '; ...' : ''));
    }
    for (const w of plan.warnings) notes.push(h('div.notice.warn', w));
    if (samples) notes.push(h('div.small.muted', 'Each sample is sent by Sample Dump into a temporary ID from 999 down, then written to its final ID with all its settings. The K2000 never gives sample RAM back until Delete Everything or a restart, so a cancelled import leaves its audio allocated.'));

    const busy = !!session.job;
    const sendBtn = h('button.btn.primary', { disabled: busy || !plan.steps.length, onclick: () => start(plan, cur) }, 'Send to K2000');
    return h('div.card.col.imp-plan',
      h('div.row',
        h('label.field', 'IDs on the K2000', modeSel),
        opt.mode === 'bank' ? h('label.field', 'Bank', bankSel) : null,
        h('label.row.small', { title: 'K2500 and K2600 programs: drop what the K2000 lacks (KDFX, KB3, extra layers) and mark them as K2000 programs. Results vary.' },
          convert, 'Convert K2500/K2600 programs (experimental)'),
        h('span.grow'),
        h('button.btn', { onclick: checkK2000, disabled: busy }, 'Check K2000'),
        sendBtn),
      h('div.small', lines.join(' ')),
      ...notes);
  }

  async function start(plan, cur) {
    if (!app.online) { toast('Connect to the K2000 first', 'warn'); return; }
    if (!session.existing) await checkK2000();
    const fresh = buildPlan(cur.items, cur.selected, { ...session.options, existing: session.existing || new Map() });
    const free = app.memory ? app.memory.sampleFreeK * 1024 : Infinity;
    if (fresh.audioBytes > free && !(await confirmDialog('Not enough sample RAM', `The audio needs ${fmtBytes(fresh.audioBytes)} but the K2000 reports ${fmtBytes(free)} free. Samples that do not fit will fail. Send anyway?`, 'Send anyway', true))) return;
    if (fresh.replacements.length && !(await confirmDialog('Replace objects?', `${fresh.replacements.length} object(s) in K2000 RAM will be replaced. Continue?`, 'Replace', true))) return;
    stopPreview();
    const js = { total: fresh.steps.length, index: 0, fraction: 0, text: 'Starting...', log: [], result: null, started: performance.now() };
    session.jobState = js;
    const job = createImportJob(fresh, {
      client: app.client,
      transport: app.transport,
      deviceId: app.client.dev,
      krz: cur.krz,
      existing: session.existing,
      setExclusive: (v) => { app.exclusive = v; },
      log: (text, kind) => { js.log.push({ text, kind }); updateJob(); },
      progress: (p) => { js.index = p.index; js.fraction = p.fraction; js.text = p.text; updateJob(); },
    });
    session.job = job;
    renderDetail();
    let result;
    try { result = await job.run(); } catch (err) { result = { done: [], failed: [{ error: err }], cancelled: false }; js.log.push({ text: err.message, kind: 'bad' }); }
    js.result = result;
    session.job = null;
    app.exclusive = false;
    session.existing = null;
    const msg = `${result.done.length} of ${js.total} object(s) sent${result.failed.length ? `, ${result.failed.length} failed` : ''}${result.cancelled ? ', cancelled' : ''}.`;
    toast(msg, result.failed.length || result.cancelled ? 'warn' : 'good', 6000);
    app.refreshMemory();
    if (alive) { renderDetail(); checkK2000(); }
  }

  let jobEls = null;
  function renderJob() {
    const js = session.jobState;
    const bar = h('div');
    const text = h('div.small');
    const log = h('div.imp-log');
    const running = !!session.job;
    const box = h('div.card.col',
      h('div.row', h('h2.grow', running ? 'Sending to the K2000' : 'Import finished'),
        running ? h('button.btn.small.danger', { onclick: () => { session.job?.cancel(); text.textContent = 'Cancelling...'; } }, 'Cancel')
          : h('button.btn.small', { onclick: () => { session.jobState = null; renderDetail(); } }, 'Close')),
      h('div.progress', bar), text, log);
    jobEls = { bar, text, log, rendered: -1 };
    updateJob();
    return box;
  }

  function updateJob() {
    const js = session.jobState;
    if (!js || !jobEls || !alive) return;
    const frac = js.total ? (js.index + Math.min(1, js.fraction)) / js.total : 1;
    jobEls.bar.style.width = `${Math.round((js.result ? 1 : frac) * 100)}%`;
    jobEls.text.textContent = js.result
      ? `${js.result.done.length} of ${js.total} sent${js.result.failed.length ? `, ${js.result.failed.length} failed` : ''}${js.result.cancelled ? ' (cancelled)' : ''}.`
      : `${js.index + 1} of ${js.total}: ${js.text}`;
    if (jobEls.rendered !== js.log.length) {
      jobEls.rendered = js.log.length;
      clear(jobEls.log).append(...js.log.slice(-200).map((l) => h('div.ln', { style: { color: l.kind === 'bad' ? 'var(--bad)' : l.kind === 'warn' ? 'var(--warn)' : l.kind === 'good' ? 'var(--good)' : '' } }, l.text)));
      jobEls.log.scrollTop = jobEls.log.scrollHeight;
    }
  }

  renderSources();
  renderDetail();
  if (session.openNext) {
    const s = session.sources.find((x) => x.id === session.openNext);
    session.openNext = null;
    if (s && !session.job) openKrz(`m${s.id}`, s.path, { parsed: s.krz }, s.id);
  }
  return {
    destroy() {
      alive = false;
      jobEls = null;
      stopPreview();
    },
  };
}
