/** Canvas 기반 경량 플로팅 도구. 점이 많아도 DOM 노드를 만들지 않아 저사양 기기에 유리하다. */
import { niceTicks, formatNumber } from '../core/stats';
import { h } from './dom';

/** Orange 기본 범주형 팔레트(Orange.widgets.utils.colorpalettes DefaultRGBColors) */
export const ORANGE_COLORS: Array<[number, number, number]> = [
  [70, 190, 250], [237, 70, 47], [170, 242, 43], [245, 174, 50], [255, 255, 0], [255, 0, 255],
  [0, 255, 255], [128, 0, 255], [0, 128, 255], [255, 223, 128], [127, 111, 64], [92, 46, 0],
  [0, 84, 0], [192, 192, 0], [0, 127, 127], [128, 0, 0], [127, 0, 127],
];

export function discreteColor(i: number, alpha = 1): string {
  if (Number.isNaN(i) || i < 0) return `rgba(128,128,128,${alpha})`;
  const [r, g, b] = ORANGE_COLORS[i % ORANGE_COLORS.length];
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 연속형 색상(viridis 근사) */
const VIRIDIS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
export function continuousColor(t: number, alpha = 1): string {
  if (Number.isNaN(t)) return `rgba(128,128,128,${alpha})`;
  t = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(t));
  const f = t - i;
  const c = VIRIDIS[i].map((v, k) => Math.round(v + (VIRIDIS[i + 1][k] - v) * f));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** 발산형 색상(상관계수 등, -1 파랑 ~ +1 빨강) */
export function divergingColor(t: number): string {
  if (Number.isNaN(t)) return 'rgba(128,128,128,0.3)';
  const a = Math.min(1, Math.abs(t));
  return t >= 0 ? `rgba(220,60,50,${0.15 + 0.85 * a})` : `rgba(50,110,220,${0.15 + 0.85 * a})`;
}

export function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface Margins { l: number; r: number; t: number; b: number }

export class Plot {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  m: Margins;
  fg = themeColor('--plot-fg', '#ddd');
  grid = themeColor('--plot-grid', 'rgba(255,255,255,0.08)');
  bg = themeColor('--plot-bg', '#1e1f24');

  constructor(container: HTMLElement, w: number, h0: number, m: Partial<Margins> = {}) {
    this.w = Math.max(200, Math.floor(w));
    this.h = Math.max(150, Math.floor(h0));
    this.m = { l: 56, r: 16, t: 16, b: 44, ...m };
    const dpr = Math.min(2, window.devicePixelRatio || 1); // 저사양 기기 메모리를 위해 2배로 제한
    this.canvas = h('canvas', { class: 'plot-canvas', width: Math.floor(this.w * dpr), height: Math.floor(this.h * dpr), style: `width:${this.w}px;height:${this.h}px` });
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.ctx.fillStyle = this.bg;
    this.ctx.fillRect(0, 0, this.w, this.h);
    this.ctx.font = '12px system-ui, sans-serif';
  }

  get pw(): number { return this.w - this.m.l - this.m.r; }
  get ph(): number { return this.h - this.m.t - this.m.b; }

  scaleX(lo: number, hi: number): (v: number) => number {
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    return (v) => this.m.l + ((v - lo) / (hi - lo)) * this.pw;
  }
  scaleY(lo: number, hi: number): (v: number) => number {
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    return (v) => this.m.t + this.ph - ((v - lo) / (hi - lo)) * this.ph;
  }

  /** 수치 축 그리기 */
  axes(x: { lo: number; hi: number; label: string; ticks?: Array<[number, string]> }, y: { lo: number; hi: number; label: string; ticks?: Array<[number, string]> }): void {
    const { ctx, m } = this;
    const sx = this.scaleX(x.lo, x.hi), sy = this.scaleY(y.lo, y.hi);
    ctx.strokeStyle = this.grid;
    ctx.fillStyle = this.fg;
    ctx.lineWidth = 1;
    const xt = x.ticks ?? niceTicks(x.lo, x.hi, Math.max(2, Math.floor(this.pw / 80))).map((t) => [t, formatNumber(t)] as [number, string]);
    const yt = y.ticks ?? niceTicks(y.lo, y.hi, Math.max(2, Math.floor(this.ph / 50))).map((t) => [t, formatNumber(t)] as [number, string]);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const [t, l] of xt) {
      const px = sx(t);
      if (px < m.l - 1 || px > m.l + this.pw + 1) continue;
      ctx.beginPath(); ctx.moveTo(px + 0.5, m.t); ctx.lineTo(px + 0.5, m.t + this.ph); ctx.stroke();
      ctx.fillText(l, px, m.t + this.ph + 6);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const [t, l] of yt) {
      const py = sy(t);
      if (py < m.t - 1 || py > m.t + this.ph + 1) continue;
      ctx.beginPath(); ctx.moveTo(m.l, py + 0.5); ctx.lineTo(m.l + this.pw, py + 0.5); ctx.stroke();
      ctx.fillText(l, m.l - 6, py);
    }
    ctx.strokeStyle = this.fg;
    ctx.globalAlpha = 0.5;
    ctx.strokeRect(m.l + 0.5, m.t + 0.5, this.pw, this.ph);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(x.label, m.l + this.pw / 2, this.h - 4);
    ctx.save();
    ctx.translate(14, m.t + this.ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(y.label, 0, 0);
    ctx.restore();
  }

  legend(items: Array<{ label: string; color: string }>, x?: number, y?: number): void {
    if (!items.length) return;
    const { ctx } = this;
    ctx.font = '12px system-ui, sans-serif';
    const w = Math.max(...items.map((i) => ctx.measureText(i.label).width)) + 30;
    const lx = x ?? this.m.l + this.pw - w - 6;
    const ly = y ?? this.m.t + 6;
    ctx.fillStyle = this.bg;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(lx, ly, w, items.length * 18 + 8);
    ctx.globalAlpha = 1;
    items.forEach((it, i) => {
      ctx.fillStyle = it.color;
      ctx.beginPath(); ctx.arc(lx + 12, ly + 13 + i * 18, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = this.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(it.label, lx + 22, ly + 13 + i * 18);
    });
  }
}

export function plotSize(main: HTMLElement, minH = 320): [number, number] {
  // clientWidth/Height에는 안쪽 여백이 포함되므로 빼고, 아래 상태 문구 한 줄 공간을 남긴다
  const cs = getComputedStyle(main);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const w = (main.clientWidth || 640) - padX;
  const hh = Math.max(minH, (main.clientHeight || 480) - padY - 28);
  return [w - 2, hh];
}
