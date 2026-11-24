// The Main Library page and the Librarian's Main Library panel, rendered on a fake DOM.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom, settle, byText, answer, change, openDialog } from './helpers/fakedom.js';
import { MainLibrary, MemoryFolder, KvStore } from '../js/core/mainlib/store.js';
import { patchFromObject, dataPatch } from '../js/devices/patches.js';
import { getDevice } from '../js/devices/registry.js';

let restore;
before(() => { restore = installFakeDom(); });
after(() => restore());

async function setup() {
  const lib = await new MainLibrary(new KvStore(null), { pickFolder: async () => new MemoryFolder() }).load();
  const jp80 = (await import('../js/devices/defs/roland-jp8080.js')).default;
  const jp00 = (await import('../js/devices/defs/roland-jp8000.js')).default;
  const e80 = getDevice('roland-jp8080');
  const e00 = getDevice('roland-jp8000');
  const named = (obj, name) => { const d = obj.init(); for (let i = 0; i < 16; i++) d[i] = (name.padEnd(16).charCodeAt(i)); return d; };
  const o80 = jp80.objects.find((o) => o.key === 'patch');
  const o00 = jp00.objects.find((o) => o.key === 'patch');
  const p80 = patchFromObject(e80, jp80, o80, named(o80, 'BA Eighty'));
  const p00 = patchFromObject(e00, jp00, o00, named(o00, 'PD Thousand'));
  const data = dataPatch(e80, 'Motion A', [Uint8Array.from([0xf0, 0x41, 0x10, 0x00, 0x06, 0x12, 0x09, 0, 0, 0, 0x77, 0xf7])]);
  const sub = await lib.createSub('Test sounds');
  await lib.addPatches(sub, [p80, p00, data]);
  return { lib, sub, jp80, jp00, e80, e00, p80, p00, data };
}

test('Main Library page: lists, opens, edits and deletes patches', async () => {
  const { lib, sub, p80, p00 } = await setup();
  const { mainLibraryView } = await import('../js/shell/mainlibrary.js');
  const errors = [];
  const shell = { mainLibrary: async () => lib, error: (e) => errors.push(e), go() {} };
  const root = document.createElement('div');
  const view = mainLibraryView(root, shell);
  await settle();
  const t = root.textContent;
  assert.ok(t.includes('Sub-libraries') && t.includes('Test sounds'), 'sub-library listed');
  assert.ok(t.includes('BA Eighty') && t.includes('PD Thousand') && t.includes('Motion A'), 'patches listed');
  assert.ok(t.includes('cannot save to a folder'), 'no folder picker here (Node): the library stays in the browser');

  // open a patch: its settings and where it loads
  byText(root, 'tr', 'BA Eighty').click();
  await settle(20);
  const detail = root.findAll((e) => e.classList.contains('ml-detail'))[0];
  assert.ok(!detail.hidden);
  assert.ok(detail.textContent.includes('OSC1 waveform'), 'settings shown');
  assert.ok(detail.textContent.includes('JP-8080') && detail.textContent.includes('JP-8000 (translated)'), `loads into: ${detail.textContent.slice(0, 400)}`);

  // set the category by hand
  const catSel = detail.findAll((e) => e.tagName === 'SELECT' && e.textContent.includes('Synth Bass'))[0];
  change(catSel, 'bright-pad');
  byText(detail, 'button', 'Save changes').click();
  await settle();
  const saved = await lib.getPatch(sub, p80.id);
  assert.equal(saved.category.id, 'bright-pad');
  assert.equal(saved.category.source, 'manual');

  // filter by device
  const devSel = root.findAll((e) => e.tagName === 'SELECT' && e.textContent.includes('All devices')).pop(); // the patch browser's (the sub-library search has one too)
  change(devSel, 'roland-jp8000');
  await settle();
  const table = root.findAll((e) => e.classList.contains('ml-table'))[0];
  assert.ok(table.textContent.includes('PD Thousand') && !table.textContent.includes('BA Eighty'), 'filtered to the JP-8000');
  change(devSel, '');
  await settle();

  // select one row and delete it with the bulk bar
  const row = byText(root, 'tr', 'PD Thousand');
  change(row.findAll((e) => e.tagName === 'INPUT')[0], true);
  await settle();
  byText(root, 'button', 'Delete').click();
  await answer('Delete');
  await settle(10);
  assert.ok(!(await lib.getSub(sub)).patches.some((r) => r.id === p00.id), 'deleted');
  assert.ok(!root.textContent.includes('PD Thousand'));

  // drop a .syx file: it becomes a new sub-library named after it, with a report
  const { jp80 } = await setup();
  const o80 = jp80.objects.find((o) => o.key === 'patch');
  const d = o80.init();
  d.set([...'LD Dropped      '].map((c) => c.charCodeAt(0)));
  const syx = o80.slots.store(0, 3, { deviceId: 0x10 }, d).flatMap((m) => [...m]);
  const drop = root.findAll((e) => e.classList.contains('dropzone'))[0];
  const ev = new Event('drop');
  ev.dataTransfer = { files: [new File([Uint8Array.from(syx)], 'Dropped set.syx')] };
  drop.dispatchEvent(ev);
  for (let i = 0; i < 200 && !lib.subs().some((s) => s.name === 'Dropped set'); i++) await settle(1);
  await settle(10);
  assert.deepEqual(errors, []);
  const made = lib.subs().find((s) => s.name === 'Dropped set');
  assert.ok(made, `new sub-library: ${lib.subs().map((s) => s.name)}`);
  assert.deepEqual((await lib.getSub(made.id)).patches.map((r) => [r.name, r.device, r.category]), [['LD Dropped', 'roland-jp8080', 'hard-lead']]);
  assert.ok(root.textContent.includes('Imported 1 item(s)'), 'report shown');
  assert.deepEqual(errors, []);
  view.destroy();
});

test('Librarian Main Library panel: badges, translated load, add a dump', async () => {
  const { lib, sub, jp00, e00, p80 } = await setup();
  const { mainLibraryPanel } = await import('../js/devices/generic/views/mainlib-panel.js');
  const set = [];
  const navs = [];
  const sent = [];
  const errors = [];
  const g = {
    def: jp00, entry: e00, host: { shell: { mainLibrary: async () => lib } },
    loadedKeys: new Set(), objectData: {}, slotNames: {}, ctx: { deviceId: 0x10, channel: 0 }, connected: true,
    setObjectData: (k, d) => set.push([k, d]), nav: (k) => navs.push(k), error: (e) => errors.push(e), setSlotName() {},
  };
  const panel = mainLibraryPanel(g, { sendMessages: async (title, msgs) => sent.push([title, msgs]) });
  await settle();
  const t = panel.el.textContent;
  assert.ok(t.includes('BA Eighty') && t.includes('PD Thousand'));
  assert.ok(!t.includes('Motion A'), 'JP-8080 data is not offered to the JP-8000');
  assert.ok(byText(panel.el, 'tr', 'BA Eighty').textContent.includes('translated'));
  assert.ok(!byText(panel.el, 'tr', 'PD Thousand').textContent.includes('translated'));

  // load the JP-8080 patch into the JP-8000 editor
  byText(byText(panel.el, 'tr', 'BA Eighty'), 'button', 'Load').click();
  await settle();
  if (openDialog()) await answer('Load');
  await settle();
  assert.equal(set.length, 1);
  assert.equal(set[0][0], 'patch');
  assert.equal(String.fromCharCode(...set[0][1].subarray(0, 9)), 'BA Eighty');
  assert.deepEqual(navs, ['patch']);

  // store the native JP-8000 patch into user memory
  byText(byText(panel.el, 'tr', 'PD Thousand'), 'button', 'Store to...').click();
  await settle();
  await answer('Store');
  await settle();
  assert.equal(sent.length, 1, 'store sent');
  assert.ok(sent[0][1].every((m) => m[0] === 0xf0 && m[5] === 0x12), 'DT1 messages');

  // a recorded dump goes into the library as patches of this device
  const o00 = jp00.objects.find((o) => o.key === 'patch');
  const d = o00.init();
  d.set([...'SQ Dumped       '].map((c) => c.charCodeAt(0)));
  const msgs = o00.slots.store(0, 5, { deviceId: 0x10 }, d).map((m) => Uint8Array.from(m));
  const before = (await lib.getSub(sub)).patches.length;
  const p = panel.addMessages('A dump', msgs);
  await answer('Add');
  await p;
  await settle();
  const rows = (await lib.getSub(sub)).patches;
  assert.equal(rows.length, before + 1);
  const added = rows.find((r) => r.name === 'SQ Dumped');
  assert.ok(added, `added: ${rows.map((r) => r.name)}`);
  assert.equal(added.device, 'roland-jp8000');
  assert.equal(added.category, 'pulsating');
  assert.ok(panel.el.textContent.includes('SQ Dumped'), 'the panel updates');
  assert.ok(p80);
  assert.deepEqual(errors, []);
  panel.destroy();
});

const button = (root, label) => root.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] || null;

test('Main Library page: merge sub-libraries, then find and delete duplicates', async () => {
  const { lib, sub, jp80, e80, p80 } = await setup();
  const { mainLibraryView } = await import('../js/shell/mainlibrary.js');
  const o80 = jp80.objects.find((o) => o.key === 'patch');
  const copy = patchFromObject(e80, jp80, o80, (() => { const d = Uint8Array.from(o80.init()); d.set([...'BA Eighty copy  '].map((c) => c.charCodeAt(0))); return d; })());
  const other = await lib.createSub('Other_set');
  await lib.addPatches(other, [copy]);
  const errors = [];
  const root = document.createElement('div');
  const view = mainLibraryView(root, { mainLibrary: async () => lib, error: (e) => errors.push(e), go() {} });
  await settle();

  // tick both sub-libraries and merge them into "Test sounds"
  change(byText(root, 'tr', 'Test sounds').findAll((e) => e.tagName === 'INPUT')[0], true);
  change(byText(root, 'tr', 'Other_set').findAll((e) => e.tagName === 'INPUT')[0], true);
  await settle();
  button(root, 'Merge 2 sub-libraries...').click();
  await settle();
  change(openDialog().findAll((e) => e.tagName === 'SELECT')[0], sub);
  await answer('Merge');
  await settle(20);
  assert.deepEqual(lib.subs().map((s) => s.name), ['Test sounds']);
  assert.equal((await lib.getSub(sub)).patches.length, 4);

  // the renamed copy is found by settings, not by name
  button(root, 'Find duplicates...').click();
  await settle();
  button(root, 'Find duplicates').click();
  await settle(20);
  assert.ok(root.textContent.includes('No duplicates found.'), 'no two names are the same');
  const radio = byText(root, 'label', 'Same settings').findAll((e) => e.tagName === 'INPUT')[0];
  change(radio, true);
  await settle();
  button(root, 'Find duplicates').click();
  await settle(30);
  assert.ok(root.textContent.includes('1 group(s), 1 duplicate(s).'), root.textContent.slice(0, 2000));
  button(root, 'Delete 1 duplicate(s)').click();
  await answer('Delete');
  await settle(30);
  const names = (await lib.getSub(sub)).patches.map((r) => r.name).sort();
  assert.deepEqual(names, ['BA Eighty', 'Motion A', 'PD Thousand'], 'the first imported copy is kept');
  assert.ok(p80);
  assert.deepEqual(errors, []);
  view.destroy();
});

test('Librarian panel: a new sub-library made from a device is that device\'s', async () => {
  const { lib, jp00, e00 } = await setup();
  const { mainLibraryPanel } = await import('../js/devices/generic/views/mainlib-panel.js');
  const g = {
    def: jp00, entry: e00, host: { shell: { mainLibrary: async () => lib } },
    loadedKeys: new Set(), objectData: {}, slotNames: {}, ctx: { deviceId: 0x10 }, connected: false,
    setObjectData() {}, nav() {}, error: (e) => { throw e; }, setSlotName() {},
  };
  const panel = mainLibraryPanel(g, { sendMessages: async () => {} });
  await settle();
  const o00 = jp00.objects.find((o) => o.key === 'patch');
  const msgs = o00.slots.store(0, 1, { deviceId: 0x10 }, o00.init()).map((m) => Uint8Array.from(m));
  const p = panel.addMessages('My_JP_dump', msgs);
  await settle(4);
  const dlg = openDialog();
  change(dlg.findAll((e) => e.tagName === 'SELECT')[0], ''); // New sub-library...
  assert.equal(dlg.findAll((e) => e.tagName === 'INPUT')[0].value, 'My JP dump', 'underscores become spaces');
  await answer('Add');
  await p;
  const made = lib.subs().find((s) => s.name === 'My JP dump');
  assert.ok(made, lib.subs().map((s) => s.name).join());
  assert.equal(made.device.model, 'JP-8000');
  panel.destroy();
});

test('Librarian: an entry stored as a whole MIDI file shows its patches, not "Other messages"', async () => {
  const { librarianView } = await import('../js/devices/generic/views/librarian.js');
  const jp00 = (await import('../js/devices/defs/roland-jp8000.js')).default;
  const o00 = jp00.objects.find((o) => o.key === 'patch');
  const d = o00.init();
  d.set([...'LD From A Midi  '].map((c) => c.charCodeAt(0)));
  const msgs = o00.slots.store(0, 2, { deviceId: 0x10 }, d).map((m) => Uint8Array.from(m));
  const vl = (n) => (n < 128 ? [n] : [0x80 | (n >> 7), n & 127]);
  const trk = msgs.flatMap((m) => [0x00, 0xf0, ...vl(m.length - 1), ...m.subarray(1)]).concat([0x00, 0xff, 0x2f, 0x00]);
  const smf = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, trk.length >> 8, trk.length & 255, ...trk]);
  const entries = [{ id: 1, device: 'roland-jp8000', name: 'Old import', bytes: smf, created: 1, notes: '' }];
  const { lib } = await setup();
  const g = {
    entry: getDevice('roland-jp8000'), def: jp00, ctx: { deviceId: 0x10 }, connected: false,
    host: { library: { list: async () => entries }, shell: { mainLibrary: async () => lib }, settings: { value: { midi: { bytesPerSecond: 3000 } } } },
    transport: { on: () => () => {} }, client: {}, loadedKeys: new Set(), objectData: {}, slotNames: {},
    error: (e) => { throw e; }, setObjectData() {}, nav() {},
  };
  const root = document.createElement('div');
  const view = librarianView(root, g);
  await settle();
  const row = byText(root, 'tr', 'Old import');
  assert.ok(row.textContent.includes('Roland'), 'the maker is read from the SysEx, not from the MIDI-file lengths');
  byText(row, 'button', 'Open').click();
  await settle();
  const open = root.findAll((e) => e.classList.contains('lib-open'))[0];
  assert.ok(open.textContent.includes('User patch A13') && open.textContent.includes('LD From A Midi'), open.textContent.slice(0, 600));
  assert.ok(!open.textContent.includes('Other messages'));
  view.destroy();
});

test('Main Library page: search the sub-libraries for patches, and sort them', async () => {
  const { lib, sub } = await setup();
  const { mainLibraryView } = await import('../js/shell/mainlibrary.js');
  const jp00 = (await import('../js/devices/defs/roland-jp8000.js')).default;
  const o00 = jp00.objects.find((o) => o.key === 'patch');
  const mk = (name) => { const d = o00.init(); d.set([...name.padEnd(16)].map((c) => c.charCodeAt(0))); return patchFromObject(getDevice('roland-jp8000'), jp00, o00, d); };
  const bassSet = await lib.createSub('Bass set');
  await lib.addPatches(bassSet, [mk('BA One'), mk('BA Two'), mk('BA Three')]);
  const padSet = await lib.createSub('Another set');
  await lib.addPatches(padSet, [mk('PD Wide')]);
  const errors = [];
  const root = document.createElement('div');
  const view = mainLibraryView(root, { mainLibrary: async () => lib, error: (e) => errors.push(e), go() {} });
  await settle();
  const subsCard = () => root.findAll((e) => e.classList.contains('card') && e.textContent.startsWith('Sub-libraries'))[0];
  const listed = () => subsCard().findAll((e) => e.tagName === 'TBODY')[0].findAll((e) => e.tagName === 'TR').map((tr) => tr.findAll((e) => e.tagName === 'A')[0].textContent);
  assert.deepEqual(listed(), ['Another set', 'Bass set', 'Test sounds'], 'sorted by name');
  change(subsCard().findAll((e) => e.tagName === 'SELECT' && e.textContent.includes('Sort: Most patches'))[0], 'count');
  await settle();
  assert.deepEqual(listed(), ['Bass set', 'Test sounds', 'Another set']);

  // patches of category Synth Bass: two sub-libraries hold some
  change(subsCard().findAll((e) => e.tagName === 'SELECT' && e.textContent.includes('All categories'))[0], 'synth-bass');
  await settle();
  assert.deepEqual(listed().sort(), ['Bass set', 'Test sounds']);
  assert.ok(subsCard().textContent.includes('4 matching patch(es) in 2 of 3 sub-libraries.'), subsCard().textContent.slice(0, 400));
  change(subsCard().findAll((e) => e.tagName === 'SELECT' && e.textContent.includes('Sort: Most matches'))[0], 'matches');
  await settle();
  assert.deepEqual(listed(), ['Bass set', 'Test sounds']);
  // a name search narrows it further
  const q = subsCard().findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'search')[0];
  q.value = 'two';
  q.dispatchEvent(new Event('input'));
  await settle();
  assert.deepEqual(listed(), ['Bass set']);
  // opening it shows its matching patches in the browser
  byText(subsCard(), 'a', 'Bass set').click();
  await settle();
  const table = root.findAll((e) => e.classList.contains('ml-table'))[0];
  assert.ok(table.textContent.includes('BA Two') && !table.textContent.includes('BA One'), table.textContent.slice(0, 300));
  assert.ok(sub);
  assert.deepEqual(errors, []);
  view.destroy();
});
