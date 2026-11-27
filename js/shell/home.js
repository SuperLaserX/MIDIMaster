// Device picker: every device in the firmware collection, searchable and grouped by maker.

import { h, clear } from '../core/ui/dom.js';
import { DEVICES, MIDI_LABEL, appLogo } from '../devices/registry.js';
import { isFullEditor } from '../devices/levels.js';
import { FAMILIES, deviceFamily } from '../devices/families.js';
import { recentDevices } from '../core/settings.js';

const TYPE_NAMES = {
  syn: 'Synthesizer', smp: 'Sampler', drm: 'Drum machine', fx: 'Effects', seq: 'Sequencer', ctl: 'Controller',
  if: 'MIDI interface', mix: 'Mixer', gtr: 'Guitar/bass', pno: 'Piano/organ', arr: 'Arranger', rec: 'Recorder',
  voc: 'Vocal', cpu: 'Computer/card', data: 'Sound data', oth: 'Other',
};
const STORE = 'midimaster.homeFilter';

export function homeView(root, shell) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(STORE) || '{}'); } catch { /* ignore */ }
  const st = { q: saved.q || '', maker: saved.maker || '', type: saved.type || '', status: saved.status || 'midi' };
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(st)); } catch { /* ignore */ } };

  const makers = [...new Set(DEVICES.map((d) => d.maker))].sort((a, b) => a.localeCompare(b));
  const types = [...new Set(DEVICES.map((d) => d.type))].sort();
  const q = h('input', { type: 'search', placeholder: 'Search devices (name, maker, CPU...)', value: st.q, oninput: () => { st.q = q.value; save(); render(); } });
  const makerSel = h('select', { onchange: () => { st.maker = makerSel.value; save(); render(); } },
    h('option', { value: '' }, 'All makers'), ...makers.map((m) => h('option', { value: m, selected: m === st.maker }, m)));
  const typeSel = h('select', { onchange: () => { st.type = typeSel.value; save(); render(); } },
    h('option', { value: '' }, 'All types'), ...types.map((t) => h('option', { value: t, selected: t === st.type }, TYPE_NAMES[t] || t)));
  const statusSel = h('select', { onchange: () => { st.status = statusSel.value; save(); render(); } },
    [['midi', 'Devices with MIDI'], ['editors', 'Full editors only'], ['all', 'Everything in the collection']].map(([v, l]) => h('option', { value: v, selected: v === st.status }, l)));
  const count = h('span.small.muted');
  const grid = h('div.dev-sections');

  function card(d) {
    const badges = [
      isFullEditor(d) ? h('span.badge.live', 'Full editor') : d.hasModule || d.hasDef ? h('span.badge.ram', 'Mapped') : d.openable ? h('span.badge', 'Generic MIDI') : null,
      !['Y', 'R'].includes(d.midi) ? h('span.badge' + (d.openable ? '.warn' : ''), MIDI_LABEL[d.midi] || d.midi) : d.midi === 'R' ? h('span.badge.warn', MIDI_LABEL.R) : null,
    ];
    return h('button.dev-card' + (d.openable ? '' : '.off'), {
      title: `${d.title}\n${TYPE_NAMES[d.type] || d.type}${d.cpu?.length ? `, CPU ${d.cpu[0]}` : ''}\n${d.archives.length} firmware file(s)`,
      onclick: () => { if (d.openable) shell.go(`#/d/${d.id}`); },
    },
    h('div.dev-model', d.model),
    h('div.dev-type', TYPE_NAMES[d.type] || d.type),
    h('div.row.dev-badges', ...badges));
  }

  const available = (d) => d.hasModule || d.hasDef;

  function row(d) {
    const tag = isFullEditor(d) ? h('span.badge.live', 'Full editor') : d.hasModule || d.hasDef ? h('span.badge.ram', 'Mapped')
      : !['Y', 'R'].includes(d.midi) ? h('span.badge' + (d.openable ? '.warn' : ''), MIDI_LABEL[d.midi] || d.midi) : null;
    const cls = d.openable ? (available(d) ? '' : '.pending') : '.off';
    return h('button.dev-row' + cls, {
      title: `${d.title}
${TYPE_NAMES[d.type] || d.type}${d.cpu?.length ? `, CPU ${d.cpu[0]}` : ''}
${MIDI_LABEL[d.midi] || d.midi}, ${d.archives.length} firmware file(s)${d.openable && !available(d) ? '\nNo editor yet: opens the generic MIDI tools.' : ''}`,
      onclick: () => { if (d.openable) shell.go(`#/d/${d.id}`); },
    }, h('span.dev-model', d.model), h('span.dev-type', TYPE_NAMES[d.type] || d.type), tag);
  }

  /** Devices grouped by maker, one card per maker. */
  const byMaker = (list) => {
    const groups = new Map();
    for (const d of list) {
      if (!groups.has(d.maker)) groups.set(d.maker, []);
      groups.get(d.maker).push(d);
    }
    return [...groups].map(([maker, devs]) => h('section.card.dev-group',
      h('h2', maker, h('span.small.muted', ` ${devs.length}`)),
      h('div.dev-list', devs.map(row))));
  };

  function render() {
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    const showAll = st.status === 'all' || shell.settings.get('showNonMidi');
    const list = DEVICES.filter((d) => {
      if (st.status === 'editors' && !available(d)) return false;
      if (!showAll && !d.openable) return false;
      if (st.maker && d.maker !== st.maker) return false;
      if (st.type && d.type !== st.type) return false;
      const hay = `${d.maker} ${d.model} ${d.id} ${(d.cpu || []).join(' ')} ${TYPE_NAMES[d.type] || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    count.textContent = `${list.length} of ${DEVICES.length} devices`;
    // Available editors first, then everything else greyed out below them.
    const ready = list.filter(available);
    const rest = list.filter((d) => !available(d));
    clear(grid);
    if (ready.length) {
      // grouped by what each instrument is (devices/families.js): grooveboxes, FM, analog, VA, effects...
      const byFamily = new Map(FAMILIES.map((f) => [f.key, []]));
      for (const d of ready) byFamily.get(deviceFamily(d))?.push(d);
      grid.append(h('section.dev-section',
        h('h2.dev-section-head', 'Available editors', h('span.small.muted', ` ${ready.length}`)),
        ...FAMILIES.filter((f) => byFamily.get(f.key).length).map((f) => h('div.dev-family',
          h('h3.dev-family-head', f.label, h('span.small.muted', ` ${byFamily.get(f.key).length}`)),
          h('div.dev-grid', byFamily.get(f.key).map(card))))));
    }
    if (rest.length) {
      grid.append(h('section.dev-section.pending',
        h('h2.dev-section-head', 'Not yet available', h('span.small.muted', ` ${rest.length}: open the generic MIDI tools (controllers, programs, SysEx Branch Library and console) until an editor is built`)),
        h('div.dev-groups', byMaker(rest))));
    }
    if (!list.length) grid.append(h('div.empty', 'No device matches.'));
  }

  const recent = recentDevices().map((id) => DEVICES.find((d) => d.id === id)).filter(Boolean);
  const stats = {
    total: DEVICES.length,
    midi: DEVICES.filter((d) => d.openable).length,
    editors: DEVICES.filter((d) => d.hasModule || d.hasDef).length,
  };

  root.append(
    h('div.hero',
      h('pre.ascii-logo.app-logo', appLogo()),
      h('div.sub', `Choose a device to edit. ${stats.total} devices from the firmware collection, ${stats.midi} with MIDI; ${stats.editors} with a complete editor so far. Every MIDI device opens at least the generic editor: controllers, programs, SysEx Branch Library, Sample Dump and a SysEx console.`)),
    recent.length ? h('div.card.col', h('h2', 'Recent'), h('div.dev-grid', recent.map(card))) : null,
    h('div.row.dev-filters', q, makerSel, typeSel, statusSel, count),
    grid);
  render();
  setTimeout(() => q.focus(), 0);
  return null;
}
