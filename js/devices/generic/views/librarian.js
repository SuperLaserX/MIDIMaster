// Librarian: record SysEx dumps from the device, keep them in the browser, send them
// back, and import or export .syx files. Works with any instrument that dumps SysEx.

import { h, clear, toast, formDialog, confirmDialog, downloadBlob, pickFiles, safeFileName } from '../../../core/ui/dom.js';
import { niceName } from '../../../core/mainlib/format.js';
import { splitSysex, manufacturerName, manufacturerId, describeMessage } from '../../../core/midi/describe.js';
import { hex, sleep } from '../../../core/bits.js';
import { fullDumpSteps, runFullDump } from '../fulldump.js';
import { sysexMessages, isSmf } from '../../../core/midi/smf.js';
import { mainLibraryPanel } from './mainlib-panel.js';

const QUIET_MS = 2500;

export function librarianView(root, g) {
  const lib = g.host.library;
  const device = g.entry.id;
  const st = { items: [], capture: null, sending: false, open: null };
  const list = h('div');
  const captureBox = h('div');
  const openBox = h('div');
  const ml = mainLibraryPanel(g, { sendMessages });

  async function refresh() {
    st.items = (await lib.list(device)).sort((a, b) => b.created - a.created);
    renderList();
  }

  // ------------------------------------------------------------ capture
  function startCapture(requestBytes = null, { name, text } = {}) {
    if (st.capture) return;
    const cap = { messages: [], bytes: 0, timer: null, started: Date.now() };
    const info = h('div.small.mono', 'Waiting...');
    const stop = async (save = true) => {
      clearTimeout(cap.timer);
      off();
      st.capture = null;
      clear(captureBox);
      if (save && cap.messages.length) await saveCapture(cap.messages, name ? { name, notes: 'Complete dump started on the device' } : {});
      else if (save) toast('Nothing was received.', 'warn');
    };
    const off = g.transport.on('sysex', (d) => {
      if (d[1] === 0x7e && (d[3] === 0x06 || d[3] >= 0x7c)) return; // identity and handshakes
      cap.messages.push(Uint8Array.from(d));
      cap.bytes += d.length;
      info.textContent = `${cap.messages.length} message(s), ${cap.bytes} bytes. Last: ${describeMessage(d, g.host.shell.device?.instance?.decode)}`;
      clearTimeout(cap.timer);
      cap.timer = setTimeout(() => stop(true), QUIET_MS);
    });
    st.capture = { stop };
    clear(captureBox).append(h('div.card.col.capture',
      h('div.row', h('span.spinner'), h('b.grow', 'Recording SysEx'),
        h('button.btn.small.primary', { onclick: () => stop(true) }, 'Stop and save'),
        h('button.btn.small', { onclick: () => stop(false) }, 'Cancel')),
      h('div.small.muted', text || (requestBytes ? 'Dump request sent. Waiting for the reply.' : `Start the dump on the ${g.entry.model} now (usually under MIDI, Utility or System: Bulk Dump, SysEx Transmit or Data Transfer). Recording stops ${QUIET_MS / 1000} s after the last message.`)),
      info));
    if (requestBytes) {
      for (const m of splitSysex(requestBytes)) g.client.send(m).catch((err) => g.error(err, 'Dump request'));
    }
  }

  async function saveCapture(messages, { name = `${g.entry.model} dump ${new Date().toLocaleString()}`, notes = '', note = '' } = {}) {
    const total = messages.reduce((a, m) => a + m.length, 0);
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const m of messages) { bytes.set(m, o); o += m.length; }
    const r = await formDialog('Save dump', [{ key: 'name', label: 'Name', value: name }], 'Save',
      `${messages.length} message(s), ${total} bytes.${note ? ` ${note}` : ''}`);
    if (!r) {
      if (notes && (await confirmDialog('Discard dump', 'Discard the complete dump? Export it as a .syx file instead to keep it outside the library.', 'Export .syx'))) {
        downloadBlob(bytes, `${safeFileName(name)}.syx`, 'application/octet-stream');
      }
      return;
    }
    const id = await lib.put({ device, name: r.name || 'Dump', bytes, kind: 'sysex', notes });
    toast('Dump saved in the library', 'good');
    await refresh();
    const saved = st.items.find((x) => x.id === id);
    if (saved) openEntry(saved);
  }

  // ------------------------------------------------------------ complete dump
  // The definition's fullDump requests in turn (see ../fulldump.js); devices without mapped
  // requests record a front-panel "dump all" instead.
  const fullSteps = () => fullDumpSteps(g.def);

  async function completeDump() {
    if (st.capture || st.sending) return;
    const steps = fullSteps();
    if (!steps) {
      startCapture(null, {
        name: `${g.entry.model} complete dump ${new Date().toLocaleString()}`,
        text: `Start a complete dump on the ${g.entry.model} now: choose the option that sends everything (often called All, All Data, Bulk Dump All or Total) under MIDI, Utility or System. The ${g.entry.model}'s own dump requests are not mapped yet, so the dump has to be started on the device. Recording stops ${QUIET_MS / 1000} s after the last message.`,
      });
      return;
    }
    if (!g.connected) { toast('Choose the MIDI ports on the Connect page first.', 'warn'); return; }
    if (!(await confirmDialog('Complete dump', `Request all of the ${g.entry.model}'s data (${steps.map((s) => s.label).join('; ')}) and save it as one library entry? This can take a few minutes; the ${g.entry.model} only sends, nothing on it changes.`, 'Start'))) return;
    const run = { cancel: false, messages: [], results: [] };
    const stepEl = h('b.grow', '');
    const info = h('div.small.mono', '');
    const bar = h('div');
    st.capture = { stop: () => { run.cancel = true; } };
    clear(captureBox).append(h('div.card.col.capture',
      h('div.row', h('span.spinner'), stepEl, h('button.btn.small', { onclick: () => { run.cancel = true; } }, 'Cancel')),
      h('div.progress', bar), info));
    try {
      Object.assign(run, await runFullDump({ transport: g.transport, client: g.client, ctx: g.ctx }, steps, {
        cancelled: () => run.cancel,
        onStep: (i, s) => { stepEl.textContent = `Complete dump ${i + 1}/${steps.length}: ${s.label}`; bar.style.width = `${Math.round((i / steps.length) * 100)}%`; },
        onProgress: (n, bytes) => { info.textContent = `${n} message(s), ${bytes} bytes`; },
      }));
    } catch (err) { g.error(err, 'Complete dump'); } finally {
      st.capture = null;
      clear(captureBox);
    }
    if (run.cancel) { toast('Complete dump cancelled.', 'warn'); return; }
    if (!run.messages.length) { toast(`The ${g.entry.model} did not answer. Check the MIDI ports and the device ID on the Connect page.`, 'bad'); return; }
    const empty = run.results.filter((r) => !r.count).map((r) => r.label);
    const notes = `Complete dump: ${run.results.map((r) => `${r.label} ${r.count ? `${r.count} msg` : 'no reply'}`).join('; ')}`;
    await saveCapture(run.messages, {
      name: `${g.entry.model} complete dump ${new Date().toLocaleString()}`,
      notes,
      note: empty.length ? `No reply (empty or not present): ${empty.join(', ')}.` : 'Every request was answered.',
    });
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
      for (let i = 0; i < msgs.length; i++) {
        await g.client.send(msgs[i]);
        // Large messages need time to travel at MIDI speed before the next one.
        await sleep((msgs[i].length / g.host.settings.value.midi.bytesPerSecond) * 1000);
        bar.style.width = `${Math.round(((i + 1) / msgs.length) * 100)}%`;
      }
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
  const joinMsgs = (msgs) => {
    const out = new Uint8Array(msgs.reduce((a, m) => a + m.length, 0));
    let o = 0;
    for (const m of msgs) { out.set(m, o); o += m.length; }
    return out;
  };

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
        h('button.btn', { disabled: !selected.size, title: 'Turn the selected items into Main Library patches (readable JSON with every setting)', onclick: () => ml.addMessages(all ? entry.name : `${entry.name} (${selected.size} items)`, chosenMsgs()) }, 'Add to Main Library')),
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
    h('h1', 'Librarian'),
    h('div.sub', `Keep ${g.entry.model} data (patches, banks, setups, sequences) as SysEx in this browser. Dumps are stored exactly as received, so they can be sent back unchanged. Open a dump to see what it holds and choose which parts to send.`),
    h('div.card.col',
      h('div.row',
        h('button.btn.primary', { onclick: completeDump, title: fullSteps() ? `Request every kind of ${g.entry.model} data in turn and save it all as one entry` : `Record a complete dump started on the ${g.entry.model}` }, 'Complete dump'),
        h('button.btn', { onclick: () => startCapture() }, 'Record a dump'),
        h('button.btn', {
          onclick: async () => {
            const files = await pickFiles('.syx,.mid,.midi,.bin', true);
            if (files?.length) importFiles([...files]);
          },
        }, 'Import .syx'),
        h('button.btn', { title: 'Look inside a .syx file and send parts of it, without adding it to the library', onclick: openFile }, 'Open .syx file'),
        h('button.btn', {
          onclick: () => {
            if (!st.items.length) return;
            downloadBlob(joinMsgs(st.items.flatMap((e) => sysexMessages(e.bytes))), `${safeFileName(g.entry.model)}-library.syx`, 'application/octet-stream');
          },
        }, 'Export all')),
      h('div.row',
        reqSel, reqHex,
        h('button.btn', {
          onclick: () => { try { startCapture(requestBytes()); } catch (err) { g.error(err, 'Request'); } },
        }, 'Send request and record')),
      h('div.small.muted', requests.length ? 'Dump requests come from the device definition.' : 'This device has no mapped dump requests yet. Most instruments can send a dump from their front panel; record it here.')),
    captureBox,
    openBox,
    list,
    ml.el);

  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])]; if (f.length) importFiles(f); });
  refresh();
  return { destroy() { st.capture?.stop(false); ml.destroy(); } };
}
