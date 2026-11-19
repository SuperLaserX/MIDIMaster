// Device picker: every device in the firmware collection, searchable and grouped by maker.

import { h, clear } from '../core/ui/dom.js';
import { DEVICES, MIDI_LABEL, appLogo } from '../devices/registry.js';
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
  const grid = h('div.dev-groups');

  function card(d) {
    const badges = [
      d.hasModule ? h('span.badge.live', 'Full editor') : d.hasDef ? h('span.badge.ram', 'Mapped') : d.openable ? h('span.badge', 'Generic MIDI') : null,
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

  function row(d) {
    const tag = d.hasModule ? h('span.badge.live', 'Editor') : d.hasDef ? h('span.badge.ram', 'Mapped')
      : !['Y', 'R'].includes(d.midi) ? h('span.badge' + (d.openable ? '.warn' : ''), MIDI_LABEL[d.midi] || d.midi) : null;
    return h('button.dev-row' + (d.openable ? '' : '.off'), {
      title: `${d.title}
${TYPE_NAMES[d.type] || d.type}${d.cpu?.length ? `, CPU ${d.cpu[0]}` : ''}
${MIDI_LABEL[d.midi] || d.midi}, ${d.archives.length} firmware file(s)`,
      onclick: () => { if (d.openable) shell.go(`#/d/${d.id}`); },
    }, h('span.dev-model', d.model), h('span.dev-type', TYPE_NAMES[d.type] || d.type), tag);
  }

  function render() {
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    const showAll = st.status === 'all' || shell.settings.get('showNonMidi');
    const list = DEVICES.filter((d) => {
      if (st.status === 'editors' && !d.hasModule && !d.hasDef) return false;
      if (!showAll && !d.openable) return false;
      if (st.maker && d.maker !== st.maker) return false;
      if (st.type && d.type !== st.type) return false;
      const hay = `${d.maker} ${d.model} ${d.id} ${(d.cpu || []).join(' ')} ${TYPE_NAMES[d.type] || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    count.textContent = `${list.length} of ${DEVICES.length} devices`;
    const groups = new Map();
    for (const d of list) {
      if (!groups.has(d.maker)) groups.set(d.maker, []);
      groups.get(d.maker).push(d);
    }
    clear(grid).append(...[...groups].map(([maker, devs]) => h('section.card.dev-group',
      h('h2', maker, h('span.small.muted', ` ${devs.length}`)),
      h('div.dev-list', devs.map(row)))));
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
      h('div.sub', `Choose a device to edit. ${stats.total} devices from the firmware collection, ${stats.midi} with MIDI; ${stats.editors} with a complete editor so far. Every MIDI device opens at least the generic editor: controllers, programs, SysEx librarian, Sample Dump and a SysEx console.`)),
    recent.length ? h('div.card.col', h('h2', 'Recent'), h('div.dev-grid', recent.map(card))) : null,
    h('div.row.dev-filters', q, makerSel, typeSel, statusSel, count),
    grid);
  render();
  setTimeout(() => q.focus(), 0);
  return null;
}
