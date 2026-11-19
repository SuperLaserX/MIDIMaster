// Parameter controls: rotary knob, select, note field, toggle, raw hex row.
// Every control calls onChange(value) continuously while dragging; the caller
// coalesces the resulting LOAD messages so only the latest value is sent.

import { h, svg } from './dom.js';
import { noteName, parseNoteName } from '../music.js';

const onOff = (v) => (v ? 'On' : 'Off');

const CONF_TITLE = {
  confirmed: 'Confirmed field',
  likely: 'Likely field (matches the K2000 page layout)',
  guess: 'Unconfirmed field',
  user: 'Field labelled by you',
};

function arcPath(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Rotary knob.
 * opts: {label, value, min, max, format(v)->string, conf, onChange(v), title}
 */
export function knob(opts) {
  const { min, max } = opts;
  let value = opts.value;
  const A0 = Math.PI * 0.75;
  const A1 = Math.PI * 2.25;
  const track = svg('path', { class: 'k-track', d: arcPath(23, 23, 18, A0, A1), fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round' });
  const arc = svg('path', { class: 'k-arc', fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round' });
  const pointer = svg('line', { stroke: '#cfd3dc', 'stroke-width': 2, 'stroke-linecap': 'round' });
  const icon = svg('svg', { viewBox: '0 0 46 46' }, track, arc, pointer);
  const valueEl = h('div.k-value');
  const el = h('div.knob.' + (opts.conf || 'confirmed'), { title: opts.title || `${opts.label}${opts.conf ? ' - ' + CONF_TITLE[opts.conf] : ''}` },
    opts.conf === 'guess' ? h('span.k-conf', '?') : null,
    icon, h('div.k-label', opts.label), valueEl);

  const zero = min < 0 && max > 0 ? 0 : min;
  function draw() {
    const t = (value - min) / (max - min || 1);
    const tz = (zero - min) / (max - min || 1);
    const a = A0 + (A1 - A0) * t;
    const az = A0 + (A1 - A0) * tz;
    arc.setAttribute('d', Math.abs(a - az) < 0.01 ? '' : arcPath(23, 23, 18, Math.min(a, az), Math.max(a, az)));
    pointer.setAttribute('x1', 23 + 7 * Math.cos(a)); pointer.setAttribute('y1', 23 + 7 * Math.sin(a));
    pointer.setAttribute('x2', 23 + 15 * Math.cos(a)); pointer.setAttribute('y2', 23 + 15 * Math.sin(a));
    valueEl.textContent = opts.format ? opts.format(value) : String(value);
  }
  function set(v, notify = true) {
    v = Math.max(min, Math.min(max, Math.round(v)));
    if (v === value) return;
    value = v;
    draw();
    if (notify) opts.onChange?.(v);
  }

  let dragY = null;
  let dragV = 0;
  icon.addEventListener('pointerdown', (e) => {
    if (opts.readOnly) return;
    icon.setPointerCapture(e.pointerId);
    dragY = e.clientY; dragV = value;
  });
  icon.addEventListener('pointermove', (e) => {
    if (dragY === null) return;
    const range = max - min;
    const speed = e.shiftKey ? 0.15 : range > 64 ? Math.max(0.5, range / 160) : Math.max(0.12, range / 120);
    set(dragV + (dragY - e.clientY) * speed);
  });
  icon.addEventListener('pointerup', () => { dragY = null; });
  icon.addEventListener('wheel', (e) => {
    if (opts.readOnly) return;
    e.preventDefault();
    set(value + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
  }, { passive: false });
  icon.addEventListener('dblclick', () => edit());
  valueEl.addEventListener('click', () => edit());

  function edit() {
    if (opts.readOnly) return;
    const inp = h('input', { type: 'number', value, min, max });
    valueEl.replaceWith(inp);
    inp.focus(); inp.select();
    let finished = false;
    const done = (commit) => {
      if (finished) return; // Enter removes the input, which fires blur again
      finished = true;
      if (commit && inp.value !== '') set(Number(inp.value));
      inp.replaceWith(valueEl);
      draw();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }

  draw();
  el.setValue = (v) => { value = v; draw(); };
  el.setState = (state) => { el.classList.toggle('pending', state === 'pending'); el.classList.toggle('error', state === 'error'); };
  return el;
}

function labelRow(label, conf) {
  return h('span.p-label', h('span.conf-dot.' + (conf || 'confirmed'), { title: CONF_TITLE[conf || 'confirmed'] }), label);
}

/** Select from a list of {value,label}. */
export function selectField(opts) {
  const sel = h('select', { disabled: opts.readOnly, onchange: () => opts.onChange?.(Number(sel.value)) },
    opts.options.map((o) => h('option', { value: o.value }, o.label)));
  if (!opts.options.some((o) => o.value === opts.value)) sel.appendChild(h('option', { value: opts.value }, `${opts.value} (unlisted)`));
  sel.value = String(opts.value);
  const el = h('div.pfield', labelRow(opts.label, opts.conf), sel);
  el.setValue = (v) => { sel.value = String(v); };
  return el;
}


/** Note number field showing the key name. */
export function noteField(opts) {
  const inp = h('input', { type: 'text', value: noteName(opts.value), size: 5, disabled: opts.readOnly });
  const commit = () => {
    const v = /^-?[0-9]+$/.test(inp.value.trim()) ? Number(inp.value) : parseNoteName(inp.value);
    if (v === null || v < 0 || v > 127) { inp.value = noteName(opts.value); return; }
    opts.value = v;
    inp.value = noteName(v);
    opts.onChange?.(v);
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      opts.value = Math.max(0, Math.min(127, opts.value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1)));
      inp.value = noteName(opts.value);
      opts.onChange?.(opts.value);
    }
  });
  const el = h('div.pfield', labelRow(opts.label, opts.conf), inp);
  el.setValue = (v) => { opts.value = v; inp.value = noteName(v); };
  return el;
}

/** Numeric input with formatted readout. */
export function numberField(opts) {
  const out = h('span.small.muted', opts.format ? opts.format(opts.value) : '');
  const inp = h('input', {
    type: 'number', value: opts.value, min: opts.min, max: opts.max, disabled: opts.readOnly,
    onchange: () => {
      const v = Math.max(opts.min, Math.min(opts.max, Number(inp.value)));
      inp.value = v;
      out.textContent = opts.format ? opts.format(v) : '';
      opts.onChange?.(v);
    },
  });
  const el = h('div.pfield', labelRow(opts.label, opts.conf), h('div.row', inp, out, opts.extra || null));
  el.setValue = (v) => { inp.value = v; out.textContent = opts.format ? opts.format(v) : ''; };
  return el;
}

export function toggleField(opts) {
  const btn = h('button.btn.small.toggle' + (opts.value ? '.on' : ''), {
    disabled: opts.readOnly,
    onclick: () => { opts.value = opts.value ? 0 : 1; btn.classList.toggle('on', !!opts.value); btn.textContent = onOff(opts.value); opts.onChange?.(opts.value); },
  }, onOff(opts.value));
  const el = h('div.pfield', labelRow(opts.label, opts.conf), btn);
  el.setValue = (v) => { opts.value = v; btn.classList.toggle('on', !!v); btn.textContent = onOff(v); };
  return el;
}

/**
 * Raw byte editor for a segment.
 * opts: {bytes (Uint8Array incl. tag), known:Set(offsets), onChange(index, value)}
 */
export function hexRow(opts) {
  const row = h('div.hexrow');
  row.appendChild(h('div.hx-tag', { title: 'Segment tag' }, opts.bytes[0].toString(16).padStart(2, '0')));
  for (let i = 1; i < opts.bytes.length; i++) {
    const idx = i - 1;
    const inp = h('input' + (opts.known?.has(idx) ? '.known' : ''), {
      value: opts.bytes[i].toString(16).padStart(2, '0'), maxlength: 2,
      title: `data[${idx}] = ${opts.bytes[i]} (signed ${opts.bytes[i] > 127 ? opts.bytes[i] - 256 : opts.bytes[i]})`,
    });
    inp.addEventListener('change', () => {
      const v = parseInt(inp.value, 16);
      if (Number.isNaN(v) || v < 0 || v > 255) { inp.value = opts.bytes[i].toString(16).padStart(2, '0'); return; }
      inp.value = v.toString(16).padStart(2, '0');
      inp.classList.add('changed');
      opts.onChange?.(idx, v);
    });
    inp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = (parseInt(inp.value, 16) + (e.deltaY < 0 ? 1 : -1) + 256) & 0xff;
      inp.value = v.toString(16).padStart(2, '0');
      inp.classList.add('changed');
      opts.onChange?.(idx, v);
    }, { passive: false });
    row.appendChild(inp);
  }
  return row;
}
