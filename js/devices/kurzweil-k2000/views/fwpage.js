// Controls and cards for parameters described by the K2000 firmware (model/fwmodel.js).
// Labels, value ranges and every displayed value come from the OS image, so each
// control shows exactly what the K2000's own display shows.

import { h } from '../../../core/ui/dom.js';
import { knob, selectField, numberField } from '../../../core/ui/controls.js';
import { paramValues, paramRange, formatParam, hasChoices, romName, LISTS } from '../model/fwmodel.js';

const SELECT_MAX = 48;
const PICK_FROM_ROM = new Set([114, 115]); // LFO shapes, FUN functions

/**
 * One control for a firmware parameter.
 * opts: {p, name, value, names(type, id), onChange(v), title}
 * Returns an element with setValue(v) and setState(state).
 */
export function fwControl(opts) {
  const { p, name } = opts;
  const vals = paramValues(p);
  const fmt = (v) => formatParam(p, v, opts.names);
  const shown = String(p.l || '').trim();
  const title = opts.title || (shown && shown !== name ? `${name} ("${shown}" on the K2000 display)` : name);
  let el;

  if (p.s && p.s.obj && PICK_FROM_ROM.has(p.s.obj) && vals) {
    // LFO shapes and FUN functions are ROM objects: pick them by name.
    const options = vals.filter((v) => v === 0 || romName(p.s.obj, v)).map((v) => ({ value: v, label: fmt(v) }));
    el = selectField({ label: name, value: opts.value, options, onChange: opts.onChange });
  } else if (p.s && p.s.obj) {
    const { min, max } = paramRange(p);
    el = numberField({ label: name, value: opts.value, min, max, format: fmt, onChange: opts.onChange });
  } else if (vals && hasChoices(p) && vals.length <= SELECT_MAX) {
    const labels = LISTS[p.s];
    el = selectField({
      label: name, value: opts.value,
      options: vals.map((v, i) => ({ value: v, label: labels[i] ?? String(v) })),
      onChange: opts.onChange,
    });
  } else if (vals && vals.length <= 4096) {
    // Knob over the list of allowed values, so sparse ranges step like the K2000's own knob.
    const idxOf = (v) => {
      const i = vals.indexOf(v);
      if (i >= 0) return i;
      let best = 0;
      vals.forEach((x, k) => { if (Math.abs(x - v) < Math.abs(vals[best] - v)) best = k; });
      return best;
    };
    const k = knob({
      label: name, value: idxOf(opts.value), min: 0, max: vals.length - 1, title,
      format: (i) => fmt(vals[i]),
      onChange: (i) => opts.onChange?.(vals[i]),
    });
    const setValue = k.setValue;
    k.setValue = (v) => setValue(idxOf(v));
    el = k;
  } else {
    const { min, max } = paramRange(p);
    el = numberField({ label: name, value: opts.value, min, max, format: fmt, onChange: opts.onChange });
  }
  if (!el.title) el.title = title;
  el.setState ??= (state) => { el.classList.toggle('pending', state === 'pending'); el.classList.toggle('error', state === 'error'); };
  return el;
}

/**
 * A card with every parameter of one firmware page.
 * entries: [{p, name, block?}]; read(entry) -> value or null (null hides the control);
 * write(entry, v, control). Returns null when nothing on the page applies.
 */
export function fwCard(title, entries, { read, write, names, subtitle, extra, cls = '' }) {
  const controls = [];
  for (const e of entries) {
    const v = read(e);
    if (v === null || v === undefined) continue;
    let ctl;
    ctl = fwControl({ p: e.p, name: e.name, value: v, names, onChange: (nv) => write(e, nv, ctl) });
    controls.push(ctl);
  }
  if (!controls.length && !extra) return null;
  return h('div.card.fw-card' + cls,
    h('div.card-head', h('h2', title), subtitle ? h('span.tag', subtitle) : null),
    extra || null,
    controls.length ? h('div.params', controls) : null);
}
