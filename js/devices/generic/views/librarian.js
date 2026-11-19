// Librarian: record SysEx dumps from the device, keep them in the browser, send them
// back, and import or export .syx files. Works with any instrument that dumps SysEx.

import { h, clear, toast, formDialog, confirmDialog, downloadBlob, pickFiles, safeFileName } from '../../../core/ui/dom.js';
import { splitSysex, manufacturerName, manufacturerId, describeMessage } from '../../../core/midi/describe.js';
import { hex, sleep } from '../../../core/bits.js';

const QUIET_MS = 2500;

export function librarianView(root, g) {
  const lib = g.host.library;
  const device = g.entry.id;
  const st = { items: [], capture: null, sending: false };
  const list = h('div');
  const captureBox = h('div');

  async function refresh() {
    st.items = (await lib.list(device)).sort((a, b) => b.created - a.created);
    renderList();
  }

  // ------------------------------------------------------------ capture
  function startCapture(requestBytes = null) {
    if (st.capture) return;
    const cap = { messages: [], bytes: 0, timer: null, started: Date.now() };
    const info = h('div.small.mono', 'Waiting...');
    const stop = async (save = true) => {
      clearTimeout(cap.timer);
      off();
      st.capture = null;
      clear(captureBox);
      if (save && cap.messages.length) await saveCapture(cap.messages);
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
      h('div.small.muted', requestBytes ? 'Dump request sent. Waiting for the reply.' : `Start the dump on the ${g.entry.model} now (usually under MIDI, Utility or System: Bulk Dump, SysEx Transmit or Data Transfer). Recording stops ${QUIET_MS / 1000} s after the last message.`),
      info));
    if (requestBytes) {
      for (const m of splitSysex(requestBytes)) g.client.send(m).catch((err) => g.error(err, 'Dump request'));
    }
  }

  async function saveCapture(messages) {
    const total = messages.reduce((a, m) => a + m.length, 0);
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const m of messages) { bytes.set(m, o); o += m.length; }
    const r = await formDialog('Save dump', [{ key: 'name', label: 'Name', value: `${g.entry.model} dump ${new Date().toLocaleString()}` }], 'Save',
      `${messages.length} message(s), ${total} bytes.`);
    if (!r) return;
    await lib.put({ device, name: r.name || 'Dump', bytes, kind: 'sysex' });
    toast('Dump saved in the library', 'good');
    refresh();
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
  async function sendEntry(e) {
    if (st.sending) return;
    if (!g.connected) { toast('Choose the MIDI output on the Connect page first.', 'warn'); return; }
    const msgs = splitSysex(e.bytes);
    st.sending = true;
    const bar = h('div');
    const box = h('div.card.col', h('div.small', `Sending "${e.name}" (${msgs.length} message(s))`), h('div.progress', bar));
    captureBox.prepend(box);
    try {
      for (let i = 0; i < msgs.length; i++) {
        await g.client.send(msgs[i]);
        // Large messages need time to travel at MIDI speed before the next one.
        await sleep((msgs[i].length / g.host.settings.value.midi.bytesPerSecond) * 1000);
        bar.style.width = `${Math.round(((i + 1) / msgs.length) * 100)}%`;
      }
      toast(`Sent "${e.name}"`, 'good');
    } catch (err) { g.error(err, 'Send'); } finally { st.sending = false; box.remove(); }
  }

  async function importFiles(files) {
    let n = 0;
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (!splitSysex(bytes).length) { toast(`${f.name}: no SysEx messages found`, 'warn'); continue; }
      await lib.put({ device, name: f.name.replace(/\.(syx|mid|bin)$/i, ''), bytes, kind: 'sysex', notes: `Imported from ${f.name}` });
      n++;
    }
    if (n) { toast(`${n} file(s) imported`, 'good'); refresh(); }
  }

  function renderList() {
    if (!st.items.length) { clear(list).append(h('div.empty', 'The library is empty. Record a dump from the device or import .syx files.')); return; }
    clear(list).append(h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Name'), h('th', 'Messages'), h('th', 'Size'), h('th', 'From'), h('th', 'Saved'), h('th', ''))),
      h('tbody', st.items.map((e) => {
        const msgs = splitSysex(e.bytes);
        const maker = msgs.length ? manufacturerName(manufacturerId(msgs[0])) : '';
        return h('tr',
          h('td', e.name, e.notes ? h('div.small.muted', e.notes) : null),
          h('td.mono', String(msgs.length)),
          h('td.mono', `${e.bytes.length}`),
          h('td.small', maker, msgs.length ? h('div.small.mono.muted', { title: hex(msgs[0].slice(0, 32)) }, hex(msgs[0].slice(0, 8))) : null),
          h('td.small', new Date(e.created).toLocaleString()),
          h('td.row',
            h('button.btn.small.primary', { onclick: () => sendEntry(e) }, 'Send'),
            h('button.btn.small', { onclick: () => downloadBlob(e.bytes, `${safeFileName(e.name)}.syx`, 'application/octet-stream') }, 'Export'),
            h('button.btn.small', {
              onclick: async () => {
                const r = await formDialog('Rename', [{ key: 'name', label: 'Name', value: e.name }], 'Rename');
                if (r?.name) { await lib.update(e.id, { name: r.name }); refresh(); }
              },
            }, 'Rename'),
            h('button.btn.small.danger', {
              onclick: async () => { if (await confirmDialog('Delete', `Delete "${e.name}" from the library?`, 'Delete', true)) { await lib.remove(e.id); refresh(); } },
            }, 'Delete')));
      })))));
  }

  root.append(
    h('h1', 'Librarian'),
    h('div.sub', `Keep ${g.entry.model} data (patches, banks, setups, sequences) as SysEx in this browser. Dumps are stored exactly as received, so they can be sent back unchanged.`),
    h('div.card.col',
      h('div.row',
        h('button.btn.primary', { onclick: () => startCapture() }, 'Record a dump'),
        h('button.btn', {
          onclick: async () => {
            const files = await pickFiles('.syx,.mid,.bin', true);
            if (files?.length) importFiles([...files]);
          },
        }, 'Import .syx'),
        h('button.btn', {
          onclick: () => {
            if (!st.items.length) return;
            const total = st.items.reduce((a, e) => a + e.bytes.length, 0);
            const all = new Uint8Array(total);
            let o = 0;
            for (const e of st.items) { all.set(e.bytes, o); o += e.bytes.length; }
            downloadBlob(all, `${safeFileName(g.entry.model)}-library.syx`, 'application/octet-stream');
          },
        }, 'Export all')),
      h('div.row',
        reqSel, reqHex,
        h('button.btn', {
          onclick: () => { try { startCapture(requestBytes()); } catch (err) { g.error(err, 'Request'); } },
        }, 'Send request and record')),
      h('div.small.muted', requests.length ? 'Dump requests come from the device definition.' : 'This device has no mapped dump requests yet. Most instruments can send a dump from their front panel; record it here.')),
    captureBox,
    list);

  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])]; if (f.length) importFiles(f); });
  refresh();
  return { destroy() { st.capture?.stop(false); } };
}
