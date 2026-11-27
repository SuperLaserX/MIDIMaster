// Drive a Chrome started with --remote-debugging-port, through the DevTools protocol, with no
// dependencies (Node's own WebSocket). For checking the app's pages in a real browser.
//
//   node tools/browser/cdp.mjs [--port 9223] [--tab <text>] <command> [args]
//     --tab <text>                 work in the page whose URL or title contains <text> (e.g. a
//                                  ?tab=name query added to its URL), else the first page; lets
//                                  two sessions share one Chrome (and its MIDI ports) in two tabs
//     tabs                         list the open pages
//     newtab <url>                 open a new page at <url>
//     nav <url>                    load a URL in the page (waits for load)
//     eval <js>                    run JS in the page (awaits promises), print the JSON result
//     evalfile <file.js>           the same, from a file
//     click <css selector>         click the first match (scrolls it into view)
//     shot <out.png> [selector]    screenshot of the page, or of one element
//     front                        bring the page to the front (a hidden page's timers are slowed)
//     grant <origin>               allow Web MIDI with SysEx for an origin (no prompt)
//     console <seconds>            print console messages and exceptions for a while
//     size <width> <height>        set the viewport size
//     drag <x1> <y1> <x2> <y2> [n] [shift]  press, move in n steps, release (viewport coordinates)
//     key <key>                    press a key (Enter, ArrowDown, Tab...) in the focused element
//     type <text>                  type text into the focused element
//
// Start Chrome (a separate profile, so the user's own is never touched), e.g.:
//   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223
//     --user-data-dir=<scratch>/chrome-profile --no-first-run --no-default-browser-check <url>

import fs from 'node:fs';

const args = process.argv.slice(2);
let port = 9223;
let tab = null;
for (;;) {
  if (args[0] === '--port') { port = Number(args[1]); args.splice(0, 2); continue; }
  if (args[0] === '--tab') { tab = args[1].toLowerCase(); args.splice(0, 2); continue; }
  break;
}
const [cmd, ...rest] = args;

async function page() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  const p = tab ? pages.find((t) => t.url.toLowerCase().includes(tab) || t.title.toLowerCase().includes(tab)) : pages[0];
  if (!p) throw new Error(tab ? `no page matching "${tab}" open in Chrome` : 'no page open in Chrome');
  return p;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  };
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('cannot connect to Chrome')); });
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; waiting.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }),
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

if (cmd === 'newtab') {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(rest[0])}`, { method: 'PUT' });
  console.log('opened', (await r.json()).url);
  process.exit(0);
}
const p = cmd === 'tabs' ? null : await page();
if (cmd === 'tabs') {
  for (const t of await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) console.log(t.type, t.url, t.title);
  process.exit(0);
}
const c = connect(p.webSocketDebuggerUrl);
await c.ready;
try {
  if (cmd === 'nav') {
    await c.send('Page.enable');
    const loaded = new Promise((resolve) => c.on((m) => { if (m.method === 'Page.loadEventFired') resolve(); }));
    await c.send('Page.navigate', { url: rest[0] });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 15000))]);
    console.log('loaded', rest[0]);
  } else if (cmd === 'eval' || cmd === 'evalfile') {
    const js = cmd === 'eval' ? rest.join(' ') : fs.readFileSync(rest[0], 'utf8');
    const v = await evaluate(c, `(async () => { ${/\breturn\b/.test(js) ? js : `return (${js});`} })()`);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  } else if (cmd === 'click') {
    const ok = await evaluate(c, `(() => { const el = document.querySelector(${JSON.stringify(rest[0])}); if (!el) return false; el.scrollIntoView({block: 'center'}); el.click(); return true; })()`);
    console.log(ok ? 'clicked' : `no element ${rest[0]}`);
  } else if (cmd === 'shot') {
    let clip;
    if (rest[1]) {
      const box = await evaluate(c, `(() => { const el = document.querySelector(${JSON.stringify(rest[1])}); if (!el) return null; el.scrollIntoView({block: 'start'}); const r = el.getBoundingClientRect(); return {x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height}; })()`);
      if (!box) throw new Error(`no element ${rest[1]}`);
      clip = { ...box, scale: 1 };
    }
    const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip } : {}) });
    fs.writeFileSync(rest[0], Buffer.from(r.data, 'base64'));
    console.log('saved', rest[0]);
  } else if (cmd === 'front') {
    await c.send('Page.bringToFront');
    console.log('in front');
  } else if (cmd === 'grant') {
    await c.send('Browser.grantPermissions', { origin: rest[0], permissions: ['midi', 'midiSysex'] });
    console.log('MIDI with SysEx allowed for', rest[0]);
  } else if (cmd === 'console') {
    await c.send('Runtime.enable');
    c.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled') console.log(`[${m.params.type}]`, m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    await new Promise((r) => setTimeout(r, Number(rest[0] || 5) * 1000));
  } else if (cmd === 'size') {
    await c.send('Emulation.setDeviceMetricsOverride', { width: Number(rest[0]), height: Number(rest[1]), deviceScaleFactor: 1, mobile: false });
    console.log('viewport', rest[0], 'x', rest[1]);
  } else if (cmd === 'drag') {
    const [x1, y1, x2, y2] = rest.slice(0, 4).map(Number);
    const n = Number(rest[4] || 8);
    const modifiers = rest[5] === 'shift' ? 8 : 0;
    const m = (type, x, y, buttons) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, modifiers });
    await m('mouseMoved', x1, y1, 0);
    await m('mousePressed', x1, y1, 1);
    for (let i = 1; i <= n; i++) await m('mouseMoved', x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n, 1);
    await m('mouseReleased', x2, y2, 0);
    console.log('dragged');
  } else if (cmd === 'key') {
    const key = rest[0];
    const code = { Enter: 13, Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Backspace: 8 }[key] ?? 0;
    for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' && type === 'rawKeyDown' ? { text: String.fromCharCode(13) } : {}) });
    console.log('key', key);
  } else if (cmd === 'type') {
    await c.send('Input.insertText', { text: rest.join(' ') });
    console.log('typed');
  } else {
    console.log('commands: tabs, newtab, nav, eval, evalfile, click, shot, grant, console, size, drag, key, type');
  }
} finally {
  c.close();
}
