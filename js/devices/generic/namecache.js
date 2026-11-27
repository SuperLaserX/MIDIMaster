// Names read from a device (patch names per memory slot, wave names...), remembered in the browser
// per device (catalog id + device ID), so lists show them at once; they are read again when the
// device connects and updated where they changed.

const KEY = (id, dev) => `midimaster.names.${id}.${dev}`;

function read(id, dev) {
  try { return JSON.parse(localStorage.getItem(KEY(id, dev)) || '{}') || {}; } catch { return {}; }
}
function write(id, dev, all) {
  try { localStorage.setItem(KEY(id, dev), JSON.stringify(all)); } catch { /* storage unavailable or full */ }
}

/** Slot names remembered for a device: {objectKey: Map('bank:slot' -> name)}. */
export function loadSlotNames(id, dev) {
  const all = read(id, dev);
  const out = {};
  for (const [key, entries] of Object.entries(all.slots || {})) out[key] = new Map(Object.entries(entries));
  return out;
}

/** Remember a device's slot names ({objectKey: Map}). */
export function saveSlotNames(id, dev, slotNames) {
  const all = read(id, dev);
  all.slots = {};
  for (const [key, m] of Object.entries(slotNames)) if (m?.size) all.slots[key] = Object.fromEntries(m);
  all.saved = new Date().toISOString();
  write(id, dev, all);
}

/** A named list remembered for a device (e.g. wave names): Map(number -> name), empty when none. */
export function loadList(id, dev, list) {
  const v = read(id, dev).lists?.[list];
  return new Map(v ? Object.entries(v).map(([k, name]) => [Number(k), name]) : []);
}

/** Remember a named list (Map(number -> name)). */
export function saveList(id, dev, list, map) {
  const all = read(id, dev);
  (all.lists ??= {})[list] = Object.fromEntries(map);
  write(id, dev, all);
}
