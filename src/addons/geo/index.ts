/**
 * Geo 애드온 (orange3-geo에 해당): Geo Map, Choropleth Map, Geocoding.
 * 카테고리 색은 orangecontrib/geo/widgets/__init__.py 의 BACKGROUND = "#a0eaa0".
 */
import { registerWidget } from '../../engine/registry';
import { registerCategory, type ViewApi } from '../../engine/types';
import { type Table, type Column, allColumns, findColumn, takeRows, cellText } from '../../core/table';
import { mean, median, std, formatNumber, niceTicks, minMax } from '../../core/stats';
import { h } from '../../ui/dom';
import { box, checkbox, combo, note, radio, slider, varCombo, emptyMain, button, row } from '../../ui/controls';
import { discreteColor, continuousColor, plotSize } from '../../ui/plot';
import { waiting, tableInput, LIMITS } from '../../widgets/common';
import type { AddonModule } from '../manager';
import { MapView, TILE_PROVIDERS, DEFAULT_TILE_PROVIDER, mercX, mercY, traceRegion, type MapViewState } from './mapview';
import { type AdminLevel, type Region, type RegionSet, LEVELS, loadRegions, matchName, regionAt, findLatLon, regionContains } from './regions';

const isCont = (c: Column) => c.variable.kind === 'continuous';
const isNum = (c: Column) => c.variable.kind !== 'string';

function contColumns(t: Table) {
  return allColumns(t).filter(isCont).map((c) => ({ name: c.variable.name, data: c.data as Float64Array }));
}

/** 설정된 위도/경도 열, 없으면 자동 탐지 */
function latLonOf(t: Table, s: { lat: string; lon: string }): { lat: Column; lon: Column } | null {
  let lat = s.lat ? findColumn(t, s.lat) : undefined, lon = s.lon ? findColumn(t, s.lon) : undefined;
  if (!lat || !lon || !isCont(lat) || !isCont(lon)) {
    const f = findLatLon(contColumns(t));
    if (!f) return null;
    lat = findColumn(t, f.lat); lon = findColumn(t, f.lon);
  }
  return lat && lon ? { lat, lon } : null;
}

function checkRanges(lat: Column, lon: Column, warn: (m: string) => void) {
  const la = lat.data as Float64Array, lo = lon.data as Float64Array;
  let bad = 0;
  for (let i = 0; i < la.length; i++) if (Math.abs(la[i]) > 90 || Math.abs(lo[i]) > 180) bad++;
  if (lat === lon) warn('위도와 경도 열을 각각 지정하세요.');
  else if (bad) warn(`${bad}개 행의 좌표가 범위(위도 ±90, 경도 ±180)를 벗어났습니다. 위도/경도 열이 바뀌지 않았는지 확인하세요.`);
}

function selectionOutputs(t: Table, sel: number[], extraMeta?: Column) {
  const valid = sel.filter((i) => i < t.nRows);
  const flag = new Float64Array(t.nRows);
  for (const i of valid) flag[i] = 1;
  const metas = [...t.metas, ...(extraMeta ? [extraMeta] : []), { variable: { name: 'Selected', kind: 'discrete' as const, values: ['No', 'Yes'] }, data: flag }];
  const annotated = { ...t, metas };
  return { selected: valid.length ? takeRows(annotated, valid) : null, annotated };
}

function tileControls(api: ViewApi<any>, onModeChange?: () => void) {
  const modes = h('div', { class: 'seg' },
    h('button', { class: `btn small${api.settings.mode !== 'select' ? ' on' : ''}`, onclick: () => { api.silentUpdate({ mode: 'pan' }); onModeChange?.(); api.rerender(); } }, '✋ 이동'),
    h('button', { class: `btn small${api.settings.mode === 'select' ? ' on' : ''}`, onclick: () => { api.silentUpdate({ mode: 'select' }); onModeChange?.(); api.rerender(); } }, '⬚ 선택'));
  const tiles = h('select', null, ...Object.keys(TILE_PROVIDERS).map((k) => h('option', { value: k }, k)));
  tiles.value = api.settings.tiles;
  tiles.addEventListener('change', () => { api.silentUpdate({ tiles: tiles.value }); api.rerender(); });
  return box('지도', row('배경 지도', tiles), modes,
    note('드래그: 이동(선택 모드에서는 영역 선택) · 휠/더블클릭: 확대 · Shift+드래그: 언제나 영역 선택'));
}

/** 지역 이름 열과 지역 종류 추측: 문자열/범주형 열 × 지역 종류마다 맞는 값 비율이 가장 높은 조합 */
async function guessRegionColumn(t: Table, levels: AdminLevel[]): Promise<{ col: Column; level: AdminLevel; rate: number } | null> {
  const cands = allColumns(t).filter((c) => !isCont(c));
  let best: { col: Column; level: AdminLevel; rate: number } | null = null;
  for (const level of levels) {
    const set = await loadRegions(level);
    for (const col of cands) {
      const uniq = [...new Set(Array.from({ length: Math.min(t.nRows, 2000) }, (_, i) => cellText(col, i)).filter((v) => v && v !== '?'))];
      if (!uniq.length) continue;
      const rate = uniq.filter((v) => { const m = matchName(set, v); return m.region !== null || m.reason === 'ambiguous'; }).length / uniq.length;
      if (!best || rate > best.rate) best = { col, level, rate };
    }
  }
  return best && best.rate > 0 ? best : null;
}

// ------------------------------------------------------------------ Geo Map
interface GeoMapSettings { lat: string; lon: string; color: string; pointSize: number; alpha: number; tiles: string; mode: 'pan' | 'select'; view: MapViewState | null; selection: number[] }

function registerGeoMap() {
  registerWidget({
    type: 'geo.map',
    name: 'Geo Map',
    category: 'geo',
    abbr: 'Map',
    description: '위도·경도가 있는 데이터를 지도 위에 점으로 표시합니다. 영역을 선택하면 Selected Data로 출력합니다.',
    keywords: ['map', 'geo', 'latitude', 'longitude', '지도', '위도', '경도'],
    inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }, { id: 'subset', name: 'Data Subset', type: 'Data' }],
    outputs: [{ id: 'selected', name: 'Selected Data', type: 'Data', default: true }, { id: 'annotated', name: 'Data', type: 'Data' }],
    windowSize: [960, 640],
    defaultSettings: (): GeoMapSettings => ({ lat: '', lon: '', color: '\u0000class', pointSize: 10, alpha: 128, tiles: DEFAULT_TILE_PROVIDER, mode: 'pan', view: null, selection: [] }),
    execute(inputs, s: GeoMapSettings, ctx) {
      const t = tableInput(inputs.data);
      if (!t) return waiting(ctx);
      const ll = latLonOf(t, s);
      if (!ll) throw new Error('위도와 경도로 쓸 수치형 변수가 2개 이상 필요합니다. (이름이 lat/latitude/위도, lon/lng/longitude/경도로 시작하면 자동으로 찾습니다)');
      checkRanges(ll.lat, ll.lon, ctx.warn);
      return { outputs: selectionOutputs(t, s.selection) };
    },
    render({ controls, main }, api: ViewApi<GeoMapSettings>) {
      const t = tableInput(api.inputs.data);
      if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
      const s = api.settings;
      const ll = latLonOf(t, s);
      if (ll && (s.lat !== ll.lat.variable.name || s.lon !== ll.lon.variable.name)) api.silentUpdate({ lat: ll.lat.variable.name, lon: ll.lon.variable.name });
      controls.appendChild(box('위치', varCombo(api, 'lat', '위도', t, isCont), varCombo(api, 'lon', '경도', t, isCont)));
      const colorName = s.color === '\u0000class' ? (t.classVar?.variable.name ?? '') : s.color;
      const colorBox = varCombo(api, 'color', '색상', t, isNum, { none: '(같은 색)' });
      (colorBox.querySelector('select') as HTMLSelectElement).value = colorName;
      controls.appendChild(box('점', colorBox, slider(api, 'pointSize', '크기', 2, 30), slider(api, 'alpha', '불투명도', 20, 255)));
      controls.appendChild(tileControls(api));
      controls.appendChild(box('선택', h('div', { class: 'info-text' }, `${s.selection.length}개 선택됨`),
        h('div', { class: 'row-actions' }, button('선택 해제', () => api.update({ selection: [] })), button('데이터에 맞추기', () => fit()))));
      if (api.message) controls.appendChild(note(api.message, api.status === 'error' ? 'error' : 'warn'));
      if (!ll) { emptyMain(main, api.message || '위도/경도 열을 찾을 수 없습니다.'); return; }

      const la = ll.lat.data as Float64Array, lo = ll.lon.data as Float64Array;
      const n = t.nRows;
      // 0~1 메르카토르 좌표를 미리 계산(그릴 때마다 삼각함수를 쓰지 않음)
      const mx = new Float64Array(n).fill(NaN), my = new Float64Array(n).fill(NaN);
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (let i = 0; i < n; i++) {
        if (Number.isNaN(la[i]) || Number.isNaN(lo[i]) || Math.abs(la[i]) > 90 || Math.abs(lo[i]) > 180) continue;
        mx[i] = mercX(lo[i]); my[i] = mercY(la[i]);
        minLon = Math.min(minLon, lo[i]); maxLon = Math.max(maxLon, lo[i]); minLat = Math.min(minLat, la[i]); maxLat = Math.max(maxLat, la[i]);
      }
      const cc = colorName ? findColumn(t, colorName) : undefined;
      const cRange = cc && isCont(cc) ? minMax((cc.data as Float64Array).filter((v) => !Number.isNaN(v))) : [0, 1];
      const colorOf = (i: number, a: number) => {
        if (!cc) return `rgba(255,120,60,${a})`;
        const v = cc.data[i] as number;
        return cc.variable.kind === 'discrete' ? discreteColor(v, a) : continuousColor((v - cRange[0]) / (cRange[1] - cRange[0] || 1), a);
      };
      const subset = tableInput(api.inputs.subset);
      const subsetIds = subset ? new Set(subset.ids) : null;
      const sel = new Set(s.selection);
      const stride = n > LIMITS.scatterPoints ? n / LIMITS.scatterPoints : 1;
      const [W, H] = plotSize(main, 360);
      const map = new MapView(main, W, H, s.view ?? { lon: 127.8, lat: 36.3, zoom: 6 }, s.tiles);
      map.mode = s.mode;
      const fit = () => map.fitBounds(minLon, minLat, maxLon, maxLat);
      if (!s.view) fit();
      map.onViewChange = (v) => api.silentUpdate({ view: { ...v } });
      map.drawLayers = (ctx, _px, zoom) => {
        const scale = 256 * 2 ** zoom;
        const ox = mercX(map.view.lon) * scale - map.w / 2, oy = mercY(map.view.lat) * scale - map.h / 2;
        const r = s.pointSize / 2, a = s.alpha / 255;
        for (let f = 0; f < n; f += stride) {
          const i = Math.floor(f);
          if (Number.isNaN(mx[i])) continue;
          const x = mx[i] * scale - ox, y = my[i] * scale - oy;
          if (x < -r || y < -r || x > map.w + r || y > map.h + r) continue;
          const dim = (sel.size && !sel.has(i)) || (subsetIds && !subsetIds.has(t.ids[i]));
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = colorOf(i, dim ? a * 0.3 : a); ctx.fill();
          ctx.strokeStyle = sel.has(i) ? '#111' : colorOf(i, Math.min(1, (dim ? a * 0.3 : a) + 0.35));
          ctx.lineWidth = sel.has(i) ? 2 : 1; ctx.stroke();
        }
        if (cc && cc.variable.kind === 'discrete') {
          const vals = cc.variable.values!;
          ctx.font = '12px system-ui, sans-serif';
          const lw = Math.max(...vals.map((v) => ctx.measureText(v).width)) + 30;
          ctx.fillStyle = 'rgba(30,32,38,0.85)'; ctx.fillRect(map.w - lw - 8, 8, lw, vals.length * 18 + 8);
          vals.forEach((v, k) => {
            ctx.fillStyle = discreteColor(k); ctx.beginPath(); ctx.arc(map.w - lw + 4, 21 + k * 18, 5, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#eee'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(v, map.w - lw + 14, 21 + k * 18);
          });
        }
      };
      const hitRows = (x0: number, y0: number, x1: number, y1: number) => {
        const scale = 256 * 2 ** map.view.zoom;
        const ox = mercX(map.view.lon) * scale - map.w / 2, oy = mercY(map.view.lat) * scale - map.h / 2;
        const out: number[] = [];
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(mx[i])) continue;
          const x = mx[i] * scale - ox, y = my[i] * scale - oy;
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(i);
        }
        return out;
      };
      map.onSelect = (r, add) => {
        if (!r) return;
        const chosen = add ? new Set(s.selection) : new Set<number>();
        for (const i of hitRows(r.x0, r.y0, r.x1, r.y1)) chosen.add(i);
        api.update({ selection: [...chosen].sort((a, b) => a - b), view: { ...map.view } });
      };
      map.onClick = (x, y, add) => {
        const rr = Math.max(4, s.pointSize / 2);
        const hit = hitRows(x - rr, y - rr, x + rr, y + rr);
        if (!hit.length) { if (!add && s.selection.length) api.update({ selection: [] }); return; }
        const chosen = add ? new Set(s.selection) : new Set<number>();
        for (const i of hit) chosen.add(i);
        api.update({ selection: [...chosen].sort((a, b) => a - b), view: { ...map.view } });
      };
      const label = t.metas.find((c) => c.variable.kind === 'string');
      map.onHover = (x, y) => {
        const rr = Math.max(4, s.pointSize / 2);
        const hit = hitRows(x - rr, y - rr, x + rr, y + rr);
        if (!hit.length) return null;
        const i = hit[0];
        return `${label ? cellText(label, i) + ' · ' : ''}${formatNumber(la[i], 4)}, ${formatNumber(lo[i], 4)}${cc ? ` · ${cc.variable.name}: ${cellText(cc, i)}` : ''}${hit.length > 1 ? ` (+${hit.length - 1})` : ''}`;
      };
      if (n > LIMITS.scatterPoints) main.appendChild(h('div', { class: 'plot-stat' }, `${n.toLocaleString()}개 중 약 ${LIMITS.scatterPoints.toLocaleString()}개를 표본으로 그렸습니다.`));
    },
  });
}

// ------------------------------------------------------------------ Choropleth Map
/** Orange Choropleth의 AGG_FUNCS (표시 이름 → 이름, 범주형 가능, 결과가 같은 변수 타입) */
const AGG_FUNCS: Array<{ id: string; label: string; disc: boolean }> = [
  { id: 'size', label: 'Instance Count', disc: true },
  { id: 'count', label: 'Defined Values Count', disc: true },
  { id: 'sum', label: 'Sum', disc: false },
  { id: 'mean', label: 'Mean', disc: false },
  { id: 'median', label: 'Median', disc: false },
  { id: 'mode', label: 'Mode', disc: true },
  { id: 'max', label: 'Maximal', disc: false },
  { id: 'min', label: 'Minimal', disc: false },
  { id: 'std', label: 'Std.', disc: false },
];

interface ChoroSettings {
  source: 'latlon' | 'name'; lat: string; lon: string; nameVar: string;
  adminLevel: AdminLevel; aggAttr: string; aggFunc: string; bins: number; alpha: number; showLegend: boolean;
  tiles: string; mode: 'pan' | 'select'; view: MapViewState | null; selection: string[];
}

interface ChoroView { set: RegionSet; assign: Array<Region | null>; values: Map<string, number>; counts: Map<string, number>; discValues?: string[]; unmatched: number; label: string }

function aggregate(func: string, vals: number[], nRows: number, disc: boolean, k: number): number {
  if (func === 'size') return nRows;
  if (func === 'count') return vals.length;
  if (!vals.length) return NaN;
  if (func === 'mode' || disc) {
    const c = new Array<number>(k).fill(0);
    for (const v of vals) c[v]++;
    return c.indexOf(Math.max(...c));
  }
  switch (func) {
    case 'sum': return vals.reduce((a, b) => a + b, 0);
    case 'mean': return mean(vals);
    case 'median': return median(vals);
    case 'max': return Math.max(...vals);
    case 'min': return Math.min(...vals);
    case 'std': return std(vals);
    default: return NaN;
  }
}

function registerChoropleth() {
  registerWidget({
    type: 'geo.choropleth',
    name: 'Choropleth Map',
    category: 'geo',
    abbr: 'Chp',
    description: '지역(국가, 시·도, 시·군·구)마다 값을 집계해 색으로 칠한 지도. 지역을 클릭하면 그 지역의 행을 출력합니다.',
    keywords: ['choropleth', 'region', 'map', '단계구분도', '지역'],
    inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
    outputs: [{ id: 'selected', name: 'Selected Data', type: 'Data', default: true }, { id: 'annotated', name: 'Data', type: 'Data' }],
    windowSize: [960, 640],
    // Orange 기본값: alpha 128, 범례 표시, 집계 = Instance Count
    defaultSettings: (): ChoroSettings => ({ source: 'latlon', lat: '', lon: '', nameVar: '', adminLevel: 1, aggAttr: '', aggFunc: 'size', bins: 6, alpha: 128, showLegend: true, tiles: DEFAULT_TILE_PROVIDER, mode: 'pan', view: null, selection: [] }),
    async execute(inputs, s: ChoroSettings, ctx) {
      const t = tableInput(inputs.data);
      if (!t) return waiting(ctx);
      const set = await loadRegions(s.adminLevel);
      const assign: Array<Region | null> = new Array(t.nRows).fill(null);
      let label = '';
      if (s.source === 'latlon') {
        const ll = latLonOf(t, s);
        if (!ll) throw new Error('위도/경도 열을 찾을 수 없습니다. 지역 이름 열을 쓰려면 "지역 이름 열"을 고르세요.');
        checkRanges(ll.lat, ll.lon, ctx.warn);
        const la = ll.lat.data as Float64Array, lo = ll.lon.data as Float64Array;
        for (let i = 0; i < t.nRows; i++) assign[i] = regionAt(set, lo[i], la[i]);
        label = `${ll.lat.variable.name}, ${ll.lon.variable.name}`;
      } else {
        const nc = s.nameVar ? findColumn(t, s.nameVar) : (await guessRegionColumn(t, [s.adminLevel]))?.col;
        if (!nc) throw new Error(`${LEVELS[s.adminLevel].label} 이름이 들어 있는 열을 찾지 못했습니다. 지역 이름 열이나 지역 단위를 바꿔 보세요.`);
        // 시·도 지도에서 시·군·구 이름(예: '군산')은 상위 시·도로 올려서 집계
        const muni = s.adminLevel === 1 ? await loadRegions(2) : null;
        const byId = new Map(set.features.map((r) => [r.id, r]));
        for (let i = 0; i < t.nRows; i++) {
          const name = cellText(nc, i);
          let r = matchName(set, name).region;
          if (!r && muni) { const m = matchName(muni, name).region; if (m) r = byId.get(m.id.slice(0, 2)) ?? null; }
          assign[i] = r;
        }
        label = nc.variable.name;
      }
      const unmatched = assign.filter((r) => !r).length;
      if (unmatched) ctx.warn(`${unmatched}개 행을 ${LEVELS[s.adminLevel].label} 지역에 대응시키지 못했습니다.`);
      // 집계
      const ac = s.aggAttr ? findColumn(t, s.aggAttr) : undefined;
      const disc = !!ac && ac.variable.kind === 'discrete';
      let func = s.aggFunc;
      if (!ac && func !== 'size') func = 'size';
      if (disc && !AGG_FUNCS.find((f) => f.id === func)?.disc) func = 'mode';
      const groups = new Map<string, number[]>();
      for (let i = 0; i < t.nRows; i++) { const r = assign[i]; if (r) { if (!groups.has(r.id)) groups.set(r.id, []); groups.get(r.id)!.push(i); } }
      const values = new Map<string, number>(), counts = new Map<string, number>();
      for (const [id, rows] of groups) {
        const vals = ac ? rows.map((i) => ac.data[i] as number).filter((v) => !Number.isNaN(v)) : [];
        values.set(id, aggregate(func, vals, rows.length, disc && func === 'mode', ac?.variable.values?.length ?? 0));
        counts.set(id, rows.length);
      }
      const selIds = new Set(s.selection);
      const sel: number[] = [];
      assign.forEach((r, i) => { if (r && selIds.has(r.id)) sel.push(i); });
      const regionCol: Column = { variable: { name: LEVELS[s.adminLevel].column, kind: 'string' }, data: assign.map((r) => r?.name ?? '') };
      const view: ChoroView = { set, assign, values, counts, discValues: disc && func === 'mode' ? ac!.variable.values : undefined, unmatched, label };
      return { outputs: selectionOutputs(t, sel, regionCol), view };
    },
    render({ controls, main }, api: ViewApi<ChoroSettings>) {
      const t = tableInput(api.inputs.data);
      const s = api.settings;
      controls.appendChild(box('지역 단위 (Administrative level)', combo(api, 'adminLevel', null, LEVELS.map((l) => [l.level, l.label]), {
        onChange: (v) => api.update({ adminLevel: Number(v) as AdminLevel, selection: [] }),
      })));
      if (t) {
        const ll = s.source === 'latlon' ? latLonOf(t, s) : null;
        if (ll && (s.lat !== ll.lat.variable.name || s.lon !== ll.lon.variable.name)) api.silentUpdate({ lat: ll.lat.variable.name, lon: ll.lon.variable.name });
        controls.appendChild(box('위치', radio(api, 'source', null, [['latlon', '위도·경도로 지역 찾기'], ['name', '지역 이름 열 사용']]),
          s.source === 'latlon' ? varCombo(api, 'lat', '위도', t, isCont) : null,
          s.source === 'latlon' ? varCombo(api, 'lon', '경도', t, isCont) : null,
          s.source === 'name' ? varCombo(api, 'nameVar', '지역 이름', t, (c) => !isCont(c), { none: '(자동)' }) : null));
        const ac = s.aggAttr ? findColumn(t, s.aggAttr) : undefined;
        const funcs = AGG_FUNCS.filter((f) => !ac ? f.id === 'size' : ac.variable.kind === 'discrete' ? f.disc : true);
        controls.appendChild(box('집계', varCombo(api, 'aggAttr', '변수', t, isNum, { none: '(행 수)' }),
          combo(api, 'aggFunc', '방법', funcs.map((f) => [f.id, f.label]))));
      }
      controls.appendChild(box('표시', slider(api, 'bins', '색 구간 수', 2, 10), slider(api, 'alpha', '불투명도', 20, 255), checkbox(api, 'showLegend', '범례')));
      controls.appendChild(tileControls(api));
      controls.appendChild(box('선택', h('div', { class: 'info-text' }, `${s.selection.length}개 지역 선택됨`), button('선택 해제', () => api.update({ selection: [] })),
        note('지역을 클릭하면 선택합니다(Shift: 추가).')));
      if (api.message) controls.appendChild(note(api.message, api.status === 'error' ? 'error' : 'warn'));
      const v = api.view as ChoroView | null;
      if (!t || !v) { emptyMain(main, api.message || (api.status === 'running' ? '경계 데이터를 불러오는 중…' : '입력 데이터가 없습니다.')); return; }

      // 색 구간
      const nums = [...v.values.values()].filter((x) => !Number.isNaN(x));
      const [lo, hi] = nums.length ? [Math.min(...nums), Math.max(...nums)] : [0, 1];
      // 보기 좋은 경계값으로 나누되 구간 수가 설정값을 넘지 않게
      let edges = niceTicks(lo, hi, s.bins);
      for (let c = s.bins - 1; c >= 1 && edges.length - 1 > s.bins; c--) edges = niceTicks(lo, hi, c);
      if (edges.length < 2) edges = [lo, hi + 1];
      if (edges[0] > lo) edges.unshift(edges[0] - (edges[1] - edges[0]));
      if (edges[edges.length - 1] < hi) edges.push(edges[edges.length - 1] + (edges[1] - edges[0]));
      const binOf = (x: number) => { let b = 0; while (b < edges.length - 2 && x >= edges[b + 1]) b++; return b; };
      const nb = edges.length - 1;
      const fill = (val: number, a: number) => (Number.isNaN(val) ? `rgba(128,128,128,${a * 0.4})`
        : v.discValues ? discreteColor(val, a) : continuousColor(lo === hi || nb <= 1 ? 0.5 : binOf(val) / (nb - 1), a));
      const sel = new Set(s.selection);
      const used = v.set.features.filter((r) => v.counts.has(r.id) || sel.has(r.id));
      const [W, H] = plotSize(main, 360);
      const defaultView: MapViewState = s.adminLevel === 0 ? { lon: 10, lat: 25, zoom: 1.3 } : { lon: 127.8, lat: 36.0, zoom: 6.3 };
      const map = new MapView(main, W, H, s.view ?? defaultView, s.tiles);
      map.mode = s.mode;
      if (!s.view && used.length) {
        const b = used.reduce((acc, r) => [Math.min(acc[0], r.bbox[0]), Math.min(acc[1], r.bbox[1]), Math.max(acc[2], r.bbox[2]), Math.max(acc[3], r.bbox[3])], [180, 90, -180, -90]);
        map.fitBounds(b[0], b[1], b[2], b[3]);
      }
      map.onViewChange = (vv) => api.silentUpdate({ view: { ...vv } });
      const a = s.alpha / 255;
      map.drawLayers = (ctx, px) => {
        for (const r of v.set.features) {
          const has = v.counts.has(r.id);
          traceRegion(ctx, r.polys, px);
          if (has) { ctx.fillStyle = fill(v.values.get(r.id)!, a); ctx.fill('evenodd'); }
          ctx.strokeStyle = sel.has(r.id) ? '#ffd34d' : has ? 'rgba(255,255,255,0.7)' : 'rgba(128,128,128,0.35)';
          ctx.lineWidth = sel.has(r.id) ? 3 : 1;
          if (has || sel.has(r.id) || s.adminLevel > 0) ctx.stroke();
        }
        if (!s.showLegend) return;
        ctx.font = '12px system-ui, sans-serif';
        const items: Array<[string, string]> = v.discValues
          ? v.discValues.map((d, k) => [d, discreteColor(k)])
          : lo === hi ? [[formatNumber(lo), continuousColor(0.5)]]
            : Array.from({ length: nb }, (_, k) => [`${formatNumber(edges[k])} – ${formatNumber(edges[k + 1])}`, continuousColor(nb > 1 ? k / (nb - 1) : 0.5)]);
        const lw = Math.max(...items.map(([l]) => ctx.measureText(l).width)) + 34;
        ctx.fillStyle = 'rgba(30,32,38,0.88)'; ctx.fillRect(8, 8, lw, items.length * 18 + 26);
        ctx.fillStyle = '#ddd'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const fn = AGG_FUNCS.find((f) => f.id === s.aggFunc)?.label ?? 'Instance Count';
        ctx.fillText(s.aggAttr ? `${fn}(${s.aggAttr})` : 'Instance Count', 14, 20);
        items.forEach(([l, c], k) => { ctx.fillStyle = c; ctx.fillRect(14, 32 + k * 18, 14, 12); ctx.fillStyle = '#eee'; ctx.fillText(l, 34, 38 + k * 18); });
      };
      const regionAtPx = (x: number, y: number) => {
        const [lon, lat] = map.unproject(x, y);
        return v.set.features.find((r) => regionContains(r, lon, lat)) ?? null;
      };
      map.onClick = (x, y, add) => {
        const r = regionAtPx(x, y);
        const next = add ? new Set(s.selection) : new Set<string>();
        if (r) { if (add && next.has(r.id)) next.delete(r.id); else next.add(r.id); }
        api.update({ selection: [...next], view: { ...map.view } });
      };
      map.onSelect = (rect, add) => {
        if (!rect) return;
        const [lon0, lat1] = map.unproject(rect.x0, rect.y0), [lon1, lat0] = map.unproject(rect.x1, rect.y1);
        const next = add ? new Set(s.selection) : new Set<string>();
        for (const r of used) if (r.center[0] >= lon0 && r.center[0] <= lon1 && r.center[1] >= lat0 && r.center[1] <= lat1) next.add(r.id);
        api.update({ selection: [...next], view: { ...map.view } });
      };
      map.onHover = (x, y) => {
        const r = regionAtPx(x, y);
        if (!r) return null;
        const val = v.values.get(r.id);
        const shown = val === undefined ? '데이터 없음' : v.discValues ? v.discValues[val] ?? '?' : formatNumber(val, 3);
        return `${r.parentName ? r.parentName + ' ' : ''}${r.name} · ${shown}${v.counts.has(r.id) ? ` (${v.counts.get(r.id)}행)` : ''}`;
      };
      main.appendChild(h('div', { class: 'plot-stat' }, `${v.counts.size}개 지역에 ${(t.nRows - v.unmatched).toLocaleString()}행 대응${v.unmatched ? ` · 대응 안 됨 ${v.unmatched}행` : ''} · 경계: ${v.set.source}`));
    },
  });
}

// ------------------------------------------------------------------ Geocoding
interface GeocodingSettings { isDecoding: boolean; strAttr: string; idType: AdminLevel | -1; lat: string; lon: string; admin: AdminLevel; replacements: Record<string, string> }

function registerGeocoding() {
  registerWidget({
    type: 'geo.geocoding',
    name: 'Geocoding',
    category: 'geo',
    abbr: 'GC',
    description: '지역 이름(국가, 시·도, 시·군·구)을 위도·경도로 바꾸거나, 위도·경도를 지역 이름으로 바꿉니다.',
    keywords: ['geocode', 'region', 'country', '지오코딩', '주소', '지역'],
    inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
    outputs: [{ id: 'coded', name: 'Coded Data', type: 'Data', default: true }],
    windowSize: [720, 560],
    defaultSettings: (): GeocodingSettings => ({ isDecoding: false, strAttr: '', idType: -1, lat: '', lon: '', admin: 1, replacements: {} }),
    async execute(inputs, s: GeocodingSettings, ctx) {
      const t = tableInput(inputs.data);
      if (!t) return waiting(ctx);
      if (s.isDecoding) {
        const ll = latLonOf(t, s);
        if (!ll) throw new Error('위도/경도 열을 찾을 수 없습니다.');
        const set = await loadRegions(s.admin);
        const la = ll.lat.data as Float64Array, lo = ll.lon.data as Float64Array;
        const names = Array.from({ length: t.nRows }, (_, i) => regionAt(set, lo[i], la[i]));
        const values = [...new Set(names.filter(Boolean).map((r) => r!.name))].sort((a, b) => a.localeCompare(b));
        const col: Column = { variable: { name: LEVELS[s.admin].column, kind: 'discrete', values }, data: Float64Array.from(names, (r) => (r ? values.indexOf(r.name) : NaN)) };
        const miss = names.filter((r) => !r).length;
        if (miss) ctx.warn(`${miss}개 행은 어느 지역에도 속하지 않습니다.`);
        return { outputs: { coded: { ...t, metas: [...t.metas, col] } }, view: { mode: 'decode', miss } };
      }
      // 열·종류를 지정하지 않았으면 데이터에서 추측(Orange Geocoding도 값으로 식별자 종류를 추측한다)
      const fixedCol = s.strAttr ? findColumn(t, s.strAttr) : undefined;
      if (s.strAttr && (!fixedCol || isCont(fixedCol))) throw new Error(`열 '${s.strAttr}'을(를) 찾을 수 없거나 문자열/범주형이 아닙니다.`);
      const guess = !fixedCol || s.idType < 0
        ? await guessRegionColumn(fixedCol ? { ...t, attributes: [], classVar: null, metas: [fixedCol] } : t, s.idType < 0 ? [2, 1, 0] : [s.idType as AdminLevel])
        : null;
      const sc = fixedCol ?? guess?.col;
      const level = (s.idType >= 0 ? s.idType : guess?.level ?? 1) as AdminLevel;
      if (!sc) throw new Error('지역 이름이 들어 있는 열을 찾지 못했습니다. 열과 지역 종류를 직접 고르세요.');
      if (!s.strAttr || s.idType < 0) ctx.info(`자동 선택: '${sc.variable.name}' 열 → ${LEVELS[level].label}`);
      const set = await loadRegions(level);
      const byId = new Map(set.features.map((r) => [r.id, r]));
      const lat = new Float64Array(t.nRows).fill(NaN), lon = new Float64Array(t.nRows).fill(NaN);
      const unmatched = new Map<string, { count: number; reason: string }>();
      for (let i = 0; i < t.nRows; i++) {
        const raw = cellText(sc, i);
        if (raw === '?' || raw === '') continue;
        const rep = s.replacements[raw];
        const region = rep ? byId.get(rep) ?? null : (() => {
          const m = matchName(set, raw);
          if (!m.region) { const u = unmatched.get(raw) ?? { count: 0, reason: m.reason }; u.count++; unmatched.set(raw, u); }
          return m.region;
        })();
        if (region) { lon[i] = region.center[0]; lat[i] = region.center[1]; }
      }
      if (unmatched.size) ctx.warn(`${unmatched.size}개 값을 찾지 못했습니다. 위젯 창에서 직접 지정할 수 있습니다.`);
      const metas: Column[] = [...t.metas,
        { variable: { name: 'latitude', kind: 'continuous', decimals: 4 }, data: lat },
        { variable: { name: 'longitude', kind: 'continuous', decimals: 4 }, data: lon }];
      return { outputs: { coded: { ...t, metas } }, view: { mode: 'encode', unmatched: [...unmatched.entries()], set, column: sc.variable.name, level } };
    },
    render({ controls, main }, api: ViewApi<GeocodingSettings>) {
      const t = tableInput(api.inputs.data);
      const s = api.settings;
      controls.appendChild(box('방향', radio(api, 'isDecoding', null, [[false as unknown as string, '인코딩: 지역 이름 → 위도·경도'], [true as unknown as string, '디코딩: 위도·경도 → 지역 이름']])));
      if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
      if (!s.isDecoding) {
        controls.appendChild(box('지역 식별자', varCombo(api, 'strAttr', '열', t, (c) => !isCont(c), { none: '(자동)' }),
          combo(api, 'idType', '종류', [[-1, '(자동)'], ...LEVELS.map((l) => [l.level, l.label] as [number, string])], { onChange: (v) => api.update({ idType: Number(v) as AdminLevel | -1, replacements: {} }) }),
          note('국가는 한글·영문 이름과 ISO 코드(KR, KOR)를, 시·도와 시·군·구는 "서울", "충남", "군산", "부산 중구" 같은 줄임말도 알아봅니다. 같은 이름이 여러 곳이면(예: 중구) 시·도를 앞에 붙이세요.')));
      } else {
        controls.appendChild(box('좌표', varCombo(api, 'lat', '위도', t, isCont), varCombo(api, 'lon', '경도', t, isCont),
          combo(api, 'admin', '지역 단위', LEVELS.map((l) => [l.level, l.label]))));
      }
      if (api.message) controls.appendChild(note(api.message, api.status === 'error' ? 'error' : 'warn'));
      const v = api.view as { mode: string; unmatched?: Array<[string, { count: number; reason: string }]>; set?: RegionSet; miss?: number } | null;
      if (!v) { emptyMain(main, api.message || '결과 없음'); return; }
      if (v.mode === 'decode') { main.appendChild(note(`좌표를 ${LEVELS[s.admin].label} 이름으로 바꿔 "${LEVELS[s.admin].column}" 열을 추가했습니다.${v.miss ? ` (${v.miss}행은 해당 지역 없음)` : ''}`)); return; }
      const reps = s.replacements;
      const done = Object.keys(reps).length;
      main.appendChild(note(v.unmatched!.length
        ? `찾지 못한 값 ${v.unmatched!.length}개 — 오른쪽 목록에서 지역을 고르면 그 값으로 대체합니다.`
        : `모든 값을 좌표로 바꿨습니다. "latitude", "longitude" 열이 추가되었습니다.${done ? ` (직접 지정 ${done}개)` : ''}`));
      const opts = [...v.set!.features].sort((a, b) => (a.parentName ?? '').localeCompare(b.parentName ?? '') || a.name.localeCompare(b.name));
      const rows = [...v.unmatched!, ...Object.keys(reps).map((k) => [k, { count: 0, reason: 'manual' }] as [string, { count: number; reason: string }])];
      if (rows.length) {
        main.appendChild(h('div', { class: 'main-scroll' }, h('table', { class: 'grid-table' },
          h('thead', null, h('tr', null, h('th', null, '데이터의 값'), h('th', null, '행'), h('th', null, '이유'), h('th', null, '대응할 지역'))),
          h('tbody', null, ...rows.map(([val, info]) => {
            const sel = h('select', null, h('option', { value: '' }, '(찾지 못함)'), ...opts.map((r) => h('option', { value: r.id }, `${r.parentName ? r.parentName + ' ' : ''}${r.name}`)));
            sel.value = reps[val] ?? '';
            sel.addEventListener('change', () => {
              const next = { ...reps };
              if (sel.value) next[val] = sel.value; else delete next[val];
              api.update({ replacements: next });
            });
            return h('tr', null, h('td', null, val), h('td', { class: 'num' }, info.count ? String(info.count) : ''),
              h('td', null, info.reason === 'ambiguous' ? '여러 지역과 같은 이름' : info.reason === 'manual' ? '직접 지정' : '모르는 이름'), h('td', null, sel));
          })))));
      }
    },
  });
}

const module: AddonModule = {
  register() {
    registerCategory({ id: 'geo', name: 'Geo', color: '#a0eaa0', addon: 'geo' });
    registerGeocoding();
    registerGeoMap();
    registerChoropleth();
  },
};

export const register = module.register;
export default module;
