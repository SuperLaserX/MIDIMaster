// A gallery: every value of one parameter as a button with its picture (the DX algorithms with their
// operator diagrams...), so a value is chosen by looking rather than by scrolling a list.
//
// Definition (on an object): galleries: [{
//   key, page (tab label), icon, param (the parameter's key), note,
//   label(value, optionLabel) -> text ("Algorithm 5"),
//   draw({value, data, ctx}) -> Element (the picture),
//   choosable(value) -> bool (values shown but not offered, e.g. DX7 algorithms a DX9 lacks: left out),
//   after: section key -> shown as a tab of the object's own page, after that section (the DX voice:
//          Voice, Algorithm, OP1...); without it the gallery is a page of its own
// }]
// Choosing a value sets the parameter as its editor page does (sent at once) and marks it here.

import { h, clear } from '../../../core/ui/dom.js';
import { readParam } from '../../../core/model/memmap.js';
import { canFetch, loadObject } from '../objects.js';

/** The buttons of gallery `gal` for the object's current data (an element; null without the parameter). */
export function galleryGrid(g, obj, gal) {
  const p0 = obj.params.find((x) => x.key === gal.param);
  if (!p0) return null;
  const d = g.objectData[obj.key] || (g.objectData[obj.key] = obj.init());
  const p = p0.dynamic ? { ...p0, ...p0.dynamic(d, g.ctx) } : p0;
  const current = readParam(d, p);
  const options = (p.options || []).filter(([v]) => !gal.choosable || gal.choosable(v));
  return h('div.gallery', options.map(([v, l]) => {
    const label = gal.label ? gal.label(v, l) : `${p.label} ${l}`;
    return h('button.gallery-item' + (v === current ? '.sel' : ''), {
      title: label, 'aria-pressed': String(v === current),
      onclick: () => { if (g.setParam(obj, p0, v)) g.emit('object', obj.key); },
    }, h('div.gallery-label', label), gal.draw({ value: v, data: d, ctx: g.ctx }));
  }));
}

/** The note above a gallery: what the pictures show and what a click does. */
export const galleryNote = (g, obj, gal) => `${gal.note ? `${gal.note} ` : ''}Click one to choose it: it is set in the ${obj.page || obj.label} and sent to the ${g.entry.model} at once.`;

/** A gallery as a page of its own. */
export function galleryView(root, g, _params, obj, gal) {
  if (!obj.params.some((x) => x.key === gal.param)) { root.append(h('div.notice.bad', `No parameter ${gal.param} in ${obj.label}.`)); return null; }
  const head = h('div');
  const grid = h('div');
  const render = () => {
    const d = g.objectData[obj.key] || (g.objectData[obj.key] = obj.init());
    const loaded = !!g.loadedKeys?.has(obj.key);
    clear(head).append(
      h('div.row', h('h1.grow', gal.page, h('span.muted', `  ${obj.label}${obj.name ? `: ${obj.name(d)}` : ''}`)),
        canFetch(obj) ? h('button.btn', { onclick: () => loadObject(g, obj).catch((err) => g.error(err, `Read ${obj.label}`)) }, 'Get from device') : null),
      h('div.sub', galleryNote(g, obj, gal)),
      !loaded && canFetch(obj) ? h('div.notice', `Showing the default ${obj.label.toLowerCase()}. Get from device reads the one on the ${g.entry.model}.`) : null);
    clear(grid).append(galleryGrid(g, obj, gal));
  };
  root.append(head, grid);
  render();
  const off = g.on('object', (key) => { if (key === obj.key) render(); });
  return { destroy() { off?.(); } };
}
