// Icons: Font Awesome Free (bundled in vendor/icons, see vendor/icons/sync-icons.mjs) shown with
// Web Awesome's <wa-icon>. Pages and docks name their icon with a symbol (icon: '◆'); this is the one
// place those symbols become icons, so device definitions never name icons themselves.

import { h } from './dom.js';

/** The symbols pages and docks use, and the icon each stands for. */
export const GLYPH_ICONS = {
  '◉': 'plug', // Connect
  '◆': 'sliders', // an object editor (patch, voice, performance...)
  '◇': 'table-list', // parameters, other settings pages
  '▦': 'table-cells-large', // galleries (every value of a parameter as a picture)
  '⇶': 'layer-group', // MIDI channels of a multitimbral device
  '♪': 'music', // controllers, notes
  '♫': 'music', // patterns, songs
  '⇆': 'right-left', // input mappings
  '⇄': 'arrow-right-arrow-left', // program changes
  '☰': 'book', // Branch Library
  '❖': 'database', // Head Library
  '∿': 'wave-square', // samples, motion
  '⌨': 'terminal', // SysEx console
  '⋔': 'diagram-project', // algorithms
  '▤': 'table-list', // maps, rhythm sets, modules
  '◎': 'circle-dot', // effects, templates
  '◫': 'table-columns', // performances
  '♯': 'hashtag', // micro tuning
  '⟋': 'chart-line', // scaling curves
  '☷': 'keyboard', // keymaps
  '⇪': 'file-import', // disk import
  '▣': 'display', // front panel
  '⚙': 'gear', // settings, system, global
  '≡': 'heart-pulse', // MIDI monitor
  '‹': 'arrow-left', // back
  '·': 'clock-rotate-left', // a recent device
  '•': 'circle', // anything without its own symbol
};

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The icon name for a page symbol or an icon name; null when there is none. */
export function iconName(glyph) {
  if (!glyph) return null;
  if (GLYPH_ICONS[glyph]) return GLYPH_ICONS[glyph];
  return NAME.test(glyph) ? glyph : null;
}

/**
 * An icon element for a page symbol ('◆') or an icon name ('gear'). Symbols without an icon are shown
 * as they are. label: read out by screen readers (otherwise the icon is decorative).
 */
export function icon(glyph, { label, cls = '', variant } = {}) {
  const name = iconName(glyph);
  if (!name) return h(`span.icon-glyph${cls ? `.${cls}` : ''}`, { 'aria-hidden': 'true' }, glyph || '');
  return h(`wa-icon${cls ? `.${cls}` : ''}`, { name, variant, label, 'aria-hidden': label ? undefined : 'true' });
}
