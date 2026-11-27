// Generic MIDI module: opens any MIDI device in the catalog. Standard MIDI messages,
// a SysEx Branch Library, Sample Dump transfers and a SysEx console work for every device;
// a device definition (from firmware analysis) adds its parameters and dump requests.

import { Emitter } from '../../core/emitter.js';
import { h, toast } from '../../core/ui/dom.js';
import { loadSlotNames, saveSlotNames } from './namecache.js';
import { DeviceClient } from '../../core/midi/device-client.js';
import { LoopbackTransport } from '../../core/midi/loopback.js';
import { manufacturerName } from '../../core/midi/describe.js';
import { introView } from './views/intro.js';
import { playView } from './views/play.js';
import { librarianView } from './views/librarian.js';
import { samplesView } from './views/samples.js';
import { consoleView } from './views/console.js';
import { paramsView } from './views/params.js';
import { editorView } from './views/editor.js';
import { multiView } from './views/multi.js';
import { loadObject, readBankNames, canFetch, objectApi, sendOut } from './objects.js';
import { inputsView } from './views/inputs.js';
import { galleryView } from './views/gallery.js';
import { resolveFunction, scaleToParam } from '../../core/midi/functions.js';
import { readParam, writeParam, paramRange } from '../../core/model/memmap.js';

export class GenericContext extends Emitter {
  constructor(host, entry, def) {
    super();
    this.host = host;
    this.entry = entry;
    this.def = def;
    this.demo = host.demo;
    if (this.demo) host.useTransport(new LoopbackTransport(entry, def));
    this.transport = host.transport;
    this.online = false;
    this.identityReply = null;
    this.objectData = {}; // object key -> Uint8Array, shared by the editor pages
    this.slotNames = {}; // object key -> Map('bank:slot' -> name)
    this.unconfirmed = {}; // object key -> Set('bank:slot'): remembered names not read again yet
    this.namesChanged = []; // remembered names found different when read again
    this.loadNameCache();
    this.job = null; // a background dump (dumpjob.js), shown by the Branch Library page
    this.loading = new Set(); // object keys being read in the background
    this.loadedKeys = new Set(); // object keys read from the device (or a file)
    this.client = new DeviceClient(this.transport, this.clientSettings(), { deviceName: entry.model });
    if (def?.parse) this.client.parse = (raw) => def.parse(raw) || DeviceClient.prototype.parse.call(this.client, raw);
    this.offs = [
      host.settings.on('change', () => this.client.setSettings(this.clientSettings())),
      this.client.on('busy', (n) => { if (!this.opBusy) host.setBusy(n); }),
      this.transport.on('connection', () => this.renderStatus()),
    ];
  }

  clientSettings() {
    const m = this.host.settings.value.midi;
    // a measured pace (Connect page, speedtest.js) replaces the global DIN-MIDI defaults for this
    // device; the definition's own minimum (e.g. time to write EEPROM) still applies
    const sp = this.host.device.value.speed;
    const gap = sp?.sendGap ?? m.sysexGap;
    const bps = sp?.sendBps || (sp?.receiveBps ? Math.max(m.bytesPerSecond, sp.receiveBps) : m.bytesPerSecond);
    return { deviceId: this.deviceId, minGap: this.demo ? 10 : Math.max(this.def?.minGap ?? 0, gap), timeout: m.replyTimeout, bytesPerSecond: bps };
  }

  get channel() { return this.host.device.value.channel ?? 0; }
  set channel(ch) { this.host.setChannel(ch); this.renderStatus(); }
  get deviceId() { return this.host.device.value.deviceId ?? this.def?.sysex?.deviceIdDefault ?? 0; }
  set deviceId(id) { this.host.device.update({ deviceId: id }); this.client.setSettings({ deviceId: id }); this.loadNameCache(); for (const o of this.def?.objects || []) this.emit('names', o.key); this.renderStatus(); }
  get connected() { return !!this.transport.output; }
  get ctx() { return { channel: this.channel, deviceId: this.deviceId, entry: this.entry, data: this.objectData, names: this.slotNames, loaded: this.loadedKeys, settings: this.host.device.value }; }

  setObjectData(key, data) {
    this.objectData[key] = Uint8Array.from(data);
    this.loadedKeys.add(key);
    this.emit('object', key);
  }

  /** Slot names remembered from earlier sessions with this device (catalog id + device ID). */
  loadNameCache() {
    if (this.demo) return;
    this.slotNames = loadSlotNames(this.entry.id, this.deviceId);
    this.unconfirmed = {};
    for (const [key, m] of Object.entries(this.slotNames)) this.unconfirmed[key] = new Set(m.keys());
  }

  /** True for a name remembered from an earlier session and not read from the device again yet. */
  nameUnconfirmed(key, bank, slot) { return !!this.unconfirmed[key]?.has(`${bank}:${slot}`); }
  /** True while some remembered names of a bank have not been read again. */
  namesPending(key, bank) { for (const k of this.unconfirmed[key] || []) if (k.startsWith(`${bank}:`)) return true; return false; }

  setSlotName(key, bank, slot, name) {
    const k = `${bank}:${slot}`;
    const m = (this.slotNames[key] ??= new Map());
    const old = m.get(k);
    if (this.unconfirmed[key]?.delete(k) && old !== name) this.namesChanged.push({ key, bank, slot, old, name });
    m.set(k, name);
    clearTimeout(this._namesTimer);
    this._namesTimer = setTimeout(() => {
      this.emit('names', key);
      if (!this.demo) saveSlotNames(this.entry.id, this.deviceId, this.slotNames);
    }, 120);
  }

  /** Tell the user which remembered names were different on the device (after a read). */
  reportNameChanges() {
    const ch = this.namesChanged.splice(0);
    if (!ch.length) return;
    const label = ({ key, bank, slot }) => this.def?.objects?.find((o) => o.key === key)?.slots?.slotLabel?.(bank, slot) ?? `${bank}:${slot}`;
    const list = ch.slice(0, 6).map((c) => `${label(c)} ${c.old || '(empty)'} → ${c.name || '(empty)'}`).join('; ');
    toast(`${ch.length} name${ch.length > 1 ? 's' : ''} changed on the ${this.entry.model} since last time: ${list}${ch.length > 6 ? '; ...' : ''}`, 'info', 8000);
  }

  error(err, context) { this.host.error(err, context); }

  // ------------------------------------------------------------ MIDI inputs (core/midi/inputs.js)
  /** Objects a controller can change: the page last shown first, then sounds, then the rest. */
  mappableObjects() {
    const objs = (this.def?.objects || []).filter((o) => o.params?.length && o.init);
    const rank = (o) => (o.key === this.activeObject ? 0 : o.toCommon ? 1 : 2);
    return objs.slice().sort((a, b) => rank(a) - rank(b));
  }

  /** {obj, p} that a function id means on this device (the first object that has it), or null. */
  resolveMapped(fn) {
    const ctx = this.ctx;
    // sounds (objects with a translator) and the page shown last; not settings objects (a drum kit's
    // "Decay" is not the amp envelope)
    for (const obj of this.mappableObjects().filter((o) => o.toCommon || o.key === this.activeObject)) {
      const data = this.objectData[obj.key] || obj.init();
      const sections = new Map((obj.sections || []).map((s) => [s.key, s.label]));
      const p = resolveFunction(fn, obj.params, {
        groupOf: (x) => `${x.group || ''} ${sections.get(x.section) || ''}`,
        usable: (x) => { try { const v = x.dynamic ? x.dynamic(data, ctx) : null; return !v?.hidden && !v?.readOnly; } catch { return true; } },
      });
      if (p) return { obj, p };
    }
    return null;
  }

  /** Set parameter p of object obj as its editor page does: written into the editor's data, sent as the
   *  parameter's own message, and its `after` hook run. False when the value did not change. */
  setParam(obj, p, value) {
    const ctx = this.ctx;
    const d = (this.objectData[obj.key] ??= obj.init());
    if (!writeParam(d, p, value)) return false;
    const v = readParam(d, p);
    const out = p.send ? p.send(v, ctx, d) : obj.sendParam?.(p, v, d, ctx);
    if (out && this.connected) sendOut(this, out, `${obj.key}:${p.sendKey || p.key}`);
    const said = p.after?.(d, v, ctx);
    if (said) toast(said, 'info');
    return true;
  }

  /** Apply a mapped controller (target {type: 'function', fn} | {type: 'param', object, param}) with
   *  value 0-127: written into the editor's data and sent as the parameter's own message. */
  applyMapped(t, value7) {
    let obj;
    let p;
    if (t.type === 'param') {
      obj = (this.def?.objects || []).find((o) => o.key === t.object);
      p = obj?.params?.find((x) => x.key === t.param);
    } else ({ obj, p } = this.resolveMapped(t.fn) || {});
    if (!obj || !p) return null;
    const ctx = this.ctx;
    const d = (this.objectData[obj.key] ??= obj.init());
    const view = p.dynamic ? { ...p, ...p.dynamic(d, ctx) } : p;
    if (view.hidden || view.readOnly) return null;
    if (this.setParam(obj, p, scaleToParam(view, value7, paramRange(view)))) {
      // the editor page redraws a few times a second, not on every controller message
      if (!this._mappedTimer) this._mappedTimer = setTimeout(() => { this._mappedTimer = null; this.emit('object', obj.key); }, 80);
    }
    return { obj, p };
  }

  /** Busy indicator for a multi-step operation; the request queue does not clear it meanwhile. */
  setBusy(n, text) {
    // a background job (dumpjob.js: a complete dump) keeps its line while it runs
    if (!n && this.job) { n = 1; text = this.job.busy?.() || this.job.title; }
    this.opBusy = n ? text || true : null;
    this.host.setBusy(n, text);
  }
  nav(page, params) { this.host.nav(page, params); }

  async connect(names) {
    await this.host.connectPorts(names);
    this.renderStatus();
    if (this.connected) this.identify().catch(() => {}).then(() => this.loadStandard());
    return this.connected;
  }

  /**
   * Read what a definition marks as standard information when the device connects:
   * objects with autoLoad (settings, edit buffers), then the definition's connectTasks
   * (e.g. finding installed expansion boards), then slot banks listed in
   * slots.autoNames (memory names). Runs in the background; editor pages update as
   * results arrive.
   *
   * connectTasks: [{label, enabled?(ctx) -> bool, run(api)}]; api is objectApi() of the
   * first object, with `quiet: true` so tasks skip their confirmations.
   */
  async loadStandard() {
    const objs = this.def?.objects || [];
    if (this.loadingStandard || !this.connected || !objs.length) return;
    this.loadingStandard = true;
    const stop = () => this.destroyed || !this.connected || !!this.job;
    const failed = [];
    try {
      for (const obj of objs.filter((o) => o.autoLoad && canFetch(o))) {
        if (stop()) return;
        if (this.loadedKeys.has(obj.key) || this.loading.has(obj.key)) continue; // an open page read it
        this.loading.add(obj.key);
        this.setBusy(1, `Reading ${obj.label}`);
        try { await loadObject(this, obj); } catch { failed.push(obj.label); } finally { this.loading.delete(obj.key); }
      }
      for (const task of this.def.connectTasks || []) {
        if (stop()) return;
        if (task.enabled && !task.enabled(this.ctx)) continue;
        this.setBusy(1, task.label);
        try {
          await task.run(objectApi(this, objs[0], { quiet: true, refresh: () => this.emit('refresh') }));
        } catch (err) { failed.push(`${task.label} (${err.message})`); }
      }
      for (const obj of objs) {
        for (const bank of obj.slots?.autoNames || []) {
          if (stop()) return;
          const banks = typeof obj.slots.banks === 'function' ? obj.slots.banks(this.ctx) : obj.slots.banks;
          const label = banks.find(([v]) => v === bank)?.[1] ?? '';
          try {
            await readBankNames(this, obj, bank, {
              shouldStop: stop,
              onProgress: (n, total) => this.setBusy(1, `Reading ${obj.slots.label || obj.label} ${label} names ${n}/${total}`),
            });
          } catch { failed.push(`${obj.slots.label || obj.label} names`); }
        }
      }
      this.reportNameChanges();
      this.emit('standard-loaded', failed);
      if (failed.length) this.host.error(new Error(`No reply for: ${failed.join(', ')}. Check the MIDI connection and the device ID.`), 'Reading device information');
    } finally {
      this.loadingStandard = false;
      this.setBusy(0);
    }
  }

  /** Universal identity request; many devices from the mid-1990s on answer it. */
  async identify() {
    try {
      const raw = await this.client.identity(0x7f, 1200);
      this.identityReply = raw;
      this.online = true;
    } catch { this.identityReply = null; }
    this.renderStatus();
    this.emit('identity', this.identityReply);
    return this.identityReply;
  }

  renderStatus() {
    const items = [];
    if (this.connected) items.push(h('span.badge', `Ch ${this.channel + 1}`));
    if (this.def?.sysex) items.push(h('span.badge', `ID ${this.deviceId}`));
    this.host.setStatus(h('div.mem', items));
    this.host.setOnline(this.online || (this.connected && !!this.transport.input));
  }

  async start() {
    const shell = this.host.shell;
    if (this.demo) { await this.connect(); return; }
    const d = this.host.device.value;
    const go = () => {
      // No ports remembered for this device but some are open (the previous device's, e.g. another
      // engine of the same instrument): use them, and read the device as usual. When they belong to
      // another instrument, the reads fail and say so ("No reply for ...").
      const open = this.transport.output?.name;
      if (!d.input && !d.output && open) this.host.rememberPorts({ input: this.transport.input?.name || '', output: open });
      if (d.input || d.output || open) this.connect().catch(() => {});
    };
    if (shell.real.access) go();
    else { const off = shell.on('midi-ready', () => { off(); go(); }); this.offs.push(off); }
  }

  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
    for (const off of this.offs) off?.();
    this.client.dispose();
  }
}

export function createGenericModule(entry, def = null) {
  return {
    id: entry.id,
    title: entry.title,
    async create(host) {
      const g = new GenericContext(host, entry, def);
      const sampler = entry.type === 'smp' || def?.sds;
      // each object's page, then its gallery pages (obj.galleries, views/gallery.js; one with `after`
      // is a tab of the object's page instead)
      const objectPages = (def?.objects || []).flatMap((obj) => [{
        key: obj.key, label: obj.page || obj.label, icon: obj.icon || '◆',
        view: (root, ctx, params) => editorView(root, ctx, params, obj),
      }, ...(obj.galleries || []).filter((gal) => gal.after === undefined || !obj.sections).map((gal) => ({
        key: `${obj.key}-${gal.key}`, label: gal.page, icon: gal.icon || '▦',
        view: (root, ctx, params) => galleryView(root, ctx, params, obj, gal),
      }))]);
      // Multitimbral objects also get a MIDI channels page (parts, patches and channels).
      const multiPages = (def?.objects || []).filter((obj) => obj.multi).map((obj) => ({
        key: `${obj.key}-channels`, label: obj.multi.page || 'MIDI channels', icon: '⇶',
        view: (root, ctx, params) => multiView(root, ctx, params, obj),
      }));
      // Pages a definition adds itself: def.pages = [{key, label, icon, view(root, g, params)}].
      const defPages = (def?.pages || []).map((p) => ({ ...p, icon: p.icon || '◇' }));
      const pages = [
        { key: 'intro', label: 'Connect', icon: '◉', view: introView },
        ...objectPages,
        ...multiPages,
        ...defPages,
        def?.params?.length ? { key: 'params', label: def.paramsPage || 'Parameters', icon: '◇', view: paramsView } : null,
        { key: 'play', label: 'Controllers', icon: '♪', view: playView },
        { key: 'inputs', label: 'Input mappings', icon: '⇆', view: inputsView },
        { key: 'librarian', label: 'Branch Library', icon: '☰', view: librarianView },
        sampler ? { key: 'samples', label: 'Samples (SDS)', icon: '∿', view: samplesView } : null,
        { key: 'console', label: 'SysEx Console', icon: '⌨', view: consoleView },
      ].filter(Boolean);
      g.start().catch(() => {});
      return {
        client: g.client,
        context: g,
        pages: pages.map(({ key, label, icon }) => ({ key, label, icon })),
        render(key, root, params) { return pages.find((p) => p.key === key).view(root, g, params); },
        decode: def?.describe || null,
        destroy() { g.destroy(); },
      };
    },
  };
}
