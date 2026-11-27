// MIDI Sample Dump Standard (Universal Non-Real-Time, F0 7E <dev> ...).
// The K2000 firmware (handler at 0x17C8AC) implements:
//   01 dump header, 02 data packet, 03 dump request, 06 01 identity request,
//   7C wait, 7D cancel, 7E NAK, 7F ACK.
// It only answers its own SysEx device ID. ROM samples cannot be dumped.
// SDS multi-byte fields are 7-bit, LEAST significant byte first.
// For dump requests the K2000 uses bits 0-9 of the sample number as the sample
// object ID and bits 10-13 as the sub-sample (e.g. the right side of a stereo pair).

import { waitForSlot, waitUntil } from './schedule.js';

const SUB = { HEADER: 0x01, PACKET: 0x02, REQUEST: 0x03, WAIT: 0x7c, CANCEL: 0x7d, NAK: 0x7e, ACK: 0x7f };

function lsb7(v, n) { const o = []; for (let i = 0; i < n; i++) { o.push(v & 0x7f); v = Math.floor(v / 128); } return o; }
function readLsb7(b, p, n) { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 128 + (b[p + i] & 0x7f); return v; }

const STANDARD_RATES = [8000, 11025, 16000, 22050, 24000, 29400, 32000, 44100, 48000, 88200, 96000];

/** Sample rate from a period in nanoseconds, snapped to a standard rate within 2 Hz. */
export function rateFromPeriod(periodNs) {
  if (!(periodNs > 0)) return 44100;
  const r = 1e9 / periodNs;
  const std = STANDARD_RATES.find((s) => Math.abs(s - r) <= 2);
  return std ?? Math.round(r);
}

export function sdsSampleNumber(sampleId, subIndex = 0) { return (sampleId & 0x3ff) | ((subIndex & 0x0f) << 10); }

/** Largest sample an SDS header can describe (21-bit length field). */
export const SDS_MAX_SAMPLES = 0x1fffff;


function buildHeader(dev, number, bits, periodNs, length, loopStart, loopEnd, loopType) {
  return Uint8Array.from([0xf0, 0x7e, dev, SUB.HEADER, ...lsb7(number, 2), bits,
    ...lsb7(periodNs, 3), ...lsb7(length, 3), ...lsb7(loopStart, 3), ...lsb7(loopEnd, 3), loopType, 0xf7]);
}

function handshake(dev, sub, packet) { return Uint8Array.from([0xf0, 0x7e, dev, sub, packet & 0x7f, 0xf7]); }

/** Encode Int16 samples (signed) into SDS 16-bit packets: 40 samples per 120-byte packet. */
function buildPacket(dev, packetNo, samples, start) {
  const body = new Array(120).fill(0);
  for (let i = 0; i < 40; i++) {
    const s = start + i < samples.length ? samples[start + i] : 0;
    const u = (s + 0x8000) & 0xffff; // offset binary
    body[i * 3] = (u >> 9) & 0x7f;
    body[i * 3 + 1] = (u >> 2) & 0x7f;
    body[i * 3 + 2] = (u << 5) & 0x60;
  }
  const msg = [0xf0, 0x7e, dev, SUB.PACKET, packetNo & 0x7f, ...body];
  let x = 0;
  for (let i = 1; i < msg.length; i++) x ^= msg[i];
  msg.push(x & 0x7f, 0xf7);
  return Uint8Array.from(msg);
}

function decodePacket(raw, bits) {
  const data = raw.subarray(5, 125);
  const bytesPer = Math.ceil(bits / 7);
  const out = [];
  for (let i = 0; i + bytesPer <= data.length; i += bytesPer) {
    let v = 0;
    for (let k = 0; k < bytesPer; k++) v = (v << 7) | data[i + k];
    v >>= bytesPer * 7 - bits; // left-justified
    const signed = v - (1 << (bits - 1));
    // Convert to 16-bit without rescaling errors: shift, never multiply.
    out.push(bits === 16 ? signed : bits < 16 ? signed << (16 - bits) : signed >> (bits - 16));
  }
  return out;
}

/**
 * Run an SDS session on the transport. The normal K2000 client queue must be
 * idle; SDS uses its own handshake timing.
 */
export class SampleDump {
  constructor(transport, deviceId = 0) {
    this.t = transport;
    this.dev = deviceId;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    try { this.t.send(handshake(this.dev, SUB.CANCEL, 0)); } catch { /* ignore */ }
  }

  _waitUniversal(pred, timeout) {
    return new Promise((resolve) => {
      let off = null;
      const timer = setTimeout(() => { off?.(); resolve(null); }, timeout);
      off = this.t.on('sysex', (raw) => {
        if (raw[1] !== 0x7e) return;
        if (pred(raw)) { clearTimeout(timer); off(); resolve(raw); }
      });
    });
  }

  /**
   * Send a mono Int16 sample to the K2000.
   * opts: {number, sampleRate, loopStart, loopEnd, loop, onProgress}
   */
  async send(samples, opts) {
    const { number, sampleRate, onProgress } = opts;
    const periodNs = Math.round(1e9 / sampleRate);
    const loop = !!opts.loop;
    const loopStart = loop ? Math.max(0, opts.loopStart | 0) : 0;
    const loopEnd = loop ? Math.min(samples.length - 1, opts.loopEnd ?? samples.length - 1) : samples.length - 1;
    this.cancelled = false;

    const isHandshake = (raw) => [SUB.ACK, SUB.NAK, SUB.WAIT, SUB.CANCEL].includes(raw[3]);
    this.t.send(buildHeader(this.dev, number, 16, periodNs, samples.length, loopStart, loopEnd, loop ? 0x00 : 0x7f));
    // Allow the K2000 time to allocate memory; it replies ACK or NAK/CANCEL.
    let reply = await this._waitUniversal(isHandshake, 4000);
    let openLoop = !reply;
    if (reply && (reply[3] === SUB.CANCEL || reply[3] === SUB.NAK)) throw new Error('The K2000 rejected the sample header (memory full or bad sample number).');

    const packets = Math.ceil(samples.length / 40);
    let p = 0;
    let retries = 0;
    let nextAt = performance.now(); // open loop: packets go out at timestamps (schedule.js)
    while (p < packets) {
      if (this.cancelled) throw new Error('Cancelled');
      if (openLoop) {
        const at = Math.max(performance.now(), nextAt);
        this.t.send(buildPacket(this.dev, p & 0x7f, samples, p * 40), at);
        nextAt = at + (this.packetGap ?? 45); // ~127 bytes at 31.25 kbaud
        await waitForSlot(nextAt);
      } else {
        this.t.send(buildPacket(this.dev, p & 0x7f, samples, p * 40));
        reply = await this._waitUniversal(isHandshake, 2000);
        if (!reply) { openLoop = true; } else if (reply[3] === SUB.WAIT) {
          reply = await this._waitUniversal((r) => [SUB.ACK, SUB.NAK, SUB.CANCEL].includes(r[3]), 30000);
        }
        if (reply && reply[3] === SUB.CANCEL) throw new Error('The K2000 cancelled the transfer.');
        if (reply && reply[3] === SUB.NAK) {
          if (++retries > 5) throw new Error(`Packet ${p} failed repeatedly.`);
          continue;
        }
      }
      retries = 0;
      p++;
      onProgress?.(p / packets);
    }
    if (openLoop) await waitUntil(nextAt); // the last scheduled packets have gone out
    return { packets, openLoop };
  }

  /** Request a sample from the K2000. Returns {samples: Int16Array, sampleRate, loopStart, loopEnd, loop, bits}. */
  async receive(number, onProgress) {
    this.cancelled = false;
    const headerP = this._waitUniversal((r) => r[3] === SUB.HEADER, 5000);
    this.t.send(Uint8Array.from([0xf0, 0x7e, this.dev, SUB.REQUEST, ...lsb7(number, 2), 0xf7]));
    const h = await headerP;
    if (!h) throw new Error('No dump header received. ROM samples cannot be dumped; check the sample ID and device ID.');
    const bits = h[6];
    const periodNs = readLsb7(h, 7, 3);
    const length = readLsb7(h, 10, 3);
    const loopStart = readLsb7(h, 13, 3);
    const loopEnd = readLsb7(h, 16, 3);
    const loopType = h[19];
    const out = new Int16Array(length);
    let filled = 0;
    let expected = 0;

    await new Promise((resolve, reject) => {
      let timer = null;
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { off(); filled ? resolve() : reject(new Error('Sample data stopped arriving.')); }, 3000); };
      const off = this.t.on('sysex', (raw) => {
        if (raw[1] !== 0x7e || raw[3] !== SUB.PACKET) return;
        if (this.cancelled) { off(); clearTimeout(timer); reject(new Error('Cancelled')); return; }
        let x = 0;
        for (let i = 1; i < raw.length - 2; i++) x ^= raw[i];
        const pk = raw[4];
        if ((x & 0x7f) !== raw[raw.length - 2] || pk !== (expected & 0x7f)) {
          this.t.send(handshake(this.dev, SUB.NAK, pk));
          arm();
          return;
        }
        const vals = decodePacket(raw, bits);
        for (const v of vals) { if (filled < length) out[filled++] = v; }
        expected++;
        this.t.send(handshake(this.dev, SUB.ACK, pk));
        onProgress?.(filled / length);
        if (filled >= length) { off(); clearTimeout(timer); resolve(); } else arm();
      });
      this.t.send(handshake(this.dev, SUB.ACK, 0)); // accept the header
      arm();
    });

    return {
      samples: out.subarray(0, filled), sampleRate: rateFromPeriod(periodNs), bits,
      loopStart, loopEnd, loop: loopType !== 0x7f,
    };
  }
}

/** Seconds needed to transfer `n` 16-bit samples over MIDI (approximate). */
export function sdsTransferSeconds(n) { return (Math.ceil(n / 40) * 127 * 10) / 31250; }
