/**
 * 웹 메르카토르 지도 캔버스. 타일 배경 + 사용자 레이어(점, 다각형) + 이동/확대/영역 선택.
 * 지도 타일은 인터넷이 필요하다. 오프라인이거나 "경계선" 배경을 고르면 애드온에 포함된 국가/시·도 경계를 그린다.
 */
import { h } from '../../ui/dom';
import { themeColor } from '../../ui/plot';
import { loadRegions, type RegionSet } from './regions';

export interface TileProvider { url: string | null; attribution: string; maxZoom: number; dark?: boolean }

/** orangecontrib.geo.widgets.plotutils.TILE_PROVIDERS 를 따른 배경 지도 목록 + 오프라인 경계선 */
export const TILE_PROVIDERS: Record<string, TileProvider> = {
  OpenStreetMap: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19 },
  'Black and white': { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19 },
  'Dark (CARTO)': { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19, dark: true },
  Topographic: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: '지도 데이터 © OpenStreetMap contributors, SRTM | 스타일 © OpenTopoMap (CC-BY-SA)', maxZoom: 17 },
  '경계선만 (오프라인)': { url: null, attribution: 'Natural Earth · 통계청 2013 경계', maxZoom: 14, dark: true },
};
export const DEFAULT_TILE_PROVIDER = 'OpenStreetMap';

const MAX_LAT = 85.0511287798;
export const mercX = (lon: number) => (lon + 180) / 360;
export const mercY = (lat: number) => {
  const φ = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2;
};
const invX = (x: number) => x * 360 - 180;
const invY = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

export interface MapViewState { lon: number; lat: number; zoom: number }

// 타일 이미지 캐시(창을 다시 그려도 재다운로드하지 않음). 저사양 기기를 위해 개수 제한
const tileCache = new Map<string, HTMLImageElement>();
const TILE_CACHE_MAX = 300;
/** 타일 서버별 성공/실패 횟수. 한 장도 못 받고 여러 번 실패하면(오프라인·차단) 경계선 배경으로 전환 */
const tileStats = new Map<string, { ok: number; fail: number }>();
const tileServerDown = (tpl: string) => { const st = tileStats.get(tpl); return !!st && st.ok === 0 && st.fail >= 4; };
let offlineBase: { world: RegionSet | null; kr: RegionSet | null } | null = null;

export class MapView {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  readonly el: HTMLElement;
  w: number;
  h: number;
  view: MapViewState;
  mode: 'pan' | 'select' = 'pan';
  provider: TileProvider;
  /** 점·다각형 레이어 그리기 */
  drawLayers: (ctx: CanvasRenderingContext2D, px: (lon: number, lat: number) => [number, number], zoom: number) => void = () => {};
  onViewChange: (v: MapViewState) => void = () => {};
  onSelect: (r: { x0: number; y0: number; x1: number; y1: number } | null, additive: boolean) => void = () => {};
  onClick: (x: number, y: number, additive: boolean) => void = () => {};
  onHover: (x: number, y: number) => string | null = () => null;
  private raf = 0;
  private tileFailed = false;

  constructor(host: HTMLElement, w: number, hh: number, view: MapViewState, providerName: string) {
    this.w = Math.max(240, Math.floor(w)); this.h = Math.max(200, Math.floor(hh));
    this.view = { ...view };
    this.provider = TILE_PROVIDERS[providerName] ?? TILE_PROVIDERS[DEFAULT_TILE_PROVIDER];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas = h('canvas', { class: 'plot-canvas map-canvas', width: Math.floor(this.w * dpr), height: Math.floor(this.h * dpr), style: `width:${this.w}px;height:${this.h}px` });
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    const rect = h('div', { class: 'sel-rect' });
    const tip = h('div', { class: 'map-tip', hidden: true });
    const zoomBtns = h('div', { class: 'map-zoom' },
      h('button', { class: 'icon-btn', title: '확대', 'aria-label': '확대', onclick: () => this.zoomAt(1, this.w / 2, this.h / 2) }, '+'),
      h('button', { class: 'icon-btn', title: '축소', 'aria-label': '축소', onclick: () => this.zoomAt(-1, this.w / 2, this.h / 2) }, '−'));
    this.el = h('div', { class: 'plot-wrap map-wrap', style: `width:${this.w}px;height:${this.h}px` }, this.canvas, rect, tip, zoomBtns);
    host.appendChild(this.el);
    if (!this.provider.url) void this.ensureOfflineBase();
    this.bind(rect, tip);
    this.redraw();
  }

  private get scale(): number { return 256 * 2 ** this.view.zoom; }

  /** 경도/위도 → 캔버스 좌표 */
  px = (lon: number, lat: number): [number, number] => {
    const s = this.scale;
    return [(mercX(lon) - mercX(this.view.lon)) * s + this.w / 2, (mercY(lat) - mercY(this.view.lat)) * s + this.h / 2];
  };

  unproject(x: number, y: number): [number, number] {
    const s = this.scale;
    return [invX(mercX(this.view.lon) + (x - this.w / 2) / s), invY(mercY(this.view.lat) + (y - this.h / 2) / s)];
  }

  fitBounds(minLon: number, minLat: number, maxLon: number, maxLat: number): void {
    if (!Number.isFinite(minLon)) return;
    const dx = Math.max(1e-6, mercX(maxLon) - mercX(minLon)), dy = Math.max(1e-6, mercY(minLat) - mercY(maxLat));
    const z = Math.log2(Math.min((this.w * 0.85) / (256 * dx), (this.h * 0.85) / (256 * dy)));
    this.view = { lon: (minLon + maxLon) / 2, lat: invY((mercY(minLat) + mercY(maxLat)) / 2), zoom: Math.max(1, Math.min(this.provider.maxZoom, z)) };
    this.onViewChange(this.view);
    this.redraw();
  }

  zoomAt(delta: number, x: number, y: number): void {
    const [lon, lat] = this.unproject(x, y);
    const z = Math.max(0.5, Math.min(this.provider.maxZoom, this.view.zoom + delta));
    if (z === this.view.zoom) return;
    this.view.zoom = z;
    // 커서 아래 지점을 고정
    const [nx, ny] = this.px(lon, lat);
    const s = this.scale;
    this.view.lon = invX(mercX(this.view.lon) + (nx - x) / s);
    this.view.lat = invY(mercY(this.view.lat) + (ny - y) / s);
    this.onViewChange(this.view);
    this.redraw();
  }

  redraw(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.draw());
  }

  private async ensureOfflineBase() {
    if (offlineBase) return;
    offlineBase = { world: null, kr: null };
    try { offlineBase.world = await loadRegions(0); offlineBase.kr = await loadRegions(1); } catch { /* 무시 */ }
    this.redraw();
  }

  private draw(): void {
    const { ctx, w, h: hh } = this;
    if (this.provider.url && tileServerDown(this.provider.url) && !this.tileFailed) { this.tileFailed = true; void this.ensureOfflineBase(); }
    const dark = this.provider.dark || (!this.provider.url) || this.tileFailed;
    ctx.fillStyle = dark ? themeColor('--plot-bg', '#1e2026') : '#aad3df';
    ctx.fillRect(0, 0, w, hh);
    if (this.provider.url && !this.tileFailed) this.drawTiles();
    if (!this.provider.url || this.tileFailed) this.drawOfflineBase();
    ctx.save();
    this.drawLayers(ctx, this.px, this.view.zoom);
    ctx.restore();
    // 저작권 표시(타일 이용 조건)
    const attr = this.tileFailed ? `${this.provider.attribution} · 타일을 불러오지 못해 경계선으로 표시` : this.provider.attribution;
    ctx.font = '11px system-ui, sans-serif';
    const tw = ctx.measureText(attr).width + 10;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(w - tw, hh - 16, tw, 16);
    ctx.fillStyle = '#333'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(attr, w - 5, hh - 8);
  }

  private drawTiles(): void {
    const z = Math.max(0, Math.min(this.provider.maxZoom, Math.floor(this.view.zoom)));
    const n = 2 ** z;
    const tileSize = 256 * 2 ** (this.view.zoom - z);
    const cx = mercX(this.view.lon) * n, cy = mercY(this.view.lat) * n;
    const x0 = Math.floor(cx - this.w / 2 / tileSize), x1 = Math.floor(cx + this.w / 2 / tileSize);
    const y0 = Math.max(0, Math.floor(cy - this.h / 2 / tileSize)), y1 = Math.min(n - 1, Math.floor(cy + this.h / 2 / tileSize));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      const url = this.provider.url!.replace('{z}', String(z)).replace('{x}', String(wx)).replace('{y}', String(ty)).replace('{s}', 'abc'[(wx + ty) % 3]);
      const img = this.tile(url);
      const dx = (tx - cx) * tileSize + this.w / 2, dy = (ty - cy) * tileSize + this.h / 2;
      if (img.complete && img.naturalWidth) this.ctx.drawImage(img, dx, dy, tileSize + 0.5, tileSize + 0.5);
    }
  }

  private tile(url: string): HTMLImageElement {
    let img = tileCache.get(url);
    if (img) { tileCache.delete(url); tileCache.set(url, img); return img; }
    img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'strict-origin-when-cross-origin';
    const tpl = this.provider.url!;
    const st = tileStats.get(tpl) ?? { ok: 0, fail: 0 };
    tileStats.set(tpl, st);
    img.onload = () => { st.ok++; this.redraw(); };
    img.onerror = () => { st.fail++; tileCache.delete(url); this.redraw(); };
    img.src = url;
    tileCache.set(url, img);
    if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!);
    return img;
  }

  private drawOfflineBase(): void {
    const ctx = this.ctx;
    const sets = [offlineBase?.world, this.view.zoom >= 4.5 ? offlineBase?.kr : null].filter(Boolean) as RegionSet[];
    for (const set of sets) {
      ctx.fillStyle = set.level === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)';
      ctx.strokeStyle = set.level === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      for (const r of set.features) {
        const [a0, b0] = this.px(r.bbox[0], r.bbox[3]), [a1, b1] = this.px(r.bbox[2], r.bbox[1]);
        if (a1 < 0 || a0 > this.w || b1 < 0 || b0 > this.h) continue;
        traceRegion(ctx, r.polys, this.px);
        ctx.fill('evenodd'); ctx.stroke();
      }
    }
  }

  private bind(rect: HTMLElement, tip: HTMLElement) {
    const c = this.canvas;
    const pos = (ev: PointerEvent | WheelEvent | MouseEvent): [number, number] => { const b = c.getBoundingClientRect(); return [ev.clientX - b.left, ev.clientY - b.top]; };
    let start: [number, number] | null = null, startView: MapViewState | null = null, selecting = false, moved = false;
    c.addEventListener('pointerdown', (ev) => {
      start = pos(ev); startView = { ...this.view }; moved = false;
      selecting = this.mode === 'select' || ev.shiftKey;
      c.setPointerCapture(ev.pointerId);
      tip.hidden = true;
    });
    c.addEventListener('pointermove', (ev) => {
      const [x, y] = pos(ev);
      if (!start) {
        const t = this.onHover(x, y);
        tip.hidden = !t;
        if (t) { tip.textContent = t; tip.style.left = `${Math.min(x + 12, this.w - 180)}px`; tip.style.top = `${y + 12}px`; }
        return;
      }
      if (Math.abs(x - start[0]) + Math.abs(y - start[1]) > 3) moved = true;
      if (selecting) {
        Object.assign(rect.style, { display: 'block', left: `${Math.min(start[0], x)}px`, top: `${Math.min(start[1], y)}px`, width: `${Math.abs(x - start[0])}px`, height: `${Math.abs(y - start[1])}px` });
      } else if (moved) {
        const s = this.scale;
        this.view.lon = invX(mercX(startView!.lon) - (x - start[0]) / s);
        this.view.lat = invY(mercY(startView!.lat) - (y - start[1]) / s);
        this.redraw();
      }
    });
    c.addEventListener('pointerup', (ev) => {
      if (!start) return;
      const [x, y] = pos(ev);
      const s0 = start;
      start = null;
      rect.style.display = 'none';
      if (!moved) { this.onClick(x, y, ev.shiftKey || ev.ctrlKey); return; }
      if (selecting) this.onSelect({ x0: Math.min(s0[0], x), y0: Math.min(s0[1], y), x1: Math.max(s0[0], x), y1: Math.max(s0[1], y) }, ev.shiftKey || ev.ctrlKey);
      else this.onViewChange(this.view);
    });
    c.addEventListener('pointerleave', () => { tip.hidden = true; });
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const [x, y] = pos(ev);
      this.zoomAt(-Math.sign(ev.deltaY) * (ev.ctrlKey ? 0.25 : 0.5), x, y);
    }, { passive: false });
    c.addEventListener('dblclick', (ev) => { const [x, y] = pos(ev); this.zoomAt(1, x, y); });
  }
}

/** 지역 다각형 경로 만들기 */
export function traceRegion(ctx: CanvasRenderingContext2D, polys: number[][][], px: (lon: number, lat: number) => [number, number]): void {
  ctx.beginPath();
  for (const poly of polys) for (const ring of poly) {
    for (let i = 0; i < ring.length; i += 2) {
      const [x, y] = px(ring[i], ring[i + 1]);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
}
