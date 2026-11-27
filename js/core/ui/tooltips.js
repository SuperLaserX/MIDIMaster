// Tooltips: every element's `title` is shown in a Web Awesome popup (styled like <wa-tooltip>) instead
// of the browser's own yellow box. Nothing in the views changes: while the pointer is over an element
// its title is held back (so the browser does not show it too) and put back when the pointer leaves.

const SHOW_DELAY = 450;

export function installTooltips() {
  if (typeof document === 'undefined' || installTooltips.done) return;
  installTooltips.done = true;

  const popup = document.createElement('wa-popup');
  popup.className = 'mm-tip';
  popup.setAttribute('placement', 'top');
  popup.setAttribute('distance', '8');
  popup.setAttribute('flip', '');
  popup.setAttribute('shift', '');
  popup.setAttribute('shift-padding', '8');
  popup.setAttribute('arrow', '');
  const body = document.createElement('div');
  body.className = 'mm-tip-body';
  body.id = 'mm-tip';
  body.setAttribute('role', 'tooltip');
  popup.append(body);
  const mount = () => document.body.append(popup);
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  const held = new WeakMap(); // element -> its title while the pointer is over it
  let target = null;
  let timer = 0;

  const titled = (el) => {
    for (let e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement || e.getRootNode?.().host) {
      if (e.getAttribute('title') || held.has(e)) return e;
      if (e.tagName === 'WA-POPUP' || e.tagName === 'SELECT' || e.tagName === 'OPTION') return null; // native lists show their own
    }
    return null;
  };

  function hide() {
    clearTimeout(timer);
    popup.active = false;
    popup.removeAttribute('active');
  }

  function release() {
    if (!target) return;
    const t = target;
    target = null;
    hide();
    t.removeAttribute('aria-describedby');
    // put the title back unless the page set a new one meanwhile
    if (held.has(t)) { if (!t.hasAttribute('title')) t.setAttribute('title', held.get(t)); held.delete(t); }
  }

  function enter(el) {
    if (el === target) return;
    release();
    if (!el) return;
    const text = el.getAttribute('title');
    if (!text) return;
    target = el;
    held.set(el, text);
    el.removeAttribute('title');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (target !== el || !el.isConnected) return;
      body.textContent = held.get(el) || '';
      el.setAttribute('aria-describedby', 'mm-tip');
      popup.anchor = el;
      popup.active = true;
      popup.setAttribute('active', '');
      popup.reposition?.();
    }, SHOW_DELAY);
  }

  document.addEventListener('pointerover', (ev) => { if (ev.pointerType !== 'touch') enter(titled(ev.composedPath?.()[0] || ev.target)); }, true);
  document.addEventListener('pointerout', (ev) => {
    if (!target) return;
    const to = ev.relatedTarget;
    if (!to || !(target === to || target.contains(to))) release();
  }, true);
  for (const type of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(type, () => { if (target) hide(); }, { capture: true, passive: true });
  window.addEventListener('blur', release);
  // elements removed while the pointer is over them (a page re-rendering) get their title back
  setInterval(() => { if (target && !target.isConnected) release(); }, 1000);
}
