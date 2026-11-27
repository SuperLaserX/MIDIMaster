// Send Head Library patches to the open device: one patch into the editor or the edit buffer, or
// any number (a selection, a whole sub-library, search results) into consecutive memory slots.
// Patches of another model go through its translator (the shared synth model). Used by the Main
// Library page and by a device Branch Library's Head Library panel.

import { h, clear, toast, dialog } from '../../core/ui/dom.js';
import { objectFromPatch, kindsOf } from '../patches.js';
import { asList } from './objects.js';
import { translationView } from '../../core/ui/mainlib.js';
import { waitUntil } from '../../core/midi/schedule.js';


/** How Head Library row `r` fits device module `g`: {obj, mode: 'native'|'translate'} | {mode: 'data'} | null. */
export function fitFor(g, r) {
  const def = g.def;
  const same = (id) => id === g.entry.id || (def?.deviceIds || []).includes(id);
  if (r.kind === 'data') return same(r.device) ? { mode: 'data' } : null;
  for (const obj of def?.objects || []) {
    if (!kindsOf(obj).includes(r.kind)) continue;
    if (same(r.device) && r.native !== false) return { obj, mode: 'native' };
    if (r.hasCommon && obj.fromCommon) return { obj, mode: 'translate' };
  }
  return null;
}

/** The writable (bank, slot) positions of an object's memory, in order. */
export function slotList(g, obj) {
  const s = obj.slots;
  if (!s?.store) return [];
  const banks = (typeof s.banks === 'function' ? s.banks(g.ctx) : s.banks).filter(([b]) => s.writable?.(b, g.ctx) !== false);
  const out = [];
  for (const [bank, label] of banks) {
    const count = typeof s.count === 'function' ? s.count(bank, g.ctx) : s.count;
    for (let i = 0; i < count; i++) out.push({ bank, slot: i, bankLabel: label, label: s.slotLabel ? s.slotLabel(bank, i) : `${label} ${i + 1}` });
  }
  return out;
}

/** Paced sending (MIDI speed), with progress. The client schedules each message with a Web MIDI
 *  timestamp (core/midi/schedule.js), leaving the time a message takes to go out before the next. */
async function sendPaced(g, msgs, onProgress) {
  let last = null;
  for (let i = 0; i < msgs.length; i++) {
    // the client's throughput: the global setting, or the device's measured speed (speedtest.js)
    const bps = g.client.s?.bytesPerSecond || g.host.settings.value.midi.bytesPerSecond;
    const r = await g.client.send(Uint8Array.from(msgs[i]), { gapAfter: (msgs[i].length / bps) * 1000 });
    last = r?.at ?? last;
    onProgress?.(i + 1, msgs.length);
  }
  if (last) await waitUntil(last); // the last message has gone out
}

/**
 * The send dialog and the job. g: the open device module; lib: the Head Library; rows: Head Library
 * rows ({sub, id, name, kind, device, model, hasCommon, native}).
 */
export async function sendToDevice(g, lib, rows) {
  const items = rows.map((r) => ({ r, m: fitFor(g, r) }));
  const loadable = items.filter((x) => x.m?.obj);
  const skipped = items.filter((x) => !x.m?.obj);
  if (!loadable.length) {
    toast(`The ${g.entry.model} cannot load ${rows.length === 1 ? `"${rows[0].name}"` : 'any of these'}: no editor object takes this kind, and no translator reads it.`, 'warn', 6000);
    return;
  }
  // one object kind at a time (the first one's): a patch selection goes to patch memory
  const obj = loadable[0].m.obj;
  const jobs = loadable.filter((x) => x.m.obj === obj);
  const otherKind = loadable.length - jobs.length;
  const translated = jobs.filter((x) => x.m.mode === 'translate').length;
  const slots = slotList(g, obj);
  const one = jobs.length === 1;

  const modes = [];
  if (one) modes.push(['editor', `Load into the ${obj.page || obj.label} page (nothing is sent)`]);
  if (one && obj.sendAll) modes.push(['buffer', `Load and send to the ${g.entry.model}'s edit buffer (heard at once)`]);
  if (slots.length) modes.push(['slots', one ? 'Store into a memory slot' : `Store into ${jobs.length} memory slots, one after another`]);
  if (!modes.length) { toast(`The ${g.entry.model}'s ${obj.label} has no memory to store into.`, 'warn'); return; }

  const modeSel = h('select', modes.map(([v, l]) => h('option', { value: v }, l)));
  const names = g.slotNames?.[obj.key];
  const startSel = h('select', slots.map((p, k) => {
    const n = names?.get(`${p.bank}:${p.slot}`);
    return h('option', { value: k }, `${p.label}${n ? `  ${n}` : ''}`);
  }));
  const preview = h('div.small');
  const slotRow = h('label.field', one ? 'Slot' : 'First slot', startSel);
  const update = () => {
    const slotsMode = modeSel.value === 'slots';
    slotRow.hidden = !slotsMode;
    clear(preview);
    if (!slotsMode) return;
    const k = Number(startSel.value);
    const fit = Math.min(jobs.length, slots.length - k);
    const first = slots[k], last = slots[k + fit - 1];
    const over = [];
    for (let j = 0; j < fit; j++) { const p = slots[k + j]; const n = names?.get(`${p.bank}:${p.slot}`); if (n && n.trim()) over.push(`${p.label} ${n}`); }
    preview.append(
      h('div', `${fit} patch(es) into ${first.label}${fit > 1 ? ` - ${last.label}` : ''}.${fit < jobs.length ? ` ${jobs.length - fit} do not fit after that slot and are left out.` : ''}`),
      h('div.c-warn', `This replaces what is in ${fit > 1 ? 'those slots' : 'that slot'} on the ${g.entry.model}.`),
      over.length ? h('div.muted', `Replaced: ${over.slice(0, 8).join(', ')}${over.length > 8 ? `, and ${over.length - 8} more` : ''}`) : null);
  };
  modeSel.addEventListener('change', update);
  startSel.addEventListener('change', update);
  update();

  // a single translated patch: show what the translation keeps and loses
  let report = null;
  if (one && translated) {
    const c = await convert(lib, g, jobs[0]);
    if (!c) return;
    report = translationView(c.report, c.mode);
  }
  const ok = await dialog(one ? `Send "${jobs[0].r.name}" to the ${g.entry.model}` : `Send ${jobs.length} patches to the ${g.entry.model}`, h('div.col',
    h('div.small.muted', [
      `${jobs.length} ${obj.label.toLowerCase()}(s)`,
      translated ? `${translated} translated from another model through the shared synth model` : 'all native',
      skipped.length ? `${skipped.length} left out (the ${g.entry.model} cannot load them)` : '',
      otherKind ? `${otherKind} of another kind left out (send them separately)` : '',
    ].filter(Boolean).join('; ') + '.'),
    h('label.field', 'What to do', modeSel),
    slotRow, preview, report), [
    { label: 'Cancel', value: false }, { label: 'Send', value: true, primary: true }]);
  if (!ok) return;
  const mode = modeSel.value;

  if (mode === 'editor' || mode === 'buffer') {
    const c = await convert(lib, g, jobs[0]);
    if (!c) return;
    g.setObjectData(obj.key, c.data);
    if (mode === 'buffer') {
      if (!g.connected) { toast('Choose the MIDI output on the Connect page first.', 'warn'); return; }
      await sendPaced(g, asList(obj.sendAll.build(c.data, g.ctx)));
      toast(`"${c.patch.name}" sent to the ${g.entry.model}${c.mode === 'translate' ? ` (translated from the ${c.patch.device.model})` : ''}.`, 'good', 4000);
    } else toast(`"${c.patch.name}" is in the ${obj.page || obj.label} page. Nothing was sent.`, 'info', 5000);
    return;
  }

  if (!g.connected) { toast('Choose the MIDI output on the Connect page first.', 'warn'); return; }
  const k0 = Number(startSel.value);
  const n = Math.min(jobs.length, slots.length - k0);
  const done = [];
  const failed = [];
  try {
    for (let j = 0; j < n; j++) {
      const p = slots[k0 + j];
      g.setBusy(1, `Storing ${j + 1}/${n}: "${jobs[j].r.name}" into ${p.label}`);
      const c = await convert(lib, g, jobs[j]);
      if (!c) { failed.push(jobs[j].r.name); continue; }
      await sendPaced(g, asList(obj.slots.store(p.bank, p.slot, g.ctx, c.data)));
      if (obj.slots.name) g.setSlotName(obj.key, p.bank, p.slot, obj.slots.name(c.data) ?? '');
      done.push(p.label);
    }
  } finally { g.setBusy(0); }
  toast(`Stored ${done.length} patch(es)${done.length ? ` into ${done[0]}${done.length > 1 ? ` - ${done[done.length - 1]}` : ''}` : ''}.${failed.length ? ` ${failed.length} could not be read.` : ''}`, failed.length ? 'warn' : 'good', 6000);
}

async function convert(lib, g, { r, m }) {
  const patch = await lib.getPatch(r.sub, r.id);
  if (!patch) return null;
  const res = objectFromPatch(g.entry, g.def, m.obj, patch);
  return res ? { patch, ...res } : null;
}
