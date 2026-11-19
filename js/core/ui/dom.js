// Tiny DOM helpers: element builder, toasts, dialogs, file I/O.

// Views build markup with conditional children (`cond ? el : null`). Native
// append() would insert the text "null"; make append/prepend skip empty values
// so every call site behaves like h().
if (typeof Element !== 'undefined' && !Element.prototype.append.__keditSafe) {
  const keep = (n) => n !== null && n !== undefined && n !== false;
  const nativeAppend = Element.prototype.append;
  const nativePrepend = Element.prototype.prepend;
  Element.prototype.append = function append(...nodes) { return nativeAppend.apply(this, nodes.flat().filter(keep)); };
  Element.prototype.prepend = function prepend(...nodes) { return nativePrepend.apply(this, nodes.flat().filter(keep)); };
  Element.prototype.append.__keditSafe = true;
}

/** h('div.card#id', {onclick, style:{}, ...attrs}, ...children) */
export function h(spec, props, ...children) {
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class') el.className += ' ' + v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

// ------------------------------------------------------------ toasts
export function toast(message, kind = 'info', ms = 4000) {
  const box = document.getElementById('toasts');
  const t = h('div.toast.' + kind, message);
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// ------------------------------------------------------------ dialogs
export function dialog(title, body, buttons = [{ label: 'OK', value: true, primary: true }]) {
  return new Promise((resolve) => {
    const dlg = h('dialog', h('h2', title), body);
    const actions = h('div.actions');
    for (const b of buttons) {
      actions.appendChild(h('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), {
        onclick: () => { dlg.close(); resolve(typeof b.value === 'function' ? b.value() : b.value); },
      }, b.label));
    }
    dlg.appendChild(actions);
    dlg.addEventListener('cancel', () => resolve(null));
    dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

export async function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return !!(await dialog(title, h('p', message), [
    { label: 'Cancel', value: false },
    { label: okLabel, value: true, primary: !danger, danger },
  ]));
}

/** fields: [{key, label, type:'text'|'number', value, min, max}] -> object or null */
export async function formDialog(title, fields, okLabel = 'OK', note = null) {
  const inputs = {};
  const body = h('div.col',
    note ? h('p.muted.small', note) : null,
    fields.map((f) => {
      const inp = f.type === 'select'
        ? h('select', f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)))
        : h('input', { type: f.type || 'text', value: f.value ?? '', min: f.min, max: f.max, maxlength: f.maxlength });
      inputs[f.key] = inp;
      return h('label.field', f.label, inp);
    }));
  setTimeout(() => Object.values(inputs)[0]?.focus(), 30);
  return dialog(title, body, [
    { label: 'Cancel', value: null },
    {
      label: okLabel, primary: true,
      value: () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'number' ? Number(el.value) : el.value])),
    },
  ]);
}

// ------------------------------------------------------------ files
export function downloadBlob(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFiles(accept = '', multiple = false) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, multiple });
    inp.addEventListener('change', () => resolve([...inp.files]));
    inp.click();
  });
}

/** Split a .syx file into individual SysEx messages. */
export function splitSysex(buffer) {
  const b = new Uint8Array(buffer);
  const out = [];
  let start = -1;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0xf0) start = i;
    else if (b[i] === 0xf7 && start >= 0) { out.push(b.slice(start, i + 1)); start = -1; }
  }
  return out;
}

export function concatBytes(chunks) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

export function safeFileName(s) { return String(s).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'object'; }

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
