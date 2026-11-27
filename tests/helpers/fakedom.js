// A very small DOM, enough to render the app's views (built with core/ui/dom.js h()) in Node and
// click through them: elements, text, events with bubbling, select values, dialogs.

class FEvent {
  constructor(type, opts = {}) { this.type = type; this.bubbles = !!opts.bubbles; this.target = null; this.cancelBubble = false; this.defaultPrevented = false; this.dataTransfer = opts.dataTransfer; }
  stopPropagation() { this.cancelBubble = true; }
  preventDefault() { this.defaultPrevented = true; }
}

class FNode {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { c.parentNode?.removeChild(c); this.childNodes.push(c); c.parentNode = this; return c; }
  insertBefore(c, ref) { c.parentNode?.removeChild(c); const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); c.parentNode = this; return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== '' && v != null) this.appendChild(new FText(String(v))); }
}

class FText extends FNode {
  constructor(t) { super(); this.data = t; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class FClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, on = !this.set.has(c)) { if (on) this.set.add(c); else this.set.delete(c); return on; }
}

class FElement extends FNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.classList = new FClassList();
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.id = '';
    this._value = '';
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get value() {
    if (this.tagName !== 'SELECT') return this._value;
    const opts = this.findAll((e) => e.tagName === 'OPTION');
    const sel = opts.filter((o) => o.selected).pop() || opts[0];
    return sel ? String(sel.value) : '';
  }
  set value(v) {
    if (this.tagName !== 'SELECT') { this._value = v; return; }
    for (const o of this.findAll((e) => e.tagName === 'OPTION')) o.selected = String(o.value) === String(v);
  }
  append(...n) { for (const x of n.flat()) if (x !== null && x !== undefined && x !== false) this.appendChild(typeof x === 'object' ? x : new FText(String(x))); }
  prepend(...n) { const first = this.firstChild; for (const x of n.flat()) if (x !== null && x !== undefined && x !== false) this.insertBefore(typeof x === 'object' ? x : new FText(String(x)), first); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) {
    ev.target ??= this;
    for (const fn of this.listeners[ev.type] || []) fn(ev);
    if (ev.bubbles && !ev.cancelBubble && this.parentNode?.dispatchEvent) this.parentNode.dispatchEvent(ev);
    return !ev.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent(new FEvent('click', { bubbles: true })); }
  focus() {}
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new FEvent('close')); }
  /** Every descendant element matching pred. */
  findAll(pred, out = []) {
    for (const c of this.childNodes) if (c instanceof FElement) { if (pred(c)) out.push(c); c.findAll(pred, out); }
    return out;
  }
}

export function installFakeDom() {
  const saved = { document: globalThis.document, Node: globalThis.Node, Element: globalThis.Element, Event: globalThis.Event };
  const body = new FElement('body');
  globalThis.document = {
    body,
    createElement: (t) => new FElement(t),
    createElementNS: (_ns, t) => new FElement(t),
    createTextNode: (t) => new FText(t),
    getElementById: () => null,
  };
  globalThis.Node = FNode;
  globalThis.Element = FElement;
  globalThis.Event = FEvent;
  return () => Object.assign(globalThis, saved);
}

// ------------------------------------------------------------ test helpers
export const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); };
export const text = (el) => el.textContent;
/** The first element under root whose tag matches and whose text includes `label`. */
export function byText(root, tag, label) {
  return root.findAll((e) => e.tagName === tag.toUpperCase() && e.textContent.includes(label))[0] || null;
}
/** The open dialog (the last one added to the body): core/ui/dom.js dialog() makes a <wa-dialog>. */
export const openDialog = () => document.body.findAll((e) => (e.tagName === 'DIALOG' || e.tagName === 'WA-DIALOG') && e.open).pop() || null;
/** Click a dialog button by its label. */
export async function answer(label) {
  await settle(2);
  const dlg = openDialog();
  if (!dlg) throw new Error(`no dialog open to answer "${label}"`);
  const b = dlg.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0];
  if (!b) throw new Error(`dialog has no "${label}" button: ${dlg.textContent.slice(0, 200)}`);
  b.click();
  await settle();
}
export function change(el, value) {
  if ('checked' in el && typeof value === 'boolean') el.checked = value; else el.value = value;
  el.dispatchEvent(new FEvent('change', { bubbles: true }));
}
