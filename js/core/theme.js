// Theme: dark, light or following the system, an accent colour and a text size.

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [242, 181, 68];
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const css = (rgb) => `rgb(${rgb.join(',')})`;
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

let media = null;

export function applyTheme(settings) {
  const root = document.documentElement;
  const resolve = () => (settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme);
  root.dataset.theme = resolve();
  if (!media) {
    media = matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', () => { if (settings.theme === 'system') root.dataset.theme = resolve(); });
  }
  const rgb = hexToRgb(settings.accent);
  const light = root.dataset.theme === 'light';
  root.style.setProperty('--accent', css(light ? mix(rgb, [0, 0, 0], 0.15) : rgb));
  root.style.setProperty('--accent-dim', css(mix(rgb, light ? [255, 255, 255] : [20, 20, 20], 0.35)));
  root.style.setProperty('--accent-ink', luminance(rgb) > 0.55 ? '#1b1406' : '#ffffff');
  root.style.setProperty('--accent-rgb', rgb.join(','));
  root.style.fontSize = `${Math.round(14 * (settings.fontScale || 1))}px`;
  root.dataset.density = settings.density || 'comfortable';
}
