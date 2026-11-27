// Global settings shared by every device module, plus per-device settings.

import { Emitter } from './emitter.js';

const KEY = 'midimaster.settings';
const DEVICE_KEY = (id) => `midimaster.device.${id}`;

export const SETTING_DEFAULTS = {
  theme: 'system', // system | dark | light
  accent: '#f2b544',
  fontScale: 1,
  density: 'comfortable', // comfortable | compact
  showNonMidi: false,
  midi: {
    autoConnect: true,
    defaultInput: '',
    defaultOutput: '',
    sysexGap: 150, // ms between SysEx messages
    replyTimeout: 2500,
    bytesPerSecond: 2900, // effective throughput for timeouts of long transfers
    sdsPacketGap: 45, // ms between Sample Dump packets when the device does not handshake
    panicOnClose: true,
    filterRealtime: true, // hide clock and active sensing in the monitor
  },
  keyboard: { show: true, channel: 0, velocity: 100, octave: 3, computerKeys: true, patternBpm: 120 },
  // MIDI inputs (core/midi/inputs.js): up to 4 controllers; global controller mappings
  inputs: {
    slots: Array.from({ length: 4 }, () => ({ port: '', enabled: true, thru: true, toChannel: true })),
    mappings: [],
  },
  monitor: { maxEntries: 400 },
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

function load(key, defaults) {
  try { return merge(defaults, JSON.parse(localStorage.getItem(key) || '{}')); } catch { return merge(defaults, {}); }
}

function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export class Settings extends Emitter {
  constructor() {
    super();
    this.value = load(KEY, SETTING_DEFAULTS);
  }

  get(path) { return path.split('.').reduce((o, k) => o?.[k], this.value); }

  /** Merge a patch, e.g. {midi: {sysexGap: 200}}, save it and notify listeners. */
  update(patch) {
    this.value = merge(this.value, patch);
    store(KEY, this.value);
    this.emit('change', this.value, patch);
  }

  reset() {
    this.value = merge(SETTING_DEFAULTS, {});
    store(KEY, this.value);
    this.emit('change', this.value, this.value);
  }

  export() { return JSON.stringify(this.value, null, 2); }

  import(json) { this.value = merge(SETTING_DEFAULTS, JSON.parse(json)); store(KEY, this.value); this.emit('change', this.value, this.value); }

  /** Settings of one device (ports, device ID, channel...). */
  device(id, defaults = {}) {
    const self = this;
    let value = load(DEVICE_KEY(id), defaults);
    return {
      get value() { return value; },
      update(patch) { value = merge(value, patch); store(DEVICE_KEY(id), value); self.emit('device', id, value); },
    };
  }
}

/** Recently opened devices (most recent first). */
export function recentDevices() {
  try { return JSON.parse(localStorage.getItem('midimaster.recent') || '[]'); } catch { return []; }
}

export function rememberDevice(id) {
  const list = [id, ...recentDevices().filter((x) => x !== id)].slice(0, 8);
  store('midimaster.recent', list);
}
