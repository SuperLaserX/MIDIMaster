// MIDI channels: a multitimbral object (performance, multi, MULTI combination) on one page,
// a row per part with the patch it plays and the MIDI channel it receives on, and a list
// of who plays on each channel. It edits the same data as the object's own page, and each
// change is sent the same way.
//
// Definition (obj.multi):
//   page: 'MIDI channels'                page label
//   label: 'Parts'                       what the parts are called
//   count: n | (data, ctx) -> n
//   section(i) -> key                    the obj.sections key holding part i's parameters
//   partLabel(i) -> 'Part 1'
//   columns: [{label, params: [param label...], role?: 'channel' | 'on' | 'patch'}]
//                                        parameters are found by label within the part's section
//   on?(i, data, ctx) -> bool            whether part i plays (default: the 'on' column, else true)
//   mode?: {param, value, note, button}  a parameter (section 'common') that must hold `value` for
//                                        the part channels to apply, e.g. combination type MULTI
//   channels?: [[value, label]]          channel values for "Channels in order" (default 0-15)
//   note?: string | (ctx) -> string

import { h, clear, toast } from '../../../core/ui/dom.js';
import { readParam, writeParam, paramRange, formatParam } from '../../../core/model/memmap.js';
import { sendOut, loadObject, canFetch } from '../objects.js';

export function multiView(root, g, _params = {}, obj) {
  const m = obj.multi;
  const data = () => g.objectData[obj.key] || (g.objectData[obj.key] = obj.init());
  const loaded = () => !!g.loadedKeys?.has(obj.key);
  const count = () => (typeof m.count === 'function' ? m.count(data(), g.ctx) : m.count);
  const view = (p) => (p.dynamic ? { ...p, ...p.dynamic(data(), g.ctx) } : p);
  const find = (section, label) => obj.params.find((p) => p.section === section && p.label === label) || null;
  const partParams = (i, col) => col.params.map((l) => find(m.section(i), l)).filter(Boolean);

  const offs = [
    g.on('object', (key) => { if (key === obj.key) render(); }),
    g.on('names', () => render()),
    g.on('refresh', () => render()),
  ];

  function change(p, v) {
    const d = data();
    if (!writeParam(d, p, v)) return;
    const value = readParam(d, p);
    const out = p.send ? p.send(value, g.ctx, d) : obj.sendParam?.(p, value, d, g.ctx);
    if (out) sendOut(g, out, `${obj.key}:${p.sendKey || p.key}`);
    render();
  }

  /** The text a parameter shows for its current value. */
  function shown(p0) {
    const p = view(p0);
    const v = readParam(data(), p);
    return p.options ? (p.options.find(([x]) => x === v)?.[1] ?? String(v)) : formatParam(p, v);
  }

  /** A compact control for a table cell. */
  function cell(p0) {
    const p = view(p0);
    const value = readParam(data(), p);
    if (p.options) {
      const opts = p.options.some(([x]) => x === value) ? p.options : [...p.options, [value, String(value)]];
      const sel = h('select', { title: p.help || p.label, disabled: p.readOnly, onchange: () => change(p0, Number(sel.value)) },
        opts.map(([v, l]) => h('option', { value: v }, l)));
      sel.value = String(value);
      return sel;
    }
    const { min, max } = paramRange(p);
    const out = h('span.small.muted', p.format ? formatParam(p, value) : '');
    const inp = h('input', {
      type: 'number', min, max, value, title: `${p.label}: ${min}-${max}`, disabled: p.readOnly,
      onchange: () => change(p0, Math.max(min, Math.min(max, Math.round(Number(inp.value) || 0)))),
    });
    return h('span.row.multi-num', inp, out);
  }

  const roleCol = (role) => m.columns.find((c) => c.role === role);
  function isOn(i) {
    if (m.on) return m.on(i, data(), g.ctx);
    const col = roleCol('on');
    const p = col && partParams(i, col)[0];
    return p ? readParam(data(), view(p)) !== 0 : true;
  }

  function modeParam() {
    return m.mode ? find('common', m.mode.param) || obj.params.find((p) => p.label === m.mode.param) : null;
  }

  async function fetchObject() {
    try {
      g.setBusy(1, `Reading ${obj.label}`);
      g.loading.add(obj.key);
      await loadObject(g, obj);
      toast(`${obj.label} received`, 'good', 1500);
    } catch (err) { g.error(err, `Read ${obj.label}`); } finally { g.loading.delete(obj.key); g.setBusy(0); }
  }

  function channelsInOrder() {
    const col = roleCol('channel');
    if (!col) return;
    const values = (m.channels || Array.from({ length: 16 }, (_, i) => [i])).map(([v]) => v);
    let n = 0;
    for (let i = 0; i < count() && i < values.length; i++) {
      const p = partParams(i, col)[0];
      if (!p) continue;
      const d = data();
      if (!writeParam(d, p, values[i])) continue;
      const out = p.send ? p.send(readParam(d, p), g.ctx, d) : obj.sendParam?.(p, readParam(d, p), d, g.ctx);
      if (out) sendOut(g, out, `${obj.key}:${p.sendKey || p.key}`);
      n++;
    }
    render();
    toast(`${m.label || 'Parts'} 1-${n} now receive on channels 1-${n}`, 'good', 2000);
  }

  function render() {
    clear(root);
    const name = obj.name?.(data());
    const note = typeof m.note === 'function' ? m.note(g.ctx) : m.note;
    const mp = modeParam();
    const modeOk = !mp || readParam(data(), view(mp)) === m.mode.value;
    root.append(
      h('div.row.obj-head',
        h('h1.grow', m.page || 'MIDI channels', name ? h('span.muted', `  ${obj.label}: ${name}`) : null),
        canFetch(obj) ? h('button.btn.primary', { onclick: fetchObject, title: `Read the ${obj.label.toLowerCase()} from the ${g.entry.model}` }, 'Get from device') : null,
        obj.sendAll ? h('button.btn', { onclick: () => sendOut(g, obj.sendAll.build(data(), g.ctx)) }, obj.sendAll.label) : null,
        roleCol('channel') ? h('button.btn', { onclick: channelsInOrder, title: `Part 1 on channel 1, part 2 on channel 2, and so on` }, 'Channels in order') : null,
        h('button.btn', { onclick: () => g.nav(obj.key), title: `All of the ${obj.label.toLowerCase()} settings` }, `Open ${obj.page || obj.label}`)),
      !loaded() && canFetch(obj)
        ? h('div.notice', g.loading.has(obj.key) ? `Reading the ${obj.label.toLowerCase()} from the ${g.entry.model}...`
          : `Showing default values. Press Get from device to load the ${obj.label.toLowerCase()} from the ${g.entry.model}.`)
        : null,
      !modeOk ? h('div.notice.warn.row', h('span.grow', m.mode.note),
        h('button.btn.small', { onclick: () => change(mp, m.mode.value) }, m.mode.button || `Set ${mp.label} to ${view(mp).options?.find(([v]) => v === m.mode.value)?.[1] ?? m.mode.value}`)) : null,
      note ? h('p.small.muted', note) : null,
      h('div.grid.cols-3', h('div.card.wide', h('div.card-head', h('h2', m.label || 'Parts')), partsTable()), channelMap()));
  }

  function partsTable() {
    const rows = [];
    for (let i = 0; i < count(); i++) {
      const on = isOn(i);
      rows.push(h('tr' + (on ? '' : '.off'),
        h('td.mono', m.partLabel ? m.partLabel(i) : `Part ${i + 1}`),
        m.columns.map((col) => h('td', h('div.row.multi-cell', partParams(i, col).map(cell))))));
    }
    return h('div.table-wrap', h('table.list.multi-table',
      h('thead', h('tr', h('th', ''), m.columns.map((c) => h('th', c.label)))),
      h('tbody', rows)));
  }

  /** Who plays on each MIDI channel. */
  function channelMap() {
    const col = roleCol('channel');
    if (!col) return null;
    const patchCol = roleCol('patch');
    const byChannel = new Map();
    for (let i = 0; i < count(); i++) {
      if (!isOn(i)) continue;
      const p = partParams(i, col)[0];
      if (!p) continue;
      const ch = shown(p);
      const patch = patchCol ? partParams(i, patchCol).map(shown).join(' ') : '';
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch).push(`${m.partLabel ? m.partLabel(i) : `Part ${i + 1}`}${patch ? `: ${patch}` : ''}`);
    }
    const order = view(partParams(0, col)[0] || {}).options?.map(([, l]) => l) || [...byChannel.keys()].sort();
    const keys = [...new Set([...order.filter((k) => byChannel.has(k)), ...byChannel.keys()])];
    return h('div.card', h('div.card-head', h('h2', 'By channel')),
      keys.length ? h('table.list', h('tbody', keys.map((k) => h('tr', h('td.mono', k), h('td.small', byChannel.get(k).map((t) => h('div', t)))))))
        : h('p.small.muted', `No ${(m.label || 'parts').toLowerCase()} are playing.`));
  }

  render();
  if (!loaded() && canFetch(obj) && g.connected && !g.loading.has(obj.key) && !g.loadingStandard) fetchObject();
  return { destroy() { for (const off of offs) off?.(); } };
}
