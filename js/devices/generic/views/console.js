// SysEx console: send any message, see every reply, decoded.

import { h, clear } from '../../../core/ui/dom.js';
import { describeMessage } from '../../../core/midi/describe.js';
import { hex } from '../../../core/bits.js';

export function consoleView(root, g) {
  const templates = [
    { label: 'Identity request (all devices)', bytes: () => [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7] },
    { label: 'Identity request (device ID)', bytes: (c) => [0xf0, 0x7e, c.deviceId & 0x7f, 0x06, 0x01, 0xf7] },
    { label: 'GM System On', bytes: () => [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7] },
    ...(g.def?.requests || []).map((r) => ({ label: r.label, bytes: r.bytes })),
    ...(g.def?.templates || []),
  ];
  const sel = h('select', { onchange: () => { if (sel.value !== '') inp.value = hex(templates[Number(sel.value)].bytes(g.ctx)).toUpperCase(); } },
    h('option', { value: '' }, 'Templates...'), ...templates.map((t, i) => h('option', { value: String(i) }, t.label)));
  const inp = h('input', { type: 'text', class: 'mono', placeholder: 'F0 7E 7F 06 01 F7', style: { minWidth: '420px', flex: '1' } });
  const out = h('div.log', { style: { height: '320px' } });
  const decode = g.host.shell.device?.instance?.decode;

  function line(dir, data) {
    const el = h('div.ln.' + dir, `${dir === 'out' ? '→' : '←'}  `, h('span.lname', describeMessage(data, decode)), h('div.small.mono.muted', hex(data.slice(0, 96)) + (data.length > 96 ? ' ...' : '')));
    out.append(el);
    out.scrollTop = out.scrollHeight;
  }

  async function send() {
    const bytes = inp.value.trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 16));
    if (!bytes.length || bytes.some((b) => Number.isNaN(b) || b < 0 || b > 255)) { g.error(new Error('Enter hex bytes separated by spaces.'), 'Console'); return; }
    try {
      if (bytes[0] === 0xf0) await g.client.send(Uint8Array.from(bytes)); else g.client.sendNow(bytes);
      line('out', Uint8Array.from(bytes));
    } catch (err) { g.error(err, 'Console'); }
  }

  const off = g.transport.on('sysex', (d) => line('in', d));
  const offMidi = g.transport.on('midi', (d) => line('in', d));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  root.append(
    h('h1', 'SysEx Console'),
    h('div.sub', `Sends exactly the bytes you type to the ${g.entry.model}, throttled like every other SysEx message, and shows everything that comes back.`),
    h('div.card.col', h('div.row', sel, inp, h('button.btn.primary', { onclick: send }, 'Send'), h('button.btn', { onclick: () => clear(out) }, 'Clear'))),
    out);
  return { destroy() { off(); offMidi(); } };
}
