// Connection page of a generic device: logo, facts from the firmware catalog, ports,
// MIDI channel, SysEx device ID and an identity request.

import { h, clear, toast } from '../../../core/ui/dom.js';
import { portPicker } from '../../../core/ui/ports.js';
import { describeUniversal, manufacturerName } from '../../../core/midi/describe.js';
import { deviceLogo, MIDI_LABEL } from '../../registry.js';
import { measureSpeed, speedObject, SPEED_GAPS } from '../speedtest.js';

const TYPE_NAMES = {
  syn: 'Synthesizer / sound module', smp: 'Sampler', drm: 'Drum machine', fx: 'Effects processor', seq: 'Sequencer',
  ctl: 'MIDI controller', if: 'MIDI interface / processor', mix: 'Mixer', gtr: 'Guitar or bass processor', pno: 'Piano / organ',
  arr: 'Arranger keyboard', rec: 'Recorder', voc: 'Vocal processor', cpu: 'Computer or card', data: 'Sound data', oth: 'Other',
};

export function introView(root, g) {
  const { entry, def, host } = g;
  const idOut = h('div.small.mono');

  function showIdentity(raw) {
    const d = raw ? Uint8Array.from(raw) : null;
    clear(idOut).append(d ? (def?.describeIdentity?.(d) || describeUniversal(d, entry.sysex || '')) :'No identity reply. Many instruments made before about 1995 do not answer identity requests; that is normal.');
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
    // choosing the ports connects as starting with remembered ports does: identity, then the
    // settings, edit buffers and memory names the definition reads (errors say what did not answer)
    onChange: (names) => { host.rememberPorts(names); g.renderStatus(); if (names.output) g.identify().then((r) => { showIdentity(r); g.loadStandard(); }); },
  });

  const sysexName = entry.sysex ? `${manufacturerName(entry.sysex)} (${entry.sysex})` : 'unknown';
  const status = def
    ? h('div.notice', h('b', 'Mapped from the firmware. '), def.coverage || 'Device-specific SysEx parameters and dumps are available on their own pages.')
    : h('div.notice', h('b', 'Generic MIDI editor. '),
      `The ${entry.model}'s own SysEx messages have not been mapped from its firmware yet. Everything that works on any instrument is available: programs, controllers, RPN/NRPN, a Branch Library that records and sends back SysEx dumps, ${entry.type === 'smp' ? 'Sample Dump Standard transfers, ' : ''}and a SysEx console.`);
  const facts = [
    ['Maker', entry.maker],
    ['Model', entry.model],
    ['Type', TYPE_NAMES[entry.type] || entry.type],
    ['MIDI', MIDI_LABEL[entry.midi] || entry.midi],
    ['SysEx manufacturer', sysexName],
    ['CPU (from the firmware)', entry.cpu?.length ? entry.cpu.join(', ') : 'not detected'],
    ['Firmware files', `${entry.archives.length}`],
  ];

  // MIDI speed: the device's measured pace instead of DIN-MIDI defaults (speedtest.js)
  function speedCard() {
    const box = h('div.col');
    const obj = speedObject(def);
    const draw = (extra = null) => {
      const sp = host.device.value.speed;
      const m = host.settings.value.midi;
      clear(box).append(
        h('h2', 'MIDI speed'),
        h('div.small', sp
          ? `Measured ${new Date(sp.measured).toLocaleString()}: messages go ${g.client.s.minGap} ms apart${sp.sendGap !== g.client.s.minGap ? ` (the ${entry.model} needs at least ${def?.minGap} ms)` : ''}; ${sp.bulkGap === 0 ? 'whole sounds go back to back: the link is faster than DIN MIDI' : sp.bulkGap ? `a whole sound needs ${sp.bulkGap} ms before the next message` : `long messages wait for their bytes at ${g.client.s.bytesPerSecond} bytes/s`}. A reply took ${sp.receiveBps} bytes/s (the ${entry.model}'s own pace answering).`
          : `Default pace: ${g.client.s.minGap} ms between SysEx messages and ${m.bytesPerSecond} bytes/s (DIN MIDI carries at most 3125). A device on USB is often much faster.`),
        obj ? h('div.small.muted', `Measure: reads the ${obj.label} edit buffer, sends bursts of parameter changes to it at shrinking gaps (${SPEED_GAPS.join(', ')} ms), reads it back after each to see what arrived, and puts it back as it was. Nothing in memory is written.`)
          : h('div.small.muted', 'This editor has no edit buffer the measurement can use.'),
        h('div.row',
          obj ? h('button.btn', { disabled: !g.connected || g.demo, onclick: run }, 'Measure speed') : null,
          sp ? h('button.btn', { onclick: () => { host.device.update({ speed: null }); g.client.setSettings(g.clientSettings()); draw(); } }, 'Use the defaults') : null),
        extra);
    };
    async function run() {
      const msg = h('div.small.mono');
      draw(msg);
      try {
        g.setBusy(1, 'Measuring MIDI speed');
        const r = await measureSpeed(g, { onProgress: (t) => { msg.textContent = t; } });
        const runs = r.runs.map((x) => `${x.bulk ? 'whole sound ' : ''}${x.gap} ms: ${x.ok}/${x.total}`).join(', ');
        if (r.sendGap === null) {
          draw(h('div.notice.warn', `Even ${SPEED_GAPS[SPEED_GAPS.length - 1]} ms apart some changes were lost (${runs}); the defaults stay. ${r.restored ? 'The edit buffer is back as it was.' : 'Check the edit buffer: it was not read back as before.'}`));
          return;
        }
        host.device.update({ speed: { sendGap: r.sendGap, receiveBps: r.receiveBps, sendBps: r.sendBps, bulkGap: r.bulkGap, measured: Date.now(), object: r.object } });
        g.client.setSettings(g.clientSettings());
        draw(h('div.small', `${r.params} changes per burst: ${runs}. Replies: ${r.bytes} bytes in ${r.seconds.toFixed(2)} s. ${r.restored ? `The edit buffer is back as it was${r.diff.length ? ` (bytes ${r.diff.slice(0, 8).join(', ')} differ: kept by the ${entry.model} itself)` : ', byte for byte'}.` : 'Check the edit buffer: it was not read back as before.'}`));
        toast(`${entry.model}: ${g.client.s.minGap} ms between messages from now on`, 'good');
      } catch (err) { g.error(err, 'Measure speed'); draw(); } finally { g.setBusy(0); }
    }
    draw();
    return h('div.card.col', box);
  }

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
        h('p.small.muted', 'The channel is used by the audition keyboard, the controllers page and messages that address a channel. The device ID is the number many instruments expect in their SysEx messages (often 0, 1 or 16; some call it the system channel).'),
        ...(def?.connectOptions || []).map((o) => {
          const box = h('input', {
            type: 'checkbox', checked: host.device.value[o.key] ?? o.default ?? false,
            onchange: () => host.device.update({ [o.key]: box.checked }),
          });
          return h('label.row.check', { title: o.help || '' }, box, h('span', o.label, o.help ? h('div.small.muted', o.help) : null));
        })),
      h('div.card.col',
        h('h2', 'From the firmware collection'),
        h('table.list.small', h('tbody', facts.map(([k, v]) => h('tr', h('td.muted', k), h('td', v))))),
        entry.strings?.length ? h('details', h('summary.small', 'Text found in the firmware'), h('pre.small.mono.wrap', entry.strings.join('\n'))) : null,
        h('details', h('summary.small', 'Firmware archives'), h('ul.small', entry.archives.map((a) => h('li', a))))),
      speedCard()));

  if (g.identityReply) showIdentity(g.identityReply);
  const off = g.on('identity', showIdentity);
  if (!g.connected && host.device.value.output) g.connect().catch((err) => toast(err.message, 'warn'));
  return { destroy() { off(); ports.destroy?.(); } };
}
