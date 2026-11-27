// "Import from Head Library": pick patches the open device can load (its own, or another model's
// through the translators) and hand them to the send dialog (load into the editor, send to the edit
// buffer, or store into memory slots). Used by the editor pages (only that page's object) and by the
// Branch Library (any object).

import { h, clear, toast, dialog } from '../../../core/ui/dom.js';
import { CATEGORY_LABEL } from '../../../core/mainlib/categories.js';
import { filterRows, filterBar, kindLabel } from '../../../core/ui/mainlib.js';
import { fitFor, sendToDevice } from '../sendto.js';

const PAGE = 150;

/** g: the device module; obj: limit to rows that load into this object (null: any object). */
export async function importFromMainLibrary(g, obj = null) {
  let lib;
  try { lib = await g.host.shell.mainLibrary(); } catch (err) { toast(`The Head Library could not be opened: ${err.message}`, 'bad'); return; }
  const rows = (await lib.allRows()).filter((r) => { const m = fitFor(g, r); return m?.obj && (!obj || m.obj === obj); });
  const what = obj ? `${obj.label.toLowerCase()} page` : g.entry.model;
  if (!rows.length) {
    toast(`Nothing in the Head Library loads into the ${what}${lib.subs().length ? '' : ' (it is empty: import files on the Head Library page)'}.`, 'warn', 6000);
    return;
  }
  const st = { f: { q: '', sub: '', device: '', type: '', category: '', kind: '' }, limit: PAGE, picked: new Set() };
  const key = (r) => `${r.sub}/${r.id}`;
  const subs = lib.subs();
  const subName = new Map(subs.map((s) => [s.id, s.name]));
  const list = h('div');
  const count = h('div.small.muted');
  const bar = h('div');
  const draw = () => {
    const shown = filterRows(rows, st.f);
    const page = shown.slice(0, st.limit);
    const all = h('input', { type: 'checkbox', title: 'Select all shown', checked: !!shown.length && shown.every((r) => st.picked.has(key(r))),
      onchange: () => { for (const r of shown) { if (all.checked) st.picked.add(key(r)); else st.picked.delete(key(r)); } draw(); } });
    clear(list).append(page.length ? h('div.table-wrap.ml-table', h('table.list',
      h('thead', h('tr', h('th', all), h('th', 'Name'), h('th', 'Category'), h('th', 'From'), h('th', 'Kind'), h('th', 'Loads as'))),
      h('tbody', page.map((r) => {
        const m = fitFor(g, r);
        const box = h('input', { type: 'checkbox', checked: st.picked.has(key(r)), onclick: (ev) => ev.stopPropagation(), onchange: () => { if (box.checked) st.picked.add(key(r)); else st.picked.delete(key(r)); draw(); } });
        return h('tr' + (st.picked.has(key(r)) ? '.sel' : ''), { onclick: () => { if (st.picked.has(key(r))) st.picked.delete(key(r)); else st.picked.add(key(r)); draw(); } },
          h('td', box), h('td', r.name, h('div.small.muted', subName.get(r.sub) || '')),
          h('td.small', CATEGORY_LABEL[r.category] || r.category), h('td.small', r.model), h('td.small', kindLabel(r.kind)),
          h('td', m.mode === 'native' ? h('span.badge.live', m.obj.label) : h('span.badge.ram', { title: `From the ${r.model} through the shared synth model` }, `${m.obj.label}, translated`)));
      })))) : h('div.empty', 'Nothing matches.'),
    shown.length > page.length ? h('button.btn.small', { onclick: () => { st.limit += PAGE * 3; draw(); } }, `Show more (${shown.length - page.length} not shown)`) : null);
    count.textContent = `${st.picked.size} selected. One patch can go into the editor or the edit buffer; several are stored into memory slots one after another.`;
  };
  clear(bar).append(filterBar(rows, st.f, () => { st.limit = PAGE; draw(); }, { subs }));
  draw();
  const ok = await dialog(`Import into the ${what} from the Head Library`, h('div.col.ml-pick', bar, list, count), [
    { label: 'Cancel', value: false }, { label: 'Next...', value: true, primary: true }]);
  if (!ok) return;
  const chosen = rows.filter((r) => st.picked.has(key(r)));
  if (!chosen.length) { toast('Nothing was selected.', 'warn'); return; }
  await sendToDevice(g, lib, chosen);
}
