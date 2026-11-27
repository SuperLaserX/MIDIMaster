// Sample manager: list soundblocks, edit sample headers live, transfer audio
// with MIDI Sample Dump Standard, rename sub-samples and split soundblocks.

import { h, clear, toast, formDialog, confirmDialog, downloadBlob, pickFiles, safeFileName } from '../../../core/ui/dom.js';
import { T } from '../model/types.js';
import { Soundblock } from '../model/soundblock.js';
import { noteName, parseNoteName } from '../model/tables.js';
import { SampleDump, sdsSampleNumber, sdsTransferSeconds } from '../../../core/midi/sds.js';
import { sdsNumberForId } from '../sds-ids.js';
import { parseWav, floatToInt16, mixToMono, writeWav, resampleLinear } from '../../../core/wav.js';
import { sleep } from '../../../core/bits.js';

export function samplesView(root, app, params = {}) {
  const st = { items: [], selected: params.id ?? null, block: null, busy: false, sds: null };
  const listWrap = h('div.table-wrap', { style: { maxHeight: 'calc(100vh - 210px)' } });
  const detail = h('div.grow', { style: { minWidth: 0 } });
  const filter = h('input', { type: 'text', placeholder: 'Filter', oninput: () => renderList() });

  root.append(
    h('h1', 'Samples'),
    h('div.sub', 'Soundblocks on the K2000. RAM samples can be edited, downloaded as WAV and replaced. Audio moves over MIDI at about 1,000 samples per second, so one second of 44.1 kHz audio takes roughly 45 seconds.'),
    h('div.row', { style: { alignItems: 'flex-start', flexWrap: 'nowrap', gap: '16px' } },
      h('div', { style: { width: '300px', flex: '0 0 300px' } },
        h('div.row', { style: { marginBottom: '8px' } }, filter, h('button.btn', { onclick: refresh }, 'Refresh')),
        h('div.row', { style: { marginBottom: '8px' } }, h('button.btn.primary.grow', { onclick: () => uploadWav() }, 'Upload WAV...')),
        listWrap),
      detail));

  async function refresh() {
    if (!app.online) { clear(listWrap).append(h('div.empty', 'Not connected.')); return; }
    clear(listWrap).append(h('div.empty', 'Reading samples...'));
    try {
      const items = await app.client.dirBank(T.SOUNDBLOCK, 127, false);
      items.forEach((i) => app.rememberInfo(i));
      st.items = items.filter((i) => i.size > 0).sort((a, b) => a.id - b.id);
      renderList();
      if (st.selected) openSample(st.selected);
    } catch (err) { clear(listWrap).append(h('div.empty', err.message)); }
  }

  function renderList() {
    const f = filter.value.toLowerCase();
    const rows = st.items.filter((i) => !f || i.objName.toLowerCase().includes(f) || String(i.id).startsWith(f));
    clear(listWrap).append(h('table.list', h('tbody', rows.map((i) => h('tr' + (i.id === st.selected ? '.sel' : ''), {
      style: { cursor: 'pointer' }, onclick: () => openSample(i.id),
    }, h('td.mono.muted', String(i.id)), h('td', i.objName), h('td', h('span.badge.' + (i.inRam ? 'ram' : 'rom'), i.inRam ? 'RAM' : 'ROM')))))));
    if (!rows.length) listWrap.append(h('div.empty', 'No samples'));
  }

  async function openSample(id) {
    st.selected = id;
    renderList();
    clear(detail).append(h('div.empty', `Reading sample ${id}...`));
    try {
      const obj = await app.client.fetchObject(T.SOUNDBLOCK, id);
      st.block = new Soundblock(obj.data, { id, name: obj.name });
      st.block.inRam = obj.inRam;
      renderDetail();
    } catch (err) { clear(detail).append(h('div.notice.bad', err.message)); }
  }

  function patchLive(patch) {
    if (!patch) return;
    app.client.load(T.SOUNDBLOCK, st.block.id, patch.offset, patch.bytes, { key: `s${st.block.id}:${patch.offset}` })
      .catch((err) => app.error(err, 'Sample edit'));
  }

  function renderDetail() {
    const b = st.block;
    const ram = b.inRam;
    clear(detail).append(
      h('div.card',
        h('div.card-head', h('h2', `#${b.id} ${b.name}`),
          h('span.badge.' + (ram ? 'ram' : 'rom'), ram ? 'RAM' : 'ROM'),
          b.stereo ? h('span.badge', 'Stereo') : null,
          h('span.badge', `${b.headers.length} sub-sample${b.headers.length === 1 ? '' : 's'}`)),
        h('div.row',
          ram ? h('button.btn', { onclick: renameBlock }, 'Rename') : null,
          ram ? h('button.btn', { onclick: downloadAll }, b.stereo ? 'Download stereo WAV' : 'Download WAV') : null,
          ram ? h('button.btn', { onclick: () => uploadWav(b.id) }, 'Replace with WAV...') : null,
          ram && b.headers.length > 1 ? h('button.btn', { onclick: splitBlock, title: 'Make one new soundblock from each sub-sample. The K2000 has no front-panel button for this; the original stays.' }, 'Split into single samples...') : null,
          ram ? h('button.btn.danger', { onclick: deleteBlock }, 'Delete') : null),
        !ram ? h('p.small.muted', 'Factory ROM samples are copy protected: the K2000 does not dump them and their headers cannot be changed.') : null),
      h('div.section-title', 'Sub-samples'),
      h('div.grid.cols-2', b.headers.map((hd) => headerCard(hd, ram))));
  }

  function headerCard(hd, ram) {
    const b = st.block;
    const rootInp = h('input', {
      type: 'text', value: noteName(hd.rootKey), size: 5, disabled: !ram,
      onchange: () => {
        const v = /^[0-9]+$/.test(rootInp.value) ? Number(rootInp.value) : parseNoteName(rootInp.value);
        if (v === null || v < 0 || v > 127) { rootInp.value = noteName(hd.rootKey); return; }
        hd.rootKey = v; rootInp.value = noteName(v);
        patchLive(b.setRootKey(hd, v));
      },
    });
    const vol = h('input', {
      type: 'number', step: 0.5, min: -64, max: 63.5, value: hd.volAdjust, disabled: !ram,
      onchange: () => patchLive(b.setVolAdjust(hd, Number(vol.value))),
    });
    const loop = h('button.btn.small.toggle' + (hd.looped ? '.on' : ''), {
      disabled: !ram,
      onclick: () => { hd.looped = !hd.looped; loop.classList.toggle('on', hd.looped); loop.textContent = hd.looped ? 'Looped' : 'One-shot'; patchLive(b.setLooped(hd, hd.looped)); },
    }, hd.looped ? 'Looped' : 'One-shot');
    const nameInp = h('input', {
      type: 'text', value: hd.subName, placeholder: '(no name)', maxlength: 31, disabled: !ram,
      onchange: () => app.client.setSubsampleName(b.id, hd.index, nameInp.value).then(() => toast('Sub-sample renamed', 'good', 1500)),
    });
    return h('div.card',
      h('div.card-head', h('h2', `Sub-sample ${hd.index + 1}${b.stereo ? (hd.index % 2 ? ' (R)' : ' (L)') : ''}`),
        ram ? h('button.btn.small', { onclick: () => downloadOne(hd) }, 'WAV') : null),
      h('div.row',
        h('label.field', 'Root key', rootInp),
        h('label.field', 'Volume adj (dB)', vol),
        h('label.field', 'Loop', loop),
        h('label.field', 'Name', nameInp)),
      h('table.list.small', { style: { marginTop: '8px' } }, h('tbody',
        h('tr', h('td.muted', 'Sample rate'), h('td.mono', `${hd.rate} Hz`), h('td.muted', 'Length'), h('td.mono', `${hd.frames} (${hd.seconds.toFixed(3)} s)`)),
        h('tr', h('td.muted', 'Start'), h('td.mono', String(hd.start)), h('td.muted', 'Alt start'), h('td.mono', String(hd.altStart))),
        h('tr', h('td.muted', 'Loop start'), h('td.mono', String(hd.loopStart)), h('td.muted', 'End'), h('td.mono', String(hd.end))),
        h('tr', h('td.muted', 'Max pitch'), h('td.mono', `${hd.maxPitch} ct`), h('td.muted', 'Flags'), h('td.mono', '0x' + hd.flags.toString(16))))));
  }

  // ------------------------------------------------------------ SDS transfers
  async function withSds(fn) {
    if (st.busy) { toast('A transfer is already running', 'warn'); return null; }
    st.busy = true;
    while (app.client.pending) await sleep(100); // let queued messages finish
    await sleep(app.settings.minGap);
    const sds = new SampleDump(app.transport, app.settings.deviceId);
    st.sds = sds;
    app.exclusive = true; // keeps the front panel from polling during the transfer
    const bar = h('div');
    const label = h('div.small');
    const cancel = h('button.btn.small.danger', { onclick: () => sds.cancel() }, 'Cancel');
    const box = h('div.card', { style: { marginBottom: '12px' } }, h('div.row', label, h('span.grow'), cancel), h('div.progress', bar));
    detail.prepend(box);
    try {
      return await fn(sds, (frac, text) => { bar.style.width = `${Math.round(frac * 100)}%`; if (text) label.textContent = text; });
    } catch (err) {
      app.error(err, 'Sample transfer');
      return null;
    } finally {
      st.busy = false; st.sds = null;
      app.exclusive = false;
      box.remove();
    }
  }

  async function receive(sds, id, sub, progress, label) {
    progress(0, `${label}: waiting for the K2000...`);
    return sds.receive(sdsSampleNumber(id, sub), (f) => progress(f, `${label}: ${Math.round(f * 100)}%`));
  }

  async function downloadOne(hd) {
    const b = st.block;
    await withSds(async (sds, progress) => {
      const r = await receive(sds, b.id, hd.index, progress, `Sub-sample ${hd.index + 1}`);
      const loop = r.loop ? { start: r.loopStart, end: r.loopEnd } : null;
      downloadBlob(writeWav([r.samples], r.sampleRate, loop), `${safeFileName(b.name)}_${b.id}_${hd.index + 1}.wav`, 'audio/wav');
      toast('Sample downloaded', 'good');
    });
  }

  async function downloadAll() {
    const b = st.block;
    await withSds(async (sds, progress) => {
      const chans = [];
      let rate = 44100;
      let loop = null;
      const count = b.stereo ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const r = await receive(sds, b.id, i, progress, count === 2 ? (i ? 'Right' : 'Left') : 'Sample');
        chans.push(r.samples); rate = r.sampleRate;
        if (r.loop) loop = { start: r.loopStart, end: r.loopEnd };
        await sleep(200);
      }
      const n = Math.min(...chans.map((c) => c.length));
      downloadBlob(writeWav(chans.map((c) => c.subarray(0, n)), rate, loop), `${safeFileName(b.name)}_${b.id}.wav`, 'audio/wav');
      toast('Sample downloaded', 'good');
    });
  }

  async function uploadWav(targetId) {
    const [file] = await pickFiles('.wav,audio/wav');
    if (!file) return;
    let wav;
    try { wav = parseWav(await file.arrayBuffer()); } catch (err) { app.error(err, 'WAV'); return; }
    const usedIds = new Set(st.items.map((i) => i.id));
    let free = 200;
    while (usedIds.has(free) && free < 999) free++;
    const secs = (rate) => sdsTransferSeconds(Math.round(wav.frames * (rate / wav.sampleRate)) * (wav.channels.length > 1 ? 2 : 1));
    const r = await formDialog(`Upload ${file.name}`, [
      { key: 'id', label: 'Sample ID on the K2000 (200-999)', type: 'number', value: Math.max(200, targetId ?? free), min: 200, max: 999 },
      { key: 'name', label: 'Name', value: file.name.replace(/\.wav$/i, '').slice(0, 16) },
      { key: 'root', label: 'Root key', value: 'C4' },
      {
        key: 'chan', label: 'Channels', type: 'select', value: wav.channels.length > 1 ? 'mono' : 'mono',
        options: wav.channels.length > 1
          ? [{ value: 'mono', label: 'Mix to mono' }, { value: 'left', label: 'Left only' }, { value: 'right', label: 'Right only' }, { value: 'both', label: 'Both, as two samples (ID and ID+1)' }]
          : [{ value: 'mono', label: 'Mono' }],
      },
      {
        key: 'rate', label: 'Sample rate', type: 'select', value: String(wav.sampleRate),
        options: [...new Set([wav.sampleRate, 48000, 44100, 32000, 29400, 22050, 16000])].map((rt) => ({ value: String(rt), label: `${rt} Hz (about ${Math.ceil(secs(rt))} s)` })),
      },
    ], 'Send', `${wav.frames} frames, ${wav.channels.length} channel(s), ${wav.sampleRate} Hz${wav.loop ? ', loop points found' : ''}.`);
    if (!r) return;
    if (!(r.id >= 200 && r.id + (r.chan === 'both' ? 1 : 0) <= 999)) { toast('Samples sent over MIDI can only land on IDs 200-999.', 'warn'); return; }
    const rate = Number(r.rate);
    const root = parseNoteName(r.root) ?? 60;
    const parts = [];
    if (r.chan === 'both') { parts.push(wav.channels[0], wav.channels[1]); } else if (r.chan === 'left') parts.push(wav.channels[0]); else if (r.chan === 'right') parts.push(wav.channels[1]); else parts.push(mixToMono(wav.channels));

    if (usedIds.has(r.id) && !(await confirmDialog('Replace sample?', `Sample ${r.id} exists. Sending replaces it.`, 'Replace', true))) return;

    const done = await withSds(async (sds, progress) => {
      for (let i = 0; i < parts.length; i++) {
        const pcm = floatToInt16(resampleLinear(parts[i], wav.sampleRate, rate));
        const ratio = rate / wav.sampleRate;
        const loop = wav.loop ? { loop: true, loopStart: Math.round(wav.loop.start * ratio), loopEnd: Math.round(wav.loop.end * ratio) } : {};
        const id = r.id + i;
        await sds.send(pcm, {
          number: sdsNumberForId(id), sampleRate: rate, ...loop,
          onProgress: (f) => progress(f, `Sending ${parts.length > 1 ? (i ? 'right ' : 'left ') : ''}sample to ID ${id}: ${Math.round(f * 100)}%`),
        });
        await sleep(400);
      }
      return true;
    });
    if (!done) return;
    toast('Sample sent', 'good');
    await sleep(500);
    // Name the new sample(s) and set the root key.
    for (let i = 0; i < parts.length; i++) {
      const id = r.id + i;
      try {
        const nm = parts.length > 1 ? `${r.name.slice(0, 14)} ${i ? 'R' : 'L'}` : r.name;
        await app.client.rename(T.SOUNDBLOCK, id, nm);
        const obj = await app.client.fetchObject(T.SOUNDBLOCK, id);
        const blk = new Soundblock(obj.data, { id });
        for (const hd of blk.headers) {
          const patch = blk.setRootKey(hd, root);
          await app.client.load(T.SOUNDBLOCK, id, patch.offset, patch.bytes);
        }
      } catch (err) { app.error(err, `Finishing sample ${id}`); }
    }
    app.refreshMemory();
    st.selected = r.id;
    refresh();
  }

  // ------------------------------------------------------------ object ops
  async function renameBlock() {
    const b = st.block;
    const r = await formDialog('Rename sample', [{ key: 'name', label: 'Name', value: b.name, maxlength: 16 }], 'Rename');
    if (!r) return;
    try { await app.client.rename(T.SOUNDBLOCK, b.id, r.name); refresh(); } catch (err) { app.error(err, 'Rename'); }
  }

  async function deleteBlock() {
    const b = st.block;
    if (!(await confirmDialog('Delete sample', `Delete sample ${b.id} "${b.name}"? Keymaps that use it will play silence.`, 'Delete', true))) return;
    try { await app.client.deleteObject(T.SOUNDBLOCK, b.id); st.selected = null; clear(detail); app.refreshMemory(); refresh(); } catch (err) { app.error(err, 'Delete'); }
  }

  async function splitBlock() {
    const b = st.block;
    const r = await formDialog('Split soundblock', [{ key: 'first', label: 'First new sample ID', type: 'number', value: b.id + 1, min: 1, max: 999 }], 'Split',
      `Creates ${b.headers.length} new single-sample soundblocks starting at the first free ID at or above the one you choose. The original stays.`);
    if (!r) return;
    await app.client.splitSoundblock(b.id, r.first);
    await sleep(800);
    toast('Split command sent', 'good');
    refresh();
  }

  if (app.online) refresh(); else root.append(h('div.notice.warn', 'Connect to the K2000 to manage samples.'));
  return { destroy() { st.sds?.cancel(); } };
}
