/** Visualize 카테고리: Scatter Plot, Distributions, Box Plot, Correlations, Heat Map */
import { registerWidget } from '../engine/registry';
import type { ViewApi } from '../engine/types';
import { type Table, type Column, allColumns, findColumn, takeRows, makeTable, rowsByIds } from '../core/table';
import {
  mean, std, minMax, sortedFinite, quantileSorted, pearson, spearman, formatNumber,
  tTestP, fTestP, chi2P, formatP,
} from '../core/stats';
import { encode, fitEncoder } from '../ml/encode';
import { computeDistances, hierarchical, leafOrder } from '../ml/unsupervised';
import { h } from '../ui/dom';
import { box, checkbox, note, slider, varCombo, emptyMain, button, radio } from '../ui/controls';
import { Plot, discreteColor, continuousColor, divergingColor, plotSize } from '../ui/plot';
import { waiting, tableInput, LIMITS } from './common';

const isCont = (c: Column) => c.variable.kind === 'continuous';
const isDisc = (c: Column) => c.variable.kind === 'discrete';
const isNum = (c: Column) => c.variable.kind !== 'string';

/** 선택한 행 인덱스를 Selected Data와 주석이 달린 Data로 만든다 */
function selectionOutputs(t: Table, sel: number[]) {
  const valid = sel.filter((i) => i < t.nRows);
  const flag = new Float64Array(t.nRows);
  for (const i of valid) flag[i] = 1;
  const annotated = { ...t, metas: [...t.metas, { variable: { name: 'Selected', kind: 'discrete' as const, values: ['No', 'Yes'] }, data: flag }] };
  return { selected: valid.length ? takeRows(t, valid) : null, annotated };
}

function nearestName(t: Table, name: string, pred: (c: Column) => boolean, skip = 0): string {
  if (name && findColumn(t, name) && pred(findColumn(t, name)!)) return name;
  const cands = allColumns(t).filter(pred);
  return cands[Math.min(skip, cands.length - 1)]?.variable.name ?? '';
}

// ------------------------------------------------------------------ Scatter Plot
interface ScatterSettings { x: string; y: string; color: string; pointSize: number; alpha: number; jitter: number; showLegend: boolean; showRegLine: boolean; selection: number[] }

registerWidget({
  type: 'visualize.scatter',
  name: 'Scatter Plot',
  category: 'visualize',
  abbr: 'Sct',
  description: '두 변수의 산점도. 드래그로 점을 선택하면 Selected Data로 출력합니다.',
  keywords: ['scatter', 'plot', 'xy', '산점도'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }, { id: 'subset', name: 'Data Subset', type: 'Data' }],
  outputs: [{ id: 'selected', name: 'Selected Data', type: 'Data', default: true }, { id: 'annotated', name: 'Data', type: 'Data' }],
  windowSize: [900, 600],
  // Orange: point_width=10, alpha_value=128, jitter_size=0, show_legend=True, show_reg_line=False
  defaultSettings: (): ScatterSettings => ({ x: '', y: '', color: '\u0000class', pointSize: 10, alpha: 128, jitter: 0, showLegend: true, showRegLine: false, selection: [] }),
  execute(inputs, s: ScatterSettings, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    if (allColumns(t).filter(isNum).length < 1) throw new Error('수치형 또는 범주형 변수가 필요합니다.');
    if (t.nRows > LIMITS.scatterPoints) ctx.info(`점이 ${t.nRows.toLocaleString()}개라 ${LIMITS.scatterPoints.toLocaleString()}개만 표본으로 그립니다(선택은 전체 데이터 기준).`);
    return { outputs: selectionOutputs(t, s.selection) };
  },
  render({ controls, main }, api: ViewApi<ScatterSettings>) {
    const t = tableInput(api.inputs.data);
    if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
    const s = api.settings;
    const xName = nearestName(t, s.x, isNum, 0);
    const yName = nearestName(t, s.y, isNum, 1);
    const colorName = s.color === '\u0000class' ? (t.classVar?.variable.name ?? '') : s.color;
    if (xName !== s.x || yName !== s.y) api.silentUpdate({ x: xName, y: yName });
    controls.appendChild(box('축', varCombo(api, 'x', 'X축', t, isNum), varCombo(api, 'y', 'Y축', t, isNum)));
    const colorBox = varCombo(api, 'color', '색상', t, isNum, { none: '(같은 색)' });
    (colorBox.querySelector('select') as HTMLSelectElement).value = colorName;
    controls.appendChild(box('속성', colorBox,
      slider(api, 'pointSize', '점 크기', 2, 30), slider(api, 'alpha', '불투명도', 20, 255),
      slider(api, 'jitter', '지터 (%)', 0, 10, 0.5, (v) => `${v}%`)));
    controls.appendChild(box('표시', checkbox(api, 'showLegend', '범례'), checkbox(api, 'showRegLine', '회귀선')));
    controls.appendChild(box('선택', h('div', { class: 'info-text' }, `${s.selection.length}개 선택됨`), button('선택 해제', () => api.update({ selection: [] })),
      note('드래그: 영역 선택, Shift+드래그: 추가, 클릭: 해제')));
    if (api.message) controls.appendChild(note(api.message, 'info'));

    const xc = findColumn(t, xName)!, yc = findColumn(t, yName)!;
    const cc = colorName ? findColumn(t, colorName) : undefined;
    const subset = tableInput(api.inputs.subset);
    const subsetRows = subset ? new Set(rowsByIds(t, new Set(subset.ids))) : null;
    const selSet = new Set(s.selection);

    const [W, H] = plotSize(main, 360);
    const wrap = h('div', { class: 'plot-wrap' });
    main.appendChild(wrap);
    const p = new Plot(wrap, W, H);
    const xd = xc.data as Float64Array, yd = yc.data as Float64Array;
    const range = (c: Column, d: Float64Array): [number, number] => {
      if (isDisc(c)) return [-0.5, c.variable.values!.length - 0.5];
      const [lo, hi] = minMax(d.filter((v) => !Number.isNaN(v)));
      const pad = (hi - lo) * 0.04 || 1;
      return [lo - pad, hi + pad];
    };
    const [x0, x1] = range(xc, xd), [y0, y1] = range(yc, yd);
    const discTicks = (c: Column) => (isDisc(c) ? c.variable.values!.map((v, i) => [i, v] as [number, string]) : undefined);
    p.axes({ lo: x0, hi: x1, label: xName, ticks: discTicks(xc) }, { lo: y0, hi: y1, label: yName, ticks: discTicks(yc) });
    const sx = p.scaleX(x0, x1), sy = p.scaleY(y0, y1);
    // 지터: 범주형 축은 항상 약간 흩뿌린다(Orange와 동일하게 겹침 방지)
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const jx = (isDisc(xc) ? 0.3 : 0) + (s.jitter / 100) * (x1 - x0);
    const jy = (isDisc(yc) ? 0.3 : 0) + (s.jitter / 100) * (y1 - y0);
    const n = t.nRows;
    const stride = n > LIMITS.scatterPoints ? n / LIMITS.scatterPoints : 1;
    const pxs = new Float32Array(n).fill(NaN), pys = new Float32Array(n).fill(NaN);
    const colorOf = (i: number, a: number): string => {
      if (!cc) return `rgba(70,190,250,${a})`;
      const v = cc.data[i] as number;
      if (isDisc(cc)) return discreteColor(v, a);
      return continuousColor((v - cRange[0]) / (cRange[1] - cRange[0] || 1), a);
    };
    const cRange = cc && isCont(cc) ? minMax((cc.data as Float64Array).filter((v) => !Number.isNaN(v))) : [0, 1];
    const { ctx } = p;
    const r = s.pointSize / 2;
    const baseA = s.alpha / 255;
    ctx.save();
    ctx.beginPath(); ctx.rect(p.m.l, p.m.t, p.pw, p.ph); ctx.clip();
    for (let f = 0; f < n; f += stride) {
      const i = Math.floor(f);
      if (Number.isNaN(xd[i]) || Number.isNaN(yd[i])) continue;
      const px = sx(xd[i] + (jx ? rnd() * jx : 0)), py = sy(yd[i] + (jy ? rnd() * jy : 0));
      pxs[i] = px; pys[i] = py;
      const dim = (selSet.size && !selSet.has(i)) || (subsetRows && !subsetRows.has(i));
      const a = dim ? baseA * 0.35 : baseA;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = colorOf(i, a); ctx.fill();
      ctx.strokeStyle = colorOf(i, Math.min(1, a + 0.3)); ctx.lineWidth = 1; ctx.stroke();
      if (selSet.has(i)) { ctx.strokeStyle = p.fg; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
    if (s.showRegLine && isCont(xc) && isCont(yc)) {
      const drawLine = (rows: number[] | null, color: string) => {
        let sxv = 0, syv = 0, sxx = 0, sxy = 0, k = 0;
        for (let i = 0; i < n; i++) {
          if (rows && !rows.includes(i)) continue;
          if (Number.isNaN(xd[i]) || Number.isNaN(yd[i])) continue;
          sxv += xd[i]; syv += yd[i]; sxx += xd[i] * xd[i]; sxy += xd[i] * yd[i]; k++;
        }
        if (k < 2) return;
        const slope = (k * sxy - sxv * syv) / (k * sxx - sxv * sxv);
        const icpt = (syv - slope * sxv) / k;
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx(x0), sy(icpt + slope * x0)); ctx.lineTo(sx(x1), sy(icpt + slope * x1)); ctx.stroke();
        const rr = pearson(xd, yd);
        ctx.fillStyle = color; ctx.textAlign = 'left';
        if (!rows) ctx.fillText(`r = ${formatNumber(rr, 2)}`, p.m.l + 8, p.m.t + p.ph - 10);
      };
      drawLine(null, p.fg);
    }
    ctx.restore();
    if (s.showLegend && cc && isDisc(cc)) p.legend(cc.variable.values!.map((v, i) => ({ label: v, color: discreteColor(i) })));
    if (s.showLegend && cc && isCont(cc)) {
      const lx = p.m.l + p.pw - 140, ly = p.m.t + 8;
      for (let k = 0; k < 120; k++) { ctx.fillStyle = continuousColor(k / 119); ctx.fillRect(lx + k, ly, 1, 10); }
      ctx.fillStyle = p.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(formatNumber(cRange[0]), lx, ly + 12); ctx.textAlign = 'right'; ctx.fillText(formatNumber(cRange[1]), lx + 120, ly + 12);
    }

    // 영역 선택
    const rect = h('div', { class: 'sel-rect' });
    wrap.appendChild(rect);
    let start: [number, number] | null = null;
    const pos = (ev: PointerEvent): [number, number] => { const b = p.canvas.getBoundingClientRect(); return [ev.clientX - b.left, ev.clientY - b.top]; };
    p.canvas.addEventListener('pointerdown', (ev) => { start = pos(ev); p.canvas.setPointerCapture(ev.pointerId); });
    p.canvas.addEventListener('pointermove', (ev) => {
      if (!start) return;
      const [cx, cy] = pos(ev);
      Object.assign(rect.style, { display: 'block', left: `${Math.min(start[0], cx)}px`, top: `${Math.min(start[1], cy)}px`, width: `${Math.abs(cx - start[0])}px`, height: `${Math.abs(cy - start[1])}px` });
    });
    p.canvas.addEventListener('pointerup', (ev) => {
      if (!start) return;
      const [cx, cy] = pos(ev);
      const [ax, ay] = start;
      start = null;
      rect.style.display = 'none';
      if (Math.abs(cx - ax) < 3 && Math.abs(cy - ay) < 3) { if (!ev.shiftKey && s.selection.length) api.update({ selection: [] }); return; }
      const lx = Math.min(ax, cx), hx = Math.max(ax, cx), ly = Math.min(ay, cy), hy = Math.max(ay, cy);
      const chosen = ev.shiftKey ? new Set(s.selection) : new Set<number>();
      for (let i = 0; i < n; i++) if (pxs[i] >= lx && pxs[i] <= hx && pys[i] >= ly && pys[i] <= hy) chosen.add(i);
      api.update({ selection: [...chosen].sort((a, b) => a - b) });
    });
  },
});

// ------------------------------------------------------------------ Distributions
interface DistSettings { variable: string; split: string; bins: number; stacked: boolean; showProbs: boolean; cumulative: boolean; selection: number[] }

function binsFor(c: Column, nb: number): { edges: number[]; labels: string[]; binOf: (x: number) => number } {
  if (isDisc(c)) {
    const vals = c.variable.values!;
    return { edges: [], labels: vals, binOf: (x) => (Number.isNaN(x) ? -1 : x) };
  }
  const d = c.data as Float64Array;
  const [lo, hi] = minMax(d.filter((v) => !Number.isNaN(v)));
  const w = (hi - lo) / nb || 1;
  const edges = Array.from({ length: nb + 1 }, (_, i) => lo + i * w);
  return {
    edges,
    labels: edges.slice(0, -1).map((e, i) => `${formatNumber(e)} – ${formatNumber(edges[i + 1])}`),
    binOf: (x) => (Number.isNaN(x) ? -1 : Math.min(nb - 1, Math.floor((x - lo) / w))),
  };
}

registerWidget({
  type: 'visualize.distributions',
  name: 'Distributions',
  category: 'visualize',
  abbr: 'Dst',
  description: '변수의 분포(히스토그램/막대)를 그리고, 목표 변수 등으로 나눠 비교합니다.',
  keywords: ['histogram', 'distribution', '히스토그램', '분포'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'selected', name: 'Selected Data', type: 'Data', default: true }, { id: 'histogram', name: 'Histogram Data', type: 'Data' }],
  windowSize: [880, 560],
  defaultSettings: (): DistSettings => ({ variable: '', split: '\u0000class', bins: 10, stacked: false, showProbs: false, cumulative: false, selection: [] }),
  execute(inputs, s: DistSettings, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const vName = nearestName(t, s.variable, isNum, 0);
    const c = findColumn(t, vName);
    if (!c) throw new Error('수치형 또는 범주형 변수가 없습니다.');
    const { labels, binOf } = binsFor(c, s.bins);
    const rows: number[] = [];
    const sel = new Set(s.selection);
    const counts = new Float64Array(labels.length);
    for (let i = 0; i < t.nRows; i++) { const b = binOf(c.data[i] as number); if (b >= 0) { counts[b]++; if (sel.has(b)) rows.push(i); } }
    const hist = makeTable(`${vName} histogram`, [{ variable: { name: 'Count', kind: 'continuous', decimals: 0 }, data: counts }], null, [{ variable: { name: 'Bin', kind: 'string' }, data: labels }]);
    return { outputs: { selected: rows.length ? takeRows(t, rows) : null, histogram: hist } };
  },
  render({ controls, main }, api: ViewApi<DistSettings>) {
    const t = tableInput(api.inputs.data);
    if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
    const s = api.settings;
    const vName = nearestName(t, s.variable, isNum, 0);
    if (vName !== s.variable) api.silentUpdate({ variable: vName, selection: [] });
    const splitName = s.split === '\u0000class' ? (t.classVar && isDisc(t.classVar) ? t.classVar.variable.name : '') : s.split;
    controls.appendChild(box('변수', varCombo(api, 'variable', null, t, isNum)));
    const c = findColumn(t, vName)!;
    if (isCont(c)) controls.appendChild(box('구간', slider(api, 'bins', '구간 수', 2, 60)));
    const splitEl = varCombo(api, 'split', '나누기', t, isDisc, { none: '(나누지 않음)' });
    (splitEl.querySelector('select') as HTMLSelectElement).value = splitName;
    controls.appendChild(box('목표/그룹', splitEl, checkbox(api, 'stacked', '막대 쌓기'), checkbox(api, 'showProbs', '그룹 내 비율 표시'), isCont(c) ? checkbox(api, 'cumulative', '누적 분포') : null));
    controls.appendChild(box('선택', h('div', { class: 'info-text' }, `${s.selection.length}개 구간 선택`), button('선택 해제', () => api.update({ selection: [] })), note('막대를 클릭해 구간을 선택합니다(Shift: 추가).')));

    const sc = splitName ? findColumn(t, splitName) : undefined;
    const { labels, binOf, edges } = binsFor(c, s.bins);
    const G = sc ? sc.variable.values!.length : 1;
    const counts = labels.map(() => new Float64Array(G));
    for (let i = 0; i < t.nRows; i++) {
      const b = binOf(c.data[i] as number);
      if (b < 0) continue;
      const g = sc ? (sc.data[i] as number) : 0;
      if (Number.isNaN(g)) continue;
      counts[b][g]++;
    }
    let values = counts.map((r) => Array.from(r));
    if (s.showProbs && sc) {
      const tot = new Array<number>(G).fill(0);
      counts.forEach((r) => r.forEach((v, g) => { tot[g] += v; }));
      values = values.map((r) => r.map((v, g) => (tot[g] ? v / tot[g] : 0)));
    }
    if (s.cumulative && isCont(c)) {
      const acc = new Array<number>(G).fill(0);
      values = values.map((r) => r.map((v, g) => (acc[g] += v)));
    }
    const maxY = Math.max(1e-9, ...values.map((r) => (s.stacked ? r.reduce((a, b) => a + b, 0) : Math.max(...r))));
    const [W, H] = plotSize(main, 340);
    const wrap = h('div', { class: 'plot-wrap' });
    main.appendChild(wrap);
    const p = new Plot(wrap, W, H, { b: isCont(c) ? 44 : 64 });
    const nb = labels.length;
    const xTicks: Array<[number, string]> = isCont(c)
      ? edges.filter((_, i) => i % Math.max(1, Math.ceil(nb / 8)) === 0).map((e, k) => [k * Math.max(1, Math.ceil(nb / 8)), formatNumber(e)] as [number, string])
      : labels.map((l, i) => [i + 0.5, l.length > 12 ? l.slice(0, 11) + '…' : l] as [number, string]);
    p.axes({ lo: 0, hi: nb, label: vName, ticks: xTicks }, { lo: 0, hi: maxY * 1.05, label: s.showProbs && sc ? '비율' : s.cumulative ? '누적 빈도' : '빈도' });
    const sx = p.scaleX(0, nb), sy = p.scaleY(0, maxY * 1.05);
    const sel = new Set(s.selection);
    const { ctx } = p;
    const bw = sx(1) - sx(0);
    values.forEach((r, b) => {
      if (sel.has(b)) { ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(sx(b), p.m.t, bw, p.ph); }
      let acc = 0;
      r.forEach((v, g) => {
        const color = sc ? discreteColor(g, 0.85) : 'rgba(70,190,250,0.85)';
        ctx.fillStyle = color;
        if (s.stacked || !sc) { ctx.fillRect(sx(b) + 2, sy(acc + v), bw - 4, sy(acc) - sy(acc + v)); acc += v; }
        else { const gw = (bw - 4) / G; ctx.fillRect(sx(b) + 2 + g * gw, sy(v), gw - 1, sy(0) - sy(v)); }
      });
      if (sel.has(b)) { ctx.strokeStyle = p.fg; ctx.lineWidth = 2; ctx.strokeRect(sx(b) + 1, p.m.t + 1, bw - 2, p.ph - 2); }
    });
    if (sc) p.legend(sc.variable.values!.map((v, i) => ({ label: v, color: discreteColor(i) })));
    p.canvas.addEventListener('click', (ev) => {
      const b = p.canvas.getBoundingClientRect();
      const x = ev.clientX - b.left;
      const bin = Math.floor(((x - p.m.l) / p.pw) * nb);
      if (bin < 0 || bin >= nb) { api.update({ selection: [] }); return; }
      const next = ev.shiftKey ? new Set(s.selection) : new Set<number>();
      if (next.has(bin) && ev.shiftKey) next.delete(bin); else next.add(bin);
      api.update({ selection: [...next] });
    });
  },
});

// ------------------------------------------------------------------ Box Plot
registerWidget({
  type: 'visualize.boxplot',
  name: 'Box Plot',
  category: 'visualize',
  abbr: 'Box',
  description: '수치형 변수의 사분위수 상자 그림(그룹 비교 + t-검정/ANOVA), 범주형 변수의 비율 막대(카이제곱 검정).',
  keywords: ['box', 'whisker', 'anova', '상자'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [],
  windowSize: [860, 540],
  defaultSettings: () => ({ variable: '', group: '\u0000class', showMean: true }),
  execute(inputs, _s, ctx) {
    if (!tableInput(inputs.data)) return waiting(ctx);
    return { outputs: {} };
  },
  render({ controls, main }, api) {
    const t = tableInput(api.inputs.data);
    if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
    const s = api.settings as { variable: string; group: string; showMean: boolean };
    const vName = nearestName(t, s.variable, (c) => isNum(c) && c !== t.classVar, 0) || nearestName(t, s.variable, isNum, 0);
    const gName = s.group === '\u0000class' ? (t.classVar && isDisc(t.classVar) ? t.classVar.variable.name : '') : s.group;
    controls.appendChild(box('변수', varCombo(api, 'variable', null, t, isNum)));
    (controls.querySelector('select') as HTMLSelectElement).value = vName;
    const gEl = varCombo(api, 'group', '그룹', t, isDisc, { none: '(그룹 없음)' });
    (gEl.querySelector('select') as HTMLSelectElement).value = gName;
    controls.appendChild(box('하위 그룹', gEl, checkbox(api, 'showMean', '평균 ± 표준편차 표시', { rerun: false })));
    controls.querySelectorAll('input[type=checkbox]').forEach((el) => el.addEventListener('change', () => api.rerender()));
    const c = findColumn(t, vName);
    if (!c) return;
    const gc = gName ? findColumn(t, gName) : undefined;
    const groupLabels = gc ? gc.variable.values! : ['전체'];
    const G = groupLabels.length;
    const [W, H] = plotSize(main, 320);
    const wrap = h('div', { class: 'plot-wrap' });
    main.appendChild(wrap);
    const stat = h('div', { class: 'plot-stat' });
    if (isCont(c)) {
      const groups = groupLabels.map(() => [] as number[]);
      const d = c.data as Float64Array;
      for (let i = 0; i < t.nRows; i++) {
        if (Number.isNaN(d[i])) continue;
        const g = gc ? (gc.data[i] as number) : 0;
        if (!Number.isNaN(g)) groups[g].push(d[i]);
      }
      const [lo, hi] = minMax(d.filter((v) => !Number.isNaN(v)));
      const pad = (hi - lo) * 0.05 || 1;
      const p = new Plot(wrap, W, Math.max(H - 30, 40 + G * 60), { l: 120 });
      p.axes({ lo: lo - pad, hi: hi + pad, label: vName }, { lo: 0, hi: G, label: gName || '', ticks: groupLabels.map((l, i) => [G - i - 0.5, l] as [number, string]) });
      const sx = p.scaleX(lo - pad, hi + pad), sy = p.scaleY(0, G);
      const { ctx } = p;
      groups.forEach((vals, g) => {
        if (!vals.length) return;
        const sorted = sortedFinite(vals);
        const q1 = quantileSorted(sorted, 0.25), q2 = quantileSorted(sorted, 0.5), q3 = quantileSorted(sorted, 0.75);
        const yc = sy(G - g - 0.5), bh = Math.min(36, (sy(0) - sy(1)) * 0.5);
        const col = gc ? discreteColor(g, 0.6) : 'rgba(70,190,250,0.6)';
        // 수염: Orange처럼 최소~최대
        ctx.strokeStyle = p.fg; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sx(sorted[0]), yc); ctx.lineTo(sx(sorted[sorted.length - 1]), yc); ctx.stroke();
        ctx.fillStyle = col; ctx.fillRect(sx(q1), yc - bh / 2, sx(q3) - sx(q1), bh);
        ctx.strokeRect(sx(q1), yc - bh / 2, sx(q3) - sx(q1), bh);
        ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx(q2), yc - bh / 2); ctx.lineTo(sx(q2), yc + bh / 2); ctx.stroke();
        if (s.showMean) {
          const m = mean(vals), sd = std(vals);
          ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(sx(m - sd), yc + bh / 2 + 5); ctx.lineTo(sx(m + sd), yc + bh / 2 + 5); ctx.stroke();
          ctx.fillStyle = '#4fc3f7'; ctx.beginPath(); ctx.arc(sx(m), yc + bh / 2 + 5, 3.5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = p.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(`중앙값 ${formatNumber(q2)} · n=${vals.length}`, sx(q3) + 6, yc - 2);
      });
      // 검정: 2그룹 t-검정(Welch 아님, Orange는 scipy.stats.ttest_ind 기본=등분산), 3그룹 이상 ANOVA
      const nonEmpty = groups.filter((g) => g.length > 1);
      if (gc && nonEmpty.length === 2) {
        const [a, b] = nonEmpty;
        const na = a.length, nb2 = b.length;
        const va = std(a, 1) ** 2, vb = std(b, 1) ** 2;
        const sp = ((na - 1) * va + (nb2 - 1) * vb) / (na + nb2 - 2);
        const tt = (mean(a) - mean(b)) / Math.sqrt(sp * (1 / na + 1 / nb2));
        stat.textContent = `Student's t: ${formatNumber(Math.abs(tt), 3)} (${formatP(tTestP(tt, na + nb2 - 2))})`;
      } else if (gc && nonEmpty.length > 2) {
        const all = nonEmpty.flat();
        const gm = mean(all);
        let ssb = 0, ssw = 0;
        for (const g of nonEmpty) { const m = mean(g); ssb += g.length * (m - gm) ** 2; for (const v of g) ssw += (v - m) ** 2; }
        const d1 = nonEmpty.length - 1, d2 = all.length - nonEmpty.length;
        const F = (ssb / d1) / (ssw / d2);
        stat.textContent = `ANOVA: ${formatNumber(F, 3)} (${formatP(fTestP(F, d1, d2))})`;
      }
    } else {
      // 범주형: 그룹별 비율 막대
      const K = c.variable.values!.length;
      const table = groupLabels.map(() => new Float64Array(K));
      for (let i = 0; i < t.nRows; i++) {
        const v = c.data[i] as number; const g = gc ? (gc.data[i] as number) : 0;
        if (!Number.isNaN(v) && !Number.isNaN(g)) table[g][v]++;
      }
      const p = new Plot(wrap, W, Math.max(H - 30, 40 + G * 50), { l: 120 });
      p.axes({ lo: 0, hi: 1, label: `${vName} 비율` }, { lo: 0, hi: G, label: gName || '', ticks: groupLabels.map((l, i) => [G - i - 0.5, l] as [number, string]) });
      const sx = p.scaleX(0, 1), sy = p.scaleY(0, G);
      const { ctx } = p;
      table.forEach((r, g) => {
        const tot = r.reduce((a, b) => a + b, 0);
        if (!tot) return;
        let acc = 0;
        const yc = sy(G - g - 0.5), bh = Math.min(30, (sy(0) - sy(1)) * 0.6);
        r.forEach((v, k) => {
          ctx.fillStyle = discreteColor(k, 0.85);
          ctx.fillRect(sx(acc / tot), yc - bh / 2, sx((acc + v) / tot) - sx(acc / tot), bh);
          acc += v;
        });
      });
      p.legend(c.variable.values!.map((v, i) => ({ label: v, color: discreteColor(i) })));
      if (gc) {
        const rowT = table.map((r) => r.reduce((a, b) => a + b, 0));
        const colT = new Array<number>(K).fill(0);
        table.forEach((r) => r.forEach((v, k) => { colT[k] += v; }));
        const N = rowT.reduce((a, b) => a + b, 0);
        let chi = 0, dfR = 0, dfC = 0;
        rowT.forEach((rt) => { if (rt) dfR++; });
        colT.forEach((ct) => { if (ct) dfC++; });
        table.forEach((r, g) => r.forEach((v, k) => { const e = (rowT[g] * colT[k]) / N; if (e > 0) chi += (v - e) ** 2 / e; }));
        const df = (dfR - 1) * (dfC - 1);
        if (df > 0) stat.textContent = `χ²: ${formatNumber(chi, 2)} (${formatP(chi2P(chi, df))})`;
      }
    }
    main.appendChild(stat);
  },
});

// ------------------------------------------------------------------ Correlations
interface CorrRow { a: string; b: string; r: number; p: number; fdr: number }

registerWidget({
  type: 'visualize.correlations',
  name: 'Correlations',
  category: 'visualize',
  abbr: 'Cor',
  description: '수치형 변수 쌍의 상관계수(Pearson/Spearman)를 크기 순으로 보여줍니다.',
  keywords: ['correlation', 'pearson', 'spearman', '상관'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data' }, { id: 'correlations', name: 'Correlations', type: 'Data', default: true }],
  windowSize: [620, 560],
  defaultSettings: () => ({ method: 'pearson', feature: '' }),
  execute(inputs, s: { method: 'pearson' | 'spearman'; feature: string }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const cols = t.attributes.filter(isCont);
    if (cols.length < 2) throw new Error('상관계수를 계산하려면 수치형 특징이 2개 이상 필요합니다.');
    if (cols.length > 400) throw new Error('수치형 특징이 400개를 넘어 계산량이 너무 큽니다. Select Columns로 줄이세요.');
    const f = s.method === 'spearman' ? spearman : pearson;
    const rows: CorrRow[] = [];
    for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
      if (s.feature && cols[i].variable.name !== s.feature && cols[j].variable.name !== s.feature) continue;
      const x = cols[i].data as Float64Array, y = cols[j].data as Float64Array;
      const r = f(x, y);
      let n = 0;
      for (let k = 0; k < t.nRows; k++) if (!Number.isNaN(x[k]) && !Number.isNaN(y[k])) n++;
      const tt = r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r));
      rows.push({ a: cols[i].variable.name, b: cols[j].variable.name, r, p: n > 2 ? tTestP(tt, n - 2) : NaN, fdr: NaN });
    }
    // Benjamini-Hochberg FDR
    const order = rows.map((_, i) => i).sort((a, b) => rows[a].p - rows[b].p);
    let prev = 1;
    for (let k = order.length - 1; k >= 0; k--) { const i = order[k]; prev = Math.min(prev, (rows[i].p * order.length) / (k + 1)); rows[i].fdr = prev; }
    rows.sort((a, b) => Math.abs(b.r) - Math.abs(a.r) || a.a.localeCompare(b.a));
    const out = makeTable('Correlations',
      [{ variable: { name: 'Correlation', kind: 'continuous', decimals: 3 }, data: Float64Array.from(rows, (r) => r.r) }, { variable: { name: 'FDR', kind: 'continuous', decimals: 4 }, data: Float64Array.from(rows, (r) => r.fdr) }],
      null,
      [{ variable: { name: 'Feature 1', kind: 'string' }, data: rows.map((r) => r.a) }, { variable: { name: 'Feature 2', kind: 'string' }, data: rows.map((r) => r.b) }]);
    return { outputs: { data: t, correlations: out }, view: rows };
  },
  render({ controls, main }, api) {
    const t = tableInput(api.inputs.data);
    controls.appendChild(box('방법', radio(api, 'method', null, [['pearson', 'Pearson 상관'], ['spearman', 'Spearman 순위 상관']])));
    if (t) controls.appendChild(box('특징', varCombo(api, 'feature', null, t, (c) => isCont(c) && t.attributes.includes(c), { none: '(모든 쌍)' })));
    const rows = api.view as CorrRow[] | null;
    if (!rows) { emptyMain(main, api.message || '입력 데이터가 없습니다.'); return; }
    const filter = h('input', { type: 'search', placeholder: '변수 검색…', class: 'search' });
    const list = h('div', { class: 'corr-list' });
    const draw = () => {
      list.replaceChildren();
      const q = filter.value.toLowerCase();
      for (const r of rows.slice(0, 2000)) {
        if (q && !r.a.toLowerCase().includes(q) && !r.b.toLowerCase().includes(q)) continue;
        const w = Math.abs(r.r) * 50;
        list.appendChild(h('div', { class: 'corr-row', title: `FDR ${formatNumber(r.fdr, 4)}` },
          h('div', { class: 'corr-bar' }, h('div', { class: `corr-fill ${r.r >= 0 ? 'pos' : 'neg'}`, style: r.r >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%` }),
            h('span', { class: 'corr-val' }, formatNumber(r.r, 3))),
          h('div', { class: 'corr-names' }, `${r.a}, ${r.b}`)));
      }
    };
    filter.addEventListener('input', draw);
    draw();
    main.appendChild(filter);
    main.appendChild(h('div', { class: 'main-scroll' }, list));
  },
});

// ------------------------------------------------------------------ Heat Map
registerWidget({
  type: 'visualize.heatmap',
  name: 'Heat Map',
  category: 'visualize',
  abbr: 'HM',
  description: '행 × 수치형 특징의 값을 색으로 표시합니다. 그룹 분할과 계층 군집 정렬을 지원합니다.',
  keywords: ['heatmap', '히트맵'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [],
  windowSize: [900, 620],
  defaultSettings: () => ({ split: '\u0000class', clusterRows: false, standardize: true, legend: true }),
  execute(inputs, _s, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    if (t.attributes.filter(isCont).length === 0) throw new Error('수치형 특징이 없습니다.');
    return { outputs: {} };
  },
  render({ controls, main }, api) {
    const t = tableInput(api.inputs.data);
    if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
    const s = api.settings as { split: string; clusterRows: boolean; standardize: boolean };
    const splitName = s.split === '\u0000class' ? (t.classVar && isDisc(t.classVar) ? t.classVar.variable.name : '') : s.split;
    const sEl = varCombo(api, 'split', '행 분할', t, isDisc, { none: '(분할 없음)' });
    (sEl.querySelector('select') as HTMLSelectElement).value = splitName;
    controls.appendChild(box('행', sEl, checkbox(api, 'clusterRows', `계층 군집으로 정렬 (≤ ${LIMITS.heatmapCluster}행)`)));
    controls.appendChild(box('색', checkbox(api, 'standardize', '열마다 표준화 (z-점수)')));
    const cols = t.attributes.filter(isCont);
    const n = t.nRows;
    const sc = splitName ? findColumn(t, splitName) : undefined;
    // 행 순서: 그룹 → (선택 시) 군집
    let order: number[] = Array.from({ length: n }, (_, i) => i);
    if (s.clusterRows) {
      if (n > LIMITS.heatmapCluster) controls.appendChild(note(`${LIMITS.heatmapCluster}행을 넘어 군집 정렬을 건너뛰었습니다.`, 'warn'));
      else {
        const sub = { ...t, attributes: cols };
        const m = encode(fitEncoder(sub, true), sub);
        const Z = hierarchical(computeDistances(m, 'euclidean', []), 'ward');
        order = leafOrder(Z, n);
      }
    }
    if (sc) {
      const g = sc.data as Float64Array;
      const rank = new Map(order.map((r, k) => [r, k]));
      order.sort((a, b) => (Number.isNaN(g[a]) ? 1e9 : g[a]) - (Number.isNaN(g[b]) ? 1e9 : g[b]) || rank.get(a)! - rank.get(b)!);
    }
    const stats = cols.map((c) => { const d = c.data as Float64Array; return { m: mean(d), sd: std(d) || 1, mm: minMax(d.filter((v) => !Number.isNaN(v))) }; });
    const val = (j: number, i: number) => {
      const v = (cols[j].data as Float64Array)[i];
      if (Number.isNaN(v)) return NaN;
      return s.standardize ? (v - stats[j].m) / stats[j].sd : (v - stats[j].mm[0]) / (stats[j].mm[1] - stats[j].mm[0] || 1);
    };
    const [W, H] = plotSize(main, 380);
    const wrap = h('div', { class: 'plot-wrap' });
    main.appendChild(wrap);
    const p = new Plot(wrap, W, H, { l: sc ? 110 : 20, b: 90, t: 10, r: 90 });
    const { ctx } = p;
    const cw = p.pw / cols.length;
    // 행이 픽셀보다 많으면 픽셀 행마다 평균(저사양 기기 보호)
    const rowsPerPx = Math.max(1, n / p.ph);
    const lines = Math.min(n, Math.floor(p.ph));
    const rh = p.ph / lines;
    for (let li = 0; li < lines; li++) {
      const a = Math.floor(li * (n / lines)), b = Math.max(a + 1, Math.floor((li + 1) * (n / lines)));
      for (let j = 0; j < cols.length; j++) {
        let sum = 0, k = 0;
        for (let r = a; r < b; r++) { const v = val(j, order[r]); if (!Number.isNaN(v)) { sum += v; k++; } }
        const v = k ? sum / k : NaN;
        ctx.fillStyle = Number.isNaN(v) ? 'rgba(128,128,128,0.4)' : s.standardize ? divergingColor(Math.max(-1, Math.min(1, v / 2.5))) : continuousColor(v);
        ctx.fillRect(p.m.l + j * cw, p.m.t + li * rh, Math.ceil(cw), Math.ceil(rh));
      }
      if (sc) {
        const g = sc.data[order[a]] as number;
        ctx.fillStyle = discreteColor(g);
        ctx.fillRect(p.m.l - 14, p.m.t + li * rh, 10, Math.ceil(rh));
      }
    }
    if (sc) {
      const g = sc.data as Float64Array;
      ctx.fillStyle = p.fg; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      sc.variable.values!.forEach((v, gi) => {
        const rows = order.map((r, k) => (g[r] === gi ? k : -1)).filter((k) => k >= 0);
        if (!rows.length) return;
        const mid = (rows[0] + rows[rows.length - 1]) / 2;
        ctx.fillText(v.length > 14 ? v.slice(0, 13) + '…' : v, p.m.l - 18, p.m.t + (mid / n) * p.ph);
      });
    }
    ctx.save();
    ctx.fillStyle = p.fg; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    cols.forEach((c, j) => {
      if (cw < 9 && j % Math.ceil(9 / cw) !== 0) return;
      ctx.save(); ctx.translate(p.m.l + (j + 0.5) * cw, p.m.t + p.ph + 6); ctx.rotate(-Math.PI / 3);
      ctx.fillText(c.variable.name.length > 14 ? c.variable.name.slice(0, 13) + '…' : c.variable.name, 0, 0); ctx.restore();
    });
    ctx.restore();
    // 색 범례
    const lx = p.w - 76, ly = p.m.t + 10;
    for (let k = 0; k < 120; k++) {
      const tt = 1 - k / 119;
      ctx.fillStyle = s.standardize ? divergingColor(tt * 2 - 1) : continuousColor(tt);
      ctx.fillRect(lx, ly + k, 12, 1);
    }
    ctx.fillStyle = p.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(s.standardize ? '+2.5σ' : '최대', lx + 16, ly);
    ctx.fillText(s.standardize ? '−2.5σ' : '최소', lx + 16, ly + 120);
    if (rowsPerPx > 1) main.appendChild(h('div', { class: 'plot-stat' }, `${n.toLocaleString()}행을 ${lines}줄로 평균내어 표시했습니다.`));
  },
});

