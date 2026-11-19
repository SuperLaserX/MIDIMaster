// Generic MIDI module: opens any MIDI device in the catalog. Standard MIDI messages,
// a SysEx librarian, Sample Dump transfers and a SysEx console work for every device;
// a device definition (from firmware analysis) adds its parameters and dump requests.

import { Emitter } from '../../core/emitter.js';
import { h } from '../../core/ui/dom.js';
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
import { loadObject, readBankNames, canFetch } from './objects.js';

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
    return { deviceId: this.deviceId, minGap: this.demo ? 10 : Math.max(this.def?.minGap ?? 0, m.sysexGap), timeout: m.replyTimeout, bytesPerSecond: m.bytesPerSecond };
  }

  get channel() { return this.host.device.value.channel ?? 0; }
  set channel(ch) { this.host.setChannel(ch); this.renderStatus(); }
  get deviceId() { return this.host.device.value.deviceId ?? this.def?.sysex?.deviceIdDefault ?? 0; }
  set deviceId(id) { this.host.device.update({ deviceId: id }); this.client.setSettings({ deviceId: id }); this.renderStatus(); }
  get connected() { return !!this.transport.output; }
  get ctx() { return { channel: this.channel, deviceId: this.deviceId, entry: this.entry, data: this.objectData, names: this.slotNames, loaded: this.loadedKeys, settings: this.host.device.value }; }

  setObjectData(key, data) {
    this.objectData[key] = Uint8Array.from(data);
    this.loadedKeys.add(key);
    this.emit('object', key);
  }

  setSlotName(key, bank, slot, name) {
    (this.slotNames[key] ??= new Map()).set(`${bank}:${slot}`, name);
    clearTimeout(this._namesTimer);
    this._namesTimer = setTimeout(() => this.emit('names', key), 120);
  }

  error(err, context) { this.host.error(err, context); }

  /** Busy indicator for a multi-step operation; the request queue does not clear it meanwhile. */
  setBusy(n, text) {
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
   * objects with autoLoad (settings, edit buffers) and slot banks listed in
   * slots.autoNames (memory names). Runs in the background; editor pages update as
   * results arrive.
   */
  async loadStandard() {
    const objs = this.def?.objects || [];
    if (this.loadingStandard || !this.connected || !objs.length) return;
    this.loadingStandard = true;
    const stop = () => this.destroyed || !this.connected;
    const failed = [];
    try {
      for (const obj of objs.filter((o) => o.autoLoad && canFetch(o))) {
        if (stop()) return;
        if (this.loadedKeys.has(obj.key) || this.loading.has(obj.key)) continue; // an open page read it
        this.loading.add(obj.key);
        this.setBusy(1, `Reading ${obj.label}`);
        try { await loadObject(this, obj); } catch { failed.push(obj.label); } finally { this.loading.delete(obj.key); }
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
    const go = () => { if (d.input || d.output) this.connect().catch(() => {}); };
    if (shell.real.access) go();
    else { const off = shell.on('midi-ready', () => { off(); go(); }); this.offs.push(off); }
  }

  destroy() {
    this.destroyed = true;
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
      const objectPages = (def?.objects || []).map((obj) => ({
        key: obj.key, label: obj.page || obj.label, icon: obj.icon || '◆',
        view: (root, ctx, params) => editorView(root, ctx, params, obj),
      }));
      const pages = [
        { key: 'intro', label: 'Connect', icon: '◉', view: introView },
        ...objectPages,
        def?.params?.length ? { key: 'params', label: def.paramsPage || 'Parameters', icon: '◇', view: paramsView } : null,
        { key: 'play', label: 'Controllers', icon: '♪', view: playView },
        { key: 'librarian', label: 'Librarian', icon: '☰', view: librarianView },
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
