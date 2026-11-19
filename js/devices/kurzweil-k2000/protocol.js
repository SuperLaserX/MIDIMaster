// Kurzweil K2000 System Exclusive protocol: message builders and parsers.
// Header: F0 07 <device id> 78 <message type> ... F7
// Message set verified against the K2000 v3.87 firmware dispatcher (0x179030),
// which accepts 00-0C, 0E-10, 12, 14-18, 79, 7C and 7E.

import {
  enc7, dec7, encodeData, decodeData, encodedLength, checksum, asciiBytes, readCString,
} from '../../core/bits.js';

export const KURZWEIL_ID = 0x07;
export const PRODUCT_ID = 0x78;

export const MSG = Object.freeze({
  DUMP: 0x00, LOAD: 0x01, DACK: 0x02, DNAK: 0x03, DIR: 0x04, INFO: 0x05,
  NEW: 0x06, DEL: 0x07, CHANGE: 0x08, WRITE: 0x09, READ: 0x0a, READBANK: 0x0b,
  DIRBANK: 0x0c, ENDOFBANK: 0x0d, DELBANK: 0x0e, MOVEBANK: 0x0f,
  LOADMACRO: 0x10, MACRODONE: 0x11,
  MEMQUERY: 0x12, MEMREPLY: 0x13, // undocumented: free program / sample memory
  PANEL: 0x14, ALLTEXT: 0x15, PARAMVALUE: 0x16, PARAMNAME: 0x17, GETGRAPHICS: 0x18,
  SCREENREPLY: 0x19,
  SPLITBLOCK: 0x79, // undocumented: split multi-sample soundblock into single blocks
  OBJADDR: 0x7c, OBJADDRREPLY: 0x7d, // undocumented: RAM address of an object
  SUBNAME: 0x7e, // undocumented: name one sub-sample of a soundblock
});

export const MSG_NAMES = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));

export const DNAK_CODES = {
  1: 'Object is open in the K2000 editor',
  2: 'Checksum error',
  3: 'ID out of range',
  4: 'Object not found or bad offset',
  5: 'Memory full',
};

export const FORM = Object.freeze({ NIBBLE: 0, BITSTREAM: 1 });

function header(dev, type) { return [0xf0, KURZWEIL_ID, dev & 0x7f, PRODUCT_ID, type]; }
function finish(arr) { arr.push(0xf7); return Uint8Array.from(arr); }
function nameField(name) { return [...asciiBytes(name || ''), 0]; }

// ---------------------------------------------------------------- builders
export const build = {
  dump: (dev, type, id, offs = 0, size = 0x1fffff, form = FORM.BITSTREAM) =>
    finish([...header(dev, MSG.DUMP), ...enc7(type, 2), ...enc7(id, 2), ...enc7(offs, 3), ...enc7(size, 3), form]),

  load(dev, type, id, offs, data, form = FORM.BITSTREAM) {
    const encoded = encodeData(data, form);
    return finish([...header(dev, MSG.LOAD), ...enc7(type, 2), ...enc7(id, 2), ...enc7(offs, 3),
      ...enc7(data.length, 3), form, ...encoded, checksum(encoded)]);
  },

  dir: (dev, type, id) => finish([...header(dev, MSG.DIR), ...enc7(type, 2), ...enc7(id, 2)]),

  /** mode 0: fail if it exists; mode 1: make a RAM copy of a ROM object. id 0 = first free. */
  new: (dev, type, id, size, mode, name) =>
    finish([...header(dev, MSG.NEW), ...enc7(type, 2), ...enc7(id, 2), ...enc7(size, 3), mode & 1, ...nameField(name)]),

  del: (dev, type, id) => finish([...header(dev, MSG.DEL), ...enc7(type, 2), ...enc7(id, 2)]),

  /** newid 0 (or equal to id) keeps the ID; an empty name keeps the name. */
  change: (dev, type, id, newid, name) =>
    finish([...header(dev, MSG.CHANGE), ...enc7(type, 2), ...enc7(id, 2), ...enc7(newid, 2), ...nameField(name)]),

  /** mode 0: write exactly at id; mode 1: first free id at or after id. */
  write(dev, type, id, mode, name, data, form = FORM.BITSTREAM) {
    const encoded = encodeData(data, form);
    return finish([...header(dev, MSG.WRITE), ...enc7(type, 2), ...enc7(id, 2), ...enc7(data.length, 3),
      mode & 1, ...nameField(name), form, ...encoded, checksum(encoded)]);
  },

  read: (dev, type, id, form = FORM.BITSTREAM) =>
    finish([...header(dev, MSG.READ), ...enc7(type, 2), ...enc7(id, 2), form]),

  readBank: (dev, type, bank, form = FORM.BITSTREAM, ramOnly = true) =>
    finish([...header(dev, MSG.READBANK), ...enc7(type, 2), bank & 0x7f, form, ramOnly ? 1 : 0]),

  dirBank: (dev, type, bank, ramOnly = false) =>
    finish([...header(dev, MSG.DIRBANK), ...enc7(type, 2), bank & 0x7f, ramOnly ? 1 : 0]),

  delBank: (dev, type, bank) => finish([...header(dev, MSG.DELBANK), ...enc7(type, 2), bank & 0x7f]),

  moveBank: (dev, type, bank, newBank) =>
    finish([...header(dev, MSG.MOVEBANK), ...enc7(type, 2), bank & 0x7f, newBank & 0x7f]),

  loadMacro: (dev) => finish(header(dev, MSG.LOADMACRO)),
  memQuery: (dev) => finish(header(dev, MSG.MEMQUERY)),

  /** events: [{type: 0x08|0x09|0x0a|0x0d, button, clicks}] */
  panel(dev, events) {
    const arr = header(dev, MSG.PANEL);
    for (const e of events) arr.push(e.type & 0x7f, e.button & 0x7f, ((e.clicks || 0) + 64) & 0x7f);
    return finish(arr);
  },

  allText: (dev) => finish(header(dev, MSG.ALLTEXT)),
  paramValue: (dev) => finish(header(dev, MSG.PARAMVALUE)),
  paramName: (dev) => finish(header(dev, MSG.PARAMNAME)),
  getGraphics: (dev) => finish(header(dev, MSG.GETGRAPHICS)),

  /** Split soundblock `sampleId` into one soundblock per sub-sample, from `firstNewId` upward. No reply. */
  splitBlock: (dev, sampleId, firstNewId) =>
    finish([...header(dev, MSG.SPLITBLOCK), ...enc7(sampleId, 2), ...enc7(firstNewId, 2)]),

  /** Ask for the RAM address of an object. Reply: OBJADDRREPLY (0x7D). */
  objAddr: (dev, type, id) => finish([...header(dev, MSG.OBJADDR), ...enc7(type, 2), ...enc7(id, 2)]),

  /** Name a sub-sample (0-based index) inside soundblock `sampleId`. No reply. */
  subName(dev, sampleId, index, name) {
    const bytes = asciiBytes((name || '').slice(0, 31));
    const field = new Array(32).fill(0);
    bytes.forEach((b, i) => { field[i] = b; });
    return finish([...header(dev, MSG.SUBNAME), ...enc7(sampleId, 2), ...enc7(index, 2), ...field]);
  },
};

// ---------------------------------------------------------------- parsing
/** True if `bytes` is a Kurzweil K2 SysEx message. */
export function isK2(bytes) {
  return bytes.length >= 6 && bytes[0] === 0xf0 && bytes[1] === KURZWEIL_ID &&
    bytes[3] === PRODUCT_ID && bytes[bytes.length - 1] === 0xf7;
}

/** Parse any K2 message into a plain object {msg, name, dev, ...fields}. */
export function parse(bytes) {
  if (!isK2(bytes)) return null;
  const msg = bytes[4];
  const b = bytes.subarray(5, bytes.length - 1);
  const out = { msg, name: MSG_NAMES[msg] || 'MSG_' + msg.toString(16), dev: bytes[2] };
  const typeId = () => { out.type = dec7(b, 0, 2); out.id = dec7(b, 2, 2); };
  switch (msg) {
    case MSG.DUMP:
      typeId(); out.offs = dec7(b, 4, 3); out.size = dec7(b, 7, 3); out.form = b[10]; break;
    case MSG.LOAD: {
      typeId(); out.offs = dec7(b, 4, 3); out.size = dec7(b, 7, 3); out.form = b[10];
      const len = encodedLength(out.size, out.form);
      const enc = b.subarray(11, 11 + len);
      out.checksumOk = checksum(enc) === b[11 + len];
      out.data = decodeData(enc, out.size, out.form);
      break;
    }
    case MSG.DACK:
      typeId(); out.offs = dec7(b, 4, 3); out.size = dec7(b, 7, 3); break;
    case MSG.DNAK:
      typeId(); out.offs = dec7(b, 4, 3); out.size = dec7(b, 7, 3); out.code = b[10];
      out.reason = DNAK_CODES[out.code] || 'code ' + out.code; break;
    case MSG.DIR: case MSG.DEL: typeId(); break;
    case MSG.INFO:
      typeId(); out.size = dec7(b, 4, 3); out.inRam = !!b[7];
      [out.objName] = readCString(b, 8); break;
    case MSG.NEW:
      typeId(); out.size = dec7(b, 4, 3); out.mode = b[7]; [out.objName] = readCString(b, 8); break;
    case MSG.CHANGE:
      typeId(); out.newid = dec7(b, 4, 2); [out.objName] = readCString(b, 6); break;
    case MSG.WRITE: {
      typeId(); out.size = dec7(b, 4, 3); out.mode = b[7];
      let p;
      [out.objName, p] = readCString(b, 8);
      out.form = b[p];
      const len = encodedLength(out.size, out.form);
      const enc = b.subarray(p + 1, p + 1 + len);
      out.checksumOk = checksum(enc) === b[p + 1 + len];
      out.data = decodeData(enc, out.size, out.form);
      break;
    }
    case MSG.READ: typeId(); out.form = b[4]; break;
    case MSG.READBANK: out.type = dec7(b, 0, 2); out.bank = b[2]; out.form = b[3]; out.ramOnly = !!b[4]; break;
    case MSG.DIRBANK: out.type = dec7(b, 0, 2); out.bank = b[2]; out.ramOnly = !!b[3]; break;
    case MSG.ENDOFBANK: case MSG.DELBANK: out.type = dec7(b, 0, 2); out.bank = b[2]; break;
    case MSG.MOVEBANK: out.type = dec7(b, 0, 2); out.bank = b[2]; out.newBank = b[3]; break;
    case MSG.MACRODONE: out.error = !!b[0]; break;
    case MSG.MEMREPLY:
      out.programFreeK = dec7(b, 0, 3);
      out.sampleFreeUnits = dec7(b, 3, 3);
      out.sampleFreeK = out.sampleFreeUnits * 2; // 2 KB units (measured by k2kremote)
      break;
    case MSG.PANEL: {
      out.events = [];
      for (let i = 0; i + 2 < b.length; i += 3) out.events.push({ type: b[i], button: b[i + 1], clicks: b[i + 2] - 64 });
      break;
    }
    case MSG.SCREENREPLY: out.data = b.slice(); break;
    case MSG.OBJADDRREPLY: {
      typeId();
      let a = 0;
      for (let i = 0; i < 8; i++) a = a * 16 + (b[4 + i] & 0x0f);
      out.address = a; break;
    }
    default: out.raw = b.slice();
  }
  return out;
}

// ---------------------------------------------------------------- screen helpers
export const SCREEN_W = 240;
export const SCREEN_H = 64;
export const TEXT_COLS = 40;
export const TEXT_ROWS = 8;

/** ALLTEXT reply: 320 characters (high bit marks reverse video) + NUL. */
export function decodeScreenText(data) {
  const rows = [];
  const inverse = [];
  for (let r = 0; r < TEXT_ROWS; r++) {
    let s = '';
    const inv = [];
    for (let c = 0; c < TEXT_COLS; c++) {
      const v = data[r * TEXT_COLS + c] ?? 32;
      inv.push(!!(v & 0x80));
      const ch = v & 0x7f;
      s += ch >= 32 ? String.fromCharCode(ch) : ' ';
    }
    rows.push(s);
    inverse.push(inv);
  }
  return { rows, inverse };
}

/** GETGRAPHICS reply: 2560 bytes, 6 pixels per byte (MSB first), row-major 240x64. */
export function decodeScreenGraphics(data) {
  const px = new Uint8Array(SCREEN_W * SCREEN_H);
  for (let i = 0; i < 2560 && i < data.length; i++) {
    const v = data[i];
    for (let k = 0; k < 6; k++) px[i * 6 + k] = (v >> (5 - k)) & 1;
  }
  return px;
}

/** PARAMNAME / PARAMVALUE replies are NUL-terminated strings. */
export function decodeScreenString(data) {
  let s = '';
  for (const v of data) { if (v === 0) break; s += String.fromCharCode(v & 0x7f); }
  return s.trim();
}

// ---------------------------------------------------------------- panel buttons
export const BTN_EVENT = { UP: 0x08, DOWN: 0x09, REPEAT: 0x0a, WHEEL: 0x0d };

export const BUTTONS = Object.freeze({
  N0: 0x00, N1: 0x01, N2: 0x02, N3: 0x03, N4: 0x04, N5: 0x05, N6: 0x06, N7: 0x07, N8: 0x08, N9: 0x09,
  PLUSMINUS: 0x0a, CANCEL: 0x0b, CLEAR: 0x0c, ENTER: 0x0d,
  UP: 0x10, DOWN: 0x11, LEFT: 0x12, RIGHT: 0x13, CHANINC: 0x14, CHANDEC: 0x15,
  PLUS: 0x16, MINUS: 0x17, UPDOWN: 0x18, LEFTRIGHT: 0x1a, CHANINCDEC: 0x1c, PLUSANDMINUS: 0x1e,
  EDIT: 0x20, EXIT: 0x21, A: 0x22, B: 0x23, C: 0x24, D: 0x25, E: 0x26, F: 0x27, AB: 0x28, CD: 0x29, EF: 0x2a,
  YES: 0x26, NO: 0x27,
  PROGRAM: 0x40, SETUP: 0x41, QUICKACCESS: 0x42, MASTER: 0x43, MIDI: 0x44, DISK: 0x45, SONG: 0x46, EFFECTS: 0x47,
});

export function digitButton(d) { return BUTTONS['N' + d]; }
