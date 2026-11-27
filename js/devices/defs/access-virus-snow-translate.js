// Access Virus TI Snow single and multi <-> the shared synth model (core/mainlib/common.js).
//
// The Snow's single is the TI's (the same 512 bytes, the same Virus Control description), so its translation is
// the TI2's (access-virus-ti2-translate.js) and another Virus TI gets the whole single back through `extra`.
// A Snow multi is the 256-byte multi of the TI with 4 parts, followed here by the 4 part singles (each part holds
// its own single on the Snow): 256 + 4 x 512 bytes. Within the family `extra` carries every byte.

import { COMMON_MODEL, unit, fromUnit, bipolar, fromBipolar, emptyReport } from '../../core/mainlib/common.js';
import { toBase64, fromBase64 } from '../../core/mainlib/format.js';
import * as TR from './access-virus-ti2-translate.js';

const FAMILY = 'access-virus-ti';
const MODEL = 'access-virus-snow';
export const PARTS = 4;
export const PART_SINGLES = 256;
export const MULTI_DATA = PART_SINGLES + PARTS * 512;
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
const PART = (ci, part) => 32 + 16 * (ci - 32) + part;

export const singleCategory = TR.singleCategory;
export const singleSetCategory = TR.singleSetCategory;
export function singleToCommon(d) {
  const c = TR.singleToCommon(d);
  return { ...c, extra: { ...c.extra, model: MODEL } };
}
export const singleFromCommon = TR.singleFromCommon;

export function multiToCommon(d) {
  return {
    model: COMMON_MODEL, kind: 'performance', keyMode: 'multi', tempo: d[15] + 63,
    parts: Array.from({ length: PARTS }, (_, i) => ({
      on: (d[240 + i] & 1) === 1, channel: d[PART(34, i)] & 15, bank: d[PART(32, i)], program: d[PART(33, i)],
      level: unit(d[PART(39, i)]), pan: bipolar(d[PART(43, i)]), transpose: d[PART(37, i)] - 64, low: d[PART(35, i)], high: d[PART(36, i)],
    })),
    extra: { family: FAMILY, model: MODEL, multi: toBase64(d), match: toBase64(Uint8Array.from(d.subarray(14))) },
  };
}
export function multiFromCommon(c, base) {
  const d = Uint8Array.from(base);
  const r = emptyReport();
  if (c.extra?.family === FAMILY && c.extra.multi) {
    const src = fromBase64(c.extra.multi);
    d.set(src.subarray(0, Math.min(src.length, d.length)));
    r.mapped.push(`all ${Math.min(src.length, d.length)} multi bytes (same family)`);
    if (src.length < d.length) r.mapped.push('the part singles kept from the Snow multi (a TI multi does not carry them)');
    if (c.extra.model !== MODEL) r.dropped.push('parts 5-16 (the Snow has 4; their bytes are kept but not played)');
    return { data: d, report: r };
  }
  if (c.tempo) { d[15] = clamp(c.tempo - 63, 0, 127); r.mapped.push('Clock tempo'); }
  (c.parts || []).slice(0, PARTS).forEach((p, i) => {
    if (!p) return;
    if (p.on !== undefined) d[240 + i] = p.on ? d[240 + i] | 1 : d[240 + i] & ~1;
    if (typeof p.channel === 'number') d[PART(34, i)] = p.channel & 15;
    if (typeof p.program === 'number') d[PART(33, i)] = clamp(p.program, 0, 127);
    if (p.level !== undefined) d[PART(39, i)] = fromUnit(p.level);
    if (p.pan !== undefined) d[PART(43, i)] = fromBipolar(p.pan);
    if (p.transpose !== undefined) d[PART(37, i)] = clamp(64 + p.transpose, 16, 112);
    if (p.low !== undefined) d[PART(35, i)] = clamp(p.low, 0, 127);
    if (p.high !== undefined) d[PART(36, i)] = clamp(p.high, 0, 127);
    r.mapped.push(`Part ${i + 1}`);
  });
  if ((c.parts || []).length > PARTS) r.dropped.push(`parts ${PARTS + 1}-${c.parts.length} (the Snow has ${PARTS})`);
  return { data: d, report: r };
}
