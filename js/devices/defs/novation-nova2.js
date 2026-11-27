// Novation Nova II Keyboard: MIDI implementation from its Keyboard OS 2 image (n2kos2.mid from
// Novation, decoded with tools/novation/os_mid.py; "NOVATION S2 NOVA 4OCT KBD"). The SuperNova II
// definition serves it (novation-supernova2.js answers with model byte 23 for this device): the
// receiver (1F1EE) has the SuperNova II OS 2.0 length table word for word (5C452, types 00-22), the
// controller map (5C498) and every CC, NRPN, packed-NRPN and NRPN 120/122 setter are the SuperNova II
// Keyboard OS 2.0's, except the digital I/O option card settings (NRPN 122 MSB 49-57: no handlers) and
// a few Keyboard-only NRPN 120/122 numbers. What differs is the size: the menus offer program banks
// A-D, drum maps a-d, performance banks A-B, user patterns U-V, 6 performance parts (outputs 1 & 2
// to 5 & 6), unison of 2-6 voices. Novation published no Nova II rack/desktop OS. Not checked on a
// unit. See docs/devices/novation-nova2.md.

import SN2def, * as SN2 from './novation-supernova2.js';

const PARTS = 6;
/** Option names for banks, parts and patterns the Nova II does not have (its menus' lists). */
const MISSING = /Prog(ram)? bank [E-H]|progs to bank [E-H]|Perf(ormance)? bank [CD]|perfs to bank [CD]|Drum map [e-h]|Dmap [e-h]|\(W\)|bank W|^W$|^Part [78]$|^7 & 8$|^[78] voice$/;
const trim = (options) => options.filter(([, n]) => !MISSING.test(String(n)));
const DROP_GROUPS = new Set(['Digital I/O option']);
const partOf = (p) => { const m = /^part(\d)$/.exec(p.section); return m ? Number(m[1]) : -1; };

function adapt(p) {
  if (DROP_GROUPS.has(p.group)) return null;
  const q = { ...p };
  if (q.options) q.options = trim(q.options);
  if (partOf(q) >= PARTS) Object.assign(q, { readOnly: true, help: 'The Nova II has 6 parts; kept so a backup restores exactly' });
  // 6 External Parts: its NRPN 120 table (11E7C) has MSB 16+8k+n for parts n = 0-5 only, in all 12 field groups
  if (/^Ext [78] /.test(q.label)) Object.assign(q, { readOnly: true, help: 'The Nova II has 6 External Parts (no NRPN 120 handler for parts 7-8); kept so a backup restores exactly' });
  return q;
}
const BANKS = { program: [...SN2.PROG_BANKS.slice(0, 4), ...SN2.DRUM_BANKS.slice(0, 4)], performance: SN2.PERF_BANKS.slice(0, 2), pattern: [[15, 'User bank U'], [16, 'User bank V']] };

const objects = SN2def.objects.map((o) => {
  const out = { ...o, params: o.params.map(adapt).filter(Boolean) };
  delete out.target; // no Rack/Keyboard choice: the Nova II is a keyboard
  if (o.slots) out.slots = { ...o.slots, banks: BANKS[o.key] ?? o.slots.banks };
  if (o.multi) out.multi = { ...o.multi, count: PARTS };
  if (o.key === 'program') {
    out.toCommon = (d) => { const c = o.toCommon(d); c.extra.model = SN2.NOVA2_ID; return c; };
    if (o.sendAll) out.sendAll = { ...o.sendAll, label: 'Send to Nova II' };
  }
  if (o.key === 'performance') {
    out.toCommon = (d) => { const c = o.toCommon(d); c.extra.model = SN2.NOVA2_ID; return c; };
    if (o.sendAll) out.sendAll = { ...o.sendAll, label: 'Send to Nova II' };
    delete out.emptySection;
  }
  return out;
});
const keep = new Set([...BANKS.program, ...BANKS.performance].map(([, l]) => l));

export default {
  ...SN2def,
  coverage: 'Programs, drum maps, performances (6 parts, vocoder, External Parts), arpeggio patterns and global settings of the Nova II Keyboard: the SuperNova II definition with the Nova II\'s model byte (23) and its menus\' banks, parts and lists, from its Keyboard OS 2 image. Not checked on a Nova II.',
  sysex: { ...SN2def.sysex, model: 0x23 },
  objects,
  requests: SN2def.requests.filter((r) => !/^(Prog bank|Drum map|Perf bank) /.test(r.label) || [...keep].some((l) => r.label.startsWith(`${l} `))),
};
export const _test = { objects, MISSING };
