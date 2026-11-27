// DigiTech DSP-256 family (DSP-256, DSP-256XL: multi-effects with a hand controller, 2 x 16 LCD; HD6303): the editor,
// made for each model from its generated tables (digitech-dsp256-fw.js, digitech-dsp256xl-fw.js; see
// docs/devices/digitech-dsp256.md and digitech-dsp256xl.md).
//
// Every name and value text is what the unit's LCD shows: the edit display and the utility pages were run in an
// emulator for every value (tools/digitech/dsp256_fw.py, which finds every address by code pattern); the bytes and
// messages are those of its receiver (SCI state machine, main-loop parser) and its senders.
//
// A program is 22 bytes: byte 0 the configuration, bytes 1-21 the parameters of that configuration's pages in page
// order; a 16-character title is kept apart. 128 user programs (1-128) and 128 factory presets in ROM (129-256).
// Every configuration also has a memory of 22 bytes: the values a program takes when the panel switches it to that
// configuration (the unit saves the program there on every value change).
//
// SysEx F0 00 00 10 <n> <model> ... F7 (DOD/DigiTech; model 06 DSP-256, 0B DSP-256XL; n = MIDI channel - 1, any n
// when the unit is on OMNI). Data bytes travel as pairs: bit 7, then bits 6-0.
//   00                       request: the unit sends 41h
//   41 <pairs>               all memory: titles, programs, configuration memories, settings (LAYOUT.dumpSize bytes)
//   42 <39 pairs>            one program: number 0-127, 22 program bytes, 16 title characters (stored, not loaded)
//   01 hb lo                 program request: jumps to RAM 0042h (JSR $42): not used
//   40 a b c d               a DSP register write (raw): not used
// Program change: the program map turns MIDI program 1-128 into program 1-256 (1:1 after the first power-up).

import { emptyReport } from '../../core/mainlib/common.js';
import { hashBytes, tidy } from './translate-helpers.js';

/** The editor of one model: opt = { id, name } (name as the messages and notes say it). */
export function makeDsp256(FW, opt) {
  const { FIRMWARE, CONFIGS, TABLES, UTILITY, PRESETS, FIRST_POWER_UP, LAYOUT } = FW;
  const NAME = opt.name;
  const PROG = 22;                 // program bytes
  const TITLE_LEN = 16;
  const SIZE = PROG + TITLE_LEN;   // the editor's program object: 22 bytes, then the title
  const DUMP_SIZE = LAYOUT.dumpSize;
  const AT = LAYOUT;                 // offsets in the 41h dump
  const hex = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
  const FIRST = hex(FIRST_POWER_UP);

  // ------------------------------------------------------------------ messages
  const HDR = [0xf0, 0x00, 0x00, 0x10];
  const isDsp256 = (raw) => raw?.[0] === 0xf0 && raw.length > 7 && raw[1] === 0 && raw[2] === 0 && raw[3] === 0x10 && raw[5] === LAYOUT.model;
  const hdr = (ch = 0) => [...HDR, ch & 15, LAYOUT.model];
  const pairs = (d) => Array.from(d).flatMap((v) => [(v >> 7) & 1, v & 0x7f]);
  const unpairs = (a) => Uint8Array.from({ length: a.length >> 1 }, (_, i) => ((a[2 * i] & 1) << 7) | (a[2 * i + 1] & 0x7f));
  const requestAll = (ch = 0) => [...hdr(ch), 0x00, 0xf7];
  const programMessage = (n, d, ch = 0) => [...hdr(ch), 0x42, ...pairs([n & 0x7f, ...Array.from({ length: SIZE }, (_, i) => d[i] ?? 0)]), 0xf7];
  const allMessage = (dump, ch = 0) => [...hdr(ch), 0x41, ...pairs(Array.from({ length: DUMP_SIZE }, (_, i) => dump[i] ?? 0)), 0xf7];
  const programChange = (n, ch = 0) => [0xc0 | (ch & 15), n & 0x7f];

  function parse(raw) {
    if (!isDsp256(raw) || raw.at(-1) !== 0xf7) return null;
    const a = Array.from(raw);
    const ch = a[4] & 15;
    const body = a.slice(7, -1);
    switch (a[6]) {
      case 0x00: return { kind: 'request', ch };
      case 0x01: return { kind: 'programRequest', ch, n: body.length >= 2 ? ((body[0] & 1) << 7) | body[1] : null };
      case 0x40: return { kind: 'dsp', ch, bytes: body };
      case 0x41: return body.length === 2 * DUMP_SIZE ? { kind: 'all', ch, data: unpairs(body) } : null;
      case 0x42: {
        if (body.length !== 2 * (1 + SIZE)) return null;
        const d = unpairs(body);
        return { kind: 'program', ch, n: d[0], data: d.slice(1) };
      }
      default: return null;
    }
  }
  const isRequest = (raw) => { const k = parse(raw)?.kind; return k === 'request' || k === 'programRequest'; };

  // ------------------------------------------------------------------ programs
  const configOf = (d) => d[0];
  const configInfo = (d) => CONFIGS[d[0]] || null;
  // The title editor steps through space, A-Z, LCD character 1, a-z, character 2, 0-9, character 3, ! to /, : to @, [,
  // ] to `, { to 7Fh (table 4D76h): the HD44780 shows 7Eh / 7Fh as arrows; 1-3 are its user-defined characters.
  const SHOW = { 0x01: '①', 0x02: '②', 0x03: '③', 0x7e: '→', 0x7f: '←' };
  const TAKE = Object.fromEntries(Object.entries(SHOW).map(([k, v]) => [v, Number(k)]));
  const isTitleChar = (c) => c === 0x20 || (c >= 1 && c <= 3) || (c >= 0x21 && c <= 0x7f && c !== 0x5c);
  const titleOf = (d) => Array.from(d.slice(PROG, SIZE)).map((c) => SHOW[c] ?? (isTitleChar(c) ? String.fromCharCode(c) : ' ')).join('').trimEnd();
  function setTitle(d, s) {
    const chars = Array.from(String(s)).map((ch) => TAKE[ch] ?? ch.charCodeAt(0)).map((c) => (isTitleChar(c) ? c : 0x20)).slice(0, TITLE_LEN);
    for (let i = 0; i < TITLE_LEN; i++) d[PROG + i] = chars[i] ?? 0x20;
  }
  const PRESET_NAMES = PRESETS.map((p) => Array.from(p[0]).map((ch) => SHOW[ch.charCodeAt(0)] ?? ch).join(''));
  function factory(i) {
    const d = new Uint8Array(SIZE);
    d.set(hex(PRESETS[i][1]), 0);
    const t = PRESETS[i][0];
    for (let k = 0; k < TITLE_LEN; k++) d[PROG + k] = k < t.length ? t.charCodeAt(k) : 0x20;
    return d;
  }
  /** User program i (0-127) from a 41h dump. */
  function programFromDump(dump, i) {
    const d = new Uint8Array(SIZE);
    d.set(dump.slice(AT.programs + PROG * i, AT.programs + PROG * (i + 1)), 0);
    d.set(dump.slice(AT.titles + TITLE_LEN * i, AT.titles + TITLE_LEN * (i + 1)), PROG);
    return d;
  }
  function programIntoDump(dump, i, d) {
    dump.set(d.slice(0, PROG), AT.programs + PROG * i);
    dump.set(d.slice(PROG, SIZE), AT.titles + TITLE_LEN * i);
  }
  /** The configuration memory c (22 bytes) of a dump. */
  const memoryOf = (dump, c) => dump.slice(AT.memory + PROG * c, AT.memory + PROG * (c + 1));
  /** The parameter page of program byte p in configuration c. */
  const pageOf = (c, p) => CONFIGS[c]?.params.find((x) => x.p === p) || null;
  /** The table of a page for program bytes d (some pages' texts follow another byte: pg.by, one table per value). */
  const tableOf = (pg, d) => (pg.by != null && d ? pg.ts[d[pg.by]] ?? pg.t : pg.t);
  const textOf = (c, p, v, d = null) => { const pg = pageOf(c, p); return pg && v <= pg.max ? TABLES[tableOf(pg, d)][v] : null; };

  // what the editor knows of the unit: the user program edits go to, the last memory read
  const unit = { target: 0, dump: null };
  const memorySource = () => unit.dump || FIRST;

  // ------------------------------------------------------------------ program parameters
  const GROUP_WORDS = { Band: 'EQ', Graphic: 'EQ', LPF: 'EQ', Early: 'Reverb', Subsequent: 'Reverb', Subsqnt: 'Reverb', Norm: 'Reverb', Damping: 'Reverb', Envelopment: 'Reverb', 'Pre-Delay': 'Reverb', Accent: 'Gate', Dry: 'Mix' };
  function groupOf(label) {
    if (label.startsWith('Mix:')) return 'Mix';
    const w = label.split(/[ :]/)[0];
    return GROUP_WORDS[w] || w;
  }
  const opts = (t, max) => TABLES[t].slice(0, max + 1).map((s, v) => [v, s]);
  const withValue = (o, v) => (o.some(([x]) => x === v) ? o : [...o, [v, `${v} (outside the page's range: the unit shows it as 0)`]].sort((x, y) => x[0] - y[0]));
  const CONFIG_OPTIONS = CONFIGS.map((c) => [c.v, c.name]);
  function setConfig(d, v) {
    d[0] = v;
    const m = memoryOf(memorySource(), v);
    for (let i = 1; i < PROG; i++) d[i] = m[i];
  }
  const pageParams = CONFIGS.flatMap((c) => c.params.map((pg) => ({
    key: `c${c.v}p${pg.p}`, group: groupOf(pg.label), label: pg.label, offset: pg.p, min: 0, max: 255, options: opts(pg.t, pg.max),
    help: `${pg.label} (${c.name}, page ${pg.p}): 0-${pg.max}${pg.by != null ? `; its texts follow ${pageOf(c.v, pg.by)?.label}` : ''}`,
    dynamic: (d) => ({ hidden: d[0] !== c.v, options: withValue(opts(tableOf(pg, d), pg.max), d[pg.p]) }),
  })));
  const programParams = [
    { key: 'config', group: 'Configuration', label: 'Configuration', offset: 0, options: CONFIG_OPTIONS, relayout: true,
      get: (d) => d[0], set: setConfig,
      help: 'The Configuration: page. As on the panel, switching loads the configuration\'s memory (the values its last program had; from the memory read with Settings, else as after the first power-up).' },
    ...pageParams,
    ...Array.from({ length: PROG - 1 }, (_, i) => ({
      key: `b${i + 1}`, group: 'Bytes (exact)', label: `Byte ${i + 1}`, offset: i + 1, min: 0, max: 255, input: 'number',
      help: `Program byte ${i + 1} as a typed number`,
      dynamic: (d) => { const pg = pageOf(d[0], i + 1); return { label: `Byte ${i + 1} (${pg ? pg.label : 'no page in this configuration'})` }; },
    })),
    ...Array.from({ length: TITLE_LEN }, (_, i) => ({ key: `t${i}`, group: 'Title', label: `Title ${i + 1}`, offset: PROG + i, min: 0x01, max: 0x7f, kind: 'char', hidden: true })),
  ];
  for (const p of programParams) p.sendKey = 'program'; // every change sends the whole program: the last one wins
  const PARAM_BY_KEY = new Map(programParams.map((p) => [p.key, p]));
  const paramOf = (key) => PARAM_BY_KEY.get(key);
  /** The parameter of configuration c whose page label is `label`. */
  const findPage = (c, label) => CONFIGS[c]?.params.find((x) => x.label === label) || null;

  /** What each edit sends: the program into the user program edited, then a program change that loads it. */
  const writeAndLoad = (d, n, ch = 0) => [programMessage(n, d, ch), programChange(n, ch)];

  // ------------------------------------------------------------------ settings (the 41h dump)
  const U = UTILITY;
  const tx = (m) => Object.entries(m).map(([v, t]) => [Number(v), t]);
  const PROGRAM_OPTIONS = tx(U.map.texts).map(([v, t]) => [v, `${t}${v >= 128 ? ` (factory ${PRESET_NAMES[v - 128]})` : ''}`]);
  const linkByte = new Map(U.links.map(([off, name]) => [off, name]));
  const LINK_OPTIONS = tx(U.linkTexts).map(([v, t]) => [v, `CC ${t}`.replace('CC ChP', 'ChP (channel pressure)')]);
  const FUNCTION_OPTIONS = U.functions.map((t, v) => [v, t]);
  const settingsParams = [
    { key: 'channel', section: 'midi', group: 'MIDI', label: U.channel.label, offset: AT.channel, options: tx(U.channel.texts), help: 'Utility page MIDI Channel: NONE takes no channel message or SysEx, OMNI takes every channel' },
    { key: 'transmit', section: 'midi', group: 'MIDI', label: 'Transmit Program Change', offset: AT.transmit, options: tx(U.transmit.texts), help: 'Utility page Transmit ProgramChange?' },
    { key: 'contrast', section: 'midi', group: 'Unit', label: U.contrast.label, offset: AT.contrast, options: tx(U.contrast.texts), help: 'Utility page LCD Contrast' },
    { key: 'current', section: 'midi', group: 'Unit', label: 'Program loaded', offset: AT.current, options: PROGRAM_OPTIONS, readOnly: true, help: 'The program the unit had loaded when it sent its memory' },
    ...Array.from({ length: 128 }, (_, i) => ({
      key: `map${i}`, section: 'map', group: 'Program map', label: `Midi Program ${i + 1}`, offset: AT.map + i, options: PROGRAM_OPTIONS,
      help: `Utility page "Midi Program ${i + 1} is ... on DSP256": the program a MIDI program change ${i + 1} loads`,
    })),
    ...Array.from({ length: LAYOUT.linkCount }, (_, id) => {
      const off = AT.links + id;
      const name = linkByte.get(off);
      return {
        key: `link${id}`, section: 'links', group: 'Linked to CC', label: name || `Link ${id} (no name on the page)`, offset: off,
        ...(name ? { options: LINK_OPTIONS } : { input: 'number', min: 0, max: 255 }),
        help: name ? `Utility page "${name} Linked to CC": the controller that moves this parameter in every configuration that has it`
          : 'No parameter uses this link, so the utility page never shows it; shown as stored',
      };
    }),
    { key: 'mode', section: 'foot', group: 'Controller', label: 'Controller', offset: AT.mode, options: [[0xff, U.modes['255']], [0x00, U.modes['0']]],
      help: 'Hand Controller (the keys do what their legends say) or Foot Controller (each switch does the function below)' },
    ...Array.from({ length: 15 }, (_, k) => ({
      key: `fn${k + 1}`, section: 'foot', group: 'Foot switch functions', label: `Switch ${k + 1}`, offset: AT.functions + k + 1, options: FUNCTION_OPTIONS,
      help: `The function of foot controller switch code ${k + 1} (the switch you press on the controller page; its number is not shown)`,
    })),
    ...Array.from({ length: 15 }, (_, k) => ({
      key: `pa${k + 1}`, section: 'foot', group: 'Foot switch patches', label: `Switch ${k + 1}`, offset: AT.patches + k + 1, options: PROGRAM_OPTIONS,
      help: `The program Patch Select loads for switch code ${k + 1}`,
    })),
    ...[['fn0', AT.functions, 'Switch 0 function', 'The function entry for switch code 0, which no switch has'], ['pa0', AT.patches, 'Switch 0 patch', 'The patch entry for switch code 0, which no switch has'], ...AT.spare.map((o, n) => [`x${o}`, o, `Spare byte ${n + 1}`, 'A spare value between the tables'])].map(([key, off, label, what]) => ({
      key, section: 'foot', group: 'Bytes (exact)', label, offset: off, min: 0, max: 255, input: 'number',
      help: `${what}: kept in the unit's memory, but no page shows it`,
    })),
    ...CONFIGS.flatMap((c) => Array.from({ length: PROG }, (_, i) => {
      const pg = i === 0 ? null : pageOf(c.v, i);
      return {
        key: `m${c.v}b${i}`, section: 'memory', group: c.name, label: i === 0 ? 'Configuration' : pg ? pg.label : `Byte ${i}`, offset: AT.memory + PROG * c.v + i,
        ...(pg ? { options: opts(pg.t, pg.max), dynamic: (d) => ({ options: withValue(opts(tableOf(pg, memoryOf(d, c.v)), pg.max), d[AT.memory + PROG * c.v + i]) }) } : { min: 0, max: 255, input: 'number' }),
        hidden: i === 0, help: `${c.name}'s memory: what a program switched to ${c.name} starts from`,
      };
    })),
  ];

  // ------------------------------------------------------------------ simulator
  function simulate() {
    const st = { dump: Uint8Array.from(FIRST), stored: 0 };
    const loaded = () => st.dump[AT.current];
    return {
      state: st,
      get current() { return loaded(); },
      handle(d) {
        const ch = st.dump[AT.channel];
        if ((d[0] & 0xf0) === 0xc0) {
          if (ch === 17 || (d[0] & 15) === ch - 1) st.dump[AT.current] = st.dump[AT.map + (d[1] & 0x7f)];
          return [];
        }
        if (d[0] !== 0xf0) return null;
        const m = parse(d);
        if (!m || !(ch === 17 || m.ch === ch - 1)) return [];
        switch (m.kind) {
          case 'request': return [Uint8Array.from(allMessage(st.dump, m.ch))];
          case 'all': st.dump.set(m.data); return [];
          case 'program': if (m.n < 128) { programIntoDump(st.dump, m.n, m.data); st.stored++; } return [];
          default: return [];
        }
      },
    };
  }

  // ------------------------------------------------------------------ monitor, library
  const cfgName = (d) => configInfo(d)?.name ?? `configuration ${d[0]}`;
  function describe(raw) {
    const m = parse(raw);
    if (!m) return isDsp256(raw) ? NAME + ' message' : null;
    switch (m.kind) {
      case 'request': return NAME + ' request: all memory';
      case 'programRequest': return `${NAME} program request ${m.n == null ? '' : m.n + 1} (jumps to RAM in v1.05: not used)`;
      case 'dsp': return NAME + ' DSP register write';
      case 'all': return NAME + ' all memory (128 programs, configuration memories, settings)';
      case 'program': return `${NAME} program ${m.n + 1} "${titleOf(m.data)}" (${cfgName(m.data)})`;
      default: return NAME + ' message';
    }
  }
  function libraryItems(msgs) {
    const items = [];
    for (const raw of msgs) {
      const m = parse(raw);
      if (m?.kind === 'program') items.push({ key: `p${m.n}`, label: `Program ${m.n + 1}`, name: titleOf(m.data), object: 'effect', data: m.data, msgs: [Uint8Array.from(raw)] });
      else if (m?.kind === 'all') {
        for (let i = 0; i < 128; i++) {
          const d = programFromDump(m.data, i);
          items.push({ key: `p${i}`, label: `Program ${i + 1}`, name: titleOf(d), object: 'effect', data: d, msgs: [Uint8Array.from(programMessage(i, d, m.ch))] });
        }
        items.push({ key: 'all', label: 'All memory (settings)', name: '', object: 'system', data: m.data, msgs: [Uint8Array.from(raw)] });
      } else if (m?.kind !== 'request') items.push({ key: `x${items.length}`, label: describe(raw) || 'Other message', name: '', object: null, msgs: [raw] });
    }
    return items;
  }

  // ------------------------------------------------------------------ Head Library translator
  // toCommon: the configuration's blocks become effects.reverb (Reverb Decay / Reverse Time / Gate Decay Time,
  // Pre-Delay), effects.delay (Delay Time or Tap1, Delay Feedback), effects.modulation and effects.chorus (Chorus /
  // Flange LFO Speed and Depth), effects.eq (a flag), each value as a fraction of its page's range; the exact bytes
  // and title in extra (family 'digitech-dsp256'). fromCommon: the same family loads the bytes; anything else picks a
  // configuration with the blocks the source uses, starts from the first factory preset with it, sets what maps and
  // keeps the title of the program it replaces.
  const FAMILY = opt.id;
  function frac(d, label) {
    const pg = findPage(d[0], label);
    return pg ? Math.max(0, Math.min(1, d[pg.p] / Math.max(1, pg.max))) : undefined;
  }
  function setFrac(d, label, f, r, what) {
    const pg = findPage(d[0], label);
    if (!pg || f === undefined || f === null || Number.isNaN(f)) return;
    d[pg.p] = Math.round(Math.max(0, Math.min(1, f)) * pg.max);
    r.approximated.push(what || label);
  }
  const blocks = (c) => {
    const n = CONFIGS[c]?.name || '';
    return {
      reverb: /Reverb|Room|Hall|Gated|Reverse/.test(n), delay: /Delay|Dly|Tap/.test(n), chorus: /Chorus|Cho/.test(n),
      flange: /Flange|Fla/.test(n), eq: /EQ|Para/.test(n),
    };
  };
  function toCommon(d) {
    const b = blocks(d[0]);
    const effects = {};
    const first = (...labels) => labels.map((l) => frac(d, l)).find((x) => x !== undefined);
    if (b.reverb) {
      effects.reverb = { type: cfgName(d), time: first('Reverb Decay', 'Reverse Time', 'Gate Decay Time', 'Norm Room Volume') ?? 0.5, level: 1 };
      const pre = first('Reverb Predelay', 'Pre-Delay Time');
      if (pre !== undefined) effects.reverb.preDelay = pre;
    }
    if (b.delay) effects.delay = { type: cfgName(d), time: first('Delay Time', 'Delay Time Tap1', 'Chorus Dly Time', 'Flange Dly Time') ?? 0.5, feedback: first('Delay Feedback', 'Delay Time Feed') ?? 0, level: 1 };
    if (b.chorus || b.flange) {
      const k = b.chorus ? 'Chorus' : 'Flange';
      effects.modulation = { type: b.chorus ? 'CHORUS' : 'FLANGER', rate: frac(d, `${k} LFO Speed`) ?? 0.5, depth: frac(d, `${k} LFO Depth`) ?? 0.5, level: 1 };
      if (b.chorus) effects.chorus = { ...effects.modulation };
    }
    if (b.eq) effects.eq = { type: cfgName(d), level: 1 };
    return { model: 1, kind: 'effect', name: titleOf(d), effects, extra: { family: FAMILY, model: opt.id, configuration: cfgName(d), labels: (configInfo(d)?.params || []).map((x) => x.label), data: Array.from(d.slice(0, SIZE)), match: hashBytes(d.slice(0, SIZE)) } };
  }
  function fromCommon(c, base) {
    const r = emptyReport();
    const x = c?.extra;
    if (x?.family === FAMILY && Array.isArray(x.data) && x.data.length === SIZE) {
      const d = Uint8Array.from(x.data, (v) => v & 0xff);
      r.mapped.push(`Program (exact, ${cfgName(d)})`);
      return { data: d, report: tidy(r) };
    }
    // the other DSP-256 model: the same configuration (by name, with the same pages) keeps every byte
    const same = x && /^digitech-dsp256/.test(String(x.family)) && Array.isArray(x.data) && x.data.length === SIZE
      ? CONFIGS.find((cf) => cf.name === x.configuration && JSON.stringify(cf.params.map((q) => q.label)) === JSON.stringify(x.labels || [])) : null;
    if (same) {
      const d = Uint8Array.from(x.data, (v) => v & 0xff);
      d[0] = same.v;
      r.mapped.push(`Program (exact, ${same.name} from the other model)`);
      return { data: d, report: tidy(r) };
    }
    const fx = c?.effects || {};
    const on = (e) => e && (e.level ?? 1) > 0;
    const want = {
      reverb: on(fx.reverb), delay: on(fx.delay), chorus: on(fx.chorus) || /CHORUS/i.test(String(fx.modulation?.type || '')),
      flange: /FLANG/i.test(String(fx.modulation?.type || '')),
    };
    if (!want.reverb && !want.delay && !want.chorus && !want.flange) {
      r.dropped.push('No effect in the source sound: the program keeps its configuration and values');
      return { data: Uint8Array.from(base || factory(0)), report: tidy(r) };
    }
    // the configuration with every wanted block and the fewest others
    let best = -1;
    let bestScore = -1e9;
    for (const cf of CONFIGS) {
      const b = blocks(cf.v);
      if (!PRESETS.some((p) => parseInt(p[1].slice(0, 2), 16) === cf.v)) continue;
      let s = 0;
      for (const k of Object.keys(want)) s += want[k] ? (b[k] ? 10 : -20) : (b[k] ? -1 : 0);
      if (b.eq) s -= 1;
      if (s > bestScore) { bestScore = s; best = cf.v; }
    }
    const n = PRESETS.findIndex((p) => parseInt(p[1].slice(0, 2), 16) === best);
    const d = factory(n);
    r.approximated.push(`Configuration ${CONFIGS[best].name}, starting from factory preset ${129 + n} (${PRESET_NAMES[n]})`);
    if (fx.reverb) { for (const l of ['Reverb Decay', 'Reverse Time', 'Gate Decay Time']) setFrac(d, l, fx.reverb.time, r, 'Reverb time'); setFrac(d, 'Reverb Predelay', fx.reverb.preDelay, r, 'Pre-delay'); setFrac(d, 'Pre-Delay Time', fx.reverb.preDelay, r, 'Pre-delay'); }
    if (fx.delay) { setFrac(d, 'Delay Time', fx.delay.time, r, 'Delay time'); setFrac(d, 'Delay Feedback', fx.delay.feedback, r, 'Delay feedback'); }
    const mod = fx.chorus || fx.modulation;
    if (mod) for (const k of ['Chorus', 'Flange']) { setFrac(d, `${k} LFO Speed`, mod.rate, r, 'Modulation rate'); setFrac(d, `${k} LFO Depth`, mod.depth, r, 'Modulation depth'); }
    for (const k of Object.keys(fx)) if (!['reverb', 'delay', 'chorus', 'modulation', 'eq'].includes(k)) r.dropped.push(`Effect ${k}`);
    if (base) d.set(base.slice(PROG, SIZE), PROG);
    else if (c?.name) setTitle(d, c.name);
    return { data: d, report: tidy(r) };
  }

  // ------------------------------------------------------------------ gallery
  const SVG = 'http://www.w3.org/2000/svg';
  const blocksOf = (v) => { const n = CONFIGS[v]?.name || ''; return n.includes('+') ? n.split('+') : [n]; };
  function drawBlocks({ value }) {
    const bl = blocksOf(value);
    const w = 64;
    const gap = 10;
    const W = Math.max(1, bl.length) * (w + gap) + gap;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} 40`);
    svg.setAttribute('width', String(Math.min(260, W)));
    const el = (tag, attrs, text) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
    bl.forEach((b, i) => {
      const x = gap + i * (w + gap);
      el('rect', { x, y: 8, width: w, height: 24, rx: 3, fill: 'none', stroke: 'currentColor' });
      el('text', { x: x + w / 2, y: 24, 'text-anchor': 'middle', 'font-size': b.length > 10 ? 7 : 8, fill: 'currentColor' }, b);
      if (i) el('line', { x1: x - gap, y1: 20, x2: x, y2: 20, stroke: 'currentColor' });
    });
    return svg;
  }

  // ------------------------------------------------------------------ definition
  const chOf = (ctx) => (ctx?.channel ?? 0) & 15;
  const isAll = (r) => parse(r)?.kind === 'all';
  /** Read the whole memory (00 request, 41h answer: about 11 KB, almost 4 s at MIDI speed). */
  async function fetchAll(api) {
    const reply = await api.g.client.request(Uint8Array.from(requestAll(chOf(api.ctx))), { match: (_m, r) => isAll(r), timeout: 15000 });
    const d = parse(reply.raw ?? reply).data;
    unit.dump = Uint8Array.from(d);
    return d;
  }
  const sendParam = (_p, _v, d, ctx) => writeAndLoad(d, unit.target, chOf(ctx));
  const def = {
    coverage: `Edits the ${NAME}'s programs (all 27 configurations with every edit page and the value texts its display shows; the title), its 128 user programs, its configuration memories and its utility settings (MIDI channel, program map, the Linked to CC controller of each of the 90 named parameters, transmit program change, LCD contrast, the foot controller switch functions and patches), and shows the 128 factory presets. Reads and writes the unit\'s whole memory, writes single programs and loads them with a program change. Not checked on hardware.`,
    sysex: { manufacturer: [0x00, 0x00, 0x10], model: LAYOUT.model },
    minGap: 20,
    describe,
    recognise: (raw) => isDsp256(raw),
    isOwn: isDsp256,
    isRequest,
    simulate,
    libraryItems,
    objects: [
      {
        key: 'effect', page: 'Program', icon: '◆', label: 'Program', size: SIZE,
        init: () => factory(0),
        fetch: async (api) => (unit.target < 128 ? programFromDump(await fetchAll(api), unit.target) : factory(unit.target - 128)),
        receive: (raw) => { const m = parse(raw); return m?.kind === 'program' ? m.data : null; },
        params: programParams,
        groupInfo: { 'Bytes (exact)': { table: true, note: 'The 21 parameter bytes as typed numbers (the pages above show the same bytes with the unit\'s texts).' } },
        sendParam,
        name: titleOf,
        setName: setTitle,
        category: () => 'none',
        patchKinds: ['effect'],
        toCommon,
        fromCommon,
        cols: 4,
        target: {
          label: 'User program', title: 'The user program edits are written into and then loaded with a program change (program map 1:1, as after the first power-up)',
          options: () => Array.from({ length: 128 }, (_, i) => [i, `${i + 1} ${unit.dump ? titleOf(programFromDump(unit.dump, i)) : ''}`.trim()]),
          value: () => unit.target, set: (v) => { unit.target = Number(v); },
        },
        note: 'The unit cannot take edits to the program it is playing: each change writes the whole program into the user program chosen above and loads it with a program change, so it is heard. Get reads the whole memory (about 4 s) and takes that program from it.',
        toSyx: (data, ctx) => programMessage(unit.target, data, chOf(ctx)),
        fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.kind === 'program') return m.data; if (m?.kind === 'all') return programFromDump(m.data, unit.target); } return null; },
        sendAll: { label: 'Write and load', build: (data, ctx) => writeAndLoad(data, unit.target, chOf(ctx)) },
        actions: [
          { label: 'Rename', run: async (api) => {
            const r = await api.form('Title', [{ key: 'name', label: 'Title (16 characters)', value: titleOf(api.data), maxlength: TITLE_LEN }]);
            if (!r) return;
            const d = Uint8Array.from(api.data);
            setTitle(d, r.name);
            api.setData(d);
          } },
        ],
        galleries: [{
          key: 'configurations', page: 'Configurations', icon: '▦', param: 'config',
          note: 'The blocks of each configuration, in the order of its name. Choosing one switches the program to it as the panel does: the configuration\'s memory gives the other values.',
          label: (v) => `${v} ${CONFIGS[v].name}`,
          draw: drawBlocks,
        }],
        slots: {
          label: 'Programs', banks: [[0, 'User 1-128'], [1, 'Factory 129-256']],
          count: () => 128,
          slotLabel: (bank, i) => String(bank ? 129 + i : 1 + i),
          note: (bank) => (bank ? 'Factory presets, built into the unit: Edit loads one from the editor\'s own copy; Play loads it with a program change when the program map points there.'
            : 'Edit and Read names read the whole memory; Store writes the program (without loading it); Play sends a program change (program map 1:1).'),
          names: (bank) => (bank === 1 ? PRESET_NAMES : null),
          writable: (bank) => bank === 0,
          name: titleOf,
          recall: (bank, i, ctx) => { if (!bank) unit.target = i; return bank ? [] : [programChange(i, chOf(ctx))]; },
          fetch: async (api, bank, i) => { if (bank === 1) return factory(i); unit.target = i; return programFromDump(unit.dump || await fetchAll(api), i); },
          scanBank: async (api, bank, onName) => {
            if (bank === 1) { PRESET_NAMES.forEach((s, i) => onName(i, s)); return; }
            const d = await fetchAll(api);
            for (let i = 0; i < 128; i++) onName(i, titleOf(programFromDump(d, i)));
          },
          store: (_bank, i, ctx, data) => [programMessage(i, data, chOf(ctx))],
        },
      },
      {
        key: 'system', page: 'Settings', icon: '⚙', label: 'Settings', size: DUMP_SIZE, notLive: true,
        init: () => Uint8Array.from(FIRST),
        fetch: async (api) => fetchAll(api),
        receive: (raw) => { const m = parse(raw); if (m?.kind !== 'all') return null; unit.dump = Uint8Array.from(m.data); return m.data; },
        params: settingsParams,
        sections: [{ key: 'midi', label: 'MIDI and unit' }, { key: 'map', label: 'Program map' }, { key: 'links', label: 'Linked to CC' }, { key: 'foot', label: 'Foot controller' }, { key: 'memory', label: 'Configuration memory' }],
        cols: 3,
        note: 'The unit\'s whole memory: the utility settings, the configuration memories and, not shown here, the 128 user programs. The unit has no message for the settings alone: Send writes the whole memory back, programs included, as they were read.',
        actions: [
          { label: `Send to the ${NAME}`, title: 'Send the whole memory: settings, configuration memories and the 128 user programs as read', run: async (api) => {
            const ok = await api.confirm('Send all memory', 'This replaces every user program, the configuration memories and the settings with the copy read last (Get first).', 'Send');
            if (ok) api.send([allMessage(api.data, chOf(api.ctx))]);
          } },
          { label: 'First power-up contents', title: 'The memory as the unit sets it after a battery failure (factory presets in the user programs, channel 1, map 1:1)', run: (api) => api.setData(Uint8Array.from(FIRST)) },
        ],
        toSyx: (data, ctx) => allMessage(data, chOf(ctx)),
        fromSyx: (msgs) => { for (const r of msgs) { const m = parse(r); if (m?.kind === 'all') return m.data; } return null; },
      },
    ],
    midiNotes: [
      'SysEx F0 00 00 10 <channel - 1> 06 <command> ... F7, taken on the unit MIDI channel (any with OMNI, none with NONE). Data bytes travel as pairs: bit 7, then bits 6-0.',
      'Commands: 00 request (the unit answers 41h), 41h all memory (5718 bytes: 128 titles, 128 programs, 27 configuration memories, settings), 42h one program (number 0-127, 22 program bytes, 16 title characters: stored, not loaded).',
      '01h (program request) jumps to RAM address 0042h in v1.04 and v1.05, and 40h writes a DSP register directly: the editor sends neither.',
      'Program change: the program map (utility pages) turns MIDI program 1-128 into program 1-256; taken while the unit shows a program (not in the utility or title pages).',
      'Control change: each parameter can be Linked to a CC (0-128) or channel pressure (ChP) on the utility pages.',
    ],
  };

  const _test = { simulate, toCommon, fromCommon, describe, libraryItems, unit, setConfig, blocks };

  return { def, _test, FIRMWARE, CONFIGS, TABLES, UTILITY, PRESETS, LAYOUT, PROG, TITLE_LEN, SIZE, DUMP_SIZE, AT, FIRST, isDsp256, pairs, unpairs, requestAll, programMessage, allMessage, programChange, parse, isRequest, configOf, configInfo, isTitleChar, titleOf, setTitle, PRESET_NAMES, factory, programFromDump, programIntoDump, memoryOf, pageOf, textOf, tableOf, groupOf, programParams, paramOf, findPage, writeAndLoad, settingsParams, blocksOf };
}
