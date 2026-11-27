// Base client for any MIDI device: a serialized SysEx request queue with a minimum
// gap between messages, reply matching, coalescing of live edits, and helpers for
// channel messages. Device modules extend it and override parse() to decode their
// own SysEx messages.

import { Emitter } from '../emitter.js';
import { sleep } from '../bits.js';
import { waitForSlot } from './schedule.js';

export const CLIENT_DEFAULTS = {
  deviceId: 0,
  minGap: 150, // ms between SysEx messages
  timeout: 2500, // ms to wait for a reply
  bytesPerSecond: 2900, // effective MIDI throughput used to scale timeouts for large messages
};

export class DeviceError extends Error {
  constructor(message, reply) { super(message); this.reply = reply; }
}

export class DeviceClient extends Emitter {
  constructor(transport, settings = {}, { deviceName = 'device', defaults = CLIENT_DEFAULTS } = {}) {
    super();
    this.t = transport;
    this.s = { ...defaults, ...settings };
    this.deviceName = deviceName;
    this.queue = [];
    this.current = null;
    this.lastSend = -Infinity; // the first message goes out at once
    this.running = false;
    this.stats = { sent: 0, received: 0, timeouts: 0, naks: 0 };
    this._off = transport.on('sysex', (data) => this._onSysex(data));
  }

  get dev() { return this.s.deviceId; }
  setSettings(patch) { Object.assign(this.s, patch); }

  /** Stop listening and reject everything still queued. */
  dispose() {
    this._off?.();
    this.cancelAll('closed');
  }

  /** Error type thrown by this client; device modules may return a subclass. */
  makeError(message, reply) { return new DeviceError(message, reply); }

  /** Decode an incoming SysEx message. Override per device; null ignores the message. */
  parse(raw) {
    const name = raw[1] === 0x7e ? 'UNIVERSAL' : raw[1] === 0x7f ? 'REALTIME' : 'SYSEX';
    return { name, sub: raw[3], raw };
  }

  // ------------------------------------------------------------ queue core
  /**
   * Enqueue a message.
   * opts.match(msg, raw) -> true when `msg` is the (final) reply
   * opts.collect(msg)    -> true to accumulate `msg`; resolution happens on match or quiet timeout
   * opts.quiet           -> resolve this many ms after the last collected message
   * opts.resolveOnQuiet  -> resolve with what was collected when the quiet time passes
   * opts.complete(list)  -> true once the collected messages are complete (resolves at once)
   * opts.key             -> coalescing key; an unsent item with the same key is replaced
   * opts.timeout         -> ms to wait for the reply
   * opts.front           -> jump the queue
   * opts.noReply         -> resolve as soon as the message is sent (scheduled: it may go out up to
   *                         schedule.js's look-ahead later, in order)
   * opts.gapAfter        -> extra ms before the next message (e.g. the time a long message takes)
   * While `hold` is set (a text: why), requests that wait for a reply are refused with it; messages
   * sent without one still go out (a complete dump sets it: another request would cut it short).
   */
  request(bytes, opts = {}) {
    if (this.hold && !opts.noReply) return Promise.reject(this.makeError(this.hold));
    return new Promise((resolve, reject) => {
      const item = { bytes, opts, resolve, reject, collected: [] };
      if (opts.key) {
        const idx = this.queue.findIndex((q) => q.opts.key === opts.key);
        if (idx >= 0) {
          const old = this.queue[idx];
          this.queue[idx] = item;
          old.resolve({ superseded: true });
          this._pump();
          return;
        }
      }
      if (opts.front) this.queue.unshift(item); else this.queue.push(item);
      this._pump();
    });
  }

  /** Send without waiting for a reply (still throttled). */
  send(bytes, opts = {}) { return this.request(bytes, { ...opts, noReply: true }); }

  /** Raw, unthrottled send for channel messages (notes, controllers). */
  sendNow(bytes) { this.t.send(bytes); }

  /** Unthrottled send scheduled at a performance.now() timestamp. */
  sendAt(bytes, at) { this.t.send(bytes, at); }

  get pending() { return this.queue.length + (this.current ? 1 : 0); }

  cancelAll(reason = 'cancelled') {
    for (const q of this.queue) q.reject(this.makeError(reason));
    this.queue = [];
  }

  /** Resolve once every queued message has been sent and answered. */
  async drain() {
    while (this.pending) await sleep(50);
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        // Live edits that replace each other while queued (opts.key) wait in the queue as before, so a
        // knob drag is coalesced. Everything else is given the time it is due and sent with a Web MIDI
        // timestamp (see schedule.js: page timers are throttled in background tabs).
        const head = this.queue[0];
        const due = this.lastSend + this.s.minGap;
        if (head.opts.key) { const wait = due - performance.now(); if (wait > 0) await sleep(wait); }
        else await waitForSlot(due);
        const item = this.queue.shift();
        if (!item) continue;
        this.emit('busy', this.pending);
        try {
          this.current = item;
          const now = performance.now();
          const at = Math.max(now, this.lastSend + this.s.minGap);
          if (at > now + 1) this.t.send(item.bytes, at); else this.t.send(item.bytes);
          this.stats.sent++;
          this.lastSend = at + (item.opts.gapAfter || 0);
          if (item.opts.noReply) {
            this.current = null;
            item.resolve({ sent: true, at });
            continue;
          }
          // the reply cannot come before the message goes out
          if (at > now + 1) item.opts = { ...item.opts, timeout: (item.opts.timeout ?? this.s.timeout) + (at - now) };
          const result = await this._awaitReply(item);
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        } finally {
          this.current = null;
          // Replies keep arriving while a long message is being received; measure the gap from the last byte.
          this.lastSend = Math.max(this.lastSend, performance.now());
        }
      }
    } finally {
      this.running = false;
      this.emit('busy', this.pending);
    }
  }

  _awaitReply(item) {
    return new Promise((resolve, reject) => {
      const base = item.opts.timeout ?? this.s.timeout;
      let timer = null;
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          item.waiter = null;
          if (item.opts.collect && item.collected.length && item.opts.resolveOnQuiet) {
            resolve({ messages: item.collected, partial: true });
          } else {
            this.stats.timeouts++;
            reject(this.makeError(`No reply from the ${this.deviceName} within ${Math.round(ms)} ms`));
          }
        }, ms);
      };
      item.waiter = (msg, raw) => {
        if (item.opts.collect && item.opts.collect(msg, raw)) {
          item.collected.push(msg);
          if (item.opts.complete && item.opts.complete(item.collected)) {
            clearTimeout(timer);
            item.waiter = null;
            resolve({ messages: item.collected, complete: true });
            return true;
          }
          arm(item.opts.quiet ?? base);
          return true;
        }
        if (item.opts.match && item.opts.match(msg, raw)) {
          clearTimeout(timer);
          item.waiter = null;
          resolve(item.opts.collect ? { messages: item.collected, end: msg } : msg);
          return true;
        }
        return false;
      };
      arm(base);
    });
  }

  _onSysex(raw) {
    this.stats.received++;
    let msg = null;
    try { msg = this.parse(raw); } catch (err) { msg = { name: 'PARSE_ERROR', error: err.message, raw }; }
    const cur = this.current;
    if (cur && cur.waiter && msg && cur.waiter(msg, raw)) return;
    if (msg) this.emit('unsolicited', msg, raw);
  }

  _sizeTimeout(bytes) { return this.s.timeout + (bytes / this.s.bytesPerSecond) * 1000; }

  // ------------------------------------------------------------ universal messages
  /** Universal Identity Request. Returns the raw reply bytes. */
  async identity(deviceId = 0x7f, timeout = 1500) {
    const req = Uint8Array.from([0xf0, 0x7e, deviceId & 0x7f, 0x06, 0x01, 0xf7]);
    const r = await this.request(req, { match: (m, raw) => raw[1] === 0x7e && raw[3] === 0x06 && raw[4] === 0x02, timeout });
    return Array.from(r.raw || []);
  }

  // ------------------------------------------------------------ channel messages
  noteOn(ch, note, vel = 100) { this.sendNow([0x90 | (ch & 15), note & 127, vel & 127]); }
  noteOff(ch, note) { this.sendNow([0x80 | (ch & 15), note & 127, 0]); }
  cc(ch, num, val) { this.sendNow([0xb0 | (ch & 15), num & 127, val & 127]); }
  programChange(ch, prog) { this.sendNow([0xc0 | (ch & 15), prog & 127]); }
  channelPressure(ch, val) { this.sendNow([0xd0 | (ch & 15), val & 127]); }
  polyPressure(ch, note, val) { this.sendNow([0xa0 | (ch & 15), note & 127, val & 127]); }
  /** Pitch bend, -8192..8191. */
  pitchBend(ch, value) {
    const v = Math.max(0, Math.min(16383, value + 8192));
    this.sendNow([0xe0 | (ch & 15), v & 127, v >> 7]);
  }

  /** Bank select (MSB, optional LSB) followed by a program change. */
  selectBankProgram(ch, msb, lsb, prog) {
    if (msb !== null && msb !== undefined) this.cc(ch, 0, msb);
    if (lsb !== null && lsb !== undefined) this.cc(ch, 32, lsb);
    this.programChange(ch, prog);
  }

  /** RPN or NRPN write with 14-bit value (data entry MSB/LSB), then null the parameter number. */
  paramNumber(ch, { nrpn = true, msb, lsb, value, fine = true }) {
    this.cc(ch, nrpn ? 99 : 101, msb);
    this.cc(ch, nrpn ? 98 : 100, lsb);
    this.cc(ch, 6, fine ? (value >> 7) & 127 : value & 127);
    if (fine) this.cc(ch, 38, value & 127);
    this.cc(ch, 101, 127);
    this.cc(ch, 100, 127);
  }

  panic() { for (let ch = 0; ch < 16; ch++) { this.cc(ch, 120, 0); this.cc(ch, 123, 0); } }
}
