// WAV parsing (PCM 8/16/24/32-bit and float32, any channel count) and
// 16-bit WAV writing with an optional 'smpl' loop chunk.

export function parseWav(buffer) {
  const v = new DataView(buffer);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let fmt = null;
  let data = null;
  let loop = null;
  let vp = null; // Roland V-Synth sample settings (vpsc / vpno chunks)
  let p = 12;
  while (p + 8 <= v.byteLength) {
    const id = tag(p);
    const size = v.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true), channels: v.getUint16(body + 2, true),
        rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = v.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, v.byteLength - body) };
    } else if (id === 'smpl' && size >= 60 && v.getUint32(body + 28, true) > 0) {
      loop = { start: v.getUint32(body + 36 + 8, true), end: v.getUint32(body + 36 + 12, true) };
    } else if (id === 'vpsc' && size >= 32) {
      vp = { ...vp, ...vsynthSettings(v, body) };
    } else if (id === 'vpno' && size >= 8) {
      vp = { ...vp, events: v.getUint32(body + 4, true) };
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV file has no fmt or data chunk');
  const { channels, bits, format } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.size / (bytes * channels));
  const chans = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const o = data.offset + (f * channels + c) * bytes;
      let s;
      if (format === 3 && bits === 32) s = v.getFloat32(o, true);
      else if (bits === 8) s = (v.getUint8(o) - 128) / 128;
      else if (bits === 16) s = v.getInt16(o, true) / 32768;
      else if (bits === 24) s = ((v.getUint8(o + 2) << 24) | (v.getUint8(o + 1) << 16) | (v.getUint8(o) << 8)) / 2147483648;
      else if (bits === 32) s = v.getInt32(o, true) / 2147483648;
      else throw new Error(`Unsupported WAV bit depth ${bits}`);
      chans[c][f] = s;
    }
  }
  return { sampleRate: fmt.rate, channels: chans, frames, loop, ...(vp ? { vsynth: vp } : {}) };
}

/**
 * The V-Synth's sample settings (chunk "vpsc", 8 x 32-bit LE), as far as they are known: word 0
 * bytes = 0Bh Variphrase-encoded / 0Ah not, the encode type (1, 3, 5: "A01".."A05" in the "rdmd"
 * chunk's text), 0 mono / 1 stereo; word 1 the sample frames; word 2 byte 2 the original key;
 * words 4 and 5 start and end in 1/16 samples; word 7 the tempo x 10000. Checked on 35 samples
 * against their names (tempos) and the "rdmd" text ("A01_MO_63_110_44000": type, mono, key 63).
 */
function vsynthSettings(v, o) {
  const w = (k) => v.getUint32(o + 4 * k, true);
  return {
    encoded: (w(0) & 0xff) === 0x0b, encodeType: (w(0) >> 8) & 0xff, stereo: ((w(0) >> 16) & 0xff) === 1,
    frames: w(1), originalKey: (w(2) >> 16) & 0xff, start: w(4) / 16, end: w(5) / 16, tempo: w(7) / 10000,
  };
}

export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  return out;
}

export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Write 16-bit PCM WAV. `channels` is an array of Int16Array. */
export function writeWav(channels, sampleRate, loop = null) {
  const n = channels[0].length;
  const ch = channels.length;
  const dataSize = n * ch * 2;
  const smplSize = loop ? 60 : 0;
  const total = 12 + 24 + 8 + dataSize + (loop ? 8 + smplSize : 0);
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  const put = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); v.setUint32(4, total - 8, true); put(8, 'WAVE');
  put(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  put(36, 'data'); v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { v.setInt16(o, channels[c][i], true); o += 2; }
  if (loop) {
    put(o, 'smpl'); v.setUint32(o + 4, smplSize, true);
    const b = o + 8;
    v.setUint32(b + 8, Math.round(1e9 / sampleRate), true);
    v.setUint32(b + 12, 60, true);
    v.setUint32(b + 28, 1, true);
    v.setUint32(b + 36 + 8, loop.start, true);
    v.setUint32(b + 36 + 12, loop.end, true);
  }
  return buf;
}

/** Simple linear resampler for converting to rates the K2000 handles well. */
export function resampleLinear(f32, fromRate, toRate) {
  if (fromRate === toRate) return f32;
  const ratio = fromRate / toRate;
  const n = Math.floor(f32.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const k = Math.floor(x);
    const fr = x - k;
    out[i] = f32[k] * (1 - fr) + (f32[Math.min(k + 1, f32.length - 1)] * fr);
  }
  return out;
}
