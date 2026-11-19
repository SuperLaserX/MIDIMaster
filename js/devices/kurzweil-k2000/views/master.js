// Master & MIDI: every setting kept in the K2000's Master table (object Table 100:16),
// laid out like the K2000's own MASTER, MIDI and mode pages. Pages, names, ranges and
// value texts come from the OS (model/fwmodel.js). Each change is sent live as a LOAD
// of the changed bytes; the K2000 applies the Master table as soon as it is loaded.

import { h, clear } from '../../../core/ui/dom.js';
import { pageEntries, modePage, masterOffset, readAt, writeAt, LOC, MASTER } from '../model/fwmodel.js';
import { fwCard, fwControl } from './fwpage.js';

// Firmware mode pages that edit the Master table, in display order.
const SECTIONS = [
  { title: 'Master', modes: [[0x08, 'Master']] },
  { title: 'MIDI', modes: [[0x05, 'Transmit'], [0x06, 'Receive']] },
  { title: 'Modes', modes: [[0x01, 'Program mode'], [0x02, 'Setup mode'], [0x03, 'Quick Access'], [0x04, 'Effects mode']] },
  { title: 'Song', modes: [[0x0a, 'Song: main'], [0x0e, 'Song: misc']] },
  { title: 'Sampling and disk', modes: [[0x0c, 'Sample record'], [0x0d, 'Sample mode'], [0x0b, 'Disk']] },
];
const CHANNELS_MODE = 0x07;
// Mode pages show their current object without a label on the K2000.
const OBJ_LABEL = { 132: 'Program (ch 1)', 135: 'Current setup', 113: 'Effect', 112: 'Song' };

export function masterView(root, app) {
  const st = { data: null, error: null };
  const body = h('div');
  root.append(
    h('div.row', h('h1.grow', 'Master & MIDI'), h('button.btn', { onclick: load }, 'Reload')),
    h('p.muted', 'Everything the K2000 keeps in its Master table: tuning, velocity and pressure maps, MIDI transmit and receive, the 16 MIDI channels, mode and song settings, sampling defaults. Each change is applied live.'),
    body);

  const names = (type, id) => {
    const n = app.nameOf(type, id);
    if (n === undefined) app.lookupName(type, id).then((x) => { if (x) render(); });
    return n;
  };

  async function load() {
    if (!app.online) {
      clear(body).append(h('div.notice.warn', 'Connect to the K2000 first. ', h('button.btn.small', { onclick: () => app.nav('connect') }, 'Connect')));
      return;
    }
    clear(body).append(h('div.empty', 'Reading the Master table...'));
    try {
      // First time: the copy read when the K2000 connected, if there is one.
      const cached = !st.data && app.standard?.master;
      if (cached) app.standard.master = null; // used once; later visits read it again
      st.data = cached ? Uint8Array.from(cached) : Uint8Array.from((await app.client.fetchObject(MASTER.type, MASTER.id)).data);
      render();
    } catch (err) {
      clear(body).append(h('div.notice.bad', `Could not read the Master table: ${err.message}`));
    }
  }

  function send(patch, ctl) {
    if (!patch) return;
    ctl?.setState?.('pending');
    app.client.load(MASTER.type, MASTER.id, patch.offset, patch.bytes, { key: `m:${patch.offset}` })
      .then((r) => { if (!r.superseded) ctl?.setState?.(null); })
      .catch((err) => { ctl?.setState?.('error'); app.error(err, 'Master table'); });
  }

  const isMaster = (e) => LOC[e.p.loc]?.obj === 'master';

  function modeCard(modeId, title, ch = 1) {
    const m = modePage(modeId);
    if (!m) return null;
    const entries = pageEntries(m.page, m.group).filter(isMaster)
      .map((e) => (/^Param \d+$/.test(e.name) ? { ...e, name: e.p.s?.obj ? OBJ_LABEL[e.p.s.obj] || 'Object' : modeId === 0x03 ? 'Bank' : 'Value' } : e));
    return fwCard(title, entries, {
      names,
      read: (e) => {
        const off = masterOffset(e.p, ch);
        return off === null || !st.data ? null : readAt(st.data, off, e.p);
      },
      write: (e, v, ctl) => send(writeAt(st.data, masterOffset(e.p, ch), e.p, v), ctl),
    });
  }

  function channelsCard() {
    const m = modePage(CHANNELS_MODE);
    const entries = pageEntries(m.page, m.group).filter((e) => LOC[e.p.loc]?.stride);
    const table = h('div.col');
    for (let ch = 1; ch <= 16; ch++) {
      const controls = entries.map((e) => {
        const off = masterOffset(e.p, ch);
        if (off + 2 > st.data.length) return null;
        let ctl;
        ctl = fwControl({ p: e.p, name: e.name, value: readAt(st.data, off, e.p), names, onChange: (v) => send(writeAt(st.data, off, e.p, v), ctl) });
        return ctl;
      }).filter(Boolean);
      table.append(h('div.row.chan-row', h('div.chan-num', `Ch ${ch}`), h('div.params', controls)));
    }
    return h('div.card.fw-card', h('div.card-head', h('h2', 'MIDI channels'), h('span.tag', 'per-channel receive settings')), table);
  }

  function render() {
    if (!st.data) return;
    clear(body);
    for (const sec of SECTIONS) {
      const cards = sec.modes.map(([id, title]) => modeCard(id, title)).filter(Boolean);
      if (cards.length) body.append(h('div.section-title', sec.title), h('div.grid.cols-2', cards));
    }
    body.append(h('div.section-title', 'MIDI channels'), channelsCard());
    body.append(h('p.small.muted', `Master table: ${st.data.length} bytes (object type ${MASTER.type}, ID ${MASTER.id}).`));
  }

  if (app.online) load();
  else {
    clear(body).append(h('div.notice.warn', 'Connect to the K2000 first. ', h('button.btn.small', { onclick: () => app.nav('connect') }, 'Connect')));
    const off = app.on('online', (ok) => { if (ok) { load(); off(); } });
  }
  return { destroy() {} };
}
