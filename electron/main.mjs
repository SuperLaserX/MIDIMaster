// MIDIMaster desktop app (Electron): the same pages as the browser version, served from the app's own
// files on a private app:// origin (a secure context, so Web MIDI with SysEx is allowed), with MIDI
// permission granted to those pages only. Settings and libraries live in the app's own profile.
import { app, BrowserWindow, Menu, protocol, session, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'app://midimaster';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.woff': 'font/woff',
};
// what the app's own pages may use: Web MIDI with SysEx, the folder the Head Library lives in (File
// System Access API), and copying to the clipboard
const ALLOWED = new Set(['midi', 'midiSysex', 'fileSystem', 'clipboard-sanitized-write']);
const ours = (url) => typeof url === 'string' && url.startsWith(`${ORIGIN}/`);

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  const win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 960, minHeight: 600, title: 'MIDIMaster', backgroundColor: '#14161c',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  // links to web pages open in the browser; the app never navigates away from its own pages
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (ev, url) => { if (!ours(url)) { ev.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.loadURL(`${ORIGIN}/index.html`);
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      return new Response(await readFile(file), { headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  // the app's own pages get MIDI, file and clipboard access; nothing else, and nothing for other origins
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) => done(ALLOWED.has(permission) && ours(details.requestingUrl || `${details.requestingOrigin || ''}/`)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED.has(permission) && String(origin).startsWith(ORIGIN));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));

  const win = createWindow();
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus(); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
