// Which devices are connected: every MIDI output is asked who it is, and the answers are matched with
// the editors (js/devices/defs). Three ways, strongest first:
//   1. identity: the Universal Identity Request (F0 7E 7F 06 01 F7); a definition recognises its reply
//      with describeIdentity(raw) or identity(raw); otherwise the reply's maker names the candidates;
//   2. request: outputs that did not answer get each editor's own read request (def.probe; else the edit
//      buffer an object reads: an object with request + match, small; else the definition's first
//      request when it reads one small thing, its reply taken by recognise / isOwn); a reply the match
//      takes is the device (several editors taking it are ranked with their prefer(msgs) hooks);
//   3. port name: def.ports (a definition's own port names) or the model's name in the port name
//      (unconfirmed; left out for a device already found on another port).
// Only reads are sent. Devices made before about 1995 often answer nothing; they are listed as silent.
//
// scanPorts(access, {onProgress}) -> {at, devices: [{id, title, input, output, how, detail,
//   alternatives: [id]}], silent: [port], busy: [port]}

import { DEVICES, loadDef, MODULE_IDS } from './registry.js';
import { identityInfo, describeUniversal } from '../core/midi/describe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDENTITY = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
const isIdentityReply = (d) => d[0] === 0xf0 && d[1] === 0x7e && d[3] === 0x06 && d[4] === 0x02;
const key = (b) => Array.from(b).join(',');
const asList = (out) => (!out ? [] : Array.isArray(out[0]) || out[0] instanceof Uint8Array ? out : [out]);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const GENERIC = new Set(['desktop', 'keyboard', 'rack', 'module', 'and', 'laptop', 'the', 'midi', 'usb', 'port', 'in', 'out']);

/** The editors with their definitions loaded: [{entry, def}] (definitions shared by models appear once per model). */
export async function editorDefs() {
  const editors = DEVICES.filter((d) => d.hasDef);
  const out = [];
  for (const entry of editors) {
    try { out.push({ entry, def: await loadDef(entry.id) }); } catch { /* a definition that fails to load is skipped */ }
  }
  return out;
}

/** The read request a definition can be recognised by: {msgs, match} or null. */
export function probeOf(entry, def) {
  const ctx = { channel: 0, deviceId: def?.sysex?.deviceIdDefault ?? 0, entry, data: {}, names: {}, loaded: new Set(), settings: {} };
  try {
    if (def?.probe) return { msgs: asList(def.probe.bytes(ctx)).map((m) => Uint8Array.from(m)), match: def.probe.match };
    const objs = (def?.objects || []).filter((o) => o.request && o.match && !(o.size > 4096));
    const obj = objs.find((o) => o.autoLoad) || objs[0];
    if (obj) {
      const msgs = asList(obj.request(ctx)).map((m) => Uint8Array.from(m)).filter((m) => m[0] === 0xf0);
      if (msgs.length) return { msgs, match: (raw) => { try { return !!obj.match(raw, ctx); } catch { return false; } } };
    }
    // the definition's first request, when it reads one small thing (an edit buffer, the system
    // settings; never a bank or "all"), with the reply recognised by the definition's own test
    const r = def?.requests?.[0];
    if (!r || /(all|banks?|dump|memory)/i.test(r.label)) return null;
    const msgs = asList(r.bytes(ctx)).map((m) => Uint8Array.from(m)).filter((m) => m[0] === 0xf0);
    const mfr = def.sysex?.manufacturer;
    const own = def.recognise || def.isOwn || (mfr ? (raw) => mfr.every((b, i) => raw[1 + i] === b) : null);
    if (!msgs.length || !own) return null;
    return { msgs, match: (raw) => { try { return !def.isRequest?.(raw) && !!own(raw); } catch { return false; } } };
  } catch { return null; }
}

/** Editors whose model name is in a port name: [{entry, score}] (best first). */
export function byPortName(name, entries = DEVICES.filter((d) => d.hasDef || d.hasModule), defs = new Map()) {
  const port = norm(name);
  const found = [];
  for (const entry of entries) {
    const def = defs.get(entry.id);
    if (def?.ports?.output?.test(name) || def?.ports?.input?.test(name)) { found.push({ entry, score: 2 }); continue; }
    // the model's words, single letters joined to the next ("V-Synth XT" -> vsynth, xt)
    const words = [];
    for (const w of String(entry.model).toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9]+/).filter(Boolean)) {
      if (words.length && words[words.length - 1].length === 1) words[words.length - 1] += w; else words.push(w);
    }
    const sig = words.filter((w) => !GENERIC.has(w));
    if (!sig.length) continue;
    const hits = sig.filter((w) => port.includes(w));
    if (!hits.some((w) => w.length >= 4) && !port.includes(norm(entry.model))) continue;
    const score = port.includes(norm(entry.model)) ? 1.5 : hits.length / sig.length;
    if (score >= 0.5) found.push({ entry, score });
  }
  return found.sort((a, b) => b.score - a.score);
}

/** The input that belongs to an output: the one that answered, else the same name. */
function pairInput(inputs, outName, answeredOn) {
  if (answeredOn) return answeredOn;
  const base = (n) => n.replace(/\s*\d+$/, '').trim();
  return inputs.find((i) => i.name === outName)?.name || inputs.find((i) => base(i.name) === base(outName))?.name || '';
}

/** Rank the editors that took a reply: their prefer(replies) hooks, then catalog order. */
function rank(cands, replies) {
  const score = (c) => { try { return c.def?.prefer ? Number(c.def.prefer(replies)) || 0 : 1; } catch { return 1; } };
  return cands.map((c) => ({ ...c, s: score(c) })).sort((a, b) => b.s - a.s);
}

export async function scanPorts(access, { onProgress = () => {}, identityMs = 900, probeMs = 1800, gap = 25 } = {}) {
  const inputs = [...access.inputs.values()];
  const outputs = [...access.outputs.values()];
  const heard = [];
  const offs = inputs.map((inp) => {
    const fn = (e) => { if (e.data?.[0] === 0xf0) heard.push({ at: performance.now(), input: inp.name, data: Uint8Array.from(e.data) }); };
    inp.addEventListener('midimessage', fn);
    return () => inp.removeEventListener('midimessage', fn);
  });
  onProgress('Loading the editors...');
  const defs = await editorDefs();
  const defById = new Map(defs.map((x) => [x.entry.id, x.def]));
  const devices = [];
  const silent = [];
  const busy = [];
  const send = (out, bytes) => out.send(Array.from(bytes));
  try {
    for (const [i, out] of outputs.entries()) {
      const n = `${i + 1}/${outputs.length}`;
      // 1. identity request
      onProgress(`${n} ${out.name}: identity request...`);
      let t0 = performance.now();
      try { await out.open?.(); send(out, IDENTITY); } catch { busy.push(out.name); continue; }
      await sleep(identityMs);
      const ids = heard.filter((x) => x.at >= t0 && isIdentityReply(x.data));
      if (ids.length) {
        const raw = ids[0].data;
        const strong = defs.filter(({ def }) => { try { return !!(def.describeIdentity?.(raw) || def.identity?.(raw)); } catch { return false; } });
        const info = identityInfo(raw);
        const maker = strong.length ? [] : defs.filter(({ entry }) => entry.sysex && entry.sysex.toUpperCase() === String(info.id).toUpperCase());
        const list = strong.length ? rank(strong, [raw]) : maker;
        if (list.length) {
          devices.push({ id: list[0].entry.id, title: list[0].entry.title, input: ids[0].input, output: out.name, how: strong.length ? 'identity' : 'maker', detail: describeUniversal(raw), alternatives: list.slice(1).map((x) => x.entry.id) });
          continue;
        }
        devices.push({ id: null, title: describeUniversal(raw), input: ids[0].input, output: out.name, how: 'identity-unknown', detail: describeUniversal(raw), alternatives: [] });
        continue;
      }
      // 2. the editors' own read requests
      onProgress(`${n} ${out.name}: trying each editor's read request...`);
      const probes = new Map(); // bytes key -> {msgs, cands: [{entry, def, match}]}
      for (const { entry, def } of defs) {
        const p = probeOf(entry, def);
        if (!p) continue;
        const k = p.msgs.map(key).join('|');
        if (!probes.has(k)) probes.set(k, { msgs: p.msgs, cands: [] });
        probes.get(k).cands.push({ entry, def, match: p.match });
      }
      const sent = new Set();
      t0 = performance.now();
      try {
        for (const { msgs } of probes.values()) for (const m of msgs) { send(out, m); sent.add(key(m)); await sleep(gap); }
      } catch { busy.push(out.name); continue; }
      await sleep(probeMs);
      const replies = heard.filter((x) => x.at >= t0 && !sent.has(key(x.data)) && !isIdentityReply(x.data));
      const took = [];
      for (const { cands } of probes.values()) {
        for (const c of cands) {
          const mine = replies.filter((r) => { try { return c.match(r.data); } catch { return false; } });
          if (mine.length) took.push({ ...c, replies: mine });
        }
      }
      if (took.length) {
        const best = rank(took, took[0].replies.map((r) => r.data));
        devices.push({ id: best[0].entry.id, title: best[0].entry.title, input: best[0].replies[0].input, output: out.name, how: 'request', detail: `answered the ${best[0].entry.model} editor's read request`, alternatives: best.slice(1).map((x) => x.entry.id) });
        continue;
      }
      silent.push(out.name);
    }
  } finally {
    offs.forEach((off) => off());
  }
  // 3. port names, for the outputs that answered nothing: a definition's own port names first (e.g.
  // "SYSTEM-8 CTRL"), then model names; none for a device already found, nor for another port of the same
  // USB device as a port that answered ("Virus TI MIDI" beside "Virus TI Synth")
  const found = new Set(devices.map((d) => d.id).filter(Boolean));
  const word = (n) => { const w = String(n).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || ''; return /^[a-z][a-z0-9]{2,}$/.test(w) ? w : ''; };
  const answered = new Set(devices.map((d) => word(d.output)).filter(Boolean));
  const named = [];
  const editors = DEVICES.filter((d) => d.hasDef || MODULE_IDS.includes(d.id));
  for (const strongPass of [true, false]) {
    for (const name of silent) {
      if (named.includes(name)) continue;
      const cands = byPortName(name, editors, defById).filter((c) => !found.has(c.entry.id) && (strongPass ? c.score >= 2 : c.score < 2));
      if (!cands.length || (!strongPass && answered.has(word(name)))) continue;
      devices.push({ id: cands[0].entry.id, title: cands[0].entry.title, input: pairInput(inputs, name, null), output: name, how: strongPass ? 'port' : 'name', detail: `port name "${name}"`, alternatives: cands.slice(1, 6).map((c) => c.entry.id) });
      found.add(cands[0].entry.id);
      answered.add(word(name));
      named.push(name);
    }
  }
  return { at: Date.now(), devices, silent: silent.filter((n) => !named.includes(n)), busy };
}
