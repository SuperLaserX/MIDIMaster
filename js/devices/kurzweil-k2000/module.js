// Kurzweil K2000 module: the full editor (formerly KEdit2000) running inside MIDIMaster.
// K2Context gives the views the same interface the standalone app had, built on the
// shell's host object.

import { Emitter } from '../../core/emitter.js';
import { h } from '../../core/ui/dom.js';
import { K2Client } from './client.js';
import { DemoTransport } from './demo.js';
import { mountFrontPanel } from './frontpanel.js';
import { describeK2 } from './decode.js';
import { introView } from './views/intro.js';
import { programView } from './views/program.js';
import { libraryView } from './views/library.js';
import { samplesView } from './views/samples.js';
import { keymapView } from './views/keymaps.js';
import { diskImportView } from './views/diskimport.js';
import { masterView } from './views/master.js';
import { T } from './model/types.js';
import { MASTER } from './model/fwmodel.js';

const PAGES = [
  { key: 'intro', label: 'Connect', icon: '◉', view: introView },
  { key: 'program', label: 'Program Editor', icon: '◆', view: programView },
  { key: 'library', label: 'Library', icon: '☰', view: libraryView },
  { key: 'samples', label: 'Samples', icon: '∿', view: samplesView },
  { key: 'keymaps', label: 'Keymaps', icon: '☷', view: keymapView },
  { key: 'import', label: 'Disk Import', icon: '⇪', view: diskImportView },
  { key: 'master', label: 'Master & MIDI', icon: '⚙', view: masterView },
];

/** Carry over settings saved by the standalone KEdit2000 (same browser origin). */
function migrateLegacy(host) {
  try {
    if (localStorage.getItem('midimaster.k2000.migrated')) return;
    const old = JSON.parse(localStorage.getItem('kedit2000.settings') || 'null');
    const ports = JSON.parse(localStorage.getItem('kedit2000.ports') || 'null');
    const patch = {};
    if (old && Number.isInteger(old.deviceId)) patch.deviceId = old.deviceId;
    if (old && Number.isInteger(old.auditionChannel)) patch.channel = old.auditionChannel;
    if (ports?.input) patch.input = ports.input;
    if (ports?.output) patch.output = ports.output;
    if (Object.keys(patch).length) host.device.update(patch);
    for (const k of ['lastProgram', 'frontpanel']) {
      const v = localStorage.getItem(`kedit2000.${k}`);
      if (v !== null && localStorage.getItem(`midimaster.k2000.${k}`) === null) localStorage.setItem(`midimaster.k2000.${k}`, v);
    }
    localStorage.setItem('midimaster.k2000.migrated', '1');
  } catch { /* storage unavailable */ }
}

class K2Context extends Emitter {
  constructor(host) {
    super();
    this.host = host;
    this.demo = host.demo;
    if (this.demo) host.useTransport(new DemoTransport());
    this.transport = host.transport;
    this.names = new Map(); // `${type}:${id}` -> {name, size, inRam}
    this.online = false;
    this.memory = null;
    this.client = new K2Client(this.transport, this.clientSettings());
    this.offs = [
      host.settings.on('change', () => this.client.setSettings(this.clientSettings())),
      this.client.on('busy', (n) => host.setBusy(n, n > 1 ? `${n} queued` : 'Talking to the K2000')),
      this.client.on('unsolicited', (m) => this.emit('unsolicited', m)),
      this.transport.on('connection', () => this.renderStatus()),
    ];
  }

  clientSettings() {
    const m = this.host.settings.value.midi;
    if (this.demo) return { deviceId: 0, minGap: 20, timeout: m.replyTimeout, bytesPerSecond: m.bytesPerSecond };
    // The K2000 can stall below about 120 ms between messages.
    return { deviceId: this.host.device.value.deviceId ?? 0, minGap: Math.max(120, m.sysexGap), timeout: m.replyTimeout, bytesPerSecond: m.bytesPerSecond };
  }

  /** What the views read as app.settings. */
  get settings() {
    return { deviceId: this.client.s.deviceId, minGap: this.client.s.minGap, timeout: this.client.s.timeout, auditionChannel: this.host.device.value.channel ?? 0 };
  }

  saveSettings(patch = {}) {
    if ('deviceId' in patch) { this.host.device.update({ deviceId: patch.deviceId }); this.client.setSettings({ deviceId: patch.deviceId }); }
    const midi = {};
    if (patch.minGap !== undefined) midi.sysexGap = patch.minGap;
    if (patch.timeout !== undefined) midi.replyTimeout = patch.timeout;
    if (Object.keys(midi).length) this.host.settings.update({ midi });
    if ('auditionChannel' in patch) this.host.setChannel(patch.auditionChannel);
    this.renderStatus();
  }

  get connected() { return this.transport.connected; }
  get keyboard() { return this.host.keyboard; }
  get exclusive() { return this.host.exclusive; }
  set exclusive(v) { this.host.exclusive = v; }

  nav(name, params) { this.host.nav(name === 'connect' ? 'intro' : name, params); }
  error(err, context) { this.host.error(err, context); }

  async start() {
    if (this.demo) { await this.connect(); return; }
    const d = this.host.device.value;
    const shell = this.host.shell;
    const tryConnect = () => { if (d.input || d.output || shell.settings.value.midi.defaultOutput) this.connect().catch(() => {}); };
    if (shell.real.access) tryConnect();
    else { const off = shell.on('midi-ready', () => { off(); tryConnect(); }); this.offs.push(off); }
  }

  async connect(names) {
    await this.host.connectPorts(names);
    if (!this.transport.connected) { this.online = false; this.renderStatus(); return false; }
    const ok = await this.client.ping();
    this.online = ok;
    if (ok) await this.refreshMemory();
    this.renderStatus();
    if (ok) this.loadStandard(); // sets loadingStandard before pages hear 'online'
    this.emit('online', ok);
    return ok;
  }

  /**
   * Standard information read once the K2000 answers: the program list (all banks) and the
   * Master table. The Programs and Master pages start from these copies.
   */
  async loadStandard() {
    if (this.loadingStandard) return;
    this.loadingStandard = true;
    this.standard = {};
    try {
      this.host.setBusy(1, 'Reading the program list');
      const infos = await this.client.dirBank(T.PROGRAM, 127, false);
      infos.forEach((i) => this.rememberInfo(i));
      this.standard.programs = infos;
      this.emit('standard', 'programs');
      this.host.setBusy(1, 'Reading the Master table');
      this.standard.master = Uint8Array.from((await this.client.fetchObject(MASTER.type, MASTER.id)).data);
      this.emit('standard', 'master');
    } catch {
      this.emit('standard', 'failed'); // the pages read these themselves
    } finally {
      this.loadingStandard = false;
      this.host.setBusy(0);
    }
  }

  async refreshMemory() {
    try {
      this.memory = await this.client.memory();
      this.online = true;
    } catch { this.memory = null; }
    this.renderStatus();
    return this.memory;
  }

  renderStatus() {
    const items = [];
    if (this.transport.connected) items.push(h('span.badge', `ID ${this.client.s.deviceId}`));
    if (this.online === false && this.transport.connected) items.push(h('span.badge.warn', 'no reply'));
    if (this.memory) {
      items.push(
        h('span.gauge', 'Program RAM ', h('b', `${this.memory.programFreeK} K`)),
        h('span.gauge', 'Sample RAM ', h('b', `${this.memory.sampleFreeK} K`)),
        h('button.icon-btn', { title: 'Refresh free memory', onclick: () => this.refreshMemory() }, '↻'));
    }
    this.host.setStatus(h('div.mem', items));
    this.host.setOnline(this.online);
  }

  // name cache
  rememberInfo(info) { this.names.set(`${info.type}:${info.id}`, { name: info.objName, size: info.size, inRam: info.inRam }); }
  nameOf(type, id) { return this.names.get(`${type}:${id}`)?.name; }
  lookupName(type, id) {
    const cached = this.nameOf(type, id);
    if (cached !== undefined) return Promise.resolve(cached);
    // One DIR per object, however many controls ask for its name at once.
    this.pendingNames ??= new Map();
    const key = `${type}:${id}`;
    if (this.pendingNames.has(key)) return this.pendingNames.get(key);
    const p = this.client.dir(type, id)
      .then((info) => { this.rememberInfo(info); return info.size ? info.objName : null; })
      .catch(() => { this.names.set(key, { name: null, size: 0, inRam: false }); return null; })
      .finally(() => this.pendingNames.delete(key));
    this.pendingNames.set(key, p);
    return p;
  }

  requireConnection(container) {
    if (this.connected && this.online) return true;
    container.appendChild(h('div.notice.warn', 'The K2000 is not connected. ',
      h('button.btn.small', { onclick: () => this.nav('intro') }, 'Open the connection page')));
    return false;
  }

  destroy() {
    for (const off of this.offs) off?.();
    this.client.dispose();
  }
}

export default {
  id: 'kurzweil-k2000',
  title: 'Kurzweil K2000',
  async create(host) {
    migrateLegacy(host);
    const k2 = new K2Context(host);
    k2.start().then(() => { if (k2.demo && host.shell.device?.page === 'intro') host.nav('program'); }).catch(() => {});
    return {
      client: k2.client,
      context: k2,
      pages: PAGES.map(({ key, label, icon }) => ({ key, label, icon })),
      render(key, root, params) { return PAGES.find((p) => p.key === key).view(root, k2, params); },
      docks: [{
        key: 'panel', label: 'Front Panel', icon: '▣',
        mount: (container) => { container.classList.add('frontpanel'); k2.frontPanel = mountFrontPanel(container, k2); return k2.frontPanel; },
      }],
      decode: describeK2,
      destroy() { k2.destroy(); },
    };
  },
};
