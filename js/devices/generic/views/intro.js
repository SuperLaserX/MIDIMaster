// Connection page of a generic device: logo, facts from the firmware catalog, ports,
// MIDI channel, SysEx device ID and an identity request.

import { h, clear, toast } from '../../../core/ui/dom.js';
import { portPicker } from '../../../core/ui/ports.js';
import { describeUniversal, manufacturerName } from '../../../core/midi/describe.js';
import { deviceLogo, MIDI_LABEL } from '../../registry.js';

const TYPE_NAMES = {
  syn: 'Synthesizer / sound module', smp: 'Sampler', drm: 'Drum machine', fx: 'Effects processor', seq: 'Sequencer',
  ctl: 'MIDI controller', if: 'MIDI interface / processor', mix: 'Mixer', gtr: 'Guitar or bass processor', pno: 'Piano / organ',
  arr: 'Arranger keyboard', rec: 'Recorder', voc: 'Vocal processor', cpu: 'Computer or card', data: 'Sound data', oth: 'Other',
};

export function introView(root, g) {
  const { entry, def, host } = g;
  const idOut = h('div.small.mono');

  function showIdentity(raw) {
    clear(idOut).append(raw ? describeUniversal(Uint8Array.from(raw)) : 'No identity reply. Many instruments made before about 1995 do not answer identity requests; that is normal.');
  }

  const chSel = h('select', { onchange: () => { g.channel = Number(chSel.value); } },
    Array.from({ length: 16 }, (_, i) => h('option', { value: i, selected: i === g.channel }, `Channel ${i + 1}`)));
  const devId = h('input', { type: 'number', min: 0, max: 127, value: g.deviceId, onchange: () => { g.deviceId = Number(devId.value); } });
  const ports = portPicker({
    transport: g.transport,
    input: host.device.value.input,
    output: host.device.value.output,
    label: `the ${entry.model}`,
    onEnable: () => host.ensureMidi(),
    onChange: (names) => { host.rememberPorts(names); g.renderStatus(); if (names.output) g.identify().then(showIdentity); },
  });

  const sysexName = entry.sysex ? `${manufacturerName(entry.sysex)} (${entry.sysex})` : 'unknown';
  const status = def
    ? h('div.notice', h('b', 'Mapped from the firmware. '), def.coverage || 'Device-specific SysEx parameters and dumps are available on their own pages.')
    : h('div.notice', h('b', 'Generic MIDI editor. '),
      `The ${entry.model}'s own SysEx messages have not been mapped from its firmware yet. Everything that works on any instrument is available: programs, controllers, RPN/NRPN, a librarian that records and sends back SysEx dumps, ${entry.type === 'smp' ? 'Sample Dump Standard transfers, ' : ''}and a SysEx console.`);
  const facts = [
    ['Maker', entry.maker],
    ['Model', entry.model],
    ['Type', TYPE_NAMES[entry.type] || entry.type],
    ['MIDI', MIDI_LABEL[entry.midi] || entry.midi],
    ['SysEx manufacturer', sysexName],
    ['CPU (from the firmware)', entry.cpu?.length ? entry.cpu.join(', ') : 'not detected'],
    ['Firmware files', `${entry.archives.length}`],
  ];

  root.append(
    h('div.intro',
      h('pre.ascii-logo', deviceLogo(entry)),
      h('div.col.intro-text',
        h('h1', entry.title),
        status,
        g.demo ? h('div.notice', 'Demo mode: a simulated device records what is sent and answers identity and dump requests.') : null)),
    h('div.grid.cols-2',
      h('div.card.col',
        h('h2', 'MIDI ports'),
        ports,
        h('div.row',
          h('label.field', 'MIDI channel', chSel),
          h('label.field', 'SysEx device ID', devId),
          h('button.btn', { onclick: async () => { if (!g.connected) await g.connect(); showIdentity(await g.identify()); } }, 'Identity request')),
        idOut,
        h('p.small.muted', 'The channel is used by the audition keyboard, the controllers page and messages that address a channel. The device ID is the number many instruments expect in their SysEx messages (often 0, 1 or 16; some call it the system channel).')),
      h('div.card.col',
        h('h2', 'From the firmware collection'),
        h('table.list.small', h('tbody', facts.map(([k, v]) => h('tr', h('td.muted', k), h('td', v))))),
        entry.strings?.length ? h('details', h('summary.small', 'Text found in the firmware'), h('pre.small.mono.wrap', entry.strings.join('\n'))) : null,
        h('details', h('summary.small', 'Firmware archives'), h('ul.small', entry.archives.map((a) => h('li', a)))))));

  if (g.identityReply) showIdentity(g.identityReply);
  const off = g.on('identity', showIdentity);
  if (!g.connected && host.device.value.output) g.connect().catch((err) => toast(err.message, 'warn'));
  return { destroy() { off(); ports.destroy?.(); } };
}
