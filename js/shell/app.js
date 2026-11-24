// MIDIMaster shell: device picker, global settings, MIDI monitor, and the host that
// device modules run in. Each module gets a `host` object (see makeHost) and returns
// pages, optional docks, a status area and a SysEx decoder.

import { MidiTransport } from '../core/midi/transport.js';
import { Settings, rememberDevice, recentDevices } from '../core/settings.js';
import { applyTheme } from '../core/theme.js';
import { h, clear, toast } from '../core/ui/dom.js';
import { mountKeyboard } from '../core/ui/keyboard.js';
import { Emitter } from '../core/emitter.js';
import { library, openDb } from '../core/library.js';
import { MainLibrary, KvStore } from '../core/mainlib/store.js';
import { getDevice, loadModule } from '../devices/registry.js';
import { homeView } from './home.js';
import { settingsView } from './settings-view.js';
import { monitorView } from './monitor.js';
import { mainLibraryView } from './mainlibrary.js';

const LEGACY = { connect: 'intro', program: 'program', library: 'library', samples: 'samples', keymaps: 'keymaps', import: 'import', discover: 'program', remote: 'program' };

export class Shell extends Emitter {
  constructor() {
    super();
    this.settings = new Settings();
    this.demo = new URLSearchParams(location.search).has('demo');
    this.real = new MidiTransport();
    this.transport = this.real;
    this.device = null; // {entry, module, instance, host, page, docks}
    this.view = null;
    this.page = null; // 'home' | 'settings' | 'monitor' | device page key
    this.exclusive = false;
    this.online = false;
    this._mainlib = null;
  }

  /** The Main Library (one per app; opened on first use). */
  mainLibrary() {
    // Without IndexedDB (some private windows) the cache lives in memory; the folder still works.
    this._mainlib ??= openDb().catch(() => null).then((db) => new MainLibrary(new KvStore(db), {
      pickFolder: (mode) => (window.showDirectoryPicker ? window.showDirectoryPicker({ mode, id: 'midimaster-library' }).catch(() => null) : Promise.reject(new Error('This browser cannot open folders. Use Chrome or Edge.'))),
    }).load());
    return this._mainlib;
  }

  // ------------------------------------------------------------ startup
  start() {
    applyTheme(this.settings.value);
    this.el = {
      nav: document.getElementById('nav'),
      view: document.getElementById('view'),
      conn: document.getElementById('conn-status'),
      crumb: document.getElementById('crumb'),
      status: document.getElementById('module-status'),
      busy: document.getElementById('busy'),
      busyText: document.getElementById('busy-text'),
      docks: document.getElementById('dock'),
      dockButtons: document.getElementById('dock-buttons'),
      keyboard: document.getElementById('keyboard-dock'),
    };
    this.keyboard = mountKeyboard(this.el.keyboard, this.keyboardApp(), this.settings.value.keyboard);
    this.applyKeyboardVisibility();
    this.settings.on('change', (v) => { applyTheme(v); this.applyKeyboardVisibility(); this.emit('settings', v); });
    document.getElementById('btn-panic').addEventListener('click', () => this.panic());
    document.getElementById('btn-settings').addEventListener('click', () => this.go('#/settings'));
    document.getElementById('brand').addEventListener('click', () => this.go('#/'));
    this.real.on('connection', () => this.renderTop());
    window.addEventListener('hashchange', () => this.route());
    this.route();
    // Reconnect silently if MIDI permission was granted before.
    if (!this.demo && navigator.permissions && this.real.supported && this.settings.get('midi.autoConnect')) {
      navigator.permissions.query({ name: 'midi', sysex: true }).then((p) => {
        if (p.state === 'granted' && !this.real.access) this.real.init().then(() => this.emit('midi-ready')).catch(() => {});
      }).catch(() => {});
    }
  }

  keyboardApp() {
    const shell = this;
    const send = (b, at) => shell.send(b, at);
    return {
      client: { noteOn: (ch, n, v) => send([0x90 | ch, n, v]), noteOff: (ch, n) => send([0x80 | ch, n, 0]), sendNow: (b) => send(b), sendAt: send },
      get connected() { return !!shell.transport.output; },
      get transport() { return shell.transport; },
      keyboardSettings: () => shell.settings.value.keyboard,
      error: (e, c) => shell.error(e, c),
    };
  }

  applyKeyboardVisibility() {
    this.el.keyboard.hidden = !this.settings.get('keyboard.show') || (this.device && this.device.instance.keyboard === false);
  }

  send(bytes, at) {
    if (!this.transport.output) throw new Error('No MIDI output selected');
    this.transport.send(bytes, at);
  }

  panic() {
    this.keyboard.allOff();
    try { for (let ch = 0; ch < 16; ch++) { this.send([0xb0 | ch, 120, 0]); this.send([0xb0 | ch, 123, 0]); } } catch { /* no output */ }
  }

  error(err, context = '') {
    console.error(err);
    toast(`${context ? context + ': ' : ''}${err?.message || err}`, 'bad', 6000);
  }

  // ------------------------------------------------------------ routing
  go(hash) {
    if (location.hash === hash) this.route(); else location.hash = hash;
  }

  route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'settings') return this.showShellPage('settings');
    if (parts[0] === 'library') return this.showShellPage('library'); // keeps an open device, like Settings
    if (parts[0] === 'monitor') return this.device ? this.showDevicePage('monitor') : this.showShellPage('monitor');
    if (parts[0] === 'd' && parts[1]) return this.openDevice(parts[1], parts[2]);
    if (LEGACY[parts[0]]) return this.openDevice('kurzweil-k2000', LEGACY[parts[0]]); // old KEdit2000 bookmarks
    this.closeDevice();
    return this.showShellPage('home');
  }

  showShellPage(name) {
    this.view?.destroy?.();
    this.page = name;
    const main = clear(this.el.view);
    main.scrollTop = 0;
    const fn = { home: homeView, settings: settingsView, monitor: monitorView, library: mainLibraryView }[name] || homeView;
    try { this.view = fn(main, this) || null; } catch (err) { this.view = null; main.append(h('div.notice.bad', `Failed to open: ${err.message}`)); console.error(err); }
    this.renderNav();
    this.renderTop();
  }

  // ------------------------------------------------------------ devices
  async openDevice(id, page, params = {}) {
    if (this.device?.entry.id === id) return this.showDevicePage(page || this.device.page || this.device.instance.pages[0].key, params);
    this.closeDevice();
    const entry = getDevice(id);
    if (!entry) { toast(`Unknown device "${id}"`, 'warn'); this.go('#/'); return; }
    if (!entry.openable) { toast(`${entry.title} has no MIDI, so there is nothing to edit.`, 'warn'); this.go('#/'); return; }
    let module;
    let instance;
    const host = this.makeHost(entry);
    try {
      module = await loadModule(id);
      instance = await module.create(host);
    } catch (err) {
      this.error(err, `Opening ${entry.title}`);
      this.transport = this.real;
      this.go('#/');
      return;
    }
    this.device = { entry: { ...entry, title: module.title || entry.title }, module, instance, host, page: null, docks: [] };
    rememberDevice(id);
    this.applyKeyboardVisibility();
    this.keyboard.setChannel(host.device.value.channel ?? 0);
    this.mountDocks();
    this.renderNav();
    this.showDevicePage(page || instance.pages[0].key, params);
  }

  closeDevice() {
    if (!this.device) return;
    this.view?.destroy?.();
    this.view = null;
    for (const d of this.device.docks) d.api?.destroy?.();
    if (this.settings.get('midi.panicOnClose')) { try { this.panic(); } catch { /* ignore */ } }
    try { this.device.instance.destroy?.(); } catch (err) { console.error(err); }
    this.keyboard.allOff();
    this.transport = this.real;
    this.device = null;
    this.exclusive = false;
    this.online = false;
    clear(this.el.docks).hidden = true;
    clear(this.el.dockButtons);
    clear(this.el.status);
    this.el.busy.hidden = true;
    this.applyKeyboardVisibility();
  }

  showDevicePage(key, params = {}) {
    if (!this.device) return;
    const { instance, entry } = this.device;
    this.view?.destroy?.();
    const main = clear(this.el.view);
    main.scrollTop = 0;
    if (key !== 'monitor' && !instance.pages.some((p) => p.key === key)) key = instance.pages[0].key;
    try {
      this.view = key === 'monitor' ? monitorView(main, this) : instance.render(key, main, params) || null;
    } catch (err) {
      console.error(err);
      this.view = null;
      main.append(h('div.notice.bad', `Failed to open view: ${err.message}`));
    }
    this.device.page = key;
    this.page = key;
    const hash = `#/d/${encodeURIComponent(entry.id)}/${key}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    this.renderNav();
    this.renderTop();
  }

  makeHost(entry) {
    const shell = this;
    const dev = this.settings.device(entry.id, { input: '', output: '', channel: 0, deviceId: entry.defaultDeviceId ?? null });
    const words = `${entry.maker} ${entry.model}`.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 2);
    const hint = words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null;
    return {
      entry,
      shell,
      settings: this.settings,
      device: dev,
      library,
      toast,
      get transport() { return shell.transport; },
      get keyboard() { return shell.keyboard; },
      get demo() { return shell.demo; },
      get exclusive() { return shell.exclusive; },
      set exclusive(v) { shell.exclusive = !!v; },
      get online() { return shell.online; },
      /** Replace the MIDI transport for this module (demo mode). */
      useTransport(t) { shell.transport = t; shell.renderTop(); },
      nav: (page, params) => shell.showDevicePage(page, params),
      error: (err, ctx) => shell.error(err, ctx),
      setStatus(nodes) { clear(shell.el.status).append(...[].concat(nodes || [])); },
      setOnline(v) { shell.online = v; shell.renderTop(); },
      setBusy(n, text) {
        shell.el.busy.hidden = !n;
        shell.el.busyText.textContent = text || (n > 1 ? `${n} queued` : `Talking to the ${entry.model}`);
      },
      async ensureMidi() {
        if (shell.transport !== shell.real) return true;
        if (!shell.real.access) await shell.real.init();
        return true;
      },
      /** Open this device's ports (remembered names, global defaults, or a name match). */
      async connectPorts(names = {}) {
        if (shell.transport !== shell.real) { shell.transport.open?.(); shell.renderTop(); return { input: shell.transport.input, output: shell.transport.output }; }
        await this.ensureMidi();
        const m = shell.settings.value.midi;
        const r = shell.real.autoSelect({ input: names.input ?? dev.value.input, output: names.output ?? dev.value.output, defaultInput: m.defaultInput, defaultOutput: m.defaultOutput, hint });
        dev.update({ input: r.input?.name || '', output: r.output?.name || '' });
        shell.renderTop();
        return r;
      },
      rememberPorts({ input, output }) { dev.update({ input, output }); shell.renderTop(); },
      setChannel(ch) { dev.update({ channel: ch }); shell.keyboard.setChannel(ch); },
    };
  }

  mountDocks() {
    const { instance } = this.device;
    for (const spec of instance.docks || []) {
      const container = h('div.dock-panel');
      this.el.docks.append(container);
      const api = spec.mount(container);
      const btn = h('button.icon-btn.toggle', { title: `Show or hide the ${spec.label}`, onclick: () => api.toggle() }, spec.label);
      this.el.dockButtons.append(btn);
      const sync = () => {
        btn.classList.toggle('on', api.isOpen);
        this.el.docks.hidden = !this.device?.docks.some((d) => d.api.isOpen);
        this.renderNav();
      };
      api.onToggle?.(sync);
      this.device.docks.push({ spec, api, button: btn });
      if (api.wasOpen) api.open({ quiet: true });
      sync();
    }
  }

  // ------------------------------------------------------------ chrome
  renderNav() {
    const nav = clear(this.el.nav);
    const item = (label, icon, active, onclick, extra = {}) => h('button' + (active ? '.active' : ''), { onclick, ...extra }, h('span.nav-ico', icon), label);
    if (this.device) {
      const { entry, instance } = this.device;
      nav.append(
        item('All devices', '‹', false, () => this.go('#/')),
        h('div.nav-device', h('div.nav-maker', entry.maker), h('div.nav-model', entry.model)),
        ...instance.pages.map((p) => item(p.label, p.icon || '•', this.page === p.key, () => this.showDevicePage(p.key), { dataset: { page: p.key } })),
        h('div.nav-sep'),
        ...this.device.docks.map((d) => item(d.spec.label, d.spec.icon || '▣', d.api.isOpen, () => d.api.toggle(), { title: `Show or hide the ${d.spec.label} beside any page` })),
        item('MIDI Monitor', '≡', this.page === 'monitor', () => this.showDevicePage('monitor')),
        item('Main Library', '❖', this.page === 'library', () => this.go('#/library')),
        item('Settings', '⚙', this.page === 'settings', () => this.go('#/settings')));
      return;
    }
    nav.append(
      item('Devices', '◫', this.page === 'home', () => this.go('#/')),
      item('Main Library', '❖', this.page === 'library', () => this.go('#/library')),
      item('MIDI Monitor', '≡', this.page === 'monitor', () => this.go('#/monitor')),
      item('Settings', '⚙', this.page === 'settings', () => this.go('#/settings')));
    const recent = recentDevices().map(getDevice).filter(Boolean);
    if (recent.length) {
      nav.append(h('div.nav-sep'), h('div.nav-head', 'Recent'));
      for (const d of recent) nav.append(item(d.title, '·', false, () => this.go(`#/d/${d.id}`)));
    }
  }

  renderTop() {
    const conn = clear(this.el.conn);
    const t = this.transport;
    clear(this.el.crumb).append(this.device ? h('span', '› ', h('b', this.device.entry.title)) : '');
    if (!t.access && t === this.real) conn.append(h('span.dot'), 'MIDI off');
    else if (!t.output && !t.input) conn.append(h('span.dot'), 'No ports');
    else {
      conn.append(h('span.dot' + (this.online ? '.on' : t.output ? '.half' : '')),
        this.demo && t !== this.real ? h('span.badge.live', 'DEMO') : null,
        `${t.input?.name || '-'} / ${t.output?.name || '-'}`);
    }
  }
}
