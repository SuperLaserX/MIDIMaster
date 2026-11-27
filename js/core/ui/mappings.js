// Controller mapping tables (MIDI inputs): the global list on the Settings page and a device's own
// list on its "Input mappings" page. A mapping: {id, input: 'any'|0-3, channel: 'any'|0-15, cc, target}
// (core/midi/inputs.js); targets in core/midi/functions.js.

import { h, clear, toast, dialog } from './dom.js';
import { FUNCTIONS, ACTIONS, targetText } from '../midi/functions.js';
import { slotsOf, newMappingId } from '../midi/inputs.js';

const sourceText = (shell, m) => {
  const slots = slotsOf(shell.settings.value.inputs);
  const inp = m.input === 'any' ? 'any input' : `input ${m.input + 1}${slots[m.input]?.port ? ` (${slots[m.input].port})` : ''}`;
  return `CC ${m.cc}, ${inp}, ${m.channel === 'any' ? 'any channel' : `channel ${m.channel + 1}`}`;
};

/**
 * Edit one mapping in a dialog. opts.params: [{object, objectLabel, key, label}] of the open device
 * (offers "this device's parameter"); returns the mapping or null.
 */
export async function editMapping(shell, m0, { params = null, deviceName = '' } = {}) {
  const m = structuredClone(m0 || { id: newMappingId(), input: 'any', channel: 'any', cc: 1, target: { type: 'function', fn: 'cutoff' } });
  const slots = slotsOf(shell.settings.value.inputs);
  const sel = (options, value, onchange) => {
    const s = h('select', { onchange: () => onchange(s.value) }, options.map(([v, l]) => h('option', { value: String(v), selected: String(v) === String(value) }, l)));
    return s;
  };
  const cc = h('input', { type: 'number', min: 0, max: 127, value: m.cc, style: { width: '5em' }, oninput: () => { m.cc = Math.max(0, Math.min(127, Number(cc.value) || 0)); } });
  const inputSel = h('span');
  const chanSel = h('span');
  const drawSource = () => {
    clear(inputSel).append(sel([['any', 'Any input'], ...slots.map((s, i) => [i, `Input ${i + 1}${s.port ? `: ${s.port}` : ' (not set)'}`])], m.input, (v) => { m.input = v === 'any' ? 'any' : Number(v); }));
    clear(chanSel).append(sel([['any', 'Any channel'], ...Array.from({ length: 16 }, (_, i) => [i, `Channel ${i + 1}`])], m.channel, (v) => { m.channel = v === 'any' ? 'any' : Number(v); }));
  };
  drawSource();
  const learnNote = h('span.small.muted');
  const learn = h('button.btn.small', {
    title: 'Move a knob, fader or button on a controller: its CC number, input and channel are filled in',
    onclick: () => {
      if (!shell.inputs.access) { learnNote.textContent = 'MIDI is not allowed yet (Settings, MIDI inputs).'; return; }
      learnNote.textContent = 'Move a control on the controller now...';
      shell.inputs.learn = ({ input, channel, cc: n }) => {
        m.cc = n; m.input = input; m.channel = channel;
        cc.value = n; drawSource();
        learnNote.textContent = `Learned CC ${n} from input ${input + 1}, channel ${channel + 1}.`;
      };
    },
  }, 'Learn');
  const types = [['function', 'A function (found on every device)'], ...(params ? [['param', `A ${deviceName} parameter`]] : []), ['action', 'An action'], ['cc', 'Send it as another CC'], ['none', 'Nothing (block it)']];
  const targetBox = h('div.col');
  const drawTarget = () => {
    const t = m.target;
    const row = [];
    if (t.type === 'function') row.push(sel(FUNCTIONS.map((f) => [f.id, f.label]), t.fn, (v) => { t.fn = v; }));
    if (t.type === 'param') {
      const objs = [...new Map(params.map((p) => [p.object, p.objectLabel])).entries()];
      if (!objs.some(([k]) => k === t.object)) t.object = objs[0]?.[0];
      const list = params.filter((p) => p.object === t.object);
      if (!list.some((p) => p.key === t.param)) t.param = list[0]?.key;
      row.push(sel(objs, t.object, (v) => { t.object = v; t.param = null; drawTarget(); }), sel(list.map((p) => [p.key, p.label]), t.param, (v) => { t.param = v; }));
    }
    if (t.type === 'action') row.push(sel(ACTIONS.map((a) => [a.id, a.label]), t.action, (v) => { t.action = v; }));
    if (t.type === 'cc') row.push(h('input', { type: 'number', min: 0, max: 127, value: t.cc ?? 1, style: { width: '5em' }, oninput: (e) => { t.cc = Math.max(0, Math.min(127, Number(e.target.value) || 0)); } }));
    clear(targetBox).append(
      sel(types, t.type, (v) => {
        m.target = { type: v, ...(v === 'function' ? { fn: 'cutoff' } : v === 'action' ? { action: ACTIONS[0].id } : v === 'cc' ? { cc: m.cc } : {}) };
        drawTarget();
      }),
      row.length ? h('div.row', row) : null,
      t.type === 'function' ? h('div.small.muted', 'Each device finds its own parameter for the function (shown on its Input mappings page); a device mapping can name another.') : null);
  };
  drawTarget();
  const ok = await dialog(m0 ? 'Edit mapping' : 'New mapping', h('div.col',
    h('div.row', h('label.field', 'Controller (CC)', cc), learn), learnNote,
    h('div.row', h('label.field', 'From', inputSel), h('label.field', 'Channel', chanSel)),
    h('label.field', 'Does', targetBox)), [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }]);
  shell.inputs.learn = null;
  if (!ok) return null;
  if (m.target.type === 'action' && !m.target.action) m.target.action = ACTIONS[0].id;
  return m;
}

/**
 * A mapping table with add / edit / delete. list(): the mappings; save(list): store them.
 * opts.params, opts.deviceName: offer the device's parameters; opts.resolve(m) -> text: what the
 * mapping does on the open device (shown in a column).
 */
export function mappingTable(shell, { list, save, params = null, deviceName = '', resolve = null, empty = 'No mappings yet.' }) {
  const el = h('div.col');
  const draw = () => {
    const rows = list();
    clear(el).append(
      rows.length ? h('div.table-wrap', h('table.list',
        h('thead', h('tr', h('th', 'Controller'), h('th', 'Does'), resolve ? h('th', `On the ${deviceName}`) : null, h('th', ''))),
        h('tbody', rows.map((m) => h('tr',
          h('td', sourceText(shell, m)),
          h('td', targetText(m.target, m.target?.type === 'param' ? params?.find((p) => p.object === m.target.object && p.key === m.target.param)?.full : null)),
          resolve ? h('td.small', resolve(m)) : null,
          h('td.row',
            h('button.btn.small', { onclick: async () => { const e = await editMapping(shell, m, { params, deviceName }); if (e) { save(list().map((x) => (x.id === m.id ? e : x))); draw(); } } }, 'Edit'),
            h('button.btn.small', { onclick: () => { save(list().filter((x) => x.id !== m.id)); draw(); } }, 'Delete'))))))) : h('div.small.muted', empty),
      h('div.row', h('button.btn.small.primary', {
        onclick: async () => {
          const e = await editMapping(shell, null, { params, deviceName });
          if (!e) return;
          const clash = list().find((x) => x.cc === e.cc && x.input === e.input && x.channel === e.channel);
          if (clash) toast(`That controller was mapped already (${targetText(clash.target)}); the new mapping replaces it.`, 'info', 5000);
          save([...list().filter((x) => x !== clash), e]);
          draw();
        },
      }, 'Add mapping...')));
  };
  draw();
  return { el, refresh: draw };
}
