// Controllers page: programs and banks, every controller, pitch bend, pressure,
// RPN/NRPN and channel mode messages, on the device's channel.

import { h, clear } from '../../../core/ui/dom.js';
import { CC_NAMES, ccName } from '../../../core/music.js';

const COMMON = [1, 2, 4, 5, 7, 8, 10, 11, 12, 13, 64, 65, 66, 67, 68, 71, 72, 73, 74, 75, 76, 77, 78, 84, 91, 92, 93, 94, 95];
/** Controller values after a reset (General MIDI defaults); the rest go to 0. */
const DEFAULTS = { 7: 100, 8: 64, 10: 64, 11: 127 };
const defaultValue = (n) => DEFAULTS[n] ?? 0;
/** Controllers a reset sends explicitly (after Reset All Controllers, CC 121), since devices differ in what 121 covers. */
const RESET = [1, 2, 4, 7, 8, 10, 11, 64, 65, 66, 67, 68, 69, 84];
const RPN_PRESETS = [
  { label: 'Pitch bend range', msb: 0, lsb: 0, nrpn: false, hint: 'MSB = semitones' },
  { label: 'Fine tuning', msb: 0, lsb: 1, nrpn: false, hint: '8192 = centre' },
  { label: 'Coarse tuning', msb: 0, lsb: 2, nrpn: false, hint: 'MSB 64 = centre' },
  { label: 'Modulation depth range', msb: 0, lsb: 5, nrpn: false, hint: '' },
];

export function playView(root, g) {
  const ch = () => g.channel;
  const send = (fn) => { try { fn(); } catch (err) { g.error(err, 'MIDI'); } };
  const c = g.client;

  // Program and bank
  const msb = h('input', { type: 'number', min: 0, max: 127, placeholder: '-', title: 'Bank select MSB (CC 0). Leave empty to not send it.' });
  const lsb = h('input', { type: 'number', min: 0, max: 127, placeholder: '-', title: 'Bank select LSB (CC 32). Leave empty to not send it.' });
  const prog = h('input', { type: 'number', min: 1, max: 128, value: 1 });
  const val = (inp) => (inp.value === '' ? null : Math.max(0, Math.min(127, Number(inp.value))));
  const sendProgram = () => send(() => c.selectBankProgram(ch(), val(msb), val(lsb), Math.max(0, Math.min(127, Number(prog.value) - 1))));
  const step = (d) => { prog.value = Math.max(1, Math.min(128, Number(prog.value) + d)); sendProgram(); };

  // Controllers
  let showAll = false;
  const ccWrap = h('div.cc-grid');
  const values = new Map();
  function ccRow(n) {
    const out = h('span.mono.small', String(values.get(n) ?? defaultValue(n)));
    const slider = h('input', {
      type: 'range', min: 0, max: 127, value: values.get(n) ?? defaultValue(n),
      oninput: () => { values.set(n, Number(slider.value)); out.textContent = slider.value; send(() => c.cc(ch(), n, Number(slider.value))); },
    });
    return h('div.cc-row', h('span.mono.small.cc-num', String(n)), h('span.small.cc-name', { title: ccName(n) }, ccName(n)), slider, out);
  }
  function renderCC() {
    const list = showAll ? Array.from({ length: 120 }, (_, i) => i) : COMMON;
    clear(ccWrap).append(...list.map(ccRow));
  }
  const allBtn = h('button.btn.small.toggle', { onclick: () => { showAll = !showAll; allBtn.classList.toggle('on', showAll); renderCC(); } }, 'All controllers');

  // Reset: Reset All Controllers, then each common controller to its default, pitch bend to
  // the centre, pressure to 0 and the RPN/NRPN selection to null, on one or all channels.
  function resetControllers(all) {
    const chans = all ? Array.from({ length: 16 }, (_, i) => i) : [ch()];
    send(() => {
      for (const n of chans) {
        c.cc(n, 121, 0);
        for (const cc of RESET) c.cc(n, cc, defaultValue(cc));
        c.pitchBend(n, 0);
        c.channelPressure(n, 0);
        c.cc(n, 101, 127); c.cc(n, 100, 127);
      }
    });
    values.clear();
    bend.value = 0;
    press.value = 0;
    renderCC();
  }

  // Pitch bend and pressure
  const bend = h('input', {
    type: 'range', min: -8192, max: 8191, value: 0,
    oninput: () => send(() => c.pitchBend(ch(), Number(bend.value))),
    onchange: () => { bend.value = 0; send(() => c.pitchBend(ch(), 0)); },
  });
  bend.addEventListener('pointerup', () => { bend.value = 0; send(() => c.pitchBend(ch(), 0)); });
  const press = h('input', { type: 'range', min: 0, max: 127, value: 0, oninput: () => send(() => c.channelPressure(ch(), Number(press.value))) });

  // RPN / NRPN
  const kind = h('select', {}, h('option', { value: 'nrpn' }, 'NRPN'), h('option', { value: 'rpn' }, 'RPN'));
  const pMsb = h('input', { type: 'number', min: 0, max: 127, value: 0 });
  const pLsb = h('input', { type: 'number', min: 0, max: 127, value: 0 });
  const pVal = h('input', { type: 'number', min: 0, max: 16383, value: 0 });
  const fine = h('input', { type: 'checkbox', checked: true, title: 'Send the value as 14 bits (data entry MSB and LSB)' });
  const sendParam = () => send(() => c.paramNumber(ch(), { nrpn: kind.value === 'nrpn', msb: Number(pMsb.value) & 127, lsb: Number(pLsb.value) & 127, value: Number(pVal.value) & 16383, fine: fine.checked }));
  const presets = RPN_PRESETS.map((p) => h('button.btn.small', {
    title: p.hint,
    onclick: () => { kind.value = p.nrpn ? 'nrpn' : 'rpn'; pMsb.value = p.msb; pLsb.value = p.lsb; },
  }, p.label));

  // Channel mode and system messages
  const modeBtn = (label, num, v) => h('button.btn.small', { onclick: () => send(() => c.cc(ch(), num, v)) }, label);
  const sys = [
    ['GM System On', [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]],
    ['GM System Off', [0xf0, 0x7e, 0x7f, 0x09, 0x02, 0xf7]],
  ];
  if (/Roland|Boss/.test(g.entry.maker)) sys.push(['GS Reset', [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7]]);
  if (/Yamaha/.test(g.entry.maker)) sys.push(['XG System On', [0xf0, 0x43, 0x10, 0x4c, 0x00, 0x00, 0x7e, 0x00, 0xf7]]);
  sys.push(['Tune request', [0xf6]]);

  root.append(
    h('h1', 'Controllers'),
    h('div.sub', `Sends on MIDI channel ${ch() + 1} (change it on the Connect page). Controller numbers and names follow the MIDI standard; the ${g.entry.model} may respond to only some of them.`),
    h('div.grid.cols-2',
      h('div.card.col',
        h('h2', 'Program'),
        h('div.row',
          h('label.field', 'Bank MSB', msb), h('label.field', 'Bank LSB', lsb), h('label.field', 'Program (1-128)', prog),
          h('button.btn.primary', { onclick: sendProgram }, 'Send'),
          h('button.btn', { onclick: () => step(-1) }, '−'), h('button.btn', { onclick: () => step(1) }, '+'))),
      h('div.card.col',
        h('h2', 'Pitch bend and pressure'),
        h('label.field', 'Pitch bend (springs back)', bend),
        h('label.field', 'Channel pressure', press)),
      h('div.card.col',
        h('h2', 'RPN / NRPN'),
        h('div.row', h('label.field', 'Type', kind), h('label.field', 'MSB', pMsb), h('label.field', 'LSB', pLsb), h('label.field', 'Value', pVal),
          h('label.row.small', fine, '14-bit'), h('button.btn.primary', { onclick: sendParam }, 'Send')),
        h('div.row', ...presets)),
      h('div.card.col',
        h('h2', 'Channel mode and system'),
        h('div.row',
          modeBtn('All sound off', 120, 0), modeBtn('CC 121 Reset', 121, 0), modeBtn('All notes off', 123, 0),
          modeBtn('Local on', 122, 127), modeBtn('Local off', 122, 0)),
        h('div.row', modeBtn('Omni off', 124, 0), modeBtn('Omni on', 125, 0), modeBtn('Mono', 126, 0), modeBtn('Poly', 127, 0)),
        h('div.row', ...sys.map(([label, bytes]) => h('button.btn.small', { onclick: () => send(() => g.client.sendNow(bytes)) }, label))))),
    h('div.card.col', { style: { marginTop: '12px' } },
      h('div.row', h('h2.grow', 'Controllers'),
        h('button.btn.small', { onclick: () => resetControllers(false), title: `Reset All Controllers (CC 121), then volume 100, pan, balance 64, expression 127, the other common controllers 0, pitch bend centre and pressure 0 on channel ${ch() + 1}` }, 'Reset controllers'),
        h('button.btn.small', { onclick: () => resetControllers(true), title: 'The same on all 16 channels' }, 'Reset all channels'),
        allBtn),
      ccWrap));
  renderCC();
  return null;
}

export { CC_NAMES };
