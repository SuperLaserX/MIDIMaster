// Yamaha 4-operator FM family (DX21, DX27, DX100, DX11, TX81Z): voice format, algorithms, parameters
// and the definition builder buildDX4(M). Model configs: yamaha-dx21.js, yamaha-dx100.js,
// yamaha-dx11.js, yamaha-tx81z.js; docs/devices/yamaha-tx81z.md (the family's notes).
//
// VCED (format 3, 93 bytes; parameter change group 4 + 2 = 12h): operators stored OP4, OP2, OP3, OP1,
// 13 bytes each: AR D1R D2R RR D1L LS RS EBS AME KVS OUT CRS DET; then 52 ALG, 53 FBL, 54 LFO speed,
// 55 delay, 56 PMD, 57 AMD, 58 sync, 59 wave, 60 PMS, 61 AMS, 62 transpose, 63 poly/mono, 64 PB range,
// 65 portamento mode, 66 portamento time, 67 FC volume, 68 sustain, 69 portamento foot switch,
// 70 chorus, 71-72 MW pitch/amplitude, 73-76 BC pitch/amplitude/pitch bias/EG bias, 77-86 name,
// 87-92 pitch EG rates 1-3 and levels 1-3 (DX21). Checked with the INIT VOICE of the DX21 v1.5 firmware
// (3CB6, stored in this form) and the maximum table of the TX81Z / DX11 / DX100 firmware (05F1...).
// ACED (TX81Z / DX11, "LM  8976AE", 23 bytes; group 4 + 3 = 13h): per operator (OP4, OP2, OP3, OP1)
// FIX, FIX range, FINE, wave (OSW), EG shift; then reverb rate, FC pitch, FC amplitude.
// VMEM (format 4, 32 x 128): per operator 10 bytes (AR D1R D2R RR D1L LS, AME<<6|EBS<<3|KVS, OUT, CRS,
// RS<<3|DET), 40 SY<<6|FBL<<3|ALG, 41-44 LFO, 45 PMS<<4|AMS<<2|WAVE, 46 transpose, 47 PB range,
// 48 CH<<4|MO<<3|SU<<2|PO<<1|PM, 49-56 portamento time .. BC EG bias, 57-66 name, 67-72 pitch EG,
// 73-80 per operator SHFT<<4|FIX<<3|FIXRG and OSW<<4|FINE (packing routine 8431 of the TX81Z firmware),
// 81 reverb rate, 82-83 FC pitch/amplitude. Checked with the presets and init voices of the firmware.

import { h, toast } from '../../core/ui/dom.js';
import { bulk, bulkHeader, parseBulk, paramChange, parseParamChange, dumpRequest, dumpRequestHeader, isYamaha, isRequest } from './yamaha-dx-sysex.js';
import { algorithmCard, algorithmGallery, scalingGraph } from './yamaha-dx-draw.js';
import { svg } from '../../core/ui/dom.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import { COMMON_MODEL, emptyReport } from '../../core/mainlib/common.js';
import { tidy } from './translate-helpers.js';
import { textAt, freqValue, ALGORITHMS } from './yamaha-dx-voice.js';

export const VCED4 = 93;
export const ACED4 = 23;
export const VMEM4 = 128;
const ORDER = [4, 2, 3, 1]; // operators in the data
export const opBase4 = (op) => ORDER.indexOf(op) * 13;
export const acedBase4 = (op) => ORDER.indexOf(op) * 5;
export const NAME4 = 77;

// The eight algorithms (Yamaha's 4-operator charts; feedback on OP4).
export const ALGORITHMS4 = [
  '4>3 3>2 2>1 | 1', '4>2 3>2 2>1 | 1', '4>1 3>2 2>1 | 1', '4>3 3>1 2>1 | 1', '4>3 2>1 | 1 3', '4>3 4>2 4>1 | 1 2 3', '4>3 | 1 2 3', ' | 1 2 3 4',
].map((s) => {
  const [m, c] = s.split('|').map((x) => x.trim());
  return { mods: m ? m.split(/\s+/).map((p) => p.split('>').map(Number)) : [], carriers: c.split(/\s+/).map(Number), fb: [4, 4], ops: 4 };
});

/** Coarse frequency ratios (CRS 0-63) of the DX21 v1.5 firmware (table at 7587, x100). */
export const RATIOS = [50, 71, 78, 87, 100, 141, 157, 173, 200, 282, 300, 314, 346, 400, 424, 471, 500, 519, 565, 600, 628, 692, 700, 707, 785, 800, 848, 865, 900, 942, 989, 1000, 1038, 1099, 1100, 1130, 1200, 1211, 1256, 1272, 1300, 1384, 1400, 1410, 1413, 1500, 1555, 1557, 1570, 1696, 1727, 1730, 1837, 1884, 1903, 1978, 2041, 2076, 2120, 2198, 2249, 2355, 2422, 2595];
export const ratioText = (crs) => { const r = RATIOS[crs & 63]; return `${Math.floor(r / 100)}.${String(r % 100).padStart(2, '0')}`; };

// The TX81Z's own frequency display (lower bank A1E0, the DX11's copy at 3600): CRS picks a byte of
// table B4EA, whose bits 0-1 choose a multiplier (A2A8: 1, sqrt 2, pi/2, sqrt 3 as 100, 141, 157, 173)
// and bits 2-5 a step n; the ratio is (16 n + FIN) x multiplier / 16 (n = 0: 8 + FIN), with the
// firmware's roundings for sqrt 2 and 0.71 / 0.87. FIX: ((CRS & 3Ch) x 4 or 8) + FIN, shifted left by
// the fix range, in Hz. Fix range texts from A494. With FIN 0 the ratios are the DX21's table above.
export const CRS_STEP = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0c, 0x0a, 0x0b, 0x10, 0x0d, 0x0e, 0x14, 0x0f, 0x11, 0x18, 0x12, 0x13, 0x1c, 0x15, 0x16, 0x20, 0x19, 0x17, 0x24, 0x1a, 0x1d, 0x28,
  0x1b, 0x1e, 0x2c, 0x21, 0x30, 0x1f, 0x22, 0x25, 0x34, 0x23, 0x38, 0x29, 0x26, 0x3c, 0x2d, 0x27, 0x2a, 0x31, 0x2e, 0x2b, 0x35, 0x32, 0x2f, 0x39, 0x36, 0x33, 0x3d, 0x3a, 0x37, 0x3e, 0x3b, 0x3f,
];
const MULT = [100, 141, 157, 173];
/** RATIO mode: the ratio x 100 the TX81Z shows for CRS and FIN. */
export function ratio4(crs, fin) {
  const t = CRS_STEP[crs & 63];
  const m = MULT[t & 3];
  const a = ((t & 0x3c) ? (t & 0x3c) << 2 : 8) + (fin & 15);
  let d = a * m;
  if (m === 141 && !(fin & 15) && a >= 0x30) d += a < 0x50 ? 0x10 : a < 0x90 ? 0x20 : a === 0x90 ? 0x30 : a < 0xb0 ? 0 : a < 0xf0 ? 0x40 : 0x50;
  let x = d >> 4;
  if (x === 0x46 || x === 0x56) x += 1;
  return x;
}
export const ratio4Text = (crs, fin) => { const x = ratio4(crs, fin); return `${Math.floor(x / 100)}.${String(x % 100).padStart(2, '0')}`; };
/** FIX mode: the frequency in Hz. */
export const fixHz = (crs, fin, range) => (((crs & 0x3c) ? (crs & 0x3c) << 2 : 8) + (fin & 15)) << (range & 7);
export const FIX_RANGES = ['255Hz', '510Hz', '1KHz', '2KHz', '4KHz', '8KHz', '16KHz', '32KHz'];

// ------------------------------------------------------------------ packed memory
/** VCED (93) + ACED (23) -> VMEM (128). */
export function packVoice4(v, a = new Uint8Array(ACED4)) {
  const m = new Uint8Array(VMEM4);
  for (let k = 0; k < 4; k++) {
    const s = k * 13;
    const d = k * 10;
    for (let i = 0; i < 6; i++) m[d + i] = v[s + i] & 0x7f;
    m[d + 6] = ((v[s + 8] & 1) << 6) | ((v[s + 7] & 7) << 3) | (v[s + 9] & 7);
    m[d + 7] = v[s + 10] & 0x7f;
    m[d + 8] = v[s + 11] & 0x3f;
    m[d + 9] = ((v[s + 6] & 3) << 3) | (v[s + 12] & 7);
    const t = k * 5;
    m[73 + k * 2] = ((a[t + 4] & 3) << 4) | ((a[t] & 1) << 3) | (a[t + 1] & 7);
    m[74 + k * 2] = ((a[t + 3] & 7) << 4) | (a[t + 2] & 15);
  }
  m[40] = ((v[58] & 1) << 6) | ((v[53] & 7) << 3) | (v[52] & 7);
  for (let i = 0; i < 4; i++) m[41 + i] = v[54 + i] & 0x7f;
  m[45] = ((v[60] & 7) << 4) | ((v[61] & 3) << 2) | (v[59] & 3);
  m[46] = v[62] & 0x7f;
  m[47] = v[64] & 0x7f;
  m[48] = ((v[70] & 1) << 4) | ((v[63] & 1) << 3) | ((v[68] & 1) << 2) | ((v[69] & 1) << 1) | (v[65] & 1);
  m[49] = v[66] & 0x7f; m[50] = v[67] & 0x7f;
  for (let i = 0; i < 6; i++) m[51 + i] = v[71 + i] & 0x7f;
  for (let i = 0; i < 10; i++) m[57 + i] = v[NAME4 + i] & 0x7f;
  for (let i = 0; i < 6; i++) m[67 + i] = v[87 + i] & 0x7f;
  m[81] = a[20] & 7; m[82] = a[21] & 0x7f; m[83] = a[22] & 0x7f;
  return m;
}
/** VMEM (128) -> {vced (93), aced (23)}. */
export function unpackVoice4(m) {
  const v = new Uint8Array(VCED4);
  const a = new Uint8Array(ACED4);
  for (let k = 0; k < 4; k++) {
    const s = k * 13;
    const d = k * 10;
    for (let i = 0; i < 6; i++) v[s + i] = m[d + i] & 0x7f;
    v[s + 8] = (m[d + 6] >> 6) & 1; v[s + 7] = (m[d + 6] >> 3) & 7; v[s + 9] = m[d + 6] & 7;
    v[s + 10] = m[d + 7] & 0x7f; v[s + 11] = m[d + 8] & 0x3f;
    v[s + 6] = (m[d + 9] >> 3) & 3; v[s + 12] = m[d + 9] & 7;
    const t = k * 5;
    a[t + 4] = (m[73 + k * 2] >> 4) & 3; a[t] = (m[73 + k * 2] >> 3) & 1; a[t + 1] = m[73 + k * 2] & 7;
    a[t + 3] = (m[74 + k * 2] >> 4) & 7; a[t + 2] = m[74 + k * 2] & 15;
  }
  v[58] = (m[40] >> 6) & 1; v[53] = (m[40] >> 3) & 7; v[52] = m[40] & 7;
  for (let i = 0; i < 4; i++) v[54 + i] = m[41 + i] & 0x7f;
  v[60] = (m[45] >> 4) & 7; v[61] = (m[45] >> 2) & 3; v[59] = m[45] & 3;
  v[62] = m[46] & 0x7f; v[64] = m[47] & 0x7f;
  v[70] = (m[48] >> 4) & 1; v[63] = (m[48] >> 3) & 1; v[68] = (m[48] >> 2) & 1; v[69] = (m[48] >> 1) & 1; v[65] = m[48] & 1;
  v[66] = m[49] & 0x7f; v[67] = m[50] & 0x7f;
  for (let i = 0; i < 6; i++) v[71 + i] = m[51 + i] & 0x7f;
  for (let i = 0; i < 10; i++) v[NAME4 + i] = m[57 + i] & 0x7f;
  for (let i = 0; i < 6; i++) v[87 + i] = m[67 + i] & 0x7f;
  a[20] = m[81] & 7; a[21] = m[82] & 0x7f; a[22] = m[83] & 0x7f;
  return { vced: v, aced: a };
}
export const voiceName4 = (d) => textAt(d, NAME4);

// ------------------------------------------------------------------ parameters
const opts = (l) => l.map((t, i) => [i, t]);
/**
 * Parameters of the 4-op voice object (VCED at 0, ACED at 93 when M.aced). M.T: texts {OFFON, WAVES,
 * POLYMONO, PORTA, OSW, FIXMODE, NOTES, L: labels}; M.peg: the pitch EG is used; M.chorus: chorus used.
 */
export function voiceParams4(M) {
  const T = M.T;
  const L = T.L;
  const ps = [];
  const P = (key, label, offset, max, group, section, extra = {}) => ps.push({ key, label, offset, min: 0, max, group, section, ...extra });
  const unused = (what) => ({ help: `${what}: kept, not used by the ${M.name}.` });
  for (let op = 1; op <= 4; op++) {
    const b = opBase4(op);
    const s = `op${op}`;
    const g = (n) => `OP${op} ${n}`;
    const k = (f) => `op${op}_${f}`;
    const a = VCED4 + acedBase4(op);
    // With the additional data the labels and values are the TX81Z's screen: "CRS(RATIO)=1.06", "FIN(FIX)=  440Hz".
    const mode = (d) => (d[a] ? 'FIX' : 'RATIO');
    const freq = (d, crs, fin) => (d[a] ? `${fixHz(crs, fin, d[a + 1])}Hz` : ratio4Text(crs, fin));
    P(k('crs'), L.crs, b + 11, 63, g('Oscillator'), s, M.aced ? {
      relayout: true,
      dynamic: (d) => ({ label: `${L.crs}(${mode(d)})`, options: Array.from({ length: 64 }, (_, i) => [i, d[a] ? `${freq(d, i, d[a + 2])} (${i})` : freq(d, i, d[a + 2])]) }),
      help: 'Coarse frequency. RATIO: the ratio with FIN as the TX81Z shows it; FIX: the frequency in Hz (CRS in brackets; four CRS values share each step).',
    } : { dynamic: () => ({ options: Array.from({ length: 64 }, (_, i) => [i, ratioText(i)]) }) });
    P(k('det'), L.det, b + 12, 6, g('Oscillator'), s, { format: (v) => `${v > 3 ? '+' : ''}${v - 3}` });
    if (M.aced) {
      P(k('fix'), L.fix, a, 1, g('Oscillator'), s, { options: opts(T.FIXMODE), relayout: true });
      P(k('fixrg'), L.fixrg, a + 1, 7, g('Oscillator'), s, { options: opts(FIX_RANGES), relayout: true, help: 'Fixed frequency range (used with FIX): the highest frequency it reaches.' });
      P(k('fin'), L.fin, a + 2, 15, g('Oscillator'), s, {
        relayout: true,
        dynamic: (d) => ({ label: `${L.fin}(${mode(d)})`, options: Array.from({ length: 16 }, (_, i) => [i, freq(d, d[b + 11], i)]) }),
        help: 'Fine frequency 0-15 (accepted at every CRS: the receive check allows 15).',
      });
      P(k('osw'), L.osw, a + 3, 7, g('Oscillator'), s, { options: opts(T.OSW) });
      P(k('shft'), L.shft, a + 4, 3, g('EG'), s, { options: opts(T.SHFT) });
    }
    P(k('ar'), L.ar, b, 31, g('EG'), s);
    P(k('d1r'), L.d1r, b + 1, 31, g('EG'), s);
    P(k('d1l'), L.d1l, b + 4, 15, g('EG'), s);
    P(k('d2r'), L.d2r, b + 2, 31, g('EG'), s);
    P(k('rr'), L.rr, b + 3, 15, g('EG'), s, { min: 1 });
    P(k('out'), L.out, b + 10, 99, g('Output and sensitivity'), s);
    P(k('kvs'), L.kvs, b + 9, 7, g('Output and sensitivity'), s);
    P(k('ame'), L.ame, b + 8, 1, g('Output and sensitivity'), s, { options: opts(T.OFFON) });
    P(k('ebs'), L.ebs, b + 7, 7, g('Output and sensitivity'), s);
    P(k('ls'), L.ls, b + 5, 99, g('Scaling'), s);
    P(k('rs'), L.rs, b + 6, 3, g('Scaling'), s);
  }
  const V = 'voice';
  P('alg', L.alg, 52, 7, 'Algorithm', V, { options: Array.from({ length: 8 }, (_, i) => [i, String(i + 1)]) });
  P('fbl', L.fbl, 53, 7, 'Algorithm', V);
  P('lfw', L.lfw, 59, 3, 'LFO', V, { options: opts(T.WAVES) });
  P('lfs', L.lfs, 54, 99, 'LFO', V);
  P('lfd', L.lfd, 55, 99, 'LFO', V);
  P('pmd', L.pmd, 56, 99, 'LFO', V);
  P('amd', L.amd, 57, 99, 'LFO', V);
  P('sy', L.sy, 58, 1, 'LFO', V, { options: opts(T.OFFON) });
  P('pms', L.pms, 60, 7, 'LFO', V);
  P('ams', L.ams, 61, 3, 'LFO', V);
  P('trps', L.trps, 62, 48, 'Voice', V, { options: Array.from({ length: 49 }, (_, v) => [v, `${T.NOTES[v % 12]}${Math.floor(v / 12) + 1}`]) });
  P('mo', L.mo, 63, 1, 'Play mode', V, { options: opts(T.POLYMONO), relayout: true });
  P('pbr', L.pbr, 64, 12, 'Play mode', V);
  P('pm', L.pm, 65, 1, 'Play mode', V, { options: opts(T.PORTA), help: 'Portamento mode (mono: full time or fingered).' });
  P('port', L.port, 66, 99, 'Play mode', V);
  P('su', L.su, 68, 1, 'Play mode', V, { options: opts(T.OFFON), help: 'Sustain foot switch.' });
  P('po', L.po, 69, 1, 'Play mode', V, { options: opts(T.OFFON), help: 'Portamento foot switch.' });
  P('ch', L.ch, 70, 1, 'Play mode', V, { options: opts(T.OFFON), ...(M.chorus ? {} : unused('Chorus')) });
  P('fcvol', L.fcvol, 67, 99, 'Controllers', V);
  P('mwp', L.mwp, 71, 99, 'Controllers', V);
  P('mwa', L.mwa, 72, 99, 'Controllers', V);
  P('bcp', L.bcp, 73, 99, 'Controllers', V);
  P('bca', L.bca, 74, 99, 'Controllers', V);
  P('bcpb', L.bcpb, 75, M.bcpbMax ?? 100, 'Controllers', V, { format: M.bcpbFormat || ((v) => `${v > 50 ? '+' : ''}${v - 50}`), ...(M.bcpbHelp ? { help: M.bcpbHelp } : {}) });
  P('bceb', L.bceb, 76, 99, 'Controllers', V);
  for (let i = 0; i < 3; i++) P(`pr${i + 1}`, `${L.pr} ${i + 1}`, 87 + i, 99, 'Pitch EG', V, M.peg ? {} : unused('Pitch EG'));
  for (let i = 0; i < 3; i++) P(`pl${i + 1}`, `${L.pl} ${i + 1}`, 90 + i, 99, 'Pitch EG', V, M.peg ? {} : unused('Pitch EG'));
  for (let i = 0; i < 10; i++) P(`name${i + 1}`, `Name character ${i + 1}`, NAME4 + i, 127, 'Voice', V, { hidden: true });
  if (M.aced) {
    P('rev', L.rev, VCED4 + 20, 7, 'Voice', V, { help: 'Reverb rate: release time after key off (0 off).' });
    P('fcp', L.fcp, VCED4 + 21, 99, 'Controllers', V);
    P('fca', L.fca, VCED4 + 22, 99, 'Controllers', V);
  }
  return ps;
}

// ------------------------------------------------------------------ 4-op EG graph
/** Points of a 4-op EG: 0 -> top (AR), -> D1L (D1R), down while held (D2R), -> 0 (RR). */
export function eg4Shape({ ar, d1r, d1l, d2r, rr }, hold = 0.6) {
  const t = (rate, max) => (rate <= 0 ? 8 : 6 * 2 ** (-(rate / max) * 9));
  const sus = d1l / 15;
  const p = [{ t: 0, l: 0 }];
  let x = t(ar, 31) / 4;
  p.push({ t: x, l: 1 });
  x += t(d1r, 31) * (1 - sus);
  p.push({ t: x, l: sus });
  const fall = d2r ? Math.min(sus, hold / t(d2r, 31)) : 0;
  x += hold;
  p.push({ t: x, l: sus - fall, hold: true });
  x += t(rr * 2, 31) * (sus - fall);
  p.push({ t: x, l: 0 });
  return p;
}
function eg4Graph(e) {
  const pts = eg4Shape(e);
  const W = 300;
  const H = 80;
  const tw = (s) => Math.log1p(s / 0.02) * 12;
  let x = 6;
  const xs = pts.map((p, i) => (i ? (x += tw(p.t - pts[i - 1].t)) : x));
  const k = Math.min(1, (W - 12) / Math.max(1, xs[xs.length - 1] - 6));
  const X = (i) => 6 + (xs[i] - 6) * k;
  const Y = (l) => 6 + (1 - l) * (H - 12);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.l).toFixed(1)}`).join(' ');
  return h('div', svg('svg', { class: 'env-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', style: 'height:80px' },
    svg('path', { class: 'env-line', d: `${d} L${X(pts.length - 1)} ${H} L6 ${H} Z` }),
    svg('line', { class: 'env-axis', x1: X(3), x2: X(3), y1: 0, y2: H, 'stroke-dasharray': '2 3' })),
  h('div.small.muted.mono', `AR ${e.ar}  D1R ${e.d1r}  D1L ${e.d1l}  D2R ${e.d2r}  RR ${e.rr}  (shape only; dashed: key off)`));
}

// ------------------------------------------------------------------ the definition
export const BANK4_KEY = 'voice-bank';

/**
 * M: {id, name, T (texts), init: [VMEM 128] (the firmware's INIT VOICE, packed), aced (TX81Z/DX11),
 * peg, chorus, requests, coverage, notes, extend(def, tools), formats, recognise, libraryItem}
 */
export function buildDX4(M) {
  const SIZE = VCED4 + (M.aced ? ACED4 : 0);
  const init = () => { const u = unpackVoice4(Uint8Array.from(M.init)); const d = new Uint8Array(SIZE); d.set(u.vced); if (M.aced) d.set(u.aced, VCED4); return d; };
  const params = voiceParams4(M);
  const ch = (ctx) => ctx?.channel ?? 0;
  const isV = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 3 && b.data.length === VCED4); };
  const isB = (raw) => { const b = parseBulk(raw); return !!(b?.ok && b.format === 4 && b.data.length === 32 * VMEM4); };
  const isA = (raw) => { if (!M.aced) return false; const b = parseBulk(raw); return !!(b?.ok && b.header === 'LM  8976AE' && b.body.length === ACED4); };
  const full = (vced, aced) => { const d = init(); d.set(vced.subarray(0, VCED4)); if (M.aced && aced) d.set(aced.subarray(0, ACED4), VCED4); return d; };
  const fromMem = (m) => { const u = unpackVoice4(m); return full(u.vced, u.aced); };
  const voiceMsgs = (c, d) => [...(M.aced ? [bulkHeader(c, 'LM  8976AE', d.subarray(VCED4, SIZE))] : []), bulk(c, 3, d.subarray(0, VCED4))];
  const bankOf = (ctx) => ctx?.data?.[BANK4_KEY] || null;
  const bankLoaded = (ctx) => !!(bankOf(ctx) && ctx.loaded?.has?.(BANK4_KEY));
  const TR = dx4Translator({ model: M.name, init, aced: !!M.aced, size: SIZE });
  const req = async (api, bytes, match) => api.request(bytes, match, (r) => r);
  async function readVoice(api) {
    const a = M.aced ? await req(api, dumpRequestHeader(ch(api.ctx), 'LM  8976AE'), isA) : null;
    const v = await req(api, dumpRequest(ch(api.ctx), 3), isV);
    return full(parseBulk(v).data, a ? parseBulk(a).body : null);
  }
  async function readBank(api) {
    const raw = await req(api, dumpRequest(ch(api.ctx), 4), isB);
    api.g.objectData[BANK4_KEY] = Uint8Array.from(parseBulk(raw).data);
    api.g.loadedKeys?.add(BANK4_KEY);
    return api.g.objectData[BANK4_KEY];
  }

  const groupInfo = {
    Algorithm: {
      wide: true, note: 'The four operators and how they connect: carriers on the output line, the others modulate the operator below them; the accent loop is OP4\'s feedback.',
      draw: ({ data }) => algorithmCard({ algorithms: ALGORITHMS4, current: data[52] & 7, level: (op) => data[opBase4(op) + 10] / 99 }),
    },
  };
  for (let op = 1; op <= 4; op++) {
    const b = opBase4(op);
    groupInfo[`OP${op} EG`] = { draw: ({ data }) => eg4Graph({ ar: data[b], d1r: data[b + 1], d2r: data[b + 2], rr: data[b + 3], d1l: data[b + 4] }) };
  }
  const voiceObj = {
    key: 'voice', page: 'Voice', icon: '◆', label: 'Voice', size: SIZE, init, params, cols: 2,
    sections: [{ key: 'voice', label: 'Voice' }, ...[1, 2, 3, 4].map((i) => ({ key: `op${i}`, label: `OP${i}` }))],
    layout: [{ group: 'Algorithm', wide: true }, { group: 'LFO' }, { group: 'Play mode' }, { group: 'Controllers' }, { group: 'Pitch EG' }, { group: 'Voice' },
      ...[1, 2, 3, 4].flatMap((i) => ['Oscillator', 'EG', 'Output and sensitivity', 'Scaling'].map((g) => ({ group: `OP${i} ${g}` })))],
    groupInfo,
    // the Algorithm tab (after Voice): the eight algorithms as diagrams (views/gallery.js)
    galleries: [algorithmGallery({
      algorithms: ALGORITHMS4, param: 'alg', level: (d, op) => d[opBase4(op) + 10] / 99,
      note: 'The four operators and how they connect: carriers on the output line, the others modulate the operator below them; the accent loop is OP4\'s feedback. Shading: the voice\'s output levels.',
    })],
    name: voiceName4,
    setName: (d, n) => { for (let i = 0; i < 10; i++) d[NAME4 + i] = Math.max(32, Math.min(126, String(n ?? '').charCodeAt(i) || 32)); return d; },
    note: M.notes?.voice || null,
    sendParam: (p, _v, d, ctx) => (p.offset >= VCED4 ? paramChange(ch(ctx), 4, 0x180 + (p.offset - VCED4), d[p.offset]) : paramChange(ch(ctx), 4, 0x100 + p.offset, d[p.offset])),
    sendAll: { label: 'Send to edit buffer', title: M.aced ? 'Send the additional data ("LM  8976AE") and the voice (format 3)' : 'Send the voice (format 3)', build: (d, ctx) => voiceMsgs(ch(ctx), d) },
    toSyx: (d, ctx) => voiceMsgs(ch(ctx), d),
    fromSyx: (msgs) => {
      const v = msgs.find(isV);
      const a = msgs.find(isA);
      if (v) return full(parseBulk(v).data, a ? parseBulk(a).body : null);
      const b = msgs.find(isB);
      return b ? fromMem(parseBulk(b).data.subarray(0, VMEM4)) : null;
    },
    ...(M.requests ? { fetch: readVoice } : {}),
    receive: (raw, d, ctx) => {
      const b = parseBulk(raw);
      if (isV(raw)) { const n = Uint8Array.from(d); n.set(b.data); return n; }
      if (isA(raw)) { const n = Uint8Array.from(d); n.set(b.body, VCED4); return n; }
      const pc = parseParamChange(raw);
      if (pc && pc.group === 4 && pc.channel === ch(ctx)) {
        const n = Uint8Array.from(d);
        if (pc.num >= 0x100 && pc.num < 0x100 + VCED4) { n[pc.num - 0x100] = pc.value; return n; }
        if (M.aced && pc.num >= 0x180 && pc.num < 0x180 + ACED4) { n[VCED4 + pc.num - 0x180] = pc.value; return n; }
      }
      if (isB(raw) && ctx?.data) { ctx.data[BANK4_KEY] = Uint8Array.from(b.data); ctx.loaded?.add?.(BANK4_KEY); toast(`32 voices received from the ${M.name}`, 'good', 2000); return Uint8Array.from(d); }
      return null;
    },
    actions: [
      { label: 'Init', title: `The ${M.name}'s INIT VOICE`, run: (api) => api.setData(init()) },
      {
        label: 'Rename', run: async (api) => {
          const r = await api.form('Voice name', [{ key: 'name', label: 'Name (10 characters)', value: voiceName4(api.data), maxlength: 10 }]);
          if (!r) return;
          const d = voiceObj.setName(Uint8Array.from(api.data), r.name);
          api.send(Array.from({ length: 10 }, (_, i) => paramChange(ch(api.ctx), 4, 0x100 + NAME4 + i, d[NAME4 + i])));
          api.setData(d);
        },
      },
      ...(M.requests ? [{ label: 'Get 32 voices', title: 'Read the 32 internal voices (format 4)', run: async (api) => { await readBank(api); api.toast('32 voices received', 'good', 2000); api.setData(Uint8Array.from(api.data)); } }] : []),
      {
        label: 'Send bank', title: 'Send the editor\'s 32 voices (format 4): replaces every internal voice', run: async (api) => {
          const b = bankOf(api.ctx);
          if (!b) { api.toast('The editor holds no bank yet: Get 32 voices first.', 'warn'); return; }
          if (!(await api.confirm('Send bank', `Replace all 32 internal voices of the ${M.name}? (Memory protect off.)`, 'Send', true))) return;
          api.send(bulk(ch(api.ctx), 4, b));
        },
      },
    ],
    slots: {
      label: 'Internal voices', banks: [[0, 'INTERNAL 1-32']], count: 32, slotLabel: (_b, i) => String(i + 1).padStart(2, '0'),
      names: (_b, ctx) => { const b = bankOf(ctx); return b ? Array.from({ length: 32 }, (_, i) => textAt(b, i * VMEM4 + 57)) : null; },
      scannable: () => !!M.requests,
      scanBank: async (api, _bank, onName) => { const b = await readBank(api); for (let i = 0; i < 32; i++) onName(i, textAt(b, i * VMEM4 + 57)); },
      note: (_b, ctx) => (bankOf(ctx) ? 'Names and Edit come from the editor\'s copy of the 32 voices. Play sends a program change; Store puts the voice into the copy and sends all 32.' : 'No bank yet: Get 32 voices (or Read names). Play sends a program change.'),
      name: voiceName4,
      recall: (_b, i, ctx) => [0xc0 | ch(ctx), i],
      fetch: async (api, _b, i) => {
        let b = bankOf(api.ctx);
        if (!b && M.requests) b = await readBank(api);
        if (!b) throw new Error('The editor holds no bank yet.');
        return fromMem(b.subarray(i * VMEM4, (i + 1) * VMEM4));
      },
      writable: (_b, ctx) => bankLoaded(ctx),
      store: (_b, i, ctx, d) => { const b = bankOf(ctx); b.set(packVoice4(d.subarray(0, VCED4), M.aced ? d.subarray(VCED4, SIZE) : undefined), i * VMEM4); return [bulk(ch(ctx), 4, b)]; },
    },
    toCommon: (d) => TR.toCommon(d),
    fromCommon: (c, base) => TR.fromCommon(c, base),
  };

  function libraryItems(msgs) {
    const items = [];
    msgs.forEach((m, k) => {
      if (isA(m) && msgs[k + 1] && isV(msgs[k + 1])) return;
      if (isV(m)) {
        const a = k > 0 && isA(msgs[k - 1]) ? msgs[k - 1] : null;
        const d = full(parseBulk(m).data, a ? parseBulk(a).body : null);
        items.push({ key: `v${k}`, label: `Voice "${voiceName4(d)}"`, name: voiceName4(d), object: 'voice', data: d, msgs: a ? [a, m] : [m] });
      } else if (isB(m)) {
        const data = parseBulk(m).data;
        for (let i = 0; i < 32; i++) {
          const d = fromMem(data.subarray(i * VMEM4, (i + 1) * VMEM4));
          items.push({ key: `b${k}-${i}`, label: `${String(i + 1).padStart(2, '0')} ${voiceName4(d)}`, name: voiceName4(d), object: 'voice', data: d, msgs: voiceMsgs(parseBulk(m).channel, d).map((x) => Uint8Array.from(x)) });
        }
      } else {
        const more = M.libraryItem?.(m, k);
        items.push(...(more || [{ key: `m${k}`, label: `Message ${k + 1}`, name: '', msgs: [m] }]));
      }
    });
    return items;
  }

  const def = {
    coverage: M.coverage,
    sysex: { manufacturer: [0x43] },
    minGap: 60,
    describe: (raw) => {
      if (!isYamaha(raw)) return null;
      const b = parseBulk(raw);
      if (b) return `${M.name} bulk ${b.header ? b.header.trim() : `format ${b.format}`}, ${b.data.length} bytes${b.ok ? '' : ' (checksum or length wrong)'}${b.format === 3 && b.data.length === VCED4 ? ` "${textAt(b.data, NAME4)}"` : ''}`;
      const pc = parseParamChange(raw);
      if (pc) return `${M.name} parameter change group ${pc.group} parameter ${pc.num} = ${pc.value}`;
      if (isRequest(raw)) return `${M.name} dump request`;
      return null;
    },
    recognise: (raw) => isV(raw) || isB(raw) || isA(raw) || !!M.recognise?.(raw),
    isOwn: (raw) => { const b = parseBulk(raw); return !!(b && [3, 4, ...(M.formats || [])].includes(b.format)); },
    isRequest,
    prefer: M.prefer || (() => 1),
    deviceIds: M.deviceIds || [],
    libraryItems,
    simulate: () => simulator4(M, init, SIZE),
    objects: [voiceObj],
    requests: M.requests ? [
      ...(M.aced ? [{ label: 'Voice edit buffer (additional data, then voice)', bytes: (ctx) => [dumpRequestHeader(ch(ctx), 'LM  8976AE'), dumpRequest(ch(ctx), 3)] }] : [{ label: 'Voice edit buffer', bytes: (ctx) => dumpRequest(ch(ctx), 3) }]),
      { label: '32 internal voices', bytes: (ctx) => dumpRequest(ch(ctx), 4), timeout: 4000 },
      ...(M.moreRequests || []),
    ] : [],
    midiNotes: M.midiNotes || [],
  };
  M.extend?.(def, { ch, init, full, TR, isV, isA, voiceMsgs, SIZE });
  return def;
}

function simulator4(M, init, SIZE) {
  const unit = { voice: init(), bank: new Uint8Array(32 * VMEM4) };
  for (let i = 0; i < 32; i++) unit.bank.set(M.init, i * VMEM4);
  return {
    unit,
    handle(d) {
      if (d[0] >= 0xc0 && d[0] <= 0xcf) { const u = unpackVoice4(unit.bank.subarray((d[1] & 31) * VMEM4, ((d[1] & 31) + 1) * VMEM4)); unit.voice.set(u.vced); if (M.aced) unit.voice.set(u.aced, VCED4); return []; }
      if (!isYamaha(d)) return null;
      const pc = parseParamChange(d);
      if (pc) {
        if (pc.group === 4 && pc.num >= 0x100 && pc.num < 0x100 + VCED4) unit.voice[pc.num - 0x100] = pc.value;
        if (M.aced && pc.group === 4 && pc.num >= 0x180 && pc.num < 0x180 + ACED4) unit.voice[VCED4 + pc.num - 0x180] = pc.value;
        return M.simulateParam?.(unit, pc) ?? [];
      }
      if (isRequest(d)) {
        if (!M.requests) return [];
        const c = d[2] & 15;
        if (d[3] === 3) return [bulk(c, 3, unit.voice.subarray(0, VCED4))];
        if (d[3] === 4) return [bulk(c, 4, unit.bank)];
        const hdr = d[3] === 0x7e ? String.fromCharCode(...d.slice(4, 14)) : '';
        if (M.aced && hdr === 'LM  8976AE') return [bulkHeader(c, hdr, unit.voice.subarray(VCED4, SIZE))];
        return M.simulateRequest?.(unit, hdr, c) ?? [];
      }
      const b = parseBulk(d);
      if (b?.ok && b.format === 3 && b.data.length === VCED4) unit.voice.set(b.data);
      else if (M.aced && b?.ok && b.header === 'LM  8976AE') unit.voice.set(b.body, VCED4);
      else if (b?.ok && b.format === 4 && b.data.length === 32 * VMEM4) unit.bank = Uint8Array.from(b.data);
      else M.simulateBulk?.(unit, b);
      return [];
    },
  };
}

// ------------------------------------------------------------------ Head Library
// 4-op voices in the shared model, family 'yamaha-dx' (ops: 4). Same family: exact. A 6-op DX voice:
// its algorithm's carriers and nearest modulators are taken into the closest 4-op algorithm (report).
const LFO4 = ['saw', 'square', 'triangle', 'sample-hold'];
const LFO4_FROM = { saw: 0, 'saw-up': 0, 'saw-down': 0, square: 1, triangle: 2, sine: 2, 'sample-hold': 3, random: 3 };
const u = (v, m) => Math.max(0, Math.min(1, v / m));
const r = (x, m) => Math.max(0, Math.min(m, Math.round(x * m)));
export function dx4Translator(P) {
  function toCommon(d) {
    const alg = ALGORITHMS4[d[52] & 7];
    const op = (n, i) => d[opBase4(n) + i];
    const carriers = alg.carriers;
    const loud = [...carriers].sort((a, b) => op(b, 10) - op(a, 10))[0];
    const env = (n) => ({ attack: 1 - u(op(n, 0), 31), decay: 1 - u(op(n, 1), 31), sustain: u(op(n, 4), 15), release: 1 - u(op(n, 3), 15) });
    const mods = (c) => alg.mods.filter(([, t]) => t === c).map(([f]) => f);
    const ml = mods(loud).length ? Math.max(...mods(loud).map((m) => op(m, 10))) / 99 : 0;
    return {
      model: COMMON_MODEL, kind: 'patch',
      voice: { mode: d[63] ? 'mono' : 'poly', portamento: { on: d[66] > 0, time: u(d[66], 99) }, bendUp: d[64], bendDown: d[64], octave: Math.max(-2, Math.min(2, Math.round((d[62] - 24) / 12))) },
      osc: carriers.map((c) => {
        const ac = VCED4 + acedBase4(c);
        const ratio = P.aced && !d[ac] ? ratio4(op(c, 11), d[ac + 2]) / 100 : RATIOS[op(c, 11)] / 100;
        const semis = 12 * Math.log2(ratio);
        const m = mods(c).filter((x) => op(x, 10) > 0);
        return { wave: m.length ? (Math.abs(RATIOS[op(m[0], 11)] / 100 / ratio - 1) < 0.02 ? 'saw' : 'fm') : 'sine', coarse: Math.round(semis), fine: Math.round((semis - Math.round(semis)) * 100), level: u(op(c, 10), 99) };
      }),
      filter: { type: 'lpf', cutoff: 0.25 + 0.75 * ml, resonance: 0, ...(mods(loud).length ? { env: env(mods(loud)[0]), envDepth: ml } : {}) },
      amp: { level: u(op(loud, 10), 99), env: env(loud), lfo1: u(d[57], 99) * (d[61] / 3) },
      lfo: [{ wave: LFO4[d[59]] || 'triangle', rate: u(d[54], 99), fade: u(d[55], 99) }],
      pitch: { lfo1: u(d[56], 99) * (d[60] / 7) },
      extra: { family: 'yamaha-dx', model: P.model, ops: 4, algorithm: (d[52] & 7) + 1, vced4: toBase64(Uint8Array.from(d.subarray(0, VCED4))), ...(P.aced ? { aced4: toBase64(Uint8Array.from(d.subarray(VCED4, VCED4 + ACED4))) } : {}), match: toBase64(Uint8Array.from([...d.subarray(0, NAME4), ...d.subarray(NAME4 + 10, VCED4)])) },
    };
  }
  function fromCommon(c, _base) {
    const report = emptyReport();
    const d = P.init();
    const x = c?.extra;
    if (x?.family === 'yamaha-dx' && x.ops === 4 && x.vced4) {
      d.set(fromBase64(x.vced4).subarray(0, VCED4));
      report.mapped.push(`every voice parameter (${x.model} 4-operator voice)`);
      if (P.aced && x.aced4) { d.set(fromBase64(x.aced4).subarray(0, ACED4), VCED4); report.mapped.push('the additional voice data'); } else if (x.aced4) report.dropped.push(`the ${x.model} additional data (FIX, FINE, waves, EG shift, reverb)`);
      return { data: d, report: tidy(report) };
    }
    if (x?.family === 'yamaha-dx' && x.ops === 6 && x.vced) return from6(fromBase64(x.vced), d, report);
    return build(c, d, report);
  }
  /** A 6-operator voice into 4 operators: the loudest carrier and its first modulator chain. */
  function from6(v, d, report) {
    const opB = (n) => (6 - n) * 21;
    // 6-op algorithm -> 4-op algorithm with the same number of carriers
    const nc = [2, 2, 2, 2, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 3, 3, 4, 4, 4, 5, 5, 3, 3, 3, 4, 4, 5, 6][v[134] & 31];
    const a4 = nc >= 4 ? 7 : nc === 3 ? 6 : nc === 2 ? 4 : 0; // 8, 7, 5, 1
    d[52] = a4; d[53] = v[135];
    const target = ALGORITHMS4[a4];
    // 6-op operators by role (carriers, then modulators, each by output level) onto the 4-op roles
    const alg6 = ALGORITHMS[v[134] & 31];
    const lvl = (a, b) => v[opB(b) + 16] - v[opB(a) + 16];
    const car6 = alg6.carriers.slice().sort(lvl);
    const mod6 = [1, 2, 3, 4, 5, 6].filter((n) => !alg6.carriers.includes(n)).sort(lvl);
    const tc = target.carriers;
    const tm = [1, 2, 3, 4].filter((n) => !tc.includes(n));
    const pool = { c: [...car6], m: [...mod6] };
    const take = (role) => (pool[role].length ? pool[role].shift() : pool[role === 'c' ? 'm' : 'c'].shift());
    const pick = new Map([...tc.map((n) => [n, take('c')]), ...tm.map((n) => [n, take('m')])]);
    const mapEG = (s, t) => {
      const R = (i) => v[s + i];
      const L = (i) => v[s + 4 + i];
      d[t] = r(R(0) / 99, 31); d[t + 1] = r(R(1) / 99, 31); d[t + 2] = r(R(2) / 99 * (L(2) < L(1) ? 1 : 0), 31); d[t + 3] = Math.max(1, r(R(3) / 99, 15)); d[t + 4] = r(L(2) / 99, 15);
      d[t + 10] = v[s + 16]; d[t + 9] = v[s + 15]; d[t + 5] = Math.round((v[s + 9] + v[s + 10]) / 2); d[t + 6] = Math.min(3, v[s + 13] >> 1);
      const ratio = freqValue(v[s + 17], v[s + 18], v[s + 19]);
      let best = 0; RATIOS.forEach((x, i) => { if (Math.abs(Math.log(x / 100 / ratio)) < Math.abs(Math.log(RATIOS[best] / 100 / ratio))) best = i; });
      d[t + 11] = best; d[t + 12] = Math.max(0, Math.min(6, Math.round((v[s + 20] - 7) / 2) + 3));
    };
    [1, 2, 3, 4].forEach((n) => mapEG(opB(pick.get(n)), opBase4(n)));
    for (let i = 0; i < 4; i++) d[54 + i] = v[137 + i];
    d[58] = v[141]; d[59] = [2, 0, 0, 1, 2, 3][v[142]] ?? 2; d[60] = v[143]; d[62] = v[144];
    for (let i = 0; i < 10; i++) d[NAME4 + i] = v[145 + i];
    report.approximated.push(`algorithm ${(v[134] & 31) + 1} as 4-operator algorithm ${a4 + 1} (the ${nc} carrier${nc > 1 ? 's' : ''} kept as far as 4 operators allow)`, 'the four loudest operators, their EGs as AR/D1R/D1L/D2R/RR and frequencies as the nearest ratios');
    report.dropped.push('two operators', 'the pitch EG', 'keyboard level scaling curves (as one level scaling depth)');
    return { data: d, report: tidy(report) };
  }
  function build(c, d, report) {
    d[52] = 4; // algorithm 5: 4>3, 2>1
    const oscs = (c.osc || []).filter((o) => o && o.on !== false).slice(0, 2);
    if (!oscs.length) oscs.push({ wave: 'saw' });
    const env = c.amp?.env || {};
    const fenv = c.filter?.env || env;
    oscs.forEach((o, i) => {
      const car = i ? 3 : 1;
      const mod = i ? 4 : 2;
      const semis = (Number(o.coarse) || 0) + (Number(o.fine) || 0) / 100;
      const ratio = 2 ** (semis / 12);
      const near = (x) => RATIOS.reduce((b, y, k) => (Math.abs(Math.log(y / 100 / x)) < Math.abs(Math.log(RATIOS[b] / 100 / x)) ? k : b), 0);
      const set = (n, k, v) => { d[opBase4(n) + k] = v; };
      set(car, 11, near(ratio)); set(car, 10, Math.round(80 + 19 * (o.level ?? 1)));
      set(car, 0, r(1 - (env.attack ?? 0), 31)); set(car, 1, r(1 - (env.decay ?? 0.5), 31)); set(car, 4, r(env.sustain ?? 1, 15)); set(car, 3, Math.max(1, r(1 - (env.release ?? 0.3), 15)));
      const k = o.wave === 'square' ? 2 : 1;
      set(mod, 11, near(ratio * k));
      set(mod, 10, o.wave === 'sine' ? 0 : Math.round(45 + 40 * (c.filter?.cutoff ?? 1)));
      set(mod, 0, r(1 - (fenv.attack ?? 0), 31)); set(mod, 1, r(1 - (fenv.decay ?? 0.5), 31)); set(mod, 4, r(fenv.sustain ?? 1, 15)); set(mod, 3, Math.max(1, r(1 - (fenv.release ?? 0.3), 15)));
    });
    if (oscs.length < 2) d[opBase4(3) + 10] = 0;
    const lfo = c.lfo?.[0];
    if (lfo) { d[59] = LFO4_FROM[lfo.wave] ?? 2; d[54] = r(lfo.rate ?? 0.35, 99); d[55] = r(lfo.fade ?? 0, 99); }
    d[56] = r(Math.min(1, c.pitch?.lfo1 ?? 0), 99);
    d[57] = r(Math.min(1, c.amp?.lfo1 ?? 0), 99);
    if (c.voice?.mode) d[63] = c.voice.mode === 'mono' || c.voice.mode === 'legato' ? 1 : 0;
    if (c.voice?.bendUp !== undefined) d[64] = Math.max(0, Math.min(12, Math.round(c.voice.bendUp)));
    if (c.voice?.portamento?.on) d[66] = Math.max(1, r(c.voice.portamento.time ?? 0.3, 99));
    d[62] = 24 + 12 * Math.max(-2, Math.min(2, Number(c.voice?.octave) || 0));
    report.approximated.push('oscillators as two-operator FM pairs (algorithm 5)', 'filter as the modulators\' level and EG', 'amp envelope as AR/D1R/D1L/RR');
    if ((c.osc || []).length > 2) report.dropped.push('oscillators after the second');
    if (c.filter?.resonance) report.dropped.push('filter resonance');
    if (c.effects) report.dropped.push('effects');
    return { data: d, report: tidy(report) };
  }
  return { toCommon, fromCommon };
}
