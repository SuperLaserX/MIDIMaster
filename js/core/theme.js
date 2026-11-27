// Theme: dark, light or following the system, an accent colour and a text size. The page uses Web
// Awesome's theme (css/theme.css): the wa-dark / wa-light class picks its colours and the accent
// becomes Web Awesome's brand colour, a scale of tones from dark (05) to light (95) around it.

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [242, 181, 68];
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const css = (rgb) => `rgb(${rgb.join(',')})`;
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Web Awesome's tone steps: 50 is the accent itself, lower is darker, higher is lighter. */
export const TONES = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95];
export function brandTones(hex) {
  const rgb = hexToRgb(hex);
  return Object.fromEntries(TONES.map((n) => {
    const t = n === 50 ? 0 : n > 50 ? ((n - 50) / 50) ** 0.9 * 0.92 : ((50 - n) / 50) ** 0.75 * 0.88;
    return [String(n).padStart(2, '0'), css(n === 50 ? rgb : mix(rgb, n > 50 ? [255, 255, 255] : [8, 8, 10], t))];
  }));
}

let media = null;
let current = null; // the settings last applied (the system theme can change later)

export function applyTheme(settings) {
  current = settings;
  const root = document.documentElement;
  const resolve = () => (settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme === 'light' ? 'light' : 'dark');
  const setMode = () => {
    const mode = resolve();
    root.dataset.theme = mode;
    root.classList.toggle('wa-dark', mode === 'dark');
    root.classList.toggle('wa-light', mode === 'light');
  };
  setMode();
  if (!media) {
    media = matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', () => { if (current?.theme === 'system') applyTheme(current); });
  }
  const rgb = hexToRgb(settings.accent);
  const light = root.dataset.theme === 'light';
  for (const [n, c] of Object.entries(brandTones(settings.accent))) root.style.setProperty(`--wa-color-brand-${n}`, c);
  // lines and arcs drawn in the accent colour: a little darker on a light page
  root.style.setProperty('--accent', css(light ? mix(rgb, [0, 0, 0], 0.15) : rgb));
  root.style.setProperty('--accent-fill', css(rgb));
  root.style.setProperty('--accent-rgb', rgb.join(','));
  root.style.setProperty('--accent-ink', luminance(rgb) > 0.55 ? '#1b1406' : '#ffffff');
  root.style.fontSize = `${Math.round(14 * (settings.fontScale || 1))}px`;
  root.dataset.density = settings.density || 'comfortable';
}
