// Device picker: every device in the firmware collection, searchable and grouped by maker.

import { h, clear, badge } from '../core/ui/dom.js';
import { icon } from '../core/ui/icons.js';
import { DEVICES, MIDI_LABEL } from '../devices/registry.js';
import { isFullEditor } from '../devices/levels.js';
import { FAMILIES, deviceFamily } from '../devices/families.js';
import { recentDevices, connectedDevices } from '../core/settings.js';

// how the port scan found a device (js/devices/identify.js)
const HOW = {
  identity: ['Identity reply', 'live'], request: ['Answered a request', 'live'], port: ['Port name', 'ram'],
  maker: ['Identity reply: maker only', 'warn'], name: ['Port name only', 'warn'], 'identity-unknown': ['Identity reply, no editor', 'warn'],
};

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
  const q = h('input', { type: 'search', placeholder: 'Search devices (name, maker, CPU...)', 'aria-label': 'Search devices', value: st.q, oninput: () => { st.q = q.value; save(); render(); } });
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
      isFullEditor(d) ? badge('Full editor', 'live') : d.hasModule || d.hasDef ? badge('Mapped', 'ram') : d.openable ? badge('Generic MIDI') : null,
      !['Y', 'R'].includes(d.midi) ? badge(MIDI_LABEL[d.midi] || d.midi, d.openable ? 'warn' : '') : d.midi === 'R' ? badge(MIDI_LABEL.R, 'warn') : null,
    ];
    return h('button.dev-card' + (d.openable ? '' : '.off'), {
      title: `${d.title}\n${TYPE_NAMES[d.type] || d.type}${d.cpu?.length ? `, CPU ${d.cpu[0]}` : ''}\n${d.archives.length} firmware file(s)`,
      onclick: () => { if (d.openable) shell.go(`#/d/${d.id}`); },
    },
    h('div.dev-maker', d.maker),
    h('div.dev-model', d.model),
    h('div.dev-type', TYPE_NAMES[d.type] || d.type),
    h('div.row.dev-badges', ...badges));
  }

  const available = (d) => d.hasModule || d.hasDef;

  function row(d) {
    const tag = isFullEditor(d) ? badge('Full editor', 'live') : d.hasModule || d.hasDef ? badge('Mapped', 'ram')
      : !['Y', 'R'].includes(d.midi) ? badge(MIDI_LABEL[d.midi] || d.midi, d.openable ? 'warn' : '') : null;
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
      h('h2.dev-family-head', maker, h('span.count', String(devs.length))),
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
        h('h2.dev-section-head', 'Available editors', h('span.count', String(ready.length))),
        ...FAMILIES.filter((f) => byFamily.get(f.key).length).map((f) => h('div.dev-family',
          h('h3.dev-family-head', f.label, h('span.count', String(byFamily.get(f.key).length))),
          h('div.dev-grid', byFamily.get(f.key).map(card))))));
    }
    if (rest.length) {
      grid.append(h('section.dev-section.pending',
        h('h2.dev-section-head', 'Not yet available', h('span.count', String(rest.length))),
        h('div.dev-section-note', 'These open the generic MIDI tools (controllers, programs, SysEx Branch Library and console) until an editor is built.'),
        h('div.dev-groups', byMaker(rest))));
    }
    if (!list.length) grid.append(h('div.empty', 'No device matches.'));
  }

  // ------------------------------------------------------------ recent and connected devices
  const recentBox = h('div');
  function renderRecent() {
    const recent = recentDevices().map((id) => DEVICES.find((d) => d.id === id)).filter(Boolean);
    clear(recentBox).append(recent.length ? h('div.card.col',
      h('div.card-head-row', h('span.card-title', icon('clock-rotate-left'), h('h2', 'Recent')), h('span.grow'), h('button.btn.small', { title: 'Clear the list of recently opened devices (here and in the sidebar)', onclick: () => shell.clearRecent() }, 'Clear')),
      h('div.dev-grid', recent.map(card))) : '');
  }

  // devices found on the MIDI ports by the last scan (shell.scanConnected -> devices/identify.js)
  const connBox = h('div');
  const scan = { running: false, progress: h('span.small.muted') };
  function connectedCard(d) {
    const e = d.id ? DEVICES.find((x) => x.id === d.id) : null;
    const [how, cls] = HOW[d.how] || [d.how, ''];
    const ports = `${d.output}${d.input && d.input !== d.output ? ` / ${d.input}` : ''}`;
    const alts = (d.alternatives || []).map((id) => DEVICES.find((x) => x.id === id)).filter(Boolean);
    return h('div.dev-card' + (e ? '' : '.off'), { title: `${d.detail || ''}
Out: ${d.output}
In: ${d.input || '(none found)'}`, onclick: () => { if (e) shell.openConnected(d); } },
      e ? h('div.dev-maker', e.maker) : null,
      h('div.dev-model', e ? e.model : d.title),
      h('div.dev-ports', ports),
      h('div.row.dev-badges', badge(how, cls)),
      alts.length ? h('select.small', { onclick: (ev) => ev.stopPropagation(), onchange: (ev) => { if (ev.target.value) shell.openConnected(d, ev.target.value); } },
        h('option', { value: '' }, `Or another model (${alts.length})...`), ...alts.map((x) => h('option', { value: x.id }, x.title))) : null);
  }
  function renderConnected() {
    const last = connectedDevices();
    const devs = last?.devices || [];
    const notes = [];
    if (last?.silent?.length) notes.push(`No answer from ${last.silent.join(', ')} (devices made before about 1995 often do not answer; open them from the list below).`);
    if (last?.busy?.length) notes.push(`In use by another program: ${last.busy.join(', ')}.`);
    clear(connBox).append(h('div.card.col',
      h('div.card-head-row', h('span.card-title', icon('plug'), h('h2', 'Connected')), h('span.grow'), scan.running ? h('span.spinner') : null, scan.running ? scan.progress : null,
        h('button.btn.small.primary', { disabled: scan.running, title: 'Ask every MIDI port which device is on it', onclick: runScan }, last ? 'Scan again' : 'Scan MIDI ports'),
        last && !scan.running ? h('button.btn.small', { title: 'Forget the scan (here and in the sidebar)', onclick: () => shell.clearConnected() }, 'Clear') : null),
      !last && !scan.running ? h('div.small.muted', { title: 'Each output gets an identity request, then the editors\' read requests. Only reads are sent. Do not scan while another program is sending data to a device.' }, 'Find the devices on your MIDI ports.') : null,
      devs.length ? h('div.dev-grid', devs.map(connectedCard)) : last && !scan.running ? h('div.small.muted', 'No device was recognised.') : null,
      last && !scan.running ? h('div.small.muted', `Scanned ${new Date(last.at).toLocaleString()}. ${notes.join(' ')}`) : null));
  }
  async function runScan() {
    scan.running = true;
    scan.progress.textContent = 'Starting...';
    renderConnected();
    try { await shell.scanConnected((t) => { scan.progress.textContent = t; }); } catch (err) { shell.error(err, 'Scan MIDI ports'); } finally { scan.running = false; renderConnected(); }
  }

  const stats = {
    total: DEVICES.length,
    midi: DEVICES.filter((d) => d.openable).length,
    editors: DEVICES.filter((d) => d.hasModule || d.hasDef).length,
  };

  const stat = (n, label) => h('div.stat', h('b', String(n)), h('span', label));
  root.append(h('div.home',
    h('header.hero',
      h('div',
        h('h1', 'Devices'),
        h('div.sub', `${stats.editors} device editors. Every other MIDI device (${stats.midi} in all) opens in the generic MIDI tools.`)),
      h('div.hero-stats', stat(stats.editors, 'Editors'), stat(stats.midi, 'MIDI devices'), stat(stats.total, 'In the collection'))),
    h('div.home-top', recentBox, connBox),
    h('div.row.dev-filters', h('div.search', icon('magnifying-glass'), q), makerSel, typeSel, statusSel, count),
    grid));
  render();
  renderRecent();
  renderConnected();
  setTimeout(() => q.focus(), 0);
  const offs = [shell.on('recent', renderRecent), shell.on('connected', () => { if (!scan.running) renderConnected(); })];
  return { destroy() { offs.forEach((off) => off?.()); } };
}
