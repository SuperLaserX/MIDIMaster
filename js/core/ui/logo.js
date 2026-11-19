// ASCII-art logos. Text is drawn from a 5x7 pixel font, then rendered in one of many
// styles and framed. Every device gets its own combination, so no two logos share a style.

const FONT = {
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  C: [' ### ', '#   #', '#    ', '#    ', '#    ', '#   #', ' ### '],
  D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ####'],
  H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  I: [' ### ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  J: ['  ###', '   # ', '   # ', '   # ', '   # ', '#  # ', ' ##  '],
  K: ['#   #', '#  # ', '# #  ', '##   ', '# #  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
  N: ['#   #', '#   #', '##  #', '# # #', '#  ##', '#   #', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  Q: [' ### ', '#   #', '#   #', '#   #', '# # #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '#   #', '# # #', '# # #', '# # #', ' # # '],
  X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '    #', '   # ', '  #  ', ' #   ', '#    ', '#####'],
  0: [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  1: ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  2: [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  3: ['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### '],
  4: ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  5: ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  6: ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  7: ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  8: [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  9: [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
  '-': ['    ', '    ', '    ', '####', '    ', '    ', '    '],
  '+': ['     ', '  #  ', '  #  ', '#####', '  #  ', '  #  ', '     '],
  '/': ['    #', '    #', '   # ', '  #  ', ' #   ', '#    ', '#    '],
  '.': ['  ', '  ', '  ', '  ', '  ', '##', '##'],
  '&': [' ##  ', '#  # ', '# #  ', ' #   ', '# # #', '#  # ', ' ## #'],
  "'": ['#', '#', ' ', ' ', ' ', ' ', ' '],
  '!': ['#', '#', '#', '#', '#', ' ', '#'],
  '(': [' #', '# ', '# ', '# ', '# ', '# ', ' #'],
  ')': ['# ', ' #', ' #', ' #', ' #', ' #', '# '],
  ':': [' ', '#', ' ', ' ', ' ', '#', ' '],
  '?': [' ### ', '#   #', '    #', '   # ', '  #  ', '     ', '  #  '],
  '_': ['     ', '     ', '     ', '     ', '     ', '     ', '#####'],
  '|': ['#', '#', '#', '#', '#', '#', '#'],
  ' ': ['   ', '   ', '   ', '   ', '   ', '   ', '   '],
};
const ROWS = 7;

/** Pixel grid for a string: array of rows of booleans. */
export function bitmap(text, spacing = 1) {
  const glyphs = [...String(text).toUpperCase()].map((ch) => FONT[ch] || FONT['?']);
  const rows = Array.from({ length: ROWS }, () => []);
  glyphs.forEach((g, i) => {
    for (let r = 0; r < ROWS; r++) {
      for (const c of g[r]) rows[r].push(c === '#');
      if (i < glyphs.length - 1) for (let s = 0; s < spacing; s++) rows[r].push(false);
    }
  });
  return rows;
}

const at = (b, r, c) => r >= 0 && r < b.length && c >= 0 && c < b[0].length && b[r][c];
const near = (b, r, c) => {
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if ((dr || dc) && at(b, r + dr, c + dc)) return true;
  return false;
};
const map = (b, fn) => b.map((row, r) => row.map((on, c) => fn(on, r, c)).join(''));

/** Rendering styles: bitmap -> lines. */
export const STYLES = {
  block: (b) => map(b, (on) => (on ? '█' : ' ')),
  hash: (b) => map(b, (on) => (on ? '#' : ' ')),
  wide: (b) => map(b, (on) => (on ? '██' : '  ')),
  dots: (b) => map(b, (on) => (on ? '●' : '·')),
  pixel: (b) => map(b, (on) => (on ? '■' : ' ')),
  banner: (b, text) => {
    const letters = [...String(text).toUpperCase()].filter((ch) => FONT[ch] || ch);
    const owner = [];
    letters.forEach((ch, i) => { const w = (FONT[ch] || FONT['?'])[0].length; for (let k = 0; k < w; k++) owner.push(/[A-Z0-9]/.test(ch) ? ch : '*'); if (i < letters.length - 1) owner.push(' '); });
    return map(b, (on, r, c) => (on ? owner[c] || '*' : ' '));
  },
  gradient: (b) => map(b, (on, r) => (on ? '█▓▓▒▒░░'[r] : ' ')),
  shadow: (b) => {
    const h = b.length + 1;
    const w = b[0].length + 1;
    return Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => (at(b, r, c) ? '█' : at(b, r - 1, c - 1) ? '░' : ' ')).join(''));
  },
  extrude: (b) => {
    const h = b.length + 2;
    const w = b[0].length + 2;
    return Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => {
      if (at(b, r, c)) return '█';
      if (at(b, r - 1, c - 1)) return '▓';
      if (at(b, r - 2, c - 2)) return '▒';
      return ' ';
    }).join(''));
  },
  glow: (b) => map(b, (on, r, c) => (on ? '▓' : near(b, r, c) ? '░' : ' ')),
  neon: (b) => map(b, (on, r, c) => (on ? '█' : near(b, r, c) ? '·' : ' ')),
  italic: (b) => b.map((row, r) => ' '.repeat(Math.floor((b.length - 1 - r) / 2)) + row.map((on) => (on ? '█' : ' ')).join('')),
  slash: (b) => b.map((row, r) => ' '.repeat(b.length - 1 - r) + row.map((on) => (on ? '/' : ' ')).join('')),
  half: (b) => {
    const out = [];
    for (let r = 0; r < b.length; r += 2) {
      out.push(b[r].map((on, c) => { const lo = at(b, r + 1, c); return on && lo ? '█' : on ? '▀' : lo ? '▄' : ' '; }).join(''));
    }
    return out;
  },
  braille: (b) => {
    const out = [];
    const dots = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
    for (let r = 0; r < b.length; r += 4) {
      let line = '';
      for (let c = 0; c < b[0].length; c += 2) {
        let v = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) if (at(b, r + y, c + x)) v |= dots[y][x];
        line += String.fromCharCode(0x2800 + v);
      }
      out.push(line);
    }
    return out;
  },
  scanline: (b) => b.flatMap((row) => [row.map((on) => (on ? '█' : ' ')).join(''), row.map((on) => (on ? '▀' : ' ')).join('')]),
  outline: (b) => map(b, (on, r, c) => {
    if (!on) return ' ';
    const n = [at(b, r - 1, c), at(b, r, c + 1), at(b, r + 1, c), at(b, r, c - 1)];
    const key = n.map((x) => (x ? 1 : 0)).join('');
    return {
      '0000': '▪', '1000': '╵', '0100': '╶', '0010': '╷', '0001': '╴', '1010': '│', '0101': '─', '1100': '└', '0110': '┌',
      '0011': '┐', '1001': '┘', '1110': '├', '0111': '┬', '1011': '┤', '1101': '┴', '1111': '┼',
    }[key];
  }),
  stencil: (b) => map(b, (on, r, c) => (on ? (r % 2 ? '▒' : '▓') : ' ')),
  digital: (b) => map(b, (on, r, c) => (on ? ((r + c) % 2 ? '▚' : '▞') : ' ')),
};
export const STYLE_NAMES = Object.keys(STYLES);

const FRAMES = {
  none: null,
  single: '┌─┐│└┘',
  double: '╔═╗║╚╝',
  rounded: '╭─╮│╰╯',
  heavy: '┏━┓┃┗┛',
  ascii: '+-+|++',
  stars: '*** ***',
  dashed: '┌┄┐┆└┘',
};
export const FRAME_NAMES = Object.keys(FRAMES);

const width = (s) => [...s].length;

function frame(lines, kind) {
  const f = FRAMES[kind];
  const w = Math.max(...lines.map(width));
  const pad = (s) => s + ' '.repeat(w - width(s));
  if (!f) return lines.map(pad);
  const [tl, hz, tr, vt, bl, br] = kind === 'stars' ? ['*', '*', '*', '*', '*', '*'] : [...f];
  return [tl + hz.repeat(w + 4) + tr, vt + ' '.repeat(w + 4) + vt, ...lines.map((l) => `${vt}  ${pad(l)}  ${vt}`), vt + ' '.repeat(w + 4) + vt, bl + hz.repeat(w + 4) + br];
}

/** Short text for a logo: the model name without parentheses, at most `max` characters. */
export function logoText(model, max = 12) {
  let t = String(model).replace(/\(.*?\)/g, '').replace(/[^A-Za-z0-9 \-+/.&!']/g, '').trim();
  if (t.length > max) t = t.split(/[ /]/).filter(Boolean).reduce((acc, w) => (acc.length + w.length + 1 <= max ? (acc ? `${acc} ${w}` : w) : acc), '') || t.slice(0, max);
  return t.toUpperCase();
}

/**
 * Render a logo. opts: {style, frame, spacing, caption, captionAbove}
 * The caption (usually the maker) is drawn in letter-spaced capitals.
 */
export function renderLogo(text, { style = 'block', frame: fr = 'none', spacing = 1, caption = '', captionAbove = false, captionStyle = 'spaced' } = {}) {
  const lines = (STYLES[style] || STYLES.block)(bitmap(text, spacing), text);
  const up = caption.toUpperCase();
  const cap = !caption ? '' : captionStyle === 'bracket' ? `[ ${up} ]` : captionStyle === 'rule' ? `── ${up} ──` : [...up].join(' ');
  const w = Math.max(...lines.map(width));
  const center = (s) => ' '.repeat(Math.max(0, Math.floor((w - width(s)) / 2))) + s;
  const body = cap ? (captionAbove ? [center(cap), '', ...lines] : [...lines, '', center(cap)]) : lines;
  return frame(body, fr).map((l) => l.replace(/\s+$/, '')).join('\n');
}

/** The n-th unique style combination (style x frame x spacing x caption position). */
export function styleCombo(n) {
  const s = STYLE_NAMES.length;
  const f = FRAME_NAMES.length;
  const total = s * f * 4 * 3;
  const i = ((n % total) + total) % total;
  return {
    style: STYLE_NAMES[i % s],
    frame: FRAME_NAMES[Math.floor(i / s) % f],
    spacing: Math.floor(i / (s * f)) % 2 ? 2 : 1,
    captionAbove: Math.floor(i / (s * f * 2)) % 2 === 1,
    captionStyle: CAPTION_STYLES[Math.floor(i / (s * f * 4)) % CAPTION_STYLES.length],
  };
}

const CAPTION_STYLES = ['spaced', 'bracket', 'rule'];
export const COMBO_COUNT = STYLE_NAMES.length * FRAME_NAMES.length * 4 * CAPTION_STYLES.length;

/** Key that identifies a style combination, used to keep logos unique. */
export const comboKey = (c) => `${c.style}/${c.frame}/${c.spacing}/${c.captionAbove ? 'a' : 'b'}/${c.captionStyle || 'spaced'}`;
