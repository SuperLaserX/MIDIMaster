// MIDI monitor: every message in both directions, decoded by the open device module.

import { h, clear, downloadBlob } from '../core/ui/dom.js';
import { describeMessage } from '../core/midi/describe.js';
import { hex } from '../core/bits.js';

export function monitorView(root, shell) {
  const transport = shell.transport;
  const decode = shell.device?.instance?.decode;
  const log = h('div.log');
  const filterRealtime = () => shell.settings.get('midi.filterRealtime');
  let paused = false;
  const pauseBtn = h('button.btn.toggle', { onclick: () => { paused = !paused; pauseBtn.classList.toggle('on', paused); pauseBtn.textContent = paused ? 'Paused' : 'Pause'; } }, 'Pause');
  function line(entry) {
    const t = (entry.time / 1000).toFixed(3).padStart(9); // seconds since the page loaded
    const el = h('div.ln.' + entry.dir, `${t}  ${entry.dir === 'out' ? '→' : '←'}  `, h('span.lname', describeMessage(entry.data, decode)));
    el.title = hex(entry.data.slice(0, 200)) + (entry.data.length > 200 ? ' ...' : '');
    return el;
  }
  const keep = (e) => !(filterRealtime() && (e.data[0] === 0xf8 || e.data[0] === 0xfe));

  const stats = shell.device?.instance?.client?.stats;
  root.append(
    h('h1', 'MIDI Monitor'),
    h('div.sub', `Every message ${shell.device ? `exchanged with the ${shell.device.entry.title}` : 'sent and received'}, decoded. Hover a line for its bytes.`),
    h('div.row', { style: { marginBottom: '8px' } }, pauseBtn,
      h('button.btn', { onclick: () => clear(log) }, 'Clear'),
      h('button.btn', {
        onclick: () => downloadBlob(transport.log.map((e) => `${e.dir} ${hex(e.data)}`).join('\n'), 'midimaster-midi-log.txt', 'text/plain'),
      }, 'Save log'),
      h('span.grow'),
      stats ? h('span.small.muted', `Sent ${stats.sent}, received ${stats.received}, timeouts ${stats.timeouts}, refusals ${stats.naks}`) : null),
    log);

  for (const e of transport.log.slice(-200).filter(keep)) log.append(line(e));
  log.scrollTop = log.scrollHeight;
  const max = () => shell.settings.get('monitor.maxEntries') || 400;
  const off = transport.on('traffic', (e) => {
    if (paused || !keep(e)) return;
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    log.append(line(e));
    while (log.childNodes.length > max()) log.removeChild(log.firstChild);
    if (stick) log.scrollTop = log.scrollHeight;
  });
  return { destroy() { off(); } };
}
