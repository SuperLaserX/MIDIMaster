// Branch Library: record SysEx dumps from the device, keep them in the browser, send them
// back, and import or export .syx files. Works with any instrument that dumps SysEx.

import { h, clear, toast, formDialog, confirmDialog, dialog, downloadBlob, pickFiles, safeFileName } from '../../../core/ui/dom.js';
import { niceName } from '../../../core/mainlib/format.js';
import { splitSysex, manufacturerName, manufacturerId, describeMessage } from '../../../core/midi/describe.js';
import { hex } from '../../../core/bits.js';
import { waitUntil } from '../../../core/midi/schedule.js';
import { fullDumpSteps, optionalGroups, estimateSeconds, durationText } from '../fulldump.js';
import { startCapture, startCompleteDump, joinMsgs } from '../dumpjob.js';
import { sysexMessages, isSmf } from '../../../core/midi/smf.js';
import { mainLibraryPanel } from './mainlib-panel.js';
import { importFromMainLibrary } from './mainlib-pick.js';

const QUIET_MS = 2500;

export function librarianView(root, g) {
  const lib = g.host.library;
  const device = g.entry.id;
  const st = { items: [], sending: false, open: null };
  const list = h('div');
  const captureBox = h('div');
  const openBox = h('div');
  const ml = mainLibraryPanel(g, { sendMessages });

  async function refresh() {
    st.items = (await lib.list(device)).sort((a, b) => b.created - a.created);
    renderList();
  }

  // ------------------------------------------------------------ dumps (background jobs, ../dumpjob.js)
  // A recording or a complete dump belongs to the device, not to this page: it goes on while other
  // pages are shown, this page shows it again when opened, and it saves itself when it is done.
  const jobEls = { job: null };
  function renderJob(job) {
    if (!job) { jobEls.job = null; clear(captureBox); return; }
    if (jobEls.job !== job) {
      jobEls.job = job;
      jobEls.title = h('b.grow', '');
      jobEls.info = h('div.small.mono', '');
      jobEls.bar = h('div');
      jobEls.time = h('span.small.muted', '');
      clear(captureBox).append(h('div.card.col.capture',
        h('div.row', h('span.spinner'), jobEls.title, jobEls.time,
          h('button.btn.small.primary', { title: 'Stop now and save what has arrived', onclick: () => job.stop(true) }, 'Stop and save'),
          h('button.btn.small', { title: 'Stop and discard what has arrived', onclick: async () => { if (job.count < 50 || await confirmDialog('Cancel', `Discard the ${job.count} messages received so far?`, 'Discard', true)) job.stop(false); } }, 'Cancel')),
        job.text ? h('div.small.muted', job.text) : null,
        job.kind === 'dump' ? h('div.progress', jobEls.bar) : null,
        jobEls.info,
        h('div.small.muted', 'It goes on while you use other pages of this device; a message tells you when it is saved.')));
    }
    jobEls.title.textContent = job.kind === 'dump'
      ? `${job.title} ${job.step.i + 1}/${job.step.n}: ${job.step.label}${job.left != null ? ` (${durationText(job.left)} left)` : ''}`
      : job.title;
    jobEls.bar.style.width = `${job.percent ?? 0}%`;
    jobEls.time.textContent = `started ${new Date(job.started).toLocaleTimeString()}`;
    jobEls.info.textContent = `${job.count} message(s), ${job.bytes} bytes${job.kind === 'capture' ? `. Last: ${job.last}` : ''}`;
  }

  function record(requestBytes = null, opts = {}) {
    if (g.job) { toast(`A ${g.job.title.toLowerCase()} is running; wait for it or stop it first.`, 'warn'); return; }
    try {
      startCapture(g, {
        requestBytes, splitSysex, quiet: QUIET_MS, ...opts,
        text: opts.text || (requestBytes ? 'Dump request sent. Waiting for the reply.' : `Start the dump on the ${g.entry.model} now (usually under MIDI, Utility or System: Bulk Dump, SysEx Transmit or Data Transfer). Recording stops ${QUIET_MS / 1000} s after the last message.`),
      });
    } catch (err) { g.error(err, 'Record'); }
  }

  // ------------------------------------------------------------ complete dump
  // The definition's fullDump requests in turn (see ../fulldump.js); devices without mapped
  // requests record a front-panel "dump all" instead.
  const fullSteps = () => fullDumpSteps(g.def);

  async function completeDump() {
    if (g.job) { toast(`A ${g.job.title.toLowerCase()} is running; wait for it or stop it first.`, 'warn'); return; }
    if (st.sending) return;
    let steps = fullSteps();
    if (!steps) {
      // def.panelDump: a device without dump requests says how its complete dump is started on the
      // unit: 'text' or {text, quiet (ms between messages it may take), expect (messages in it)}
      const pd = typeof g.def?.panelDump === 'string' ? { text: g.def.panelDump } : g.def?.panelDump;
      const quiet = pd?.quiet ?? QUIET_MS;
      record(null, {
        name: `${g.entry.model} complete dump ${new Date().toLocaleString()}`, notes: 'Complete dump started on the device',
        quiet, expect: pd?.expect ?? null,
        text: pd ? `Start the complete dump on the ${g.entry.model} now: ${pd.text}. The ${g.entry.model} has no dump requests, so the dump is started on the unit. Recording stops ${pd.expect ? 'when it is complete, or ' : ''}${quiet / 1000} s after the last message.`
          : `Start a complete dump on the ${g.entry.model} now: choose the option that sends everything (often called All, All Data, Bulk Dump All or Total) under MIDI, Utility or System. The ${g.entry.model}'s own dump requests are not mapped yet, so the dump has to be started on the device. Recording stops ${QUIET_MS / 1000} s after the last message.`,
      });
      return;
    }
    if (!g.connected) { toast('Choose the MIDI ports on the Connect page first.', 'warn'); return; }
    // optional groups (e.g. ROM banks) are chosen here, all ticked: a complete dump holds everything
    const groups = optionalGroups(steps);
    const boxes = groups.map(() => h('input', { type: 'checkbox', checked: true }));
    const timed = steps.some((s) => s.seconds);
    const estimate = h('div.small');
    const chosen = () => steps.filter((s) => !s.optional || boxes[groups.findIndex((x) => x.steps.includes(s))].checked);
    const showEstimate = () => { estimate.textContent = timed ? `Takes ${durationText(estimateSeconds(chosen()))}. It goes on while you use other pages of the ${g.entry.model} (and in a background tab), and is saved by itself when it is done.` : 'This can take a few minutes. It goes on while you use other pages of this device, and is saved by itself when it is done.'; };
    boxes.forEach((b) => b.addEventListener('change', showEstimate));
    showEstimate();
    const sp = g.host.device.value.speed;
    const pace = `Pace: requests go out ${g.client.s.minGap} ms apart (${sp ? `measured on the Connect page, ${new Date(sp.measured).toLocaleDateString()}` : 'the DIN-MIDI default; Measure speed on the Connect page for this link\'s own pace'}).${g.def?.fullDumpPace ? ` ${g.def.fullDumpPace}` : ''}`;
    const mandatory = [...new Set(steps.filter((s) => !s.optional).map((s) => s.group || s.label))];
    const ok = await dialog('Complete dump', h('div.col',
      h('p.small', `Request all of the ${g.entry.model}'s data and save it in the Branch Library: each bank of sounds as an entry of its own, the settings and other data together in one. The ${g.entry.model} only sends; nothing on it changes.`),
      h('div.small.muted', `${mandatory.length > 12 ? `${mandatory.slice(0, 12).join('; ')}; and ${mandatory.length - 12} more` : mandatory.join('; ')}.`),
      groups.length ? h('div.col', groups.map((x, i) => h('label.row', boxes[i], `${x.group} (${x.steps.length} request${x.steps.length === 1 ? '' : 's'}${x.seconds ? `, ${durationText(x.seconds)}` : ''})`))) : null,
      h('div.small', pace),
      estimate), [{ label: 'Cancel', value: false }, { label: 'Start', value: true, primary: true }]);
    if (!ok) return;
    steps = chosen();
    try { startCompleteDump(g, steps); } catch (err) { g.error(err, 'Complete dump'); }
  }

  // ------------------------------------------------------------ requests
  const reqSel = h('select');
  const reqHex = h('input', { type: 'text', class: 'mono', placeholder: 'F0 ... F7 (dump request, use the device ID and channel the device expects)', style: { minWidth: '360px' } });
  const requests = g.def?.requests || [];
  clear(reqSel).append(h('option', { value: '' }, requests.length ? 'Choose a dump request...' : 'Custom request (type it)'),
    ...requests.map((r, i) => h('option', { value: String(i) }, r.label)));
  function requestBytes() {
    if (reqSel.value !== '') {
      const r = requests[Number(reqSel.value)];
      return Uint8Array.from(r.bytes(g.ctx));
    }
    const b = reqHex.value.trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 16));
    if (!b.length || b.some((x) => Number.isNaN(x) || x < 0 || x > 255) || b[0] !== 0xf0 || b[b.length - 1] !== 0xf7) throw new Error('Enter a SysEx message as hex bytes, from F0 to F7.');
    return Uint8Array.from(b);
  }

  // ------------------------------------------------------------ send / files
  async function sendMessages(title, msgs) {
    if (st.sending) return;
    if (!g.connected) { toast('Choose the MIDI output on the Connect page first.', 'warn'); return; }
    if (!msgs.length) { toast('Nothing is selected.', 'warn'); return; }
    st.sending = true;
    const bar = h('div');
    const box = h('div.card.col', h('div.small', `Sending ${title} (${msgs.length} message(s))`), h('div.progress', bar));
    captureBox.prepend(box);
    try {
      let last = null;
      for (let i = 0; i < msgs.length; i++) {
        // a long message needs time to go out before the next: the device's measured pace (Connect
        // page) or the DIN-MIDI default; scheduled by the client, so a background tab is not slowed
        const r = await g.client.send(msgs[i], { gapAfter: (msgs[i].length / g.client.s.bytesPerSecond) * 1000 });
        last = r?.at ?? last;
        bar.style.width = `${Math.round(((i + 1) / msgs.length) * 100)}%`;
      }
      if (last) await waitUntil(last);
      toast(`Sent ${title}`, 'good');
    } catch (err) { g.error(err, 'Send'); } finally { st.sending = false; box.remove(); }
  }

  // ------------------------------------------------------------ contents of an entry
  // A dump split into items: the definition's libraryItems(msgs) groups messages into the
  // objects they hold (patches, performances...); otherwise each message is one item.
  const decode = () => g.def?.describe || g.host.shell?.device?.instance?.decode;
  function itemsOf(bytes) {
    const msgs = sysexMessages(bytes); // older entries may hold a whole MIDI file
    const grouped = g.def?.libraryItems?.(msgs, g.ctx);
    if (grouped?.length) return grouped;
    return msgs.map((m, i) => ({ key: String(i), label: describeMessage(m, decode()), name: '', msgs: [m] }));
  }

  /** Show what an entry (or an unsaved file: entry without id) holds; all items selected. */
  function openEntry(e) {
    const items = itemsOf(e.bytes);
    st.open = { entry: e, items, selected: new Set(items.map((_, i) => i)) };
    renderOpen();
    renderList();
    openBox.scrollIntoView?.({ block: 'nearest' });
  }

  function renderOpen() {
    const o = st.open;
    if (!o) { clear(openBox); return; }
    const { entry, items, selected } = o;
    const chosen = () => items.filter((_, i) => selected.has(i));
    // Everything selected: the dump exactly as stored. A selection: the items' messages, which a
    // definition may rebuild (e.g. single-program writes taken out of an all-programs dump).
    const chosenMsgs = () => (selected.size === items.length ? sysexMessages(entry.bytes) : chosen().flatMap((it) => it.msgs));
    const all = selected.size === items.length;
    const count = h('span.small.muted', `${selected.size} of ${items.length} selected, ${chosenMsgs().reduce((a, m) => a + m.length, 0)} bytes`);
    const objects = new Map((g.def?.objects || []).map((x) => [x.key, x]));
    const rows = items.map((it, i) => {
      const box = h('input', { type: 'checkbox', checked: selected.has(i), onclick: (ev) => ev.stopPropagation(), onchange: () => { if (box.checked) selected.add(i); else selected.delete(i); renderOpen(); } });
      const obj = it.object ? objects.get(it.object) : null;
      return h('tr' + (selected.has(i) ? '.sel' : ''), { onclick: () => { box.checked = !box.checked; box.dispatchEvent(new Event('change')); } },
        h('td', box),
        h('td.mono.muted', String(i + 1)),
        h('td', it.label),
        h('td', it.name || ''),
        h('td.mono', String(it.msgs.length)),
        h('td.mono', String(it.msgs.reduce((a, m) => a + m.length, 0))),
        h('td', obj?.fromSyx ? h('button.btn.small', { title: `Load into the ${obj.page || obj.label} page (nothing is sent)`, onclick: (ev) => { ev.stopPropagation(); openInEditor(obj, it); } }, 'Open in editor') : null));
    });
    clear(openBox).append(h('div.card.col.lib-open',
      h('div.card-head', h('h2.grow', entry.name, entry.id ? null : h('span.small.muted', '  (file, not in the library)')),
        h('button.btn.small', { onclick: () => { st.open = null; renderOpen(); renderList(); } }, 'Close')),
      h('div.row',
        h('button.btn.small', { onclick: () => { if (all) selected.clear(); else items.forEach((_, i) => selected.add(i)); renderOpen(); } }, all ? 'Select none' : 'Select all'),
        count,
        h('span.grow'),
        h('button.btn.primary', { disabled: !selected.size || st.sending, onclick: () => sendMessages(selected.size === items.length ? `"${entry.name}"` : `${selected.size} of ${items.length} items from "${entry.name}"`, chosenMsgs()) }, `Send selected (${selected.size})`),
        h('button.btn', { disabled: !selected.size, onclick: () => downloadBlob(joinMsgs(chosenMsgs()), `${safeFileName(all ? entry.name : `${entry.name} (${selected.size} items)`)}.syx`, 'application/octet-stream') }, 'Export selected'),
        h('button.btn', { disabled: !selected.size, onclick: saveSelection }, entry.id ? 'Save selected as new entry' : 'Save to library'),
        h('button.btn', { disabled: !selected.size, title: 'Turn the selected items into Head Library patches (readable JSON with every setting)', onclick: () => ml.addMessages(all ? entry.name : `${entry.name} (${selected.size} items)`, chosenMsgs()) }, 'Add to Head Library')),
      h('div.small.muted', g.def?.libraryItems ? `Items are the ${g.entry.model} objects the dump holds. Click a row or its box to choose what to send.` : 'Each item is one SysEx message. Click a row or its box to choose what to send.'),
      h('div.table-wrap.lib-items', h('table.list',
        h('thead', h('tr', h('th', ''), h('th', '#'), h('th', 'Item'), h('th', 'Name'), h('th', 'Messages'), h('th', 'Bytes'), h('th', ''))),
        h('tbody', rows)))));

    async function saveSelection() {
      const name = all ? entry.name : `${entry.name} (${selected.size} items)`;
      const r = await formDialog('Save to library', [{ key: 'name', label: 'Name', value: name }], 'Save');
      if (!r) return;
      const id = await lib.put({ device, name: r.name || name, bytes: joinMsgs(chosenMsgs()), kind: 'sysex', notes: entry.id ? `Selected from "${entry.name}"` : entry.notes || '' });
      toast('Saved in the library', 'good');
      await refresh();
      const saved = st.items.find((x) => x.id === id);
      if (saved) openEntry(saved);
    }
  }

  function openInEditor(obj, it) {
    const d = obj.fromSyx(it.msgs);
    if (!d) { toast(`No ${obj.label.toLowerCase()} found in "${it.label}".`, 'warn'); return; }
    g.setObjectData(obj.key, d);
    toast(`${it.label} is in the ${obj.page || obj.label} page. Nothing was sent: use its send or store buttons to put it on the ${g.entry.model}.`, 'info', 6000);
    g.nav(obj.key);
  }

  async function importFiles(files) {
    const ids = [];
    for (const f of files) {
      const raw = new Uint8Array(await f.arrayBuffer());
      const msgs = sysexMessages(raw); // a MIDI file is stored as the SysEx it holds
      if (!msgs.length) { toast(`${f.name}: no SysEx messages found`, 'warn'); continue; }
      ids.push(await lib.put({ device, name: niceName(f.name.replace(/\.(syx|mid|midi|bin)$/i, '')), bytes: joinMsgs(msgs), kind: 'sysex', notes: `Imported from ${f.name}${isSmf(raw) ? ' (the SysEx of a MIDI file)' : ''}` }));
    }
    if (!ids.length) return;
    toast(`${ids.length} file(s) imported`, 'good');
    await refresh();
    const one = ids.length === 1 && st.items.find((x) => x.id === ids[0]);
    if (one) openEntry(one);
  }

  /** Look inside a .syx file without adding it to the library. */
  async function openFile() {
    const files = await pickFiles('.syx,.mid,.midi,.bin', false);
    if (!files?.length) return;
    const f = files[0];
    const msgs = sysexMessages(new Uint8Array(await f.arrayBuffer()));
    if (!msgs.length) { toast(`${f.name}: no SysEx messages found`, 'warn'); return; }
    openEntry({ name: niceName(f.name.replace(/\.(syx|mid|midi|bin)$/i, '')), bytes: joinMsgs(msgs), notes: `Imported from ${f.name}` });
  }

  function renderList() {
    if (!st.items.length) { clear(list).append(h('div.empty', 'The library is empty. Record a dump from the device or import .syx files.')); return; }
    clear(list).append(h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Name'), h('th', 'Items'), h('th', 'Messages'), h('th', 'Size'), h('th', 'From'), h('th', 'Saved'), h('th', ''))),
      h('tbody', st.items.map((e) => {
        const msgs = sysexMessages(e.bytes);
        const maker = msgs.length ? manufacturerName(manufacturerId(msgs[0])) : '';
        return h('tr' + (st.open?.entry.id === e.id ? '.sel' : ''),
          h('td', h('a.link', { href: '#', title: 'Show what this dump holds', onclick: (ev) => { ev.preventDefault(); openEntry(e); } }, e.name), e.notes ? h('div.small.muted', e.notes) : null),
          h('td.mono', String(itemsOf(e.bytes).length)),
          h('td.mono', String(msgs.length)),
          h('td.mono', `${e.bytes.length}`),
          h('td.small', maker, msgs.length ? h('div.small.mono.muted', { title: hex(msgs[0].slice(0, 32)) }, hex(msgs[0].slice(0, 8))) : null),
          h('td.small', new Date(e.created).toLocaleString()),
          h('td.row',
            h('button.btn.small.primary', { title: 'Show the contents and choose what to send', onclick: () => openEntry(e) }, 'Open'),
            h('button.btn.small', { onclick: () => downloadBlob(joinMsgs(sysexMessages(e.bytes)), `${safeFileName(e.name)}.syx`, 'application/octet-stream') }, 'Export'),
            h('button.btn.small', {
              onclick: async () => {
                const r = await formDialog('Rename', [{ key: 'name', label: 'Name', value: e.name }], 'Rename');
                if (!r?.name) return;
                await lib.update(e.id, { name: r.name });
                if (st.open?.entry.id === e.id) { st.open.entry.name = r.name; renderOpen(); }
                refresh();
              },
            }, 'Rename'),
            h('button.btn.small.danger', {
              onclick: async () => {
                if (!(await confirmDialog('Delete', `Delete "${e.name}" from the library?`, 'Delete', true))) return;
                await lib.remove(e.id);
                if (st.open?.entry.id === e.id) { st.open = null; renderOpen(); }
                refresh();
              },
            }, 'Delete')));
      })))));
  }

  root.append(
    h('h1', 'Branch Library'),
    h('div.sub', `Keep ${g.entry.model} data (patches, banks, setups, sequences) as SysEx in this browser. Dumps are stored exactly as received, so they can be sent back unchanged. Open a dump to see what it holds and choose which parts to send.`),
    h('div.card.col',
      h('div.row',
        h('button.btn.primary', { onclick: completeDump, title: fullSteps() ? `Request every kind of ${g.entry.model} data in turn and save it in the Branch Library (each bank of sounds as an entry)` : `Record a complete dump started on the ${g.entry.model}` }, 'Complete dump'),
        h('button.btn', { onclick: () => record() }, 'Record a dump'),
        h('button.btn', {
          onclick: async () => {
            const files = await pickFiles('.syx,.mid,.midi,.bin', true);
            if (files?.length) importFiles([...files]);
          },
        }, 'Import .syx'),
        h('button.btn', { title: 'Look inside a .syx file and send parts of it, without adding it to the library', onclick: openFile }, 'Open .syx file'),
        (g.def?.objects || []).some((o) => o.init && o.params?.length) ? h('button.btn', { title: `Load Head Library patches (another model's through its translator) into the editor, the edit buffer or ${g.entry.model} memory slots`, onclick: () => importFromMainLibrary(g).catch((err) => g.error(err, 'Import from Head Library')) }, 'Import from Head Library...') : null,
        h('button.btn', {
          onclick: () => {
            if (!st.items.length) return;
            downloadBlob(joinMsgs(st.items.flatMap((e) => sysexMessages(e.bytes))), `${safeFileName(g.entry.model)}-library.syx`, 'application/octet-stream');
          },
        }, 'Export all')),
      h('div.row',
        reqSel, reqHex,
        h('button.btn', {
          onclick: () => { try { record(requestBytes()); } catch (err) { g.error(err, 'Request'); } },
        }, 'Send request and record')),
      h('div.small.muted', requests.length ? 'Dump requests come from the device definition.' : 'This device has no mapped dump requests yet. Most instruments can send a dump from their front panel; record it here.')),
    captureBox,
    openBox,
    list,
    ml.el);

  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])]; if (f.length) importFiles(f); });
  refresh();
  renderJob(g.job);
  const offs = [
    g.on('job', renderJob),
    // a dump saved itself: show it (the newest entry)
    g.on('library', async () => { await refresh(); if (st.items[0] && !st.open) openEntry(st.items[0]); }),
  ];
  // leaving the page does not stop a dump (it belongs to the device)
  return { destroy() { offs.forEach((off) => off?.()); ml.destroy(); } };
}
