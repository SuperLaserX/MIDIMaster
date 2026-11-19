// Front-panel dock: LCD mirror plus every K2000 button and the alpha wheel.
// Lives beside the current view so it can be used on any page. Keyboard shortcuts
// only apply while the panel has focus (click it first).

import { h, toast } from '../../core/ui/dom.js';
import { LcdView } from './lcd.js';
import { BUTTONS, BTN_EVENT } from './protocol.js';
import { sleep } from '../../core/bits.js';

const STORE_KEY = 'midimaster.k2000.frontpanel';

function loadPrefs() {
  const base = { open: false, scale: 2, graphics: true };
  try { return { ...base, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch { return base; }
}

export function mountFrontPanel(container, app) {
  const prefs = loadPrefs();
  const st = { refreshing: false, again: false, poll: false, timer: null, open: false, lcd: null };
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };
  const paramOut = h('div.small.mono.muted.fp-param', ' ');
  const lcdHolder = h('div.fp-lcd');
  const listeners = new Set();

  function makeLcd() {
    const old = st.lcd;
    st.lcd = new LcdView(prefs.scale);
    if (old) { st.lcd.text = old.text; st.lcd.pixels = old.pixels; st.lcd.render(); }
    lcdHolder.replaceChildren(st.lcd.canvas);
    container.style.setProperty('--fp-width', `${240 * prefs.scale + 46}px`);
  }

  // Skip panel traffic while a sample dump or import owns the MIDI link.
  const idle = () => app.online && !app.exclusive;

  async function refresh() {
    if (!st.open || !idle()) return;
    if (st.refreshing) { st.again = true; return; }
    st.refreshing = true;
    try {
      do {
        st.again = false;
        await sleep(120);
        if (!idle()) break;
        st.lcd.setText(await app.client.screenText());
        if (prefs.graphics && idle()) st.lcd.setPixels(await app.client.screenGraphics());
      } while (st.again && st.open);
    } catch (err) {
      paramOut.textContent = err.message;
    } finally { st.refreshing = false; }
  }

  async function readParam() {
    try {
      const name = await app.client.paramName();
      const value = await app.client.paramValue();
      paramOut.textContent = `${name || '(no parameter)'} = ${value}`;
    } catch (err) { paramOut.textContent = err.message; }
  }

  const press = (code) => { app.client.press(code).catch((err) => app.error(err, 'Panel')); };
  const key = (label, code, cls = '') => h('button.pkey' + cls, { onclick: () => press(code), tabindex: -1 }, label);

  // Alpha wheel: drag up/down or scroll.
  const wheel = h('div.wheel', { title: 'Alpha wheel: drag up/down or scroll' }, 'Alpha');
  let acc = 0;
  let last = null;
  let wheelTimer = null;
  const flushWheel = () => {
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      const clicks = Math.trunc(acc);
      acc -= clicks;
      if (clicks) app.client.wheel(clicks).catch((err) => app.error(err, 'Wheel'));
    }, 60);
  };
  wheel.addEventListener('wheel', (e) => { e.preventDefault(); acc += e.deltaY < 0 ? 1 : -1; flushWheel(); }, { passive: false });
  wheel.addEventListener('pointerdown', (e) => { wheel.setPointerCapture(e.pointerId); last = e.clientY; });
  wheel.addEventListener('pointermove', (e) => { if (last === null) return; acc += (last - e.clientY) / 6; last = e.clientY; flushWheel(); });
  wheel.addEventListener('pointerup', () => { last = null; });

  const modes = [['Program', BUTTONS.PROGRAM], ['Setup', BUTTONS.SETUP], ['Q Access', BUTTONS.QUICKACCESS], ['Effects', BUTTONS.EFFECTS],
    ['MIDI', BUTTONS.MIDI], ['Master', BUTTONS.MASTER], ['Song', BUTTONS.SONG], ['Disk', BUTTONS.DISK]];

  const pollBtn = h('button.btn.small.toggle', {
    title: 'Refresh the display every 2 seconds. Avoid while the K2000 loads from disk or deletes objects.',
    onclick: () => { st.poll = !st.poll; pollBtn.classList.toggle('on', st.poll); schedule(); },
  }, 'Auto');
  const gfxBtn = h('button.btn.small.toggle', {
    title: 'Also read the graphics layer (bars, envelopes). Slower.',
    onclick: () => { prefs.graphics = !prefs.graphics; gfxBtn.classList.toggle('on', prefs.graphics); save(); refresh(); },
  }, 'Graphics');
  gfxBtn.classList.toggle('on', prefs.graphics);
  const scaleBtn = h('button.btn.small', {
    title: 'Display size',
    onclick: () => { prefs.scale = prefs.scale === 2 ? 3 : 2; scaleBtn.textContent = `${prefs.scale}x`; save(); makeLcd(); },
  }, `${prefs.scale}x`);

  function schedule() {
    clearTimeout(st.timer);
    if (st.poll && st.open) st.timer = setTimeout(async () => { await refresh(); schedule(); }, 2000);
  }

  container.tabIndex = 0;
  container.append(
    h('div.fp-head',
      h('strong.grow', 'Front Panel'),
      h('button.btn.small', { onclick: refresh, title: 'Read the display now' }, 'Refresh'),
      gfxBtn, pollBtn, scaleBtn,
      h('button.icon-btn', { onclick: () => api.close(), title: 'Hide the front panel' }, 'Close')),
    h('div.lcd-wrap', lcdHolder,
      h('div.softkeys', ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => key(k, BUTTONS[k])))),
    h('div.row', h('button.btn.small', { onclick: readParam }, 'Read parameter'), paramOut),
    h('div.pad.fp-modes', modes.map(([l, c]) => key(l, c, '.mode'))),
    h('div.fp-controls',
      h('div.pad.fp-cursor',
        key('Edit', BUTTONS.EDIT), key('▲', BUTTONS.UP), key('Exit', BUTTONS.EXIT),
        key('◀', BUTTONS.LEFT), key('▼', BUTTONS.DOWN), key('▶', BUTTONS.RIGHT),
        key('-', BUTTONS.MINUS), key('+/-', BUTTONS.PLUSANDMINUS), key('+', BUTTONS.PLUS),
        key('Chan-', BUTTONS.CHANDEC), h('span'), key('Chan+', BUTTONS.CHANINC)),
      wheel,
      h('div.pad.fp-keypad',
        ...[7, 8, 9, 4, 5, 6, 1, 2, 3].map((n) => key(String(n), BUTTONS['N' + n])),
        key('+/-', BUTTONS.PLUSMINUS), key('0', BUTTONS.N0), key('Clear', BUTTONS.CLEAR),
        key('Cancel', BUTTONS.CANCEL), h('span'), key('Enter', BUTTONS.ENTER))),
    h('div.small.muted.fp-hint', 'Click the panel, then type: arrows move, digits and Enter enter values, + and - step, Esc is Exit, E is Edit, F1-F6 are the soft keys, PageUp/PageDown turn the wheel.'));

  const keymap = {
    ArrowUp: BUTTONS.UP, ArrowDown: BUTTONS.DOWN, ArrowLeft: BUTTONS.LEFT, ArrowRight: BUTTONS.RIGHT,
    Enter: BUTTONS.ENTER, Escape: BUTTONS.EXIT, '+': BUTTONS.PLUS, '=': BUTTONS.PLUS, '-': BUTTONS.MINUS,
    Backspace: BUTTONS.CLEAR, Delete: BUTTONS.CANCEL, e: BUTTONS.EDIT, E: BUTTONS.EDIT,
    F1: BUTTONS.A, F2: BUTTONS.B, F3: BUTTONS.C, F4: BUTTONS.D, F5: BUTTONS.E, F6: BUTTONS.F,
  };
  const isDigit = (k) => k.length === 1 && k >= '0' && k <= '9';
  container.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    if (isDigit(e.key)) press(BUTTONS['N' + e.key]);
    else if (e.key === 'PageUp' || e.key === 'PageDown') app.client.wheel(e.key === 'PageUp' ? 1 : -1).catch(() => {});
    else if (keymap[e.key] !== undefined) press(keymap[e.key]);
    else handled = false;
    // Stop handled keys here so the audition keyboard and the open view do not see them.
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });
  container.addEventListener('keyup', (e) => { if (isDigit(e.key) || keymap[e.key] !== undefined) e.stopPropagation(); });

  // Any panel message (from here, from "Select on K2000", ...) changes the display.
  let soon = null;
  app.client.on('panel', () => { clearTimeout(soon); soon = setTimeout(refresh, 40); });
  // Presses made on the K2000 itself (needs MIDI > TRANSMIT > Buttons = On).
  app.on('unsolicited', (m) => {
    if (m.name !== 'PANEL') return;
    if (m.events.some((ev) => ev.type !== BTN_EVENT.WHEEL || ev.clicks !== 63)) refresh();
  });
  app.on('online', (ok) => { if (ok) refresh(); });

  const api = {
    get isOpen() { return st.open; },
    get wasOpen() { return prefs.open; },
    open({ quiet = false } = {}) {
      if (st.open) return;
      st.open = true; prefs.open = true; save();
      container.hidden = false;
      if (!st.lcd) makeLcd();
      if (app.online) refresh(); else if (!quiet) toast('Connect to the K2000 to use the front panel', 'warn');
      schedule();
      for (const fn of listeners) fn(true);
    },
    close() {
      if (!st.open) return;
      st.open = false; prefs.open = false; save();
      container.hidden = true;
      clearTimeout(st.timer);
      for (const fn of listeners) fn(false);
    },
    toggle() { if (st.open) api.close(); else api.open(); },
    refresh,
    onToggle(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  container.hidden = true;
  return api;
}
