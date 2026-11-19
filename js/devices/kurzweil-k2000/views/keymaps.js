// Keymap viewer/editor: zones per velocity level, sample assignments, tuning and
// volume per entry. Edits are sent live as one LOAD spanning the changed bytes.

import { h, clear, toast, formDialog } from '../../../core/ui/dom.js';
import { T } from '../model/types.js';
import { Keymap, LEVELS } from '../model/keymap.js';
import { noteName } from '../model/tables.js';

const COLORS = ['#f2b544', '#5aa7f2', '#4fc28a', '#ef5d5d', '#b48cf2', '#f08a4b', '#3fd0c9', '#e46fb4'];

export function keymapView(root, app, params = {}) {
  const st = { items: [], selected: params.id ?? null, km: null, level: 4 };
  const listWrap = h('div.table-wrap', { style: { maxHeight: 'calc(100vh - 210px)' } });
  const detail = h('div.grow', { style: { minWidth: 0 } });
  const filter = h('input', { type: 'text', placeholder: 'Filter', oninput: () => renderList() });

  root.append(
    h('h1', 'Keymaps'),
    h('div.sub', 'Which sample plays on each key and velocity level. RAM keymaps can be edited live.'),
    h('div.row', { style: { alignItems: 'flex-start', flexWrap: 'nowrap', gap: '16px' } },
      h('div', { style: { width: '280px', flex: '0 0 280px' } },
        h('div.row', { style: { marginBottom: '8px' } }, filter, h('button.btn', { onclick: refresh }, 'Refresh')),
        listWrap),
      detail));

  async function refresh() {
    if (!app.online) { clear(listWrap).append(h('div.empty', 'Not connected.')); return; }
    clear(listWrap).append(h('div.empty', 'Reading keymaps...'));
    try {
      const items = await app.client.dirBank(T.KEYMAP, 127, false);
      items.forEach((i) => app.rememberInfo(i));
      st.items = items.filter((i) => i.size > 0).sort((a, b) => a.id - b.id);
      renderList();
      if (st.selected) open(st.selected);
    } catch (err) { clear(listWrap).append(h('div.empty', err.message)); }
  }

  function renderList() {
    const f = filter.value.toLowerCase();
    const rows = st.items.filter((i) => !f || i.objName.toLowerCase().includes(f) || String(i.id).startsWith(f));
    clear(listWrap).append(h('table.list', h('tbody', rows.map((i) => h('tr' + (i.id === st.selected ? '.sel' : ''), {
      style: { cursor: 'pointer' }, onclick: () => open(i.id),
    }, h('td.mono.muted', String(i.id)), h('td', i.objName), h('td', h('span.badge.' + (i.inRam ? 'ram' : 'rom'), i.inRam ? 'RAM' : 'ROM')))))));
  }

  async function open(id) {
    st.selected = id;
    renderList();
    clear(detail).append(h('div.empty', `Reading keymap ${id}...`));
    try {
      const obj = await app.client.fetchObject(T.KEYMAP, id);
      st.km = new Keymap(obj.data, { id, name: obj.name });
      st.km.inRam = obj.inRam;
      render();
    } catch (err) { clear(detail).append(h('div.notice.bad', err.message)); }
  }

  function sendPatches(patches) {
    const list = patches.filter(Boolean);
    if (!list.length || !st.km.inRam) return;
    const start = Math.min(...list.map((p) => p.offset));
    const end = Math.max(...list.map((p) => p.offset + p.bytes.length));
    app.client.load(T.KEYMAP, st.km.id, start, st.km.data.slice(start, end), { key: `k${st.km.id}:${start}:${end}` })
      .catch((err) => app.error(err, 'Keymap edit'));
  }

  function render() {
    const km = st.km;
    const zones = km.zones(st.level);
    const sampleIds = [...new Set(zones.map((z) => z.sampleId))];
    const color = (id) => COLORS[sampleIds.indexOf(id) % COLORS.length];
    const strip = h('div', { style: { position: 'relative', height: '34px', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '6px', overflow: 'hidden' } });
    for (const z of zones) {
      const lo = Math.max(0, Math.round(z.lo));
      const hi = Math.min(127, Math.round(z.hi));
      strip.append(h('div', {
        title: `${noteName(lo)}-${noteName(hi)}: sample ${z.sampleId}`,
        style: { position: 'absolute', top: 0, bottom: 0, left: `${(lo / 128) * 100}%`, width: `${((hi - lo + 1) / 128) * 100}%`, background: color(z.sampleId), opacity: 0.75, borderRight: '1px solid var(--bg)' },
      }));
    }
    const levelTabs = h('div.tabs', LEVELS.map((l, i) => h('button' + (i === st.level ? '.active' : ''), { onclick: () => { st.level = i; render(); } }, l)));
    const rows = zones.map((z) => {
      const name = h('span.small.muted', app.nameOf(T.SOUNDBLOCK, z.sampleId) ?? '');
      if (app.nameOf(T.SOUNDBLOCK, z.sampleId) === undefined) app.lookupName(T.SOUNDBLOCK, z.sampleId).then((n) => { name.textContent = n ?? '(missing)'; });
      const sid = h('input', {
        type: 'number', min: 0, max: 999, value: z.sampleId, disabled: !km.inRam || !(km.method & 0x02),
        onchange: () => { sendPatches(z.entries.map((e) => km.setSample(e, Number(sid.value)))); km.parse(); render(); },
      });
      const vol = h('input', {
        type: 'number', min: -128, max: 127, value: z.entries[0].volume ?? 0, disabled: !km.inRam || !(km.method & 0x04),
        title: 'Volume adjust for every entry in this zone (0.5 dB steps)',
        onchange: () => sendPatches(z.entries.map((e) => km.setVolume(e, Number(vol.value)))),
      });
      const tune = h('input', {
        type: 'number', min: -32768, max: 32767, value: z.entries[0].tuning ?? 0, disabled: !km.inRam || !(km.method & 0x18),
        title: 'Tuning in cents for every entry in this zone',
        onchange: () => sendPatches(z.entries.map((e) => km.setTuning(e, Number(tune.value)))),
      });
      return h('tr',
        h('td', h('span', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: color(z.sampleId) } })),
        h('td.mono', `${noteName(Math.round(z.lo))} - ${noteName(Math.round(z.hi))}`),
        h('td', sid, ' ', name),
        h('td.mono', z.subSample ?? ''),
        h('td', tune), h('td', vol),
        h('td.muted.small', `${z.entries.length} entries`));
    });
    clear(detail).append(
      h('div.card',
        h('div.card-head', h('h2', `#${km.id} ${km.name}`), h('span.badge.' + (km.inRam ? 'ram' : 'rom'), km.inRam ? 'RAM' : 'ROM'),
          km.inRam ? h('button.btn.small', { onclick: rename }, 'Rename') : null),
        h('div.row.small.muted', { style: { gap: '16px' } },
          [`Method 0x${km.method.toString(16)}`, `Base pitch ${km.basePitch} ct`, `${km.centsPerEntry} ct per entry`,
            `${km.numEntries} entries`, `${km.entrySize} bytes each`, `${km.tables.length} table(s)`].map((t) => h('span', t))),
        h('div', { style: { marginTop: '10px' } }, levelTabs, strip),
        !km.inRam ? h('p.small.muted', 'ROM keymap: copy it to RAM in the Library to edit it.') : null),
      h('div.section-title', 'Zones'),
      h('div.table-wrap', h('table.list',
        h('thead', h('tr', h('th', ''), h('th', 'Keys'), h('th', 'Sample'), h('th', 'Sub'), h('th', 'Tuning'), h('th', 'Volume'), h('th', ''))),
        h('tbody', rows))));
  }

  async function rename() {
    const r = await formDialog('Rename keymap', [{ key: 'name', label: 'Name', value: st.km.name, maxlength: 16 }], 'Rename');
    if (!r) return;
    try { await app.client.rename(T.KEYMAP, st.km.id, r.name); toast('Renamed', 'good', 1500); refresh(); } catch (err) { app.error(err, 'Rename'); }
  }

  if (app.online) refresh(); else root.append(h('div.notice.warn', 'Connect to the K2000 to browse keymaps.'));
  return null;
}
