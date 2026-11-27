// MIDIMaster shell: device picker, global settings, MIDI monitor, and the host that
// device modules run in. Each module gets a `host` object (see makeHost) and returns
// pages, optional docks, a status area and a SysEx decoder.

import { MidiTransport } from '../core/midi/transport.js';
import { MidiInputs, slotsOf, effectiveMapping } from '../core/midi/inputs.js';
import { Settings, rememberDevice, recentDevices, clearRecent, connectedDevices, saveConnected } from '../core/settings.js';
import { applyTheme } from '../core/theme.js';
import { h, clear, toast, confirmDialog } from '../core/ui/dom.js';
import { mountKeyboard } from '../core/ui/keyboard.js';
import { icon as iconEl } from '../core/ui/icons.js';
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
    this.inputs = new MidiInputs(this.settings, (slot, data) => this.routeInput(slot, data));
    this.inputProgram = new Map(); // device id -> program number the inputs' next/previous actions are at
    this.actionState = new Map(); // mapping id -> last value (buttons act on press)
  }

  // ------------------------------------------------------------ MIDI inputs (controllers)
  /** A message from controller input `slot`: a mapped controller, or thru to the open device. */
  routeInput(slot, data) {
    const s = slotsOf(this.settings.value.inputs)[slot];
    const dev = this.device;
    const st = data[0] & 0xf0;
    const ch = data[0] & 15;
    if (st === 0xb0) {
      const m = effectiveMapping(dev?.host.device.value.inputMappings, this.settings.value.inputs?.mappings, slot, ch, data[1]);
      if (m && this.applyMapping(m, data[2])) return;
    }
    if (!s.thru || !dev || !this.transport.output) return;
    const b = Uint8Array.from(data);
    if (s.toChannel && st >= 0x80 && st < 0xf0) b[0] = st | ((dev.host.device.value.channel ?? 0) & 15);
    try { this.transport.send(b); } catch { /* no output */ }
  }

  /** Carry out mapping m with controller value v; false when nothing on the open device takes it. */
  applyMapping(m, v) {
    const t = m.target || {};
    const dev = this.device;
    const ch = (dev?.host.device.value.channel ?? 0) & 15;
    const send = (b) => { try { this.transport.send(b); } catch { /* no output */ } };
    switch (t.type) {
      case 'none': return true;
      case 'cc': if (dev && this.transport.output) send([0xb0 | ch, t.cc & 127, v & 127]); return true;
      case 'action': {
        // buttons send 127 when pressed and 0 when released: act once per press
        const was = this.actionState.get(m.id) ?? 0;
        this.actionState.set(m.id, v);
        if (!(v >= 64 && was < 64)) return true;
        if (t.action === 'panic') { this.panic(); return true; }
        if (!dev || !this.transport.output) return true;
        const id = dev.entry.id;
        const p = ((this.inputProgram.get(id) ?? 0) + (t.action === 'program-next' ? 1 : -1) + 128) % 128;
        this.inputProgram.set(id, p);
        send([0xc0 | ch, p]);
        toast(`Program ${p + 1}`, 'info', 1200);
        return true;
      }
      case 'function': case 'param': {
        const ctx = dev?.instance.context;
        return !!ctx?.applyMapped?.(t, v);
      }
      default: return false;
    }
  }

  /** The Head Library (one per app; opened on first use). */
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
    this.settings.on('change', (v, patch) => { applyTheme(v); this.applyKeyboardVisibility(); if (patch?.inputs) this.inputs.reopen(); this.emit('settings', v); });
    this.real.on('ready', (access) => this.inputs.attach(access));
    document.getElementById('btn-panic').addEventListener('click', () => this.panic());
    document.getElementById('btn-settings').addEventListener('click', () => this.go('#/settings'));
    // the busy line of a running dump leads to the Branch Library page, which shows it
    this.el.busy.addEventListener('click', () => { if (this.deviceJob() && this.device.page !== 'librarian') this.go(`#/d/${encodeURIComponent(this.device.entry.id)}/librarian`); });
    document.getElementById('brand').addEventListener('click', () => this.go('#/'));
    this.real.on('connection', () => this.renderTop());
    this.real.on('port-busy', (name) => toast(`"${name}" is in use by another program (another MIDIMaster window or a browser tab with MIDIMaster?). Close it there, then choose the port again.`, 'bad', 10000));
    window.addEventListener('hashchange', () => this.route());
    // a background job (a complete dump) of the open device: closing the tab stops it
    window.addEventListener('beforeunload', (ev) => { if (this.deviceJob()) { ev.preventDefault(); ev.returnValue = ''; } });
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

  // ------------------------------------------------------------ connected devices (devices/identify.js)
  /** Scan every MIDI port for devices; the result is kept and listed under Connected. */
  async scanConnected(onProgress) {
    if (!this.real.access) await this.real.init();
    const { scanPorts } = await import('../devices/identify.js');
    const r = await scanPorts(this.real.access, { onProgress });
    saveConnected(r);
    this.renderNav();
    this.emit('connected', r);
    return r;
  }

  /** Open a device found by the scan, on the ports it was found on. */
  openConnected(d, id = d.id) {
    this.settings.device(id).update({ input: d.input || '', output: d.output || '' });
    this.go(`#/d/${encodeURIComponent(id)}`);
  }

  clearConnected() { saveConnected(null); this.renderNav(); this.emit('connected', null); }

  clearRecent() { clearRecent(); this.renderNav(); this.emit('recent'); }

  /** The open device's running background job (generic/dumpjob.js), or null. */
  deviceJob() { return this.device?.instance?.context?.job || null; }

  async route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    // Settings, the Head Library and the monitor keep the device open; anything else closes it, which
    // stops a running dump: ask first (what arrived so far is kept)
    const keeps = ['settings', 'library', 'monitor'].includes(parts[0]) || (parts[0] === 'd' && parts[1] === this.device?.entry.id);
    const job = !keeps && this.deviceJob();
    if (job && !this._leaving) {
      const model = this.device.entry.title;
      const back = this._lastHash ?? '#/';
      history.replaceState(null, '', back); // stay until the answer
      const ok = await confirmDialog('Leave the device?', `A ${job.title.toLowerCase()} of the ${model} is running (${job.count} messages so far). Leaving the ${model} stops it; what has arrived is saved in its Branch Library.`, 'Leave and stop it', true);
      if (!ok) return;
      const target = `#/${parts.map(encodeURIComponent).join('/')}`;
      this._leaving = true; // the next route goes through
      if (location.hash === target) this.route(); else location.hash = target;
      return;
    }
    this._leaving = false;
    this._lastHash = location.hash || '#/';
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
        shell.el.busy.classList.toggle('link', !!shell.deviceJob());
        shell.el.busy.title = shell.deviceJob() ? 'Show it on the Branch Library page' : '';
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
        const r = shell.real.autoSelect({ input: names.input ?? dev.value.input, output: names.output ?? dev.value.output, defaultInput: m.defaultInput, defaultOutput: m.defaultOutput, hint, prefer: names.prefer });
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
      const btn = h('button.icon-btn.toggle', { title: `Show or hide the ${spec.label}`, onclick: () => api.toggle() }, iconEl(spec.icon || '▣'), h('span', spec.label));
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
    const item = (label, icon, active, onclick, extra = {}) => h('button' + (active ? '.active' : ''), { onclick, 'aria-current': active ? 'page' : undefined, ...extra }, h('span.nav-ico', iconEl(icon)), h('span.nav-label', label));
    if (this.device) {
      const { entry, instance } = this.device;
      nav.append(
        item('All devices', '‹', false, () => this.go('#/'), { class: 'nav-back' }),
        h('div.nav-device', h('div.nav-maker', entry.maker), h('div.nav-model', entry.model)),
        ...instance.pages.map((p) => item(p.label, p.icon || '•', this.page === p.key, () => this.showDevicePage(p.key), { dataset: { page: p.key } })),
        h('div.nav-sep'),
        ...this.device.docks.map((d) => item(d.spec.label, d.spec.icon || '▣', d.api.isOpen, () => d.api.toggle(), { title: `Show or hide the ${d.spec.label} beside any page` })),
        item('MIDI Monitor', '≡', this.page === 'monitor', () => this.showDevicePage('monitor')),
        item('Head Library', '❖', this.page === 'library', () => this.go('#/library')),
        item('Settings', '⚙', this.page === 'settings', () => this.go('#/settings')));
      return;
    }
    nav.append(
      item('Devices', 'grip', this.page === 'home', () => this.go('#/')),
      item('Head Library', '❖', this.page === 'library', () => this.go('#/library')),
      item('MIDI Monitor', '≡', this.page === 'monitor', () => this.go('#/monitor')),
      item('Settings', '⚙', this.page === 'settings', () => this.go('#/settings')));
    const recent = recentDevices().map(getDevice).filter(Boolean);
    if (recent.length) {
      nav.append(h('div.nav-sep'), h('div.nav-head.nav-head-row', h('span', 'Recent'),
        h('button.nav-clear', { title: 'Clear the list of recently opened devices', onclick: (ev) => { ev.stopPropagation(); this.clearRecent(); } }, 'Clear')));
      for (const d of recent) nav.append(item(d.title, '·', false, () => this.go(`#/d/${d.id}`)));
    }
    // devices found by the last port scan (front page, Scan MIDI ports)
    const found = (connectedDevices()?.devices || []).filter((d) => d.id && getDevice(d.id));
    if (found.length) {
      nav.append(h('div.nav-sep'), h('div.nav-head', 'Connected'));
      for (const d of found) nav.append(item(getDevice(d.id).title, '◉', false, () => this.openConnected(d), { title: `${d.output}${d.input && d.input !== d.output ? ` / ${d.input}` : ''}: ${d.detail || ''}` }));
    }
  }

  renderTop() {
    const conn = clear(this.el.conn);
    const t = this.transport;
    clear(this.el.crumb).append(this.device ? [h('span.crumb-sep', '/'), h('b', this.device.entry.title)] : '');
    if (!t.access && t === this.real) conn.append(h('span.dot'), h('span', 'MIDI off'));
    else if (!t.output && !t.input) conn.append(h('span.dot'), h('span', 'No ports'));
    else {
      conn.append(h('span.dot' + (this.online ? '.on' : t.output ? '.half' : '')),
        this.demo && t !== this.real ? h('span.badge.live', 'DEMO') : null,
        h('span', `${t.input?.name || '-'} / ${t.output?.name || '-'}`));
    }
  }
}
