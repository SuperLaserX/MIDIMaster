// Connection page of a generic device: logo, facts from the firmware catalog, ports,
// MIDI channel, SysEx device ID and an identity request.

import { h, clear, toast, shortNote, badge } from '../../../core/ui/dom.js';
import { icon } from '../../../core/ui/icons.js';
import { portPicker } from '../../../core/ui/ports.js';
import { describeUniversal, manufacturerName } from '../../../core/midi/describe.js';
import { deviceLogo, MIDI_LABEL } from '../../registry.js';
import { isFullEditor } from '../../levels.js';
import { measureSpeed, speedObject, SPEED_GAPS } from '../speedtest.js';

const TYPE_NAMES = {
  syn: 'Synthesizer / sound module', smp: 'Sampler', drm: 'Drum machine', fx: 'Effects processor', seq: 'Sequencer',
  ctl: 'MIDI controller', if: 'MIDI interface / processor', mix: 'Mixer', gtr: 'Guitar or bass processor', pno: 'Piano / organ',
  arr: 'Arranger keyboard', rec: 'Recorder', voc: 'Vocal processor', cpu: 'Computer or card', data: 'Sound data', oth: 'Other',
};

const cardTitle = (name, text) => h('div.card-title', icon(name), h('h2', text));

export function introView(root, g) {
  const { entry, def, host } = g;
  const idOut = h('div.small.mono.muted');

  function showIdentity(raw) {
    const d = raw ? Uint8Array.from(raw) : null;
    clear(idOut).append(d ? (def?.describeIdentity?.(d) || describeUniversal(d, entry.sysex || '')) : 'No identity reply (normal for most instruments made before about 1995).');
  }

  const chSel = h('select', { title: 'Used by the audition keyboard, the Controllers page and messages sent on a channel', onchange: () => { g.channel = Number(chSel.value); } },
    Array.from({ length: 16 }, (_, i) => h('option', { value: i, selected: i === g.channel }, `Channel ${i + 1}`)));
  const devId = h('input', { type: 'number', min: 0, max: 127, value: g.deviceId, title: 'The number the instrument expects in its SysEx messages (often 0, 1 or 16; some call it the system channel)', onchange: () => { g.deviceId = Number(devId.value); } });
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
  // what this editor is: a badge and one line, the details behind "More"
  const status = h('div.intro-status',
    def ? badge(isFullEditor(entry) ? 'Full editor' : 'Mapped from the firmware', isFullEditor(entry) ? 'live' : 'ram') : badge('Generic MIDI'),
    def ? shortNote(def.coverage || 'Its SysEx parameters and dumps are on their own pages.', 'small')
      : h('div.small', `Programs, controllers, a SysEx Branch Library${entry.type === 'smp' ? ', Sample Dump transfers' : ''} and a SysEx console. Its own SysEx messages are not mapped yet.`));
  const facts = [
    ['Maker', entry.maker],
    ['Model', entry.model],
    ['Type', TYPE_NAMES[entry.type] || entry.type],
    ['MIDI', MIDI_LABEL[entry.midi] || entry.midi],
    ['SysEx ID', sysexName],
  ];

  // MIDI speed: the device's measured pace instead of DIN-MIDI defaults (speedtest.js)
  let redrawSpeed = () => {};
  function speedCard() {
    const box = h('div.col');
    const obj = speedObject(def);
    const draw = (extra = null) => {
      const saved = host.device.value.speed;
      const sp = g.measuredSpeed();
      const m = host.settings.value.midi;
      const measured = sp ? `${new Date(sp.measured).toLocaleDateString()}${sp.port ? ` on ${sp.port}` : ''}` : '';
      clear(box).append(
        cardTitle('gauge-high', 'MIDI speed'),
        h('div.speed-line',
          h('b', `${g.client.s.minGap} ms`), h('span.small', 'between messages'),
          badge(sp ? `measured ${measured}` : 'default (DIN MIDI)', sp ? 'live' : '')),
        saved && !sp ? h('div.small.muted', `Measured on ${saved.port}, not this port.`) : null,
        sp && sp.bulkGap != null ? h('div.small.muted', sp.bulkGap === 0 ? 'Whole sounds go back to back.' : `Whole sounds need ${sp.bulkGap} ms each.`) : null,
        h('div.row',
          obj ? h('button.btn', {
            disabled: !g.connected || g.demo || !!g.cannot?.(obj.needs),
            title: g.cannot?.(obj.needs) || `Finds the fastest pace this port takes: changes are sent to the ${obj.label} edit buffer at shrinking gaps and read back, then the edit buffer is put back. Nothing in memory is written.`,
            onclick: run,
          }, 'Measure speed') : h('span.small.muted', 'No edit buffer to measure with.'),
          saved ? h('button.btn', { title: 'Forget the measurement and use the DIN-MIDI defaults', onclick: () => { host.device.update({ speed: null }); g.client.setSettings(g.clientSettings()); draw(); } }, 'Use the defaults') : null),
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
          draw(h('div.notice.warn', { title: runs }, `Some changes were lost even ${SPEED_GAPS[SPEED_GAPS.length - 1]} ms apart, so the defaults stay. ${r.restored ? 'The edit buffer is back as it was.' : 'Check the edit buffer: it did not read back as before.'}`));
          return;
        }
        host.device.update({ speed: { sendGap: r.sendGap, receiveBps: r.receiveBps, sendBps: r.sendBps, bulkGap: r.bulkGap, measured: Date.now(), object: r.object, port: g.transport.output?.name || '' } });
        g.client.setSettings(g.clientSettings());
        draw(h('div.small', { title: `${r.params} changes per burst: ${runs}. Replies: ${r.bytes} bytes in ${r.seconds.toFixed(2)} s.${r.diff.length ? ` Bytes ${r.diff.slice(0, 8).join(', ')} are kept by the ${entry.model} itself.` : ''}` }, r.restored ? 'Done. The edit buffer is back as it was.' : 'Done. Check the edit buffer: it did not read back as before.'));
        toast(`${entry.model}: ${g.client.s.minGap} ms between messages from now on`, 'good');
      } catch (err) { g.error(err, 'Measure speed'); draw(); } finally { g.setBusy(0); }
    }
    draw();
    redrawSpeed = () => draw();
    return h('div.card.col', box);
  }

  root.append(
    h('div.intro',
      h('div.intro-logo', h('pre.ascii-logo', deviceLogo(entry))),
      h('div.col.intro-text',
        h('div.eyebrow', entry.maker),
        h('h1', entry.title.startsWith(`${entry.maker} `) ? entry.title.slice(entry.maker.length + 1) : entry.title),
        status,
        g.demo ? h('div.notice', 'Demo mode: a simulated device answers.') : null)),
    h('div.grid.cols-2',
      h('div.card.col',
        cardTitle('plug', 'MIDI ports'),
        ports,
        h('div.row',
          h('label.field', 'MIDI channel', chSel),
          h('label.field', 'SysEx device ID', devId),
          h('button.btn', { onclick: async () => { if (!g.connected) await g.connect(); showIdentity(await g.identify()); } }, 'Identity request')),
        idOut,
        ...(def?.connectOptions || []).map((o) => {
          const box = h('input', {
            type: 'checkbox', checked: host.device.value[o.key] ?? o.default ?? false,
            onchange: () => host.device.update({ [o.key]: box.checked }),
          });
          return h('label.row.check', { title: o.help || '' }, box, h('span', o.label));
        })),
      h('div.card.col',
        cardTitle('microchip', 'Device'),
        h('dl.facts', facts.map(([k, v]) => [h('dt', k), h('dd', v)])),
        h('details', h('summary.small', 'Firmware'),
          h('div.small', `CPU: ${entry.cpu?.length ? entry.cpu.join(', ') : 'not detected'}`),
          h('ul.small', entry.archives.map((a) => h('li', a))),
          entry.strings?.length ? h('details', h('summary.small', 'Text found in the firmware'), h('pre.small.mono.wrap', entry.strings.join('\n'))) : null)),
      speedCard()));

  if (g.identityReply) showIdentity(g.identityReply);
  const off = g.on('identity', showIdentity);
  const offPort = g.transport.on('connection', () => redrawSpeed()); // another port: its own speed
  if (!g.connected && host.device.value.output) g.connect().catch((err) => toast(err.message, 'warn'));
  return { destroy() { off(); offPort?.(); ports.destroy?.(); } };
}
