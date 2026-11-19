// Global settings: appearance, MIDI, audition keyboard, library and data.

import { h, clear, toast, confirmDialog, downloadBlob, pickFiles } from '../core/ui/dom.js';
import { library } from '../core/library.js';
import { SETTING_DEFAULTS } from '../core/settings.js';
import { DEVICES } from '../devices/registry.js';

const ACCENTS = ['#f2b544', '#5aa7f2', '#4fc28a', '#ef5d5d', '#b48cf2', '#f28cc2', '#3fd0d0'];

export function settingsView(root, shell) {
  const s = shell.settings;
  const v = () => s.value;
  const num = (path, opts) => {
    const [group, key] = path.split('.');
    const inp = h('input', {
      type: 'number', min: opts.min, max: opts.max, step: opts.step || 1, value: key ? v()[group][key] : v()[group],
      onchange: () => {
        const n = Math.max(opts.min, Math.min(opts.max, Number(inp.value) || opts.min));
        inp.value = n;
        s.update(key ? { [group]: { [key]: n } } : { [group]: n });
      },
    });
    return h('label.field', opts.label, inp, opts.help ? h('span.small.muted', opts.help) : null);
  };
  const toggle = (path, label, help) => {
    const [group, key] = path.split('.');
    const cur = () => (key ? v()[group][key] : v()[group]);
    const btn = h('button.btn.small.toggle' + (cur() ? '.on' : ''), {
      onclick: () => { const nv = !cur(); s.update(key ? { [group]: { [key]: nv } } : { [group]: nv }); btn.classList.toggle('on', nv); btn.textContent = nv ? 'On' : 'Off'; },
    }, cur() ? 'On' : 'Off');
    return h('div.setting-row', h('div.grow', h('div', label), help ? h('div.small.muted', help) : null), btn);
  };
  const select = (path, label, options) => {
    const [group, key] = path.split('.');
    const sel = h('select', { onchange: () => s.update(key ? { [group]: { [key]: sel.value } } : { [group]: sel.value }) },
      options.map(([val, l]) => h('option', { value: val, selected: String(key ? v()[group][key] : v()[group]) === String(val) }, l)));
    return h('label.field', label, sel);
  };

  // Appearance
  const accentRow = h('div.row', ...ACCENTS.map((c) => h('button.swatch' + (v().accent === c ? '.on' : ''), {
    style: { background: c }, title: c, onclick: () => { s.update({ accent: c }); render(); },
  })), h('input', { type: 'color', value: v().accent, title: 'Custom colour', oninput: (e) => s.update({ accent: e.target.value }) }));
  const scale = h('input', { type: 'range', min: 0.85, max: 1.3, step: 0.05, value: v().fontScale, oninput: () => s.update({ fontScale: Number(scale.value) }) });

  // MIDI ports (global defaults)
  const t = shell.real;
  const portsBox = h('div.col');
  function fillPorts() {
    clear(portsBox);
    if (!t.supported) { portsBox.append(h('div.notice.bad', 'This browser has no Web MIDI. Use Chrome or Edge.')); return; }
    if (!t.access) {
      portsBox.append(h('div.row', h('button.btn.primary', { onclick: async () => { try { await t.init(); fillPorts(); } catch (err) { shell.error(err, 'MIDI'); } } }, 'Enable MIDI'),
        h('span.small.muted', 'Allows MIDIMaster to use your MIDI ports with SysEx.')));
      return;
    }
    const { inputs, outputs } = t.ports();
    const mk = (list, key) => {
      const sel = h('select', { onchange: () => s.update({ midi: { [key]: sel.value } }) },
        h('option', { value: '' }, '(choose per device)'), ...list.map((p) => h('option', { value: p.name, selected: p.name === v().midi[key] }, p.name)));
      return sel;
    };
    portsBox.append(h('div.row',
      h('label.field', 'Default input', mk(inputs, 'defaultInput')),
      h('label.field', 'Default output', mk(outputs, 'defaultOutput')),
      h('button.btn', { onclick: async () => { await t.init(); fillPorts(); } }, 'Refresh')),
    h('div.small.muted', `${inputs.length} input(s), ${outputs.length} output(s). Each device remembers its own ports; these are used when a device has none yet.`));
  }

  const libInfo = h('span.small.muted', '...');
  library.count().then((n) => { libInfo.textContent = `${n} stored dump(s)`; }).catch(() => { libInfo.textContent = 'not available'; });

  function render() {
    clear(root).append(
      h('h1', 'Settings'),
      h('div.sub', 'These settings apply to every device. Each device page has its own MIDI ports, channel and device ID.'),
      h('div.grid.cols-2',
        h('div.card.col',
          h('h2', 'Appearance'),
          h('div.row', select('theme', 'Theme', [['system', 'Follow the system'], ['dark', 'Dark'], ['light', 'Light']]),
            select('density', 'Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']])),
          h('label.field', 'Accent colour', accentRow),
          h('label.field', `Text size (${Math.round(v().fontScale * 100)}%)`, scale)),
        h('div.card.col',
          h('h2', 'MIDI ports'),
          portsBox,
          toggle('midi.autoConnect', 'Reconnect at startup', 'Use MIDI without asking again once you have allowed it.'),
          toggle('midi.panicOnClose', 'All notes off when leaving a device')),
        h('div.card.col',
          h('h2', 'MIDI timing'),
          h('div.row',
            num('midi.sysexGap', { label: 'Gap between SysEx messages (ms)', min: 0, max: 5000, help: 'Older instruments need 100-200 ms.' }),
            num('midi.replyTimeout', { label: 'Reply timeout (ms)', min: 200, max: 30000 })),
          h('div.row',
            num('midi.bytesPerSecond', { label: 'Throughput (bytes/s)', min: 300, max: 3125, help: 'Used to size timeouts of long dumps. MIDI carries at most 3125 bytes/s.' }),
            num('midi.sdsPacketGap', { label: 'Sample Dump packet gap (ms)', min: 10, max: 500, help: 'Used when a device does not acknowledge packets.' })),
          toggle('midi.filterRealtime', 'Hide clock and active sensing in the monitor')),
        h('div.card.col',
          h('h2', 'Audition keyboard'),
          toggle('keyboard.show', 'Show the keyboard at the bottom'),
          toggle('keyboard.computerKeys', 'Play notes from the computer keys (Z-M, Q-U)'),
          h('div.row',
            num('keyboard.velocity', { label: 'Velocity', min: 1, max: 127 }),
            num('keyboard.octave', { label: 'Start octave', min: 0, max: 7 }),
            num('keyboard.patternBpm', { label: 'Test pattern BPM', min: 30, max: 300 }))),
        h('div.card.col',
          h('h2', 'Devices'),
          toggle('showNonMidi', 'List devices without MIDI', 'They can be browsed but there is nothing to edit over MIDI.'),
          h('div.small.muted', `${DEVICES.length} devices in the catalog, ${DEVICES.filter((d) => d.openable).length} with MIDI.`),
          num('monitor.maxEntries', { label: 'Monitor lines kept', min: 50, max: 5000 })),
        h('div.card.col',
          h('h2', 'Library and data'),
          h('div.row', libInfo, h('span.grow'),
            h('button.btn.small.danger', {
              onclick: async () => {
                if (!(await confirmDialog('Clear library', 'Delete every SysEx dump stored in this browser for all devices?', 'Delete all', true))) return;
                await library.clear(); libInfo.textContent = '0 stored dumps'; toast('Library cleared', 'good');
              },
            }, 'Clear library')),
          h('div.row',
            h('button.btn', { onclick: () => downloadBlob(s.export(), 'midimaster-settings.json', 'application/json') }, 'Export settings'),
            h('button.btn', {
              onclick: async () => {
                const [f] = await pickFiles('.json');
                if (!f) return;
                try { s.import(await f.text()); toast('Settings imported', 'good'); render(); } catch (err) { shell.error(err, 'Import settings'); }
              },
            }, 'Import settings'),
            h('button.btn.danger', {
              onclick: async () => {
                if (!(await confirmDialog('Reset settings', 'Restore every global setting to its default? Device settings and the library stay.', 'Reset', true))) return;
                s.reset(); render();
              },
            }, 'Reset to defaults')))),
      h('p.small.muted', `MIDIMaster. Defaults: SysEx gap ${SETTING_DEFAULTS.midi.sysexGap} ms, timeout ${SETTING_DEFAULTS.midi.replyTimeout} ms.`));
    fillPorts();
  }

  render();
  const off = t.on('ports', () => { if (t.access) fillPorts(); });
  return { destroy() { off(); } };
}
