// Parameters page driven by a device definition. Each parameter knows how to encode
// itself (CC, NRPN, RPN or a SysEx builder); edits are sent live.
//
// Definition params: {group, key, label, min, max, default, options?: [[value, label]],
//   cc?, nrpn?: [msb, lsb], rpn?: [msb, lsb], send?: (value, ctx) => bytes or [bytes...],
//   format?: (value) => string}

import { h, clear } from '../../../core/ui/dom.js';
import { knob, selectField } from '../../../core/ui/controls.js';

export function paramsView(root, g) {
  const def = g.def;
  const values = new Map();
  const groups = new Map();
  for (const p of def.params) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
    values.set(p.key, p.default ?? p.min ?? 0);
  }

  function send(p, v) {
    try {
      const ctx = g.ctx;
      if (p.send) {
        const out = p.send(v, ctx);
        const list = Array.isArray(out[0]) || out[0] instanceof Uint8Array ? out : [out];
        for (const bytes of list) {
          if (bytes[0] === 0xf0) g.client.send(Uint8Array.from(bytes), { key: `p:${p.key}` }).catch((err) => g.error(err, p.label));
          else g.client.sendNow(bytes);
        }
      } else if (p.cc !== undefined) g.client.cc(ctx.channel, p.cc, v);
      else if (p.nrpn) g.client.paramNumber(ctx.channel, { nrpn: true, msb: p.nrpn[0], lsb: p.nrpn[1], value: v, fine: (p.max ?? 127) > 127 });
      else if (p.rpn) g.client.paramNumber(ctx.channel, { nrpn: false, msb: p.rpn[0], lsb: p.rpn[1], value: v, fine: (p.max ?? 127) > 127 });
    } catch (err) { g.error(err, p.label); }
  }

  function control(p) {
    const value = values.get(p.key);
    const onChange = (v) => { values.set(p.key, v); send(p, v); };
    if (p.options) return selectField({ label: p.label, value, options: p.options.map(([v, l]) => ({ value: v, label: l })), onChange });
    return knob({ label: p.label, min: p.min ?? 0, max: p.max ?? 127, value, format: p.format, onChange });
  }

  const body = h('div.grid.cols-2');
  for (const [name, ps] of groups) body.append(h('div.card', h('div.card-head', h('h2', name)), h('div.params', ps.map(control))));
  root.append(
    h('h1', 'Parameters'),
    h('div.sub', def.paramsNote || `Every change is sent to the ${g.entry.model} as you make it.`),
    body);
  return null;
}
