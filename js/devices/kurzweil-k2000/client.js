// High-level K2000 client: serialized request queue with throttling, reply
// matching, coalescing of live edits, and convenience methods for every
// SysEx message the firmware understands.

import { DeviceClient, DeviceError } from '../../core/midi/device-client.js';
import {
  build, parse, isK2, MSG, FORM, BTN_EVENT, BUTTONS, digitButton,
  decodeScreenText, decodeScreenGraphics, decodeScreenString,
} from './protocol.js';

export const DEFAULTS = {
  deviceId: 0,
  minGap: 150, // ms between SysEx messages. The K2000 stalls below ~120 ms.
  timeout: 2500,
  bytesPerSecond: 2900, // effective MIDI throughput used to scale timeouts
};

export class K2Error extends DeviceError {}

export class K2Client extends DeviceClient {
  constructor(transport, settings = {}) {
    super(transport, settings, { deviceName: 'K2000', defaults: DEFAULTS });
  }

  makeError(message, reply) { return new K2Error(message, reply); }

  parse(raw) {
    if (isK2(raw)) return parse(raw);
    if (raw[1] === 0x7e) return { name: 'UNIVERSAL', sub: raw[3], raw };
    return null;
  }

  // ------------------------------------------------------------ helpers
  _ack(type, id) {
    return (m) => (m.msg === MSG.DACK || m.msg === MSG.DNAK) && m.type === type && m.id === id;
  }

  _checkAck(reply) {
    if (reply.superseded) return reply;
    if (reply.msg === MSG.DNAK) {
      this.stats.naks++;
      throw new K2Error(`K2000 refused: ${reply.reason}`, reply);
    }
    return reply;
  }

  // ------------------------------------------------------------ object API
  async dir(type, id) {
    return this.request(build.dir(this.dev, type, id), {
      match: (m) => m.msg === MSG.INFO && m.type === type && m.id === id,
    });
  }

  /** Partial or full dump. Returns Uint8Array (DUMP of a missing object gets no reply). */
  async dump(type, id, offs = 0, size = 0x1fffff, expected = 4096) {
    const reply = await this.request(build.dump(this.dev, type, id, offs, size), {
      match: (m) => m.msg === MSG.LOAD && m.type === type && m.id === id && m.offs === offs,
      timeout: this._sizeTimeout(Math.min(size, expected) * 1.2),
    });
    if (reply.checksumOk === false) throw new K2Error('Checksum error in dump reply');
    return reply.data;
  }

  /** READ: whole object with its name. Returns {name, data, size}. */
  async readObject(type, id, expectedSize = 4096) {
    const reply = await this.request(build.read(this.dev, type, id), {
      match: (m) => m.msg === MSG.WRITE && m.type === type && m.id === id,
      timeout: this._sizeTimeout(expectedSize * 1.2),
    });
    if (reply.checksumOk === false) throw new K2Error('Checksum error in object reply');
    return { name: reply.objName, data: reply.data, size: reply.size };
  }

  /** Read an object after asking DIR for its size (better timeouts, detects missing objects). */
  async fetchObject(type, id) {
    const info = await this.dir(type, id);
    if (!info.size) throw new K2Error(`Object ${type}:${id} does not exist`);
    const obj = await this.readObject(type, id, info.size);
    return { ...obj, inRam: info.inRam };
  }

  /** LOAD bytes into an existing object at offset. Live edits use coalescing keys. */
  async load(type, id, offs, data, { key } = {}) {
    const reply = await this.request(build.load(this.dev, type, id, offs, data), {
      match: this._ack(type, id),
      key,
      timeout: this._sizeTimeout(data.length * 1.2),
    });
    return this._checkAck(reply);
  }

  /** WRITE a whole object (deletes any existing RAM object at that ID first). */
  async writeObject(type, id, name, data, mode = 0) {
    const reply = await this.request(build.write(this.dev, type, id, mode, name, data), {
      match: (m) => (m.msg === MSG.DACK || m.msg === MSG.DNAK) && m.type === type && (mode === 1 || m.id === id),
      timeout: this._sizeTimeout(data.length * 1.2) + 1500,
    });
    return this._checkAck(reply);
  }

  /** Send a raw WRITE message captured from a .syx file. */
  async sendWriteMessage(bytes) {
    const m = parse(bytes);
    if (!m || m.msg !== MSG.WRITE) throw new K2Error('Not a K2000 WRITE message');
    const reply = await this.request(Uint8Array.from([...bytes.slice(0, 2), this.dev, ...bytes.slice(3)]), {
      match: (r) => (r.msg === MSG.DACK || r.msg === MSG.DNAK) && r.type === m.type,
      timeout: this._sizeTimeout(bytes.length) + 1500,
    });
    return this._checkAck(reply);
  }

  async newObject(type, id, size, name, copyRom = false) {
    return this.request(build.new(this.dev, type, id, size, copyRom ? 1 : 0, name), {
      match: (m) => m.msg === MSG.INFO && m.type === type,
    });
  }

  async deleteObject(type, id) {
    return this.request(build.del(this.dev, type, id), {
      match: (m) => m.msg === MSG.INFO && m.type === type && m.id === id,
    });
  }

  async change(type, id, newid, name) {
    return this.request(build.change(this.dev, type, id, newid, name), {
      match: (m) => m.msg === MSG.INFO && m.type === type,
    });
  }

  rename(type, id, name) { return this.change(type, id, 0, name); }
  moveObject(type, id, newid) { return this.change(type, id, newid, ''); }

  /** Copy = read + write at the new ID. */
  async copyObject(type, id, newid, newName) {
    const obj = await this.fetchObject(type, id);
    await this.writeObject(type, newid, newName ?? obj.name, obj.data);
    return obj;
  }

  /** List objects. bank 0-9 or 127 for all banks. Returns INFO messages. */
  async dirBank(type, bank = 127, ramOnly = false) {
    const res = await this.request(build.dirBank(this.dev, type, bank, ramOnly), {
      collect: (m) => m.msg === MSG.INFO,
      match: (m) => m.msg === MSG.ENDOFBANK,
      quiet: 3000,
      resolveOnQuiet: true,
      timeout: 4000,
    });
    return res.messages || [];
  }

  /** Read whole banks. Returns WRITE messages (parsed) and the raw bytes for .syx export. */
  async readBank(type, bank = 127, ramOnly = true, onProgress) {
    const raws = [];
    const res = await this.request(build.readBank(this.dev, type, bank, FORM.BITSTREAM, ramOnly), {
      collect: (m) => {
        if (m.msg !== MSG.WRITE) return false;
        onProgress?.(m);
        return true;
      },
      match: (m) => m.msg === MSG.ENDOFBANK,
      quiet: 8000,
      resolveOnQuiet: true,
      timeout: 8000,
    });
    // Raw bytes are re-encoded from parsed messages for export.
    for (const m of res.messages || []) raws.push(build.write(0, m.type, m.id, 0, m.objName, m.data));
    return { objects: res.messages || [], raws };
  }

  async deleteBank(type, bank) {
    return this.request(build.delBank(this.dev, type, bank), {
      match: (m) => m.msg === MSG.ENDOFBANK || m.msg === MSG.INFO,
      timeout: 6000,
    }).catch((err) => ({ timeout: true, err })); // a one-type DELBANK may be silent
  }

  async moveBank(type, bank, newBank) {
    return this.request(build.moveBank(this.dev, type, bank, newBank), {
      match: (m) => m.msg === MSG.ENDOFBANK,
      timeout: 8000,
    });
  }

  async loadMacro() {
    return this.request(build.loadMacro(this.dev), { match: (m) => m.msg === MSG.MACRODONE, timeout: 10000 });
  }

  /** Undocumented 0x12: free program memory (KB) and sample memory (KB). */
  async memory(timeout = 1500) {
    return this.request(build.memQuery(this.dev), { match: (m) => m.msg === MSG.MEMREPLY, timeout });
  }

  /** Undocumented 0x7C: RAM address of an object (0 if missing). */
  async objectAddress(type, id) {
    const r = await this.request(build.objAddr(this.dev, type, id), { match: (m) => m.msg === MSG.OBJADDRREPLY });
    return r.address;
  }

  /** Undocumented 0x7E: rename one sub-sample of a soundblock. */
  setSubsampleName(sampleId, index, name) { return this.send(build.subName(this.dev, sampleId, index, name)); }

  /** Undocumented 0x79: split a multi-sample soundblock into single soundblocks. */
  splitSoundblock(sampleId, firstNewId) { return this.send(build.splitBlock(this.dev, sampleId, firstNewId)); }

  // ------------------------------------------------------------ front panel
  panel(events) { return this.send(build.panel(this.dev, events)).then((r) => { this.emit('panel', events); return r; }); }

  press(...buttons) {
    const ev = [];
    buttons.forEach((b, i) => {
      ev.push({ type: BTN_EVENT.DOWN, button: b });
      if (buttons[i + 1] !== b) ev.push({ type: BTN_EVENT.UP, button: b });
    });
    return this.panel(ev);
  }

  /** Type a number on the keypad and optionally press Enter. */
  typeNumber(n, enter = true) {
    const keys = [];
    if (n < 0) keys.push(BUTTONS.PLUSMINUS);
    for (const ch of String(Math.abs(Math.trunc(n)))) keys.push(digitButton(+ch));
    if (enter) keys.push(BUTTONS.ENTER);
    return this.press(...keys);
  }

  wheel(clicks) {
    const ev = [];
    let rest = clicks;
    while (rest !== 0) {
      const c = Math.max(-63, Math.min(63, rest));
      ev.push({ type: BTN_EVENT.WHEEL, button: 0, clicks: c });
      rest -= c;
    }
    return ev.length ? this.panel(ev) : Promise.resolve();
  }

  /** Select a program on the K2000 by typing its number in Program mode. */
  selectProgram(id) { return this.press(BUTTONS.PROGRAM).then(() => this.typeNumber(id, true)); }

  async screenText() {
    const r = await this.request(build.allText(this.dev), { match: (m) => m.msg === MSG.SCREENREPLY && m.data.length > 300 });
    return decodeScreenText(r.data);
  }

  async screenGraphics() {
    const r = await this.request(build.getGraphics(this.dev), {
      match: (m) => m.msg === MSG.SCREENREPLY && m.data.length > 2000,
      timeout: this.s.timeout + 1500,
    });
    return decodeScreenGraphics(r.data);
  }

  async paramName() {
    const r = await this.request(build.paramName(this.dev), { match: (m) => m.msg === MSG.SCREENREPLY && m.data.length < 300 });
    return decodeScreenString(r.data);
  }

  async paramValue() {
    const r = await this.request(build.paramValue(this.dev), { match: (m) => m.msg === MSG.SCREENREPLY && m.data.length < 300 });
    return decodeScreenString(r.data);
  }

  // ------------------------------------------------------------ universal / misc
  /** Universal Identity Request. The K2000 only answers its own device ID, never 127. */
  identity() { return super.identity(this.dev); }

  /** Probe whether a K2000 answers on the current device ID. */
  async ping() {
    try { await this.memory(Math.min(1500, this.s.timeout)); return true; } catch { return false; }
  }

  /** Try device IDs until one answers. */
  async scanDeviceId(candidates = [0, 127, ...Array.from({ length: 126 }, (_, i) => i + 1)]) {
    const saved = this.s.timeout;
    this.s.timeout = 400;
    try {
      for (const id of candidates) {
        this.s.deviceId = id;
        if (await this.ping()) return id;
      }
      return null;
    } finally {
      this.s.timeout = saved;
    }
  }

}
