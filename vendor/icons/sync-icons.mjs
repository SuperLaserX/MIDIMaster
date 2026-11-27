// Copies the Font Awesome Free icons MIDIMaster uses into vendor/icons/{solid,regular}/, where
// <wa-icon name="..."> finds them (js/core/ui/wa.js sets Web Awesome's icon path to vendor/icons).
// Only these icons are bundled; add a name here and run the script again to use another one.
//
// Usage: npm pack @fortawesome/fontawesome-free@7.3.1, unpack it, then
//   node vendor/icons/sync-icons.mjs <unpacked>/package

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICONS = {
  solid: [
    // pages and the sidebar (js/core/ui/icons.js)
    'plug', 'sliders', 'table-list', 'table-cells-large', 'layer-group', 'music', 'right-left', 'arrow-right-arrow-left',
    'book', 'database', 'wave-square', 'terminal', 'diagram-project', 'circle-dot', 'table-columns', 'hashtag', 'chart-line',
    'keyboard', 'file-import', 'file-export', 'display', 'gear', 'heart-pulse', 'arrow-left', 'chevron-left', 'chevron-right',
    'chevron-down', 'clock-rotate-left', 'circle', 'volume-xmark', 'house', 'grip', 'magnifying-glass', 'rotate-right', 'rotate',
    'circle-info', 'circle-check', 'triangle-exclamation', 'circle-exclamation', 'xmark', 'download', 'upload', 'folder-open',
    'floppy-disk', 'trash', 'pen', 'play', 'stop', 'pause', 'plus', 'minus', 'check', 'bolt', 'link', 'link-slash',
    'satellite-dish', 'tower-broadcast', 'list-ul', 'microchip', 'sun', 'moon', 'desktop', 'palette', 'bars', 'ellipsis-vertical',
    'arrow-right', 'copy', 'filter', 'wand-magic-sparkles', 'eye', 'power-off', 'signal', 'cube', 'cubes', 'grip-vertical',
    'toggle-on', 'sort', 'star', 'box-archive', 'broom', 'square', 'circle-half-stroke', 'arrows-rotate', 'paper-plane', 'inbox',
    'list', 'server', 'hard-drive', 'sd-card', 'compact-disc', 'guitar', 'drum', 'sitemap', 'tags', 'tag', 'wrench',
    'screwdriver-wrench', 'bullseye', 'arrow-up-right-from-square', 'circle-question', 'lightbulb', 'gauge-high', 'headphones',
    'microphone', 'volume-high', 'shuffle', 'repeat', 'sliders', 'puzzle-piece', 'radio', 'bell', 'arrow-down', 'arrow-up',
    'clone', 'pen-to-square', 'scissors', 'paste', 'eraser', 'folder', 'file', 'file-audio', 'code', 'robot', 'flask',
  ],
  regular: ['circle', 'circle-dot', 'folder-open', 'star', 'bookmark', 'file', 'copy', 'clock', 'square', 'circle-question'],
};

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pkg = process.argv[2];
  if (!pkg) { console.error('usage: node vendor/icons/sync-icons.mjs <fontawesome-free package folder>'); process.exit(1); }
  let n = 0;
  for (const [variant, names] of Object.entries(ICONS)) {
    mkdirSync(join(here, variant), { recursive: true });
    for (const name of new Set(names)) {
      const from = join(pkg, 'svgs', variant, `${name}.svg`);
      if (!existsSync(from)) { console.warn(`missing: ${variant}/${name}`); continue; }
      copyFileSync(from, join(here, variant, `${name}.svg`));
      n++;
    }
  }
  copyFileSync(join(pkg, 'LICENSE.txt'), join(here, 'LICENSE.txt'));
  console.log(`${n} icons copied`);
}
