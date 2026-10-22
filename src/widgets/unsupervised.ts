/** Unsupervised 카테고리: k-Means, PCA, Distances, Distance Matrix, Hierarchical Clustering */
import { registerWidget } from '../engine/registry';
import type { ViewApi } from '../engine/types';
import { type Table, type Column, cellText, makeTable, takeRows, formatBytes, allColumns, findColumn } from '../core/table';
import { formatNumber } from '../core/stats';
import { type DistMatrix, type Linkage, type LinkageMatrix, type PCAResult, type Metric, distanceBytes, distAt, cutTopN, cutHeight, leafOrder } from '../ml/unsupervised';
import { Rng } from '../ml/random';
import { h } from '../ui/dom';
import { box, checkbox, combo, note, radio, spin, emptyMain, slider } from '../ui/controls';
import { Plot, discreteColor, continuousColor, plotSize } from '../ui/plot';
import { waiting, tableInput, LIMITS } from './common';

export interface DistancesValue { dm: DistMatrix; data: Table | null }

function clusterColumn(name: string, labels: ArrayLike<number>, k: number, prefix = 'C'): Column {
  return { variable: { name, kind: 'discrete', values: Array.from({ length: k }, (_, i) => `${prefix}${i + 1}`) }, data: Float64Array.from(labels as ArrayLike<number>, (v) => (v < 0 ? NaN : v)) };
}

// ------------------------------------------------------------------ k-Means
interface KMSettings { k: number; optimizeK: boolean; kFrom: number; kTo: number; init: 'kmeans++' | 'random'; nInit: number; maxIter: number; normalize: boolean; selectedK: number }
interface KMRun { k: number; labels: Int32Array; inertia: number; silhouette: Float64Array | null; meanSilhouette: number }

registerWidget({
  type: 'unsupervised.kmeans',
  name: 'k-Means',
  category: 'unsupervised',
  abbr: 'kM',
  description: 'k-평균 군집화. 군집 번호(Cluster)와 실루엣 점수를 메타 열로 추가합니다.',
  keywords: ['kmeans', 'cluster', '군집'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }, { id: 'centroids', name: 'Centroids', type: 'Data' }],
  windowSize: [560, 520],
  // Orange 기본값: k=3, 최적화 범위 2–8, k-means++, 재시도 10, 최대 반복 300, 정규화
  defaultSettings: (): KMSettings => ({ k: 3, optimizeK: false, kFrom: 2, kTo: 8, init: 'kmeans++', nInit: 10, maxIter: 300, normalize: true, selectedK: 0 }),
  async execute(inputs, s: KMSettings, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const k: number | [number, number] = s.optimizeK ? [Math.max(2, s.kFrom), Math.max(s.kFrom, s.kTo)] : s.k;
    if (t.nRows > LIMITS.silhouette) ctx.info(`${LIMITS.silhouette.toLocaleString()}행을 넘어 실루엣 점수는 계산하지 않습니다.`);
    const res = await ctx.compute<{ runs: KMRun[] }>('kmeans', { data: t, k, normalize: s.normalize, nInit: s.nInit, maxIter: s.maxIter, init: s.init, silhouetteLimit: LIMITS.silhouette });
    let run = res.runs[0];
    if (s.optimizeK) {
      run = res.runs.find((r) => r.k === s.selectedK) ?? res.runs.reduce((a, b) => (b.meanSilhouette > a.meanSilhouette ? b : a));
    }
    const metas = [...t.metas, clusterColumn('Cluster', run.labels, run.k)];
    if (run.silhouette) metas.push({ variable: { name: 'Silhouette', kind: 'continuous', decimals: 3 }, data: run.silhouette });
    // 중심(원래 단위): 군집별 평균
    const contCols = t.attributes.filter((c) => c.variable.kind === 'continuous');
    const centroids = makeTable('Centroids', contCols.map((c) => {
      const d = c.data as Float64Array;
      const sum = new Float64Array(run.k), cnt = new Float64Array(run.k);
      for (let i = 0; i < t.nRows; i++) if (!Number.isNaN(d[i])) { sum[run.labels[i]] += d[i]; cnt[run.labels[i]]++; }
      return { variable: c.variable, data: Float64Array.from(sum, (v, i) => v / (cnt[i] || 1)) };
    }), null, [clusterColumn('Cluster', Array.from({ length: run.k }, (_, i) => i), run.k)]);
    return { outputs: { data: { ...t, metas }, centroids }, view: { runs: res.runs, chosen: run.k } };
  },
  render({ controls, main }, api: ViewApi<KMSettings>) {
    const s = api.settings;
    controls.appendChild(box('군집 수',
      radio(api, 'optimizeK', null, [[false as unknown as string, '고정'], [true as unknown as string, '범위에서 최적화 (실루엣)']]),
      !s.optimizeK ? spin(api, 'k', 'k', 2, 30) : null,
      s.optimizeK ? spin(api, 'kFrom', '시작', 2, 30) : null,
      s.optimizeK ? spin(api, 'kTo', '끝', 2, 30) : null));
    controls.appendChild(box('전처리', checkbox(api, 'normalize', '열 정규화 (표준화)')));
    controls.appendChild(box('초기화', combo(api, 'init', null, [['kmeans++', 'k-Means++'], ['random', '무작위 초기화']]),
      spin(api, 'nInit', '재시도 횟수', 1, 100), spin(api, 'maxIter', '최대 반복', 10, 10000)));
    const v = api.view as { runs: KMRun[]; chosen: number } | null;
    if (api.message) controls.appendChild(note(api.message));
    if (!v) { emptyMain(main, api.message || '결과 없음'); return; }
    main.appendChild(h('table', { class: 'grid-table selectable' },
      h('thead', null, h('tr', null, h('th', null, 'k'), h('th', null, '실루엣 (평균)'), h('th', null, '관성 (inertia)'), h('th', null, '군집 크기'))),
      h('tbody', null, ...v.runs.map((r) => {
        const sizes = new Array<number>(r.k).fill(0);
        for (const l of r.labels) sizes[l]++;
        return h('tr', { class: r.k === v.chosen ? 'sel' : '', onclick: () => s.optimizeK && api.update({ selectedK: r.k }) },
          h('td', { class: 'num' }, r.k), h('td', null, Number.isNaN(r.meanSilhouette) ? '-' : h('div', { class: 'bar-cell' }, h('div', { class: 'bar', style: `width:${Math.max(0, r.meanSilhouette) * 100}%` }), formatNumber(r.meanSilhouette, 3))),
          h('td', { class: 'num' }, formatNumber(r.inertia, 4)), h('td', null, sizes.map((n, i) => `C${i + 1}: ${n}`).join(', ')));
      }))));
    if (s.optimizeK) main.appendChild(note('행을 클릭하면 해당 k의 결과를 출력합니다. 기본은 실루엣이 가장 높은 k입니다.'));
  },
});

// ------------------------------------------------------------------ PCA
registerWidget({
  type: 'unsupervised.pca',
  name: 'PCA',
  category: 'unsupervised',
  abbr: 'PCA',
  description: '주성분 분석. 선택한 수의 주성분으로 데이터를 변환하고 설명 분산(스크리 도표)을 보여줍니다.',
  keywords: ['principal component', 'dimensionality reduction', '차원 축소', '주성분'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'transformed', name: 'Transformed Data', type: 'Data', default: true }, { id: 'data', name: 'Data', type: 'Data' }, { id: 'components', name: 'Components', type: 'Data' }],
  windowSize: [820, 520],
  // Orange 기본값: 성분 2개, 정규화
  defaultSettings: () => ({ ncomponents: 2, normalize: true }),
  async execute(inputs, s: { ncomponents: number; normalize: boolean }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    if (t.nRows < 2) throw new Error('PCA에는 2행 이상이 필요합니다.');
    const { result, scores } = await ctx.compute<{ result: PCAResult; scores: Float64Array; n: number }>('pca', { data: t, normalize: s.normalize });
    const p = result.names.length;
    const q = Math.min(Math.max(1, s.ncomponents), p);
    const pcs: Column[] = Array.from({ length: q }, (_, c) => ({ variable: { name: `PC${c + 1}`, kind: 'continuous', decimals: 3 }, data: Float64Array.from({ length: t.nRows }, (_, i) => scores[i * p + c]) }));
    const transformed = { ...t, attributes: pcs };
    const annotated = { ...t, metas: [...t.metas, ...pcs] };
    const components = makeTable('Components', result.names.map((nm, a) => ({ variable: { name: nm, kind: 'continuous', decimals: 4 }, data: Float64Array.from({ length: q }, (_, c) => result.components[a * p + c]) })),
      null, [{ variable: { name: 'component', kind: 'string' }, data: pcs.map((c) => c.variable.name) }]);
    return { outputs: { transformed, data: annotated, components }, view: result };
  },
  render({ controls, main }, api) {
    const r = api.view as PCAResult | null;
    const p = r?.names.length ?? 100;
    controls.appendChild(box('주성분 선택', spin(api, 'ncomponents', '성분 수', 1, Math.max(1, p))));
    controls.appendChild(box('옵션', checkbox(api, 'normalize', '변수 정규화 (표준화)')));
    if (!r) { emptyMain(main, api.message || '결과 없음'); return; }
    const q = Math.min(Number(api.settings.ncomponents), p);
    const cum = r.ratio.reduce((acc: number[], v, i) => { acc.push((acc[i - 1] ?? 0) + v); return acc; }, []);
    controls.appendChild(box('설명 분산', h('div', { class: 'info-text' }, `${q}개 성분: ${(cum[q - 1] * 100).toFixed(1)}%`)));
    const [W, H] = plotSize(main, 320);
    const wrap = h('div', { class: 'plot-wrap' });
    main.appendChild(wrap);
    const shown = Math.min(p, 20);
    const plot = new Plot(wrap, W, H);
    plot.axes({ lo: 0.5, hi: shown + 0.5, label: '주성분', ticks: Array.from({ length: shown }, (_, i) => [i + 1, String(i + 1)] as [number, string]) }, { lo: 0, hi: 1, label: '설명 분산 비율' });
    const sx = plot.scaleX(0.5, shown + 0.5), sy = plot.scaleY(0, 1);
    const { ctx } = plot;
    const line = (vals: number[], color: string) => {
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); vals.slice(0, shown).forEach((v, i) => (i ? ctx.lineTo(sx(i + 1), sy(v)) : ctx.moveTo(sx(i + 1), sy(v)))); ctx.stroke();
      vals.slice(0, shown).forEach((v, i) => { ctx.beginPath(); ctx.arc(sx(i + 1), sy(v), 3.5, 0, Math.PI * 2); ctx.fill(); });
    };
    line(Array.from(r.ratio), discreteColor(1));
    line(cum, discreteColor(0));
    ctx.strokeStyle = plot.fg; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(sx(q), plot.m.t); ctx.lineTo(sx(q), plot.m.t + plot.ph); ctx.stroke(); ctx.setLineDash([]);
    plot.legend([{ label: '누적 분산', color: discreteColor(0) }, { label: '성분별 분산', color: discreteColor(1) }], plot.m.l + plot.pw - 130, plot.m.t + plot.ph - 50);
  },
});

// ------------------------------------------------------------------ Distances
interface DistSettings { metric: Metric; normalize: boolean; autoSample: boolean; maxRows: number }
registerWidget({
  type: 'unsupervised.distances',
  name: 'Distances',
  category: 'unsupervised',
  abbr: 'Dist',
  description: '행 사이의 거리 행렬을 계산합니다. 메모리 사용량을 미리 계산해 큰 데이터는 경고하거나 표본을 뽑습니다.',
  keywords: ['distance', 'euclidean', 'cosine', '거리'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'distances', name: 'Distances', type: 'Distances', default: true }],
  windowSize: [440, 440],
  controlsOnly: true,
  // Orange 기본값: Euclidean (normalized), 행 사이 거리
  defaultSettings: (): DistSettings => ({ metric: 'euclidean', normalize: true, autoSample: true, maxRows: 2000 }),
  async execute(inputs, s: DistSettings, ctx) {
    let t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    if (t.nRows < 2) throw new Error('거리를 계산하려면 2행 이상이 필요합니다.');
    let bytes = distanceBytes(t.nRows);
    if (t.nRows > s.maxRows || bytes > LIMITS.distanceMaxBytes) {
      if (!s.autoSample) throw new Error(`${t.nRows.toLocaleString()}행의 거리 행렬은 약 ${formatBytes(bytes)}가 필요합니다. 자동 표본 추출을 켜거나 Data Sampler로 줄이세요.`);
      const m = Math.min(s.maxRows, Math.floor(Math.sqrt((2 * LIMITS.distanceMaxBytes) / 8)));
      const idx = Array.from({ length: t.nRows }, (_, i) => i);
      new Rng(42).shuffle(idx);
      const keep = idx.slice(0, m).sort((a, b) => a - b);
      ctx.warn(`${t.nRows.toLocaleString()}행 중 ${m.toLocaleString()}행을 무작위로 뽑아 계산했습니다(메모리 보호).`);
      t = takeRows(t, keep);
      bytes = distanceBytes(t.nRows);
    }
    if (bytes > LIMITS.distanceWarnBytes) ctx.warn(`거리 행렬이 약 ${formatBytes(bytes)}의 메모리를 사용합니다.`);
    const labelCol = t.metas.find((c) => c.variable.kind === 'string') ?? t.classVar;
    const labels = Array.from({ length: t.nRows }, (_, i) => (labelCol ? cellText(labelCol, i) : String(i + 1)));
    const dm = await ctx.compute<DistMatrix>('distances', { data: { ...t, metas: [] }, metric: s.metric, normalize: s.normalize, labels });
    dm.rowIds = t.ids;
    const value: DistancesValue = { dm, data: t };
    return { outputs: { distances: value }, view: { n: t.nRows, bytes } };
  },
  render({ controls }, api: ViewApi<DistSettings>) {
    controls.appendChild(box('거리 척도', radio(api, 'metric', null, [['euclidean', 'Euclidean'], ['manhattan', 'Manhattan'], ['chebyshev', 'Chebyshev'], ['cosine', 'Cosine'], ['pearson', 'Pearson 상관 거리']]),
      checkbox(api, 'normalize', '정규화 (표준화 후 계산)')));
    controls.appendChild(box('메모리 보호', checkbox(api, 'autoSample', '행이 많으면 자동 표본 추출'), spin(api, 'maxRows', '최대 행 수', 10, 8000),
      note('거리 행렬 메모리는 행 수의 제곱에 비례합니다. 2,000행 ≈ 16MB, 5,000행 ≈ 100MB, 8,000행 ≈ 256MB.')));
    const v = api.view as { n: number; bytes: number } | null;
    if (v) controls.appendChild(note(`${v.n.toLocaleString()} × ${v.n.toLocaleString()} 행렬 · 메모리 ${formatBytes(v.bytes)}`));
    if (api.message) controls.appendChild(note(api.message, 'warn'));
  },
});

// ------------------------------------------------------------------ Distance Matrix
registerWidget({
  type: 'unsupervised.distancematrix',
  name: 'Distance Matrix',
  category: 'unsupervised',
  abbr: 'DM',
  description: '거리 행렬을 색이 있는 표로 보여줍니다(최대 300×300).',
  inputs: [{ id: 'distances', name: 'Distances', type: 'Distances', default: true }],
  outputs: [],
  windowSize: [820, 620],
  defaultSettings: () => ({}),
  execute(inputs, _s, ctx) {
    if (!inputs.distances) return waiting(ctx, 'Distances를 연결하세요.');
    return { outputs: {} };
  },
  render({ main }, api) {
    const v = api.inputs.distances as DistancesValue | null;
    if (!v) { emptyMain(main, '거리 행렬이 없습니다.'); return; }
    const n = Math.min(v.dm.n, 300);
    let mx = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) mx = Math.max(mx, distAt(v.dm, i, j));
    const cell = 22;
    const wrap = h('div', { class: 'main-scroll' });
    const c = h('canvas', { width: (n + 4) * cell, height: (n + 4) * cell, class: 'dm-canvas' });
    const g = c.getContext('2d')!;
    g.font = '10px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const d = distAt(v.dm, i, j);
      g.fillStyle = continuousColor(1 - d / (mx || 1));
      g.fillRect((j + 4) * cell, (i + 4) * cell, cell - 1, cell - 1);
    }
    g.fillStyle = '#ccc';
    for (let i = 0; i < n; i++) {
      const l = v.dm.labels[i] ?? String(i + 1);
      g.save(); g.textAlign = 'right'; g.fillText(l.slice(0, 10), 4 * cell - 4, (i + 4.5) * cell); g.restore();
      g.save(); g.translate((i + 4.5) * cell, 4 * cell - 4); g.rotate(-Math.PI / 2); g.textAlign = 'left'; g.fillText(l.slice(0, 10), 0, 0); g.restore();
    }
    wrap.appendChild(c);
    if (v.dm.n > n) main.appendChild(note(`처음 ${n}행만 표시합니다.`));
    main.appendChild(wrap);
  },
});

// ------------------------------------------------------------------ Hierarchical Clustering
const LINKAGES: Array<[Linkage, string]> = [['single', 'Single'], ['average', 'Average'], ['weighted', 'Weighted'], ['complete', 'Complete'], ['ward', 'Ward']];
interface HCSettings { linkage: Linkage; selectionMethod: 'manual' | 'height' | 'topn'; cutRatio: number; topN: number; manual: number[]; annotation: string }

registerWidget({
  type: 'unsupervised.hierarchical',
  name: 'Hierarchical Clustering',
  category: 'unsupervised',
  abbr: 'HC',
  description: '거리 행렬로 계층적 군집을 만들고 덴드로그램을 그립니다. 가지를 클릭하거나 높이/개수로 군집을 고릅니다.',
  keywords: ['dendrogram', 'hierarchical', '계층', '덴드로그램'],
  inputs: [{ id: 'distances', name: 'Distances', type: 'Distances', default: true }],
  outputs: [{ id: 'selected', name: 'Selected Data', type: 'Data', default: true }, { id: 'annotated', name: 'Data', type: 'Data' }],
  windowSize: [960, 640],
  // Orange 기본값: Ward 연결, 수동 선택, 높이 비율 75%, Top N 3
  defaultSettings: (): HCSettings => ({ linkage: 'ward', selectionMethod: 'manual', cutRatio: 75, topN: 3, manual: [], annotation: '' }),
  async execute(inputs, s: HCSettings, ctx) {
    const v = inputs.distances as DistancesValue | null;
    if (!v) return waiting(ctx, 'Distances를 연결하세요.');
    const n = v.dm.n;
    const Z = await ctx.compute<LinkageMatrix>('hierarchical', { dm: v.dm, linkage: s.linkage });
    const clusters = selectionLabels(Z, n, s);
    const k = Math.max(0, ...clusters) + 1;
    let selected: Table | null = null, annotated: Table | null = null;
    if (v.data) {
      const rows = Array.from(clusters.keys()).filter((i) => clusters[i] >= 0);
      if (rows.length) {
        const t = takeRows(v.data, rows);
        selected = { ...t, metas: [...t.metas, clusterColumn('Cluster', rows.map((i) => clusters[i]), k)] };
      }
      annotated = { ...v.data, metas: [...v.data.metas, clusterColumn('Cluster', clusters, Math.max(1, k))] };
    }
    return { outputs: { selected, annotated }, view: { Z, n, clusters, labels: v.dm.labels } };
  },
  render({ controls, main }, api: ViewApi<HCSettings>) {
    const s = api.settings;
    const dv = api.inputs.distances as DistancesValue | null;
    controls.appendChild(box('연결 방법 (Linkage)', combo(api, 'linkage', null, LINKAGES)));
    if (dv?.data) {
      const opts: Array<[string, string]> = [['', '번호 (Enumeration)'], ...allColumns(dv.data).map((c) => [c.variable.name, c.variable.name] as [string, string])];
      controls.appendChild(box('주석', combo(api, 'annotation', null, opts)));
    }
    controls.appendChild(box('선택',
      radio(api, 'selectionMethod', null, [['manual', '수동 (가지 클릭)'], ['height', '높이 비율'], ['topn', '상위 N개 군집']]),
      s.selectionMethod === 'height' ? slider(api, 'cutRatio', '비율', 0, 100, 1, (v) => `${v}%`) : null,
      s.selectionMethod === 'topn' ? spin(api, 'topN', 'N', 1, 50) : null,
      s.selectionMethod === 'manual' ? note('덴드로그램의 가지(세로선)를 클릭해 군집을 선택합니다. Ctrl/Shift+클릭: 추가') : null));
    const v = api.view as { Z: LinkageMatrix; n: number; clusters: Int32Array; labels: string[] } | null;
    if (api.message) controls.appendChild(note(api.message, 'warn'));
    if (!v) { emptyMain(main, api.message || '결과 없음'); return; }
    const { Z, n, clusters } = v;
    const annCol = dv?.data && s.annotation ? findColumn(dv.data, s.annotation) : undefined;
    const labelOf = (i: number) => (annCol ? cellText(annCol, i) : String(i + 1));
    const order = leafOrder(Z, n);
    const pos = new Float64Array(2 * n - 1);
    order.forEach((leaf, k) => { pos[leaf] = k; });
    Z.forEach(([a, b], i) => { pos[n + i] = (pos[a] + pos[b]) / 2; });
    const height = (x: number) => (x < n ? 0 : Z[x - n][2]);
    const maxH = Z.length ? Z[Z.length - 1][2] : 1;
    const showLabels = n <= 120;
    const rowH = showLabels ? 14 : Math.max(1, Math.min(14, 520 / n));
    const [W] = plotSize(main, 300);
    const labelW = showLabels ? 120 : 10;
    const H = Math.max(200, n * rowH + 40);
    const wrap = h('div', { class: 'main-scroll' });
    main.appendChild(wrap);
    const plot = new Plot(wrap, W - 16, H, { l: 10, r: labelW, t: 10, b: 30 });
    const sx = (hh: number) => plot.m.l + plot.pw - (hh / (maxH || 1)) * plot.pw;
    const sy = (p: number) => plot.m.t + (p + 0.5) * rowH;
    const { ctx } = plot;
    const nodeCluster = new Int32Array(2 * n - 1).fill(-2);
    for (let i = 0; i < n; i++) nodeCluster[i] = clusters[i];
    Z.forEach(([a, b], i) => { nodeCluster[n + i] = nodeCluster[a] === nodeCluster[b] ? nodeCluster[a] : -1; });
    const colorFor = (x: number) => (nodeCluster[x] >= 0 ? discreteColor(nodeCluster[x]) : plot.fg);
    ctx.lineWidth = 1.2;
    Z.forEach(([a, b, d], i) => {
      const x = sx(d);
      ctx.strokeStyle = colorFor(n + i);
      ctx.beginPath();
      ctx.moveTo(sx(height(a)), sy(pos[a])); ctx.lineTo(x, sy(pos[a])); ctx.lineTo(x, sy(pos[b])); ctx.lineTo(sx(height(b)), sy(pos[b]));
      ctx.stroke();
    });
    if (showLabels) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '11px system-ui';
      order.forEach((leaf, k) => { ctx.fillStyle = clusters[leaf] >= 0 ? discreteColor(clusters[leaf]) : plot.fg; ctx.fillText(labelOf(leaf).slice(0, 18), plot.m.l + plot.pw + 6, sy(k)); });
    }
    if (s.selectionMethod === 'height') {
      const x = sx((s.cutRatio / 100) * maxH);
      ctx.strokeStyle = '#ffd34d'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(x, plot.m.t); ctx.lineTo(x, plot.m.t + n * rowH); ctx.stroke(); ctx.setLineDash([]);
    }
    if (s.selectionMethod === 'manual') {
      plot.canvas.style.cursor = 'pointer';
      plot.canvas.addEventListener('click', (ev) => {
        const b = plot.canvas.getBoundingClientRect();
        const mx = ev.clientX - b.left, my = ev.clientY - b.top;
        let best = -1, bestD = 8;
        Z.forEach(([a, bb, d], i) => {
          const x = sx(d), y0 = sy(Math.min(pos[a], pos[bb])), y1 = sy(Math.max(pos[a], pos[bb]));
          if (my >= y0 - 4 && my <= y1 + 4 && Math.abs(mx - x) < bestD) { bestD = Math.abs(mx - x); best = n + i; }
        });
        if (best < 0) { api.update({ manual: [] }); return; }
        const next = ev.shiftKey || ev.ctrlKey ? [...s.manual, best] : [best];
        api.update({ manual: next });
      });
    }
  },
});

/** 선택 방식에 따라 행별 군집 번호(-1 = 선택 안 됨) */
function selectionLabels(Z: LinkageMatrix, n: number, s: HCSettings): Int32Array {
  if (s.selectionMethod === 'topn') return cutTopN(Z, n, Math.min(n, s.topN));
  if (s.selectionMethod === 'height') {
    const maxH = Z.length ? Z[Z.length - 1][2] : 0;
    return cutHeight(Z, n, (s.cutRatio / 100) * maxH);
  }
  const out = new Int32Array(n).fill(-1);
  const leavesOf = (x: number): number[] => {
    const res: number[] = [];
    const st = [x];
    while (st.length) { const y = st.pop()!; if (y < n) res.push(y); else if (y - n < Z.length) st.push(Z[y - n][0], Z[y - n][1]); }
    return res;
  };
  s.manual.filter((x) => x < 2 * n - 1).forEach((node, ci) => { for (const l of leavesOf(node)) out[l] = ci; });
  return out;
}
