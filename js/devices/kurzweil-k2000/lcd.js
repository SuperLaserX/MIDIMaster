// Renders the K2000's 240x64 display from the GETGRAPHICS pixel layer and the
// ALLTEXT character layer (40x8 cells of 6x8 pixels, high bit = reverse video).

import { SCREEN_W, SCREEN_H, TEXT_COLS, TEXT_ROWS } from './protocol.js';

export class LcdView {
  constructor(scale = 3) {
    this.scale = scale;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lcd';
    this.canvas.width = SCREEN_W * scale;
    this.canvas.height = SCREEN_H * scale;
    this.ctx = this.canvas.getContext('2d');
    this.pixels = null;
    this.text = null;
    const css = getComputedStyle(document.documentElement);
    this.bg = css.getPropertyValue('--lcd-bg').trim() || '#2a6fd8';
    this.fg = css.getPropertyValue('--lcd-px').trim() || '#f4f1b2';
    this.render();
  }

  setPixels(px) { this.pixels = px; this.render(); }
  setText(t) { this.text = t; this.render(); }

  render() {
    const { ctx, scale: s } = this;
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.pixels) {
      ctx.fillStyle = this.fg;
      for (let y = 0; y < SCREEN_H; y++) {
        for (let x = 0; x < SCREEN_W; x++) {
          if (this.pixels[y * SCREEN_W + x]) ctx.fillRect(x * s, y * s, s - 0.4, s - 0.4);
        }
      }
    }
    if (!this.text) return;
    ctx.font = `${Math.round(7.4 * s)}px ui-monospace, Consolas, monospace`;
    ctx.textBaseline = 'top';
    for (let r = 0; r < TEXT_ROWS; r++) {
      for (let c = 0; c < TEXT_COLS; c++) {
        const ch = this.text.rows[r][c];
        const inv = this.text.inverse[r][c];
        const x = c * 6 * s;
        const y = r * 8 * s;
        const pxLit = this.pixels ? this.pixels[(r * 8 + 4) * SCREEN_W + c * 6 + 2] : 0;
        const lit = inv !== !!pxLit;
        if (inv) { ctx.fillStyle = pxLit ? this.bg : this.fg; ctx.fillRect(x, y, 6 * s, 8 * s); }
        if (ch === ' ') continue;
        ctx.fillStyle = lit ? this.bg : this.fg;
        ctx.fillText(ch, x + 0.3 * s, y + 0.4 * s, 6 * s);
      }
    }
  }
}
