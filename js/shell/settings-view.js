// Global settings: appearance, MIDI, audition keyboard, library and data.

import { h, clear, toast, confirmDialog, downloadBlob, pickFiles } from '../core/ui/dom.js';
import { icon } from '../core/ui/icons.js';
import { library } from '../core/library.js';
import { SETTING_DEFAULTS } from '../core/settings.js';
import { DEVICES } from '../devices/registry.js';
import { slotsOf } from '../core/midi/inputs.js';
import { mappingTable } from '../core/ui/mappings.js';

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
  // an on/off setting: a Web Awesome switch
  const toggle = (path, label, help) => {
    const [group, key] = path.split('.');
    const cur = () => (key ? v()[group][key] : v()[group]);
    const sw = h('wa-switch', {
      checked: !!cur(), 'aria-label': label,
      onchange: () => { const nv = !!sw.checked; if (nv !== !!cur()) s.update(key ? { [group]: { [key]: nv } } : { [group]: nv }); },
    });
    return h('label.setting-row', h('div.grow', h('div', label), help ? h('div.small.muted', help) : null), sw);
  };
  // a choice of a few: a segmented Web Awesome radio group
  const segment = (path, label, options) => {
    const [group, key] = path.split('.');
    const cur = String(key ? v()[group][key] : v()[group]);
    const rg = h('wa-radio-group', { value: cur, orientation: 'horizontal', 'aria-label': label, onchange: () => { if (rg.value) s.update(key ? { [group]: { [key]: rg.value } } : { [group]: rg.value }); } },
      options.map(([val, l]) => h('wa-radio', { value: val, appearance: 'button' }, l)));
    return h('div.field.segment-field', h('span.field-label', label), rg);
  };
  const cardTitle = (name, text) => h('div.card-title', icon(name), h('h2', text));

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

  // MIDI inputs: up to 4 controllers that play the open device and drive mapped functions
  const inputsBox = h('div.col');
  const activity = [];
  function fillInputs() {
    clear(inputsBox);
    activity.length = 0;
    if (!t.supported) return;
    if (!t.access) {
      inputsBox.append(h('div.row', h('button.btn.primary', { onclick: async () => { try { await t.init(); fillPorts(); fillInputs(); } catch (err) { shell.error(err, 'MIDI'); } } }, 'Enable MIDI'),
        h('span.small.muted', 'Controllers can be chosen once MIDI is allowed.')));
      return;
    }
    const names = shell.inputs.portNames();
    const slots = slotsOf(v().inputs);
    const set = (i, patch) => { const next = slotsOf(v().inputs).map((x, k) => (k === i ? { ...x, ...patch } : x)); s.update({ inputs: { slots: next } }); fillInputs(); };
    const status = { off: 'not used', 'no-midi': 'MIDI not allowed', missing: 'not connected', open: 'listening' };
    const devIn = shell.device ? shell.transport.input?.name : null;
    inputsBox.append(...slots.map((x, i) => {
      const sel = h('select', { onchange: () => set(i, { port: sel.value }) },
        h('option', { value: '' }, '(none)'),
        ...[...new Set([...names, ...(x.port && !names.includes(x.port) ? [x.port] : [])])].map((n) => h('option', { value: n, selected: n === x.port }, names.includes(n) ? n : `${n} (not connected)`)));
      const flag = (key, label, title) => h('label.row.small', { title }, h('input', { type: 'checkbox', checked: !!x[key], onchange: (e) => set(i, { [key]: e.target.checked }) }), label);
      const dot = h('span.dot' + (shell.inputs.status(i) === 'open' ? '.half' : ''));
      activity[i] = dot;
      return h('div.col.input-slot',
        h('div.row', h('b', `Input ${i + 1}`), sel, dot, h('span.small.muted', status[shell.inputs.status(i)])),
        x.port ? h('div.row',
          flag('enabled', 'On', 'Listen to this controller'),
          flag('thru', 'Plays the open device', 'Notes, pitch bend, aftertouch and unmapped controllers go to the open device'),
          flag('toChannel', 'On the device\'s channel', 'Change the MIDI channel to the open device\'s channel (off: keep the controller\'s channel)')) : null,
        x.port && x.port === devIn ? h('div.small.c-warn', 'This is also the open device\'s input port: with "Plays the open device" on, its own keys are heard twice (turn Local off on the device, or the option here).') : null);
    }),
    h('div.small.muted', 'What a controller sends goes to the device that is open. Mapped controllers change that device\'s parameter instead (below; each device\'s Input mappings page can override them).'));
  }
  const mappings = mappingTable(shell, {
    list: () => v().inputs?.mappings || [],
    save: (list) => s.update({ inputs: { mappings: list } }),
    empty: 'No global mappings yet. Add one, e.g. CC 74 to Filter Cutoff (Learn picks the controller you move).',
  });

  const libInfo = h('span.small.muted', '...');
  library.count().then((n) => { libInfo.textContent = `${n} stored dump(s)`; }).catch(() => { libInfo.textContent = 'not available'; });

  function render() {
    clear(root).append(
      h('h1', 'Settings'),
      h('div.sub', 'These settings apply to every device. Each device page has its own MIDI ports, channel and device ID.'),
      h('div.grid.cols-2',
        h('div.card.col',
          cardTitle('palette', 'Appearance'),
          h('div.row.segments', segment('theme', 'Theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Follow the system']]),
            segment('density', 'Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']])),
          h('label.field', 'Accent colour', accentRow),
          h('label.field', `Text size (${Math.round(v().fontScale * 100)}%)`, scale)),
        h('div.card.col',
          cardTitle('plug', 'MIDI ports'),
          portsBox,
          toggle('midi.autoConnect', 'Reconnect at startup', 'Use MIDI without asking again once you have allowed it.'),
          toggle('midi.panicOnClose', 'All notes off when leaving a device')),
        h('div.card.col',
          cardTitle('keyboard', 'MIDI inputs (controllers)'),
          inputsBox),
        h('div.card.col',
          cardTitle('right-left', 'Controller mappings (all devices)'),
          h('div.small.muted', 'Saved and loaded at startup. A device\'s own mappings (its Input mappings page) override these.'),
          mappings.el),
        h('div.card.col',
          cardTitle('gauge-high', 'MIDI timing'),
          h('div.row',
            num('midi.sysexGap', { label: 'Gap between SysEx messages (ms)', min: 0, max: 5000, help: 'Older instruments need 100-200 ms.' }),
            num('midi.replyTimeout', { label: 'Reply timeout (ms)', min: 200, max: 30000 })),
          h('div.row',
            num('midi.bytesPerSecond', { label: 'Throughput (bytes/s)', min: 300, max: 3125, help: 'Used to size timeouts of long dumps. MIDI carries at most 3125 bytes/s.' }),
            num('midi.sdsPacketGap', { label: 'Sample Dump packet gap (ms)', min: 10, max: 500, help: 'Used when a device does not acknowledge packets.' })),
          toggle('midi.filterRealtime', 'Hide clock and active sensing in the monitor')),
        h('div.card.col',
          cardTitle('music', 'Audition keyboard'),
          toggle('keyboard.show', 'Show the keyboard at the bottom'),
          toggle('keyboard.computerKeys', 'Play notes from the computer keys (Z-M, Q-U)'),
          h('div.row',
            num('keyboard.velocity', { label: 'Velocity', min: 1, max: 127 }),
            num('keyboard.octave', { label: 'Start octave', min: 0, max: 7 }),
            num('keyboard.patternBpm', { label: 'Test pattern BPM', min: 30, max: 300 }))),
        h('div.card.col',
          cardTitle('grip', 'Devices'),
          toggle('showNonMidi', 'List devices without MIDI', 'They can be browsed but there is nothing to edit over MIDI.'),
          h('div.small.muted', `${DEVICES.length} devices in the catalog, ${DEVICES.filter((d) => d.openable).length} with MIDI.`),
          num('monitor.maxEntries', { label: 'Monitor lines kept', min: 50, max: 5000 })),
        h('div.card.col',
          cardTitle('database', 'Library and data'),
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
    fillInputs();
    mappings.refresh();
  }

  render();
  const offs = [
    t.on('ports', () => { if (t.access) { fillPorts(); fillInputs(); } }),
    shell.inputs.on('status', () => fillInputs()),
    // a blink on the input's dot for each message it sends
    shell.inputs.on('activity', (i) => { const d = activity[i]; if (!d) return; d.classList.add('on'); clearTimeout(d._t); d._t = setTimeout(() => d.classList.remove('on'), 120); }),
  ];
  return { destroy() { for (const off of offs) off(); shell.inputs.learn = null; } };
}
