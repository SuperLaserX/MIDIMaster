// K2000 connection page: logo, MIDI ports, SysEx ID and the rules for safe editing.

import { h, toast } from '../../../core/ui/dom.js';
import { portPicker } from '../../../core/ui/ports.js';
import { hex } from '../../../core/bits.js';
import { deviceLogo, getDevice } from '../../registry.js';

export function introView(root, app) {
  const host = app.host;
  const entry = getDevice('kurzweil-k2000');
  const status = h('div.small.muted', app.online ? 'Connected. The K2000 answers.' : '');

  async function connect() {
    try {
      status.textContent = 'Checking for a reply...';
      const ok = await app.connect();
      status.textContent = ok ? 'Connected. The K2000 answered.' : app.connected
        ? 'No reply. Check both MIDI cables, the interface, and the K2000 SysEx ID (MIDI mode > RECEIVE page). Try Scan.'
        : 'Choose the MIDI ports first.';
      if (ok) toast('K2000 connected', 'good');
    } catch (err) { app.error(err, 'Connect'); status.textContent = err.message; }
  }

  async function scan() {
    status.textContent = 'Scanning device IDs (this can take up to a minute)...';
    const id = await app.client.scanDeviceId();
    if (id === null) { status.textContent = 'No device ID answered.'; return; }
    app.saveSettings({ deviceId: id });
    devId.value = id;
    await app.connect();
    status.textContent = `The K2000 answers on device ID ${id}.`;
  }

  async function identity() {
    try {
      const r = await app.client.identity();
      toast(`Identity reply: ${hex(r)}`, 'good', 8000);
    } catch (err) { app.error(err, 'Identity'); }
  }

  const devId = h('input', { type: 'number', min: 0, max: 127, value: app.settings.deviceId, onchange: () => app.saveSettings({ deviceId: Number(devId.value) }) });
  const aud = h('select', { onchange: () => app.saveSettings({ auditionChannel: Number(aud.value) }) },
    Array.from({ length: 16 }, (_, i) => h('option', { value: i, selected: i === app.settings.auditionChannel }, `Channel ${i + 1}`)));
  const ports = portPicker({
    transport: app.transport,
    input: host.device.value.input,
    output: host.device.value.output,
    label: 'the K2000',
    onEnable: () => host.ensureMidi(),
    onChange: (names) => { host.rememberPorts(names); if (names.input && names.output) connect(); },
  });

  root.append(
    h('div.intro',
      h('pre.ascii-logo', deviceLogo(entry, 'K2000')),
      h('div.col.intro-text',
        h('h1', 'Kurzweil K2000'),
        h('div.sub', 'Full editor: live program editing, Branch Library, samples over MIDI Sample Dump, keymaps, disk import from .KRZ files and CD images, and the front panel. Connect MIDI Out of your interface to the K2000 MIDI In, and the K2000 MIDI Out back to your interface.'),
        app.demo ? h('div.notice', 'Demo mode: a simulated K2000 answers every message. Remove ?demo from the address to use your instrument.') : null)),
    h('div.card.col',
      h('h2', 'MIDI ports'),
      ports,
      h('div.row',
        h('button.btn.primary', { onclick: connect }, 'Connect'),
        h('button.btn', { onclick: scan }, 'Scan for device ID'),
        h('button.btn', { onclick: identity }, 'Identity request')),
      status),
    h('div.card.col',
      h('h2', 'K2000 settings'),
      h('div.row',
        h('label.field', 'K2000 SysEx ID', devId),
        h('label.field', 'Audition channel', aud)),
      h('p.small.muted', 'The K2000 only answers messages addressed to its own SysEx ID (0 by default) and ignores the broadcast ID 127. It needs at least 120 ms between messages; the gap and timeout are set under Settings > MIDI timing.')),
    h('div.card.col',
      h('h2', 'Before you edit'),
      h('ul.small',
        h('li', 'Live editing writes straight into the program stored on the K2000. Edit RAM programs (IDs 200+), or make a RAM copy of a ROM program first.'),
        h('li', 'Leave the K2000 out of its own Program Editor while MIDIMaster edits that program. The K2000 refuses changes to an object that is open in its editor.'),
        h('li', 'Avoid sending MIDI while the K2000 loads from disk or deletes many objects. The K2000 can lock up under traffic while it is busy.'),
        h('li', 'Back up your RAM objects from the Library page before experimenting.'))),
  );
  return { destroy() { ports.destroy?.(); } };
}
