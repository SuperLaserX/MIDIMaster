// Yamaha DX7s v1.3: its own performance and system pages over the DX7II's formats (yamaha-dx7s.js,
// docs/devices/yamaha-dx7s.md). Addresses are the DX7s ROM's (32 KB at 8000h; listing re/dx/dx7s.lst).

// Micro tune names (pointer table E5D0); the page (D6A6) shows the number, the name, and for 11 and up
// "User" + (n - 10) with "[INT n]" (11-12) or "[CRT n]" (13-75, maximum 4Bh at 9C4B).
export const MICRO_NAMES_DX7S = ['Equal', 'Pure(major)', 'Pure(minor)', 'Mean tone', 'Pythagorean', 'Werckmeister', 'Kirnberger', 'Vallotti,yong', '1/4 Shift eql', '1/4 Tone', '1/8 Tone', 'User'];
export const MICRO_MAX_DX7S = 0x4b;
export const microText = (v) => {
  const name = `${v + 1}:${MICRO_NAMES_DX7S[Math.min(v, 11)]}`;
  if (v <= 10) return name;
  return `${name}${v - 10} [${v <= 12 ? `INT${v - 10}` : `CRT${v - 12}`}]`;
};
// The key of Pure(major) .. Pythagorean (tables 1-4, D6D9): flats from C (FF95), Pure(minor) sharps from A (DC10).
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SHARPS = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];
// Continuous slider destinations (E92E, 36 names; D7CF: 0-21 by number, then six per name for OP1-OP6).
const CS = ['No Effect', 'Total volume', 'Total volume', 'Total volume', 'Total volume', 'Algorithm', 'Feedback', 'LFO Wave', 'LFO Speed', 'LFO Delay', 'PMOD SENS.', 'LFO PMOD', 'LFO AMOD',
  'Pitch EG R1', 'Pitch EG R2', 'Pitch EG R3', 'Pitch EG R4', 'Pitch EG L1', 'Pitch EG L2', 'Pitch EG L3', 'Pitch EG L4', 'Porta time',
  'Freq coarse', 'Freq fine', 'OSC detune', 'EG Rate 1', 'EG Rate 2', 'EG Rate 3', 'EG Rate 4', 'EG Level 1', 'EG Level 2', 'EG Level 3', 'EG Level 4', 'Velocity', 'AMOD SENS.', 'Total level'];
export const csText = (v) => {
  if (v <= 21) return v >= 2 && v <= 4 ? `${CS[v]} (${v}: the DX7II's ${['Output balance', 'PAN control', 'Dual detune'][v - 2]})` : CS[v];
  return `${CS[22 + Math.floor((v - 22) / 6)]} OP${((v - 22) % 6) + 1}`;
};
const NOT_SHOWN = (what) => ({ readOnly: true, help: `Not shown or read by the DX7s (no page; ${what}); kept for DX7II performances.` });

/**
 * The DX7s's performance pages (1Ah-1Ch: entries 9B87, 9B8B, 9B8D; maxima 9C44, 9C48, 9C4A; labels E4C9,
 * E517, E537 and ">Micro tune<"). It loads a performance with voice mode single and the A/B switches and
 * slider switch fixed (8C91: bytes 0 = 0, 5, 9, 11 = 1, 19 = 5); bytes 2, 6, 7, 14, 15 and 20-30 are never read.
 */
export function dx7sPced(names) {
  const set = (ps, key, x) => { const p = ps.find((q) => q.key === key); if (p) Object.assign(p, x); };
  return (ps) => {
    set(ps, 'p0', { readOnly: true, help: 'Voice mode: the DX7s has single only and sets it when it loads a performance.' });
    set(ps, 'p1', { label: 'Voice number', help: 'Voice number=: I01-I64 internal, C01-C64 cartridge.' });
    set(ps, 'p2', NOT_SHOWN('voice B'));
    set(ps, 'p3', { label: 'Micro tune', max: MICRO_MAX_DX7S, options: Array.from({ length: MICRO_MAX_DX7S + 1 }, (_, v) => [v, microText(v)]), help: `>Micro tune<: ${names.slice(0, 11).join(', ')}; User 1-2 internal, 3-65 the cartridge's 1-63.` });
    set(ps, 'p4', { label: 'Key', dynamic: (d) => ({ hidden: !(d[3] >= 1 && d[3] <= 4), options: (d[3] === 2 ? SHARPS : FLATS).map((t, i) => [i, t]) }), help: 'Key: shown for Pure(major), Pure(minor), Mean tone and Pythagorean; Pure(minor) names the minor key (from A).' });
    set(ps, 'p5', { readOnly: true, help: 'Micro tuning A/B: the DX7s sets 1 when it loads a performance.' });
    set(ps, 'p6', NOT_SHOWN('dual detune'));
    set(ps, 'p7', NOT_SHOWN('split point'));
    set(ps, 'p8', { label: 'Forced damp', options: [[0, 'off'], [1, 'on']] });
    set(ps, 'p9', { readOnly: true, help: 'Sustain foot switch A/B: the DX7s sets 1 when it loads a performance.' });
    set(ps, 'p10', { label: 'FS', options: [[0, 'sustain'], [1, 'portamento'], [2, 'key hold'], [3, 'Soft']], help: 'FS : what the foot switch does.' });
    set(ps, 'p11', { readOnly: true, help: 'Foot switch A/B: the DX7s sets 1 when it loads a performance.' });
    set(ps, 'p12', { label: 'FS soft', dynamic: () => ({ hidden: false }), help: 'FS soft =: the soft pedal range 0-7.' });
    set(ps, 'p13', { label: 'Key shift', help: 'Key shift =: 24 = none.' });
    set(ps, 'p14', NOT_SHOWN('note shift B'));
    set(ps, 'p15', NOT_SHOWN('balance'));
    set(ps, 'p16', { label: 'Total volume' });
    set(ps, 'p17', { label: 'CS1', options: Array.from({ length: 106 }, (_, v) => [v, csText(v)]) });
    set(ps, 'p18', { label: 'CS2', options: Array.from({ length: 106 }, (_, v) => [v, csText(v)]) });
    set(ps, 'p19', { readOnly: true, help: 'Continuous slider switches: the DX7s sets 5 when it loads a performance.' });
    for (let o = 20; o <= 30; o++) set(ps, `p${o}`, NOT_SHOWN('PAN'));
  };
}

// The DX7s's system pages: Midi edit (1Eh: entries 9B91, maxima 9C4E, labels E69E; D99A) and Exclusive (1Fh:
// 9B9B, 9C58, E76E). Bytes 1, 3, 6 and 19 have no page and no reference in v1.3. Maxima of the setup B0D9
// (as the DX7II's bytes 0-19); initial values B186 (byte 19 = 1) and the program change table 0-63 (B178).
const SYS_MAX = [16, 1, 16, 16, 1, 31, 31, 31, 31, 2, 2, 1, 1, 1, 15, 1, 15, 15, 15, 3, 127];
export const SYS_INIT_DX7S = [0, 1, 0, 0, 1, 12, 13, 14, 15, 0, 1, 1, 0, 0, 0, 1, 0, 2, 3, 1, 64, ...Array.from({ length: 64 }, (_, i) => i)];
export function dx7sSysParams({ chOpts, opts, OFFON }) {
  const ps = [];
  const P = (o, label, group, extra = {}) => ps.push({ key: `s${o}`, label, offset: o, min: 0, max: SYS_MAX[o] ?? 127, group, ...extra });
  const unused = (what) => ({ readOnly: true, input: 'number', help: `The DX7s has no page for it and does not use it (${what}); sent only with the whole setup.` });
  P(0, 'Trns ch', 'Midi edit', { options: chOpts, help: 'Trns ch =: 1-16, or off.' });
  P(1, 'Transmit on (DX7II)', 'Midi edit', unused('the DX7II\'s transmit on/off; the DX7s uses Trns ch off'));
  P(2, 'Recv ch', 'Midi edit', { options: chOpts, help: 'Recv ch =: 1-16, or off.' });
  P(3, 'Receive channel B (DX7II)', 'Midi edit', unused('the DX7II\'s voice B channel'));
  P(4, 'Omni mode', 'Midi edit', { options: opts(OFFON) });
  P(11, 'Local', 'Midi edit', { options: opts(OFFON) });
  P(5, 'IN control#', 'Midi edit', { min: 11, help: 'IN control# =: the control number (11-31) the voice parameter MC follows.' });
  P(6, 'MIDI IN control B (DX7II)', 'Midi edit', unused('the DX7II\'s voice B control number'));
  P(7, 'CS1 control#', 'Midi edit', { min: 5 });
  P(8, 'CS2 control#', 'Midi edit', { min: 5 });
  P(9, 'Note on/off', 'Midi edit', { options: opts(['all', 'odd', 'even']) }); // E6C1
  P(10, 'PC trns', 'Midi edit', { options: opts(['off', 'Normal', 'Memory']), help: 'PC trns: no program change, the memory number, or the number in the table below.' });
  P(15, 'Exclusive', 'Exclusive', { options: opts(OFFON), help: 'Exclusive: off = the DX7s takes no SysEx at all (no voices, banks, requests or single changes).' });
  P(14, 'Device number', 'Exclusive', { format: (v) => String(v + 1) });
  P(13, 'Recv block', 'Exclusive', { options: opts(['1-32', '33-64']), help: 'Recv block: where a received bank of 32 voices goes.' });
  P(12, 'Trns block', 'Exclusive', { options: opts(['1-32', '33-64']), help: 'Trns block: which 32 voices the DX7s sends as a bank.' });
  P(20, 'Master tune', 'Utility', { format: (v) => `${v >= 64 ? '+' : '-'}${Math.abs(v - 64)}`, help: 'Master tune =: 64 = centre.' });
  ['>VP', '>FS', '>MT'].forEach((t, i) => P(16 + i, `Set bank ${t}`, 'Cartridge', { format: (v) => String(v + 1), help: 'Set bank >VP >FS >MT: the cartridge bank for voices and performances, fractional scaling, micro tuning.' }));
  P(19, 'Byte 19 (DX7II)', 'Cartridge', unused('0-3, initially 1'));
  for (let i = 0; i < 64; i++) P(21 + i, `Program SW [${i + 1}] Trns #`, 'Program change table', { input: 'number', format: (v) => String(v + 1), help: 'Program SW [ ] Trns #: the program number (1-128) sent for this memory when PC trns is Memory.' });
  return ps;
}
