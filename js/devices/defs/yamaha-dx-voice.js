// Yamaha 6-operator FM voice (DX7, TX7, DX7II, DX7s, TX802, TX816, DX5, DX1): the voice edit buffer
// (VCED, 155 bytes, plus the operator on/off byte the edit buffer keeps at 155), the packed 128-byte
// memory format (VMEM), the 32 algorithms, value displays and the parameter list. Model configs give
// the labels and value texts of their own firmware (yamaha-dx7-fw.js...); see docs/devices/yamaha-dx7.md.
//
// VCED (parameter numbers of group 0 = byte offsets): operators are stored OP6 first, 21 bytes each:
//   0-3 EG RATE 1-4   4-7 EG LEVEL 1-4   8 BREAK POINT   9 L SCALE DEPTH  10 R SCALE DEPTH
//   11 L KEY SCALE (curve)   12 R KEY SCALE   13 RATE SCALING   14 A MOD SENS.   15 KEY VELOCITY
//   16 OUTPUT LEVEL   17 OSC MODE   18 F COARSE   19 F FINE   20 OSC DETUNE
// 126-129 P EG RATE 1-4, 130-133 P EG LEVEL 1-4, 134 ALGORITHM, 135 FEEDBACK, 136 OSC KEY SYNC,
// 137 LFO SPEED, 138 LFO DELAY, 139 LFO PM DEPTH, 140 LFO AM DEPTH, 141 LFO KEY SYNC, 142 LFO WAVE,
// 143 P MOD SENS., 144 transpose (MIDDLE C), 145-154 name, 155 operator on/off (bit 5 = OP1 .. bit 0 = OP6).

export const VCED_SIZE = 155;
export const VOICE_SIZE = 156;
export const VMEM_SIZE = 128;
export const OP_SIZE = 21;
export const NAME = 145;
export const OPON = 155;
/** VCED offset of operator `op` (1-6). */
export const opBase = (op) => (6 - op) * OP_SIZE;

// ------------------------------------------------------------------ algorithms
// The 32 algorithms as Yamaha prints them: "a>b" = operator a modulates b, carriers, and the
// feedback loop (from>to: the output of `from` is fed back into the input of `to`).
const ALG_TEXT = [
  '6>5 5>4 4>3 2>1 | 1 3 | 6>6', '6>5 5>4 4>3 2>1 | 1 3 | 2>2', '6>5 5>4 3>2 2>1 | 1 4 | 6>6', '6>5 5>4 3>2 2>1 | 1 4 | 4>6',
  '6>5 4>3 2>1 | 1 3 5 | 6>6', '6>5 4>3 2>1 | 1 3 5 | 5>6', '6>5 5>3 4>3 2>1 | 1 3 | 6>6', '6>5 5>3 4>3 2>1 | 1 3 | 4>4',
  '6>5 5>3 4>3 2>1 | 1 3 | 2>2', '6>4 5>4 3>2 2>1 | 1 4 | 3>3', '6>4 5>4 3>2 2>1 | 1 4 | 6>6', '6>3 5>3 4>3 2>1 | 1 3 | 2>2',
  '6>3 5>3 4>3 2>1 | 1 3 | 6>6', '6>4 5>4 4>3 2>1 | 1 3 | 6>6', '6>4 5>4 4>3 2>1 | 1 3 | 2>2', '6>5 5>1 4>3 3>1 2>1 | 1 | 6>6',
  '6>5 5>1 4>3 3>1 2>1 | 1 | 2>2', '6>5 5>4 4>1 3>1 2>1 | 1 | 3>3', '6>5 6>4 3>2 2>1 | 1 4 5 | 6>6', '6>4 5>4 3>2 3>1 | 1 2 4 | 3>3',
  '6>5 6>4 3>2 3>1 | 1 2 4 5 | 3>3', '6>5 6>4 6>3 2>1 | 1 3 4 5 | 6>6', '6>5 6>4 3>2 | 1 2 4 5 | 6>6', '6>5 6>4 6>3 | 1 2 3 4 5 | 6>6',
  '6>5 6>4 | 1 2 3 4 5 | 6>6', '6>4 5>4 3>2 | 1 2 4 | 6>6', '6>4 5>4 3>2 | 1 2 4 | 3>3', '5>4 4>3 2>1 | 1 3 6 | 5>5',
  '6>5 4>3 | 1 2 3 5 | 6>6', '5>4 4>3 | 1 2 3 6 | 5>5', '6>5 | 1 2 3 4 5 | 6>6', ' | 1 2 3 4 5 6 | 6>6',
];
const parseAlg = (s) => {
  const [m, c, f] = s.split('|').map((x) => x.trim());
  const pair = (t) => t.split('>').map(Number);
  return { mods: m ? m.split(/\s+/).map(pair) : [], carriers: c.split(/\s+/).map(Number), fb: pair(f), ops: 6 };
};
/** ALGORITHMS[n] (n = 0-31 for algorithm 1-32): {mods: [[from, to]], carriers, fb: [from, to], ops}. */
export const ALGORITHMS = ALG_TEXT.map(parseAlg);

// ------------------------------------------------------------------ packed memory format (VMEM)
// Per operator (OP6 first, 17 bytes): R1-R4 L1-L4 BP LD RD, then RC<<2|LC, PD<<3|RS, KVS<<2|AMS,
// TL, PC<<1|PM, PF. Then 102-105 P EG rates, 106-109 levels, 110 ALG, 111 OKS<<3|FB, 112 LFS,
// 113 LFD, 114 PMD, 115 AMD, 116 PMS<<4|WAVE<<1|LFO SYNC, 117 transpose, 118-127 name.
export function vcedToVmem(v) {
  const m = new Uint8Array(VMEM_SIZE);
  for (let k = 0; k < 6; k++) {
    const s = k * OP_SIZE;
    const d = k * 17;
    for (let i = 0; i < 11; i++) m[d + i] = v[s + i] & 0x7f;
    m[d + 11] = ((v[s + 12] & 3) << 2) | (v[s + 11] & 3);
    m[d + 12] = ((v[s + 20] & 15) << 3) | (v[s + 13] & 7);
    m[d + 13] = ((v[s + 15] & 7) << 2) | (v[s + 14] & 3);
    m[d + 14] = v[s + 16] & 0x7f;
    m[d + 15] = ((v[s + 18] & 31) << 1) | (v[s + 17] & 1);
    m[d + 16] = v[s + 19] & 0x7f;
  }
  for (let i = 0; i < 8; i++) m[102 + i] = v[126 + i] & 0x7f;
  m[110] = v[134] & 31;
  m[111] = ((v[136] & 1) << 3) | (v[135] & 7);
  for (let i = 0; i < 4; i++) m[112 + i] = v[137 + i] & 0x7f;
  m[116] = ((v[143] & 7) << 4) | ((v[142] & 7) << 1) | (v[141] & 1);
  m[117] = v[144] & 0x7f;
  for (let i = 0; i < 10; i++) m[118 + i] = v[NAME + i] & 0x7f;
  return m;
}

/** VMEM (128 bytes) -> voice edit data (156 bytes, all operators on). */
export function vmemToVced(m) {
  const v = new Uint8Array(VOICE_SIZE);
  for (let k = 0; k < 6; k++) {
    const s = k * OP_SIZE;
    const d = k * 17;
    for (let i = 0; i < 11; i++) v[s + i] = m[d + i] & 0x7f;
    v[s + 11] = m[d + 11] & 3;
    v[s + 12] = (m[d + 11] >> 2) & 3;
    v[s + 13] = m[d + 12] & 7;
    v[s + 20] = (m[d + 12] >> 3) & 15;
    v[s + 14] = m[d + 13] & 3;
    v[s + 15] = (m[d + 13] >> 2) & 7;
    v[s + 16] = m[d + 14] & 0x7f;
    v[s + 17] = m[d + 15] & 1;
    v[s + 18] = (m[d + 15] >> 1) & 31;
    v[s + 19] = m[d + 16] & 0x7f;
  }
  for (let i = 0; i < 8; i++) v[126 + i] = m[102 + i] & 0x7f;
  v[134] = m[110] & 31;
  v[135] = m[111] & 7;
  v[136] = (m[111] >> 3) & 1;
  for (let i = 0; i < 4; i++) v[137 + i] = m[112 + i] & 0x7f;
  v[141] = m[116] & 1;
  v[142] = (m[116] >> 1) & 7;
  v[143] = (m[116] >> 4) & 7;
  v[144] = m[117] & 0x7f;
  for (let i = 0; i < 10; i++) v[NAME + i] = m[118 + i] & 0x7f;
  v[OPON] = 0x3f;
  return v;
}

/** Voices of a 32-voice bank (4096 bytes) as edit data. */
export const bankVoices = (bank) => Array.from({ length: Math.floor(bank.length / VMEM_SIZE) }, (_, i) => vmemToVced(bank.subarray(i * VMEM_SIZE, (i + 1) * VMEM_SIZE)));
/** Text of `n` characters at `at` (control codes as spaces, trailing spaces removed). */
export const textAt = (d, at, n = 10) => String.fromCharCode(...Array.from(d.subarray(at, at + n), (c) => (c >= 32 && c < 127 ? c : 32))).replace(/\s+$/, '');
export const voiceName = (v) => textAt(v, NAME);
export const vmemName = (m) => textAt(m, 118);
export function setVoiceName(v, name, at = NAME) {
  for (let i = 0; i < 10; i++) v[at + i] = Math.max(32, Math.min(126, String(name ?? '').charCodeAt(i) || 32));
  return v;
}

// ------------------------------------------------------------------ value displays
// fw: {CURVES, WAVES, OFFON, OSC_MODES, NOTES, DETUNE, FIXED, TRANSPOSE (optional: 49 texts)} texts of the model's firmware.
const pad2 = (n) => String(n).padStart(2, '0');
/** The DX7's frequency display (routine F145 of the v1.8 firmware): ratio or fixed frequency. */
export function freqText(fw, mode, coarse, fine) {
  coarse &= 31;
  fine = fine > 99 ? 0 : fine;
  if (!mode) {
    const x = coarse === 0 ? 50 + (fine >> 1) : coarse * (100 + fine);
    return `${Math.floor(x / 100)}.${pad2(x % 100)}`;
  }
  const digits = String(fw.FIXED[fine]).padStart(4, '0');
  const p = (coarse & 3) + 1;
  return p >= 4 ? `${digits} Hz` : `${digits.slice(0, p)}.${digits.slice(p)}Hz`;
}
/** The frequency as a number: ratio, or Hz in fixed mode (exact, not the display's rounding). */
export function freqValue(mode, coarse, fine) {
  if (!mode) return (coarse === 0 ? 0.5 : coarse) * (1 + fine / 100);
  return 10 ** ((coarse & 3) + fine / 100);
}
/** Key names as the DX7 shows them: break point 0 = A-1 .. 99 = C8 (key 21-120). */
export const bpText = (fw, v) => `${fw.NOTES[(v + 9) % 12].trim()}${Math.floor((v + 9) / 12) - 1}`;
/** MIDDLE C = (transpose 0-48): 24 = C3. */
export const transposeText = (fw, v) => `${fw.NOTES[v % 12].trim()}${Math.floor(v / 12) + 1}`;

// ------------------------------------------------------------------ parameters
const opts = (list) => list.map((t, i) => [i, t]);
const DEFAULT_LABELS = {
  r: 'EG RATE', l: 'EG LEVEL', bp: 'BREAK POINT', ld: 'L SCALE DEPTH', rd: 'R SCALE DEPTH', lc: 'L KEY SCALE', rc: 'R KEY SCALE',
  rs: 'RATE SCALING', ams: 'A MOD SENS.', kvs: 'KEY VELOCITY', tl: 'OUTPUT LEVEL', pm: 'OSC MODE', pc: 'F COARSE', pf: 'F FINE', pd: 'OSC DETUNE',
  pr: 'P EG RATE', pl: 'P EG LEVEL', als: 'ALGORITHM', fbl: 'FEEDBACK', opi: 'OSC KEY SYNC', lfs: 'LFO SPEED', lfd: 'LFO DELAY',
  lpmd: 'LFO PM DEPTH', lamd: 'LFO AM DEPTH', lfks: 'LFO KEY SYNC', lfw: 'LFO WAVE', lpms: 'P MOD SENS.', trnp: 'MIDDLE C', opon: 'OP ON/OFF',
};

/**
 * Parameters of the 156-byte voice edit data. M: {fw (value texts), labels ({field: text}), help ({field: text}),
 * base (offset of the voice in the object, default 0), section (prefix for section keys, default ''), keyPrefix}.
 * Sections: `${section}voice`, `${section}op1` .. `${section}op6`.
 */
export function voiceParams(M) {
  const fw = M.fw;
  const L = { ...DEFAULT_LABELS, ...(M.labels || {}) };
  const H = M.help || {};
  const base = M.base || 0;
  const sec = M.section || '';
  const kp = M.keyPrefix || '';
  const stage = M.stage || ((t, n) => `${t} ${n}`); // 'EG RATE 1' (DX7), 'R1' (DX7II)
  const ps = [];
  // help texts are keyed by field: 'pc', 'r', 'trnp'... (the key without operator and stage)
  const field = (key) => key.replace(/^op\d_/, '').replace(/\d+$/, '');
  const add = (key, label, offset, max, group, section, extra = {}) => {
    const help = H[field(key)];
    ps.push({ key: kp + key, label, offset: base + offset, min: 0, max, group, section: sec + section, vced: offset, ...(help ? { help } : {}), ...extra });
  };
  const OFFON = opts(fw.OFFON);
  for (let op = 1; op <= 6; op++) {
    const b = opBase(op);
    const s = `op${op}`;
    const k = (f) => `op${op}_${f}`;
    const freq = (data) => ({ mode: data[base + b + 17] & 1, coarse: data[base + b + 18], fine: data[base + b + 19] });
    add(k('pm'), L.pm, b + 17, 1, `OP${op} Oscillator`, s, { options: opts(fw.OSC_MODES), relayout: true });
    add(k('pc'), L.pc, b + 18, 31, `OP${op} Oscillator`, s, { dynamic: (d) => { const f = freq(d); return { options: Array.from({ length: 32 }, (_, v) => [v, freqText(fw, f.mode, v, f.fine)]) }; } });
    add(k('pf'), L.pf, b + 19, 99, `OP${op} Oscillator`, s, { dynamic: (d) => { const f = freq(d); return { format: (v) => freqText(fw, f.mode, f.coarse, v) }; } });
    add(k('pd'), L.pd, b + 20, 14, `OP${op} Oscillator`, s, { format: (v) => (fw.DETUNE[v] ?? String(v - 7)).trim() });
    for (let i = 0; i < 4; i++) add(k(`r${i + 1}`), stage(L.r, i + 1), b + i, 99, `OP${op} EG`, s);
    for (let i = 0; i < 4; i++) add(k(`l${i + 1}`), stage(L.l, i + 1), b + 4 + i, 99, `OP${op} EG`, s);
    add(k('bp'), L.bp, b + 8, 99, `OP${op} Keyboard level scaling`, s, { options: Array.from({ length: 100 }, (_, v) => [v, bpText(fw, v)]) });
    add(k('lc'), L.lc, b + 11, 3, `OP${op} Keyboard level scaling`, s, { options: opts(fw.CURVES) });
    add(k('ld'), L.ld, b + 9, 99, `OP${op} Keyboard level scaling`, s);
    add(k('rc'), L.rc, b + 12, 3, `OP${op} Keyboard level scaling`, s, { options: opts(fw.CURVES) });
    add(k('rd'), L.rd, b + 10, 99, `OP${op} Keyboard level scaling`, s);
    add(k('rs'), L.rs, b + 13, 7, `OP${op} Output and sensitivity`, s);
    add(k('tl'), L.tl, b + 16, 99, `OP${op} Output and sensitivity`, s);
    add(k('kvs'), L.kvs, b + 15, 7, `OP${op} Output and sensitivity`, s);
    add(k('ams'), L.ams, b + 14, 3, `OP${op} Output and sensitivity`, s);
  }
  for (let op = 1; op <= 6; op++) {
    add(`op${op}_on`, `OP${op}`, OPON, 1, 'Algorithm', 'voice', { shift: 6 - op, bits: 1, options: OFFON, help: `${L.opon}: operator ${op} on or muted (edit buffer only; not stored with the voice).` });
  }
  add('als', L.als, 134, 31, 'Algorithm', 'voice', { options: Array.from({ length: 32 }, (_, v) => [v, String(v + 1)]) });
  add('fbl', L.fbl, 135, 7, 'Algorithm', 'voice');
  add('opi', L.opi, 136, 1, 'Algorithm', 'voice', { options: OFFON });
  add('lfw', L.lfw, 142, 5, 'LFO', 'voice', { options: opts(fw.WAVES) });
  add('lfs', L.lfs, 137, 99, 'LFO', 'voice');
  add('lfd', L.lfd, 138, 99, 'LFO', 'voice');
  add('lpmd', L.lpmd, 139, 99, 'LFO', 'voice');
  add('lamd', L.lamd, 140, 99, 'LFO', 'voice');
  add('lfks', L.lfks, 141, 1, 'LFO', 'voice', { options: OFFON });
  add('lpms', L.lpms, 143, 7, 'LFO', 'voice');
  for (let i = 0; i < 4; i++) add(`pr${i + 1}`, stage(L.pr, i + 1), 126 + i, 99, 'Pitch EG', 'voice');
  for (let i = 0; i < 4; i++) add(`pl${i + 1}`, stage(L.pl, i + 1), 130 + i, 99, 'Pitch EG', 'voice');
  add('trnp', L.trnp, 144, 48, 'Voice', 'voice', { options: Array.from({ length: 49 }, (_, v) => [v, fw.TRANSPOSE?.[v] ?? transposeText(fw, v)]), help: H.trnp || 'Key transpose: the note middle C plays (C3 = no transpose).' });
  for (let i = 0; i < 10; i++) add(`name${i + 1}`, `Name character ${i + 1}`, NAME + i, 127, 'Voice', 'voice', { hidden: true });
  return ps;
}

export const voiceSections = (sec = '') => [{ key: `${sec}voice`, label: 'Voice' }, ...Array.from({ length: 6 }, (_, i) => ({ key: `${sec}op${i + 1}`, label: `OP${i + 1}` }))];

/** The firmware's VOICE INIT (packed) as edit data. */
export const initVoice = (packed) => vmemToVced(Uint8Array.from(packed));
/** A bank of 32 copies of the init voice. */
export function initBank(packed) {
  const b = new Uint8Array(32 * VMEM_SIZE);
  for (let i = 0; i < 32; i++) b.set(packed, i * VMEM_SIZE);
  return b;
}

// ------------------------------------------------------------------ EG times (for graphs and the shared model)
// Approximate: the DX EG's time for a segment roughly halves every 6 rate steps (rate 99 is
// immediate, rate 0 takes tens of seconds over the full level range). Only used to draw and to
// translate; the editor never sends it.
export const egSeconds = (rate, from, to) => {
  const span = Math.abs(to - from) / 99;
  if (span === 0) return 0;
  return Math.max(0.002, 40 * 2 ** (-rate / 6.2) * (0.25 + 0.75 * span));
};
export const egSecondsToRate = (sec, from, to) => {
  const span = Math.max(1 / 99, Math.abs(to - from) / 99);
  const r = -6.2 * Math.log2(Math.max(1e-4, sec) / (40 * (0.25 + 0.75 * span)));
  return Math.max(0, Math.min(99, Math.round(r)));
};
