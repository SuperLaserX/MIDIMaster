// A device's "Input mappings" page: what the global controller mappings (Settings, MIDI inputs) do on
// this device, and the device's own mappings, which override them (core/midi/inputs.js).

import { h, clear } from '../../../core/ui/dom.js';
import { mappingTable, editMapping } from '../../../core/ui/mappings.js';
import { targetText } from '../../../core/midi/functions.js';
import { slotsOf } from '../../../core/midi/inputs.js';

export function inputsView(root, g) {
  const shell = g.host.shell;
  const dev = g.host.device;
  const own = () => dev.value.inputMappings || [];
  const saveOwn = (list) => dev.update({ inputMappings: list });
  // every parameter a controller can set, by object
  const params = g.mappableObjects().flatMap((obj) => {
    const sections = new Map((obj.sections || []).map((s) => [s.key, s.label]));
    return obj.params.filter((p) => !p.readOnly && !p.hidden && p.kind !== 'char').map((p) => {
      const where = [sections.size > 1 ? sections.get(p.section) : null, p.group].filter(Boolean).join(' / ');
      return { object: obj.key, objectLabel: obj.page || obj.label, key: p.key, label: `${where ? `${where}: ` : ''}${p.label}`, full: `${obj.page || obj.label}: ${where ? `${where}: ` : ''}${p.label}` };
    });
  });
  const onDevice = (t) => {
    if (t.type === 'function') {
      const r = g.resolveMapped(t.fn);
      return r ? `${r.obj.page || r.obj.label}: ${r.p.label}` : 'no such parameter found: the controller is passed through unchanged';
    }
    if (t.type === 'param') return params.find((p) => p.object === t.object && p.key === t.param)?.full || 'parameter not found';
    return targetText(t);
  };
  const ownTable = mappingTable(shell, { list: own, save: (l) => { saveOwn(l); drawGlobal(); }, params, deviceName: g.entry.model, resolve: (m) => onDevice(m.target), empty: `No ${g.entry.model} mappings: the global ones apply.` });
  const globalBox = h('div');
  const drawGlobal = () => {
    const list = shell.settings.value.inputs?.mappings || [];
    clear(globalBox).append(list.length ? h('div.table-wrap', h('table.list',
      h('thead', h('tr', h('th', 'Controller'), h('th', 'Does'), h('th', `On the ${g.entry.model}`), h('th', ''))),
      h('tbody', list.map((m) => {
        // a device mapping at least as wide as this one takes its place
        const over = own().find((x) => x.cc === m.cc && (x.input === 'any' || x.input === m.input) && (x.channel === 'any' || x.channel === m.channel));
        const exact = own().find((x) => x.cc === m.cc && x.input === m.input && x.channel === m.channel);
        return h('tr',
          h('td', `CC ${m.cc}${m.input === 'any' ? '' : `, input ${m.input + 1}`}${m.channel === 'any' ? '' : `, ch ${m.channel + 1}`}`),
          h('td', targetText(m.target)),
          h('td.small', exact || over ? h('span.muted', 'overridden below') : onDevice(m.target)),
          h('td', exact ? null : h('button.btn.small', {
            title: `Make a ${g.entry.model} mapping for this controller (it overrides the global one here)`,
            onclick: async () => {
              const r = m.target.type === 'function' ? g.resolveMapped(m.target.fn) : null;
              const seed = { ...structuredClone(m), id: undefined, target: r ? { type: 'param', object: r.obj.key, param: r.p.key } : structuredClone(m.target) };
              const e = await editMapping(shell, { ...seed, id: `d${Date.now().toString(36)}` }, { params, deviceName: g.entry.model });
              if (e) { saveOwn([...own(), e]); ownTable.refresh(); drawGlobal(); }
            },
          }, 'Override...')));
      })))) : h('div.small.muted', 'No global mappings. Add them in Settings, MIDI inputs (they apply to every device).'));
  };
  drawGlobal();
  const slots = slotsOf(shell.settings.value.inputs);
  const status = { off: 'not used', 'no-midi': 'MIDI not allowed yet', missing: 'port not found', open: 'listening' };
  root.append(
    h('h1', 'Input mappings'),
    h('div.sub', `Controllers connected to MIDIMaster (Settings, MIDI inputs) play the ${g.entry.model} and can change its parameters. A ${g.entry.model} mapping overrides a global mapping of the same controller; a function finds the ${g.entry.model}'s own parameter, shown here.`),
    h('div.card.col',
      h('div.card-head.row', h('h2.grow', 'MIDI inputs'), h('a.btn.small', { href: '#/settings' }, 'Settings...')),
      h('div.small', slots.map((s, i) => h('div', `Input ${i + 1}: ${s.port || '-'}${s.port ? ` (${status[shell.inputs.status(i)]}${s.thru ? `, plays the open device${s.toChannel ? ` on its channel (${g.channel + 1})` : ''}` : ''})` : ''}`)))),
    h('div.card.col', h('h2', `${g.entry.model} mappings`), ownTable.el),
    h('div.card.col', h('h2', 'Global mappings'), globalBox));
  const off = shell.inputs.on('status', () => drawGlobal());
  return { destroy() { off?.(); shell.inputs.learn = null; } };
}
