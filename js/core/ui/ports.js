// MIDI port picker used on every device's connection page.

import { h, clear } from './dom.js';

/**
 * opts: {transport, input, output, onChange({input, output}) names, onEnable(), label}
 * Shows input/output selects for the shared Web MIDI transport.
 */
export function portPicker({ transport, input = '', output = '', onChange, onEnable, label = 'the device' }) {
  const inSel = h('select', { onchange: () => apply() });
  const outSel = h('select', { onchange: () => apply() });
  const wrap = h('div.col');
  const status = h('div.small.muted');

  function fill() {
    const { inputs, outputs } = transport.ports();
    clear(inSel).append(h('option', { value: '' }, '(none)'), ...inputs.map((p) => h('option', { value: p.name }, p.name)));
    clear(outSel).append(h('option', { value: '' }, '(none)'), ...outputs.map((p) => h('option', { value: p.name }, p.name)));
    inSel.value = transport.input?.name || input || '';
    outSel.value = transport.output?.name || output || '';
    status.textContent = inputs.length + outputs.length ? '' : 'No MIDI ports found. Connect your interface and press Refresh.';
  }

  function apply() {
    const { inputs, outputs } = transport.ports();
    const i = inputs.find((p) => p.name === inSel.value);
    const o = outputs.find((p) => p.name === outSel.value);
    transport.open(i?.id, o?.id);
    onChange?.({ input: inSel.value, output: outSel.value });
  }

  async function enable() {
    try {
      await onEnable?.();
      if (!transport.access && transport.init) await transport.init();
      render();
    } catch (err) { status.textContent = err.message; }
  }

  function render() {
    clear(wrap);
    if (!transport.supported) {
      wrap.append(h('div.notice.bad', 'This browser has no Web MIDI. Use Google Chrome or Microsoft Edge, and open MIDIMaster from http://localhost (run start.bat).'));
      return;
    }
    if (!transport.access) {
      wrap.append(h('div.row', h('button.btn.primary', { onclick: enable }, 'Enable MIDI'),
        h('span.small.muted', 'The browser asks for permission to use MIDI with SysEx.')), status);
      return;
    }
    fill();
    wrap.append(
      h('div.row',
        h('label.field', `Input (from ${label})`, inSel),
        h('label.field', `Output (to ${label})`, outSel),
        h('button.btn', { onclick: async () => { if (transport.init) await transport.init(); fill(); } }, 'Refresh')),
      status);
  }

  render();
  const off = transport.on?.('ports', () => { if (transport.access) fill(); });
  wrap.destroy = () => off?.();
  return wrap;
}
