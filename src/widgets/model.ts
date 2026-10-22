/** Model 카테고리: Constant, kNN, Tree, Random Forest, Logistic Regression, Linear Regression, Naive Bayes, Tree Viewer */
import { registerWidget } from '../engine/registry';
import type { ViewApi, WidgetDef } from '../engine/types';
import { type Table, makeTable } from '../core/table';
import { formatNumber } from '../core/stats';
import type { LearnerSpec, LearnerType, Model } from '../ml/models';
import { describeModel } from '../ml/models';
import { type TreeNode, treeDepth, treeSize } from '../ml/tree';
import { h } from '../ui/dom';
import { box, checkbox, combo, note, radio, spin, textInput, emptyMain, row } from '../ui/controls';
import { discreteColor } from '../ui/plot';
import { tableInput } from './common';

interface LearnerWidgetOpts<S> {
  type: string;
  learner: LearnerType;
  name: string;
  abbr: string;
  description: string;
  keywords?: string[];
  defaults: S;
  params: (s: S) => Record<string, unknown>;
  controls: (el: HTMLElement, api: ViewApi<S & { learnerName: string }>) => void;
  /** 모델이 있을 때 추가 출력 */
  extraOutputs?: WidgetDef['outputs'];
  extra?: (m: Model) => Record<string, unknown>;
  main?: (el: HTMLElement, m: Model) => void;
}

/**
 * Orange의 학습기 위젯 공통 구조: Data 입력(선택) → Learner 출력은 항상, Model 출력은 데이터가 있을 때.
 */
function learnerWidget<S extends object>(o: LearnerWidgetOpts<S>): void {
  registerWidget({
    type: o.type,
    name: o.name,
    category: 'model',
    abbr: o.abbr,
    description: o.description,
    keywords: o.keywords,
    inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
    outputs: [{ id: 'learner', name: 'Learner', type: 'Learner', default: true }, { id: 'model', name: 'Model', type: 'Model' }, ...(o.extraOutputs ?? [])],
    windowSize: o.main ? [760, 520] : [420, 520],
    controlsOnly: !o.main,
    defaultSettings: () => ({ learnerName: o.name, ...structuredClone(o.defaults) }),
    async execute(inputs, s: S & { learnerName: string }, ctx) {
      const spec: LearnerSpec = { type: o.learner, name: s.learnerName || o.name, params: o.params(s) };
      const data = tableInput(inputs.data);
      if (!data) return { outputs: { learner: spec, model: null } };
      const model = await ctx.compute<Model>('fit', { learner: spec, data });
      return { outputs: { learner: spec, model, ...(o.extra ? o.extra(model) : {}) }, view: model };
    },
    render({ controls, main }, api) {
      controls.appendChild(box('이름', textInput(api, 'learnerName', '학습기 이름')));
      o.controls(controls, api as ViewApi<S & { learnerName: string }>);
      const m = api.view as Model | null;
      controls.appendChild(box('모델', h('div', { class: 'info-text' }, m ? describeModel(m) : api.status === 'error' ? '' : 'Data를 연결하면 모델을 학습해 Model로 출력합니다. Learner 출력은 Test and Score에 연결하세요.')));
      if (api.status === 'error') controls.appendChild(note(api.message, 'error'));
      if (o.main) { if (m) o.main(main, m); else emptyMain(main, '학습된 모델이 없습니다.'); }
    },
  });
}

// Constant
learnerWidget({
  type: 'model.constant', learner: 'constant', name: 'Constant', abbr: 'Cst',
  description: '항상 최빈 클래스(분류) 또는 평균(회귀)을 예측하는 기준 모델.',
  keywords: ['baseline', 'majority', 'mean'],
  defaults: {}, params: () => ({}),
  controls: (el) => el.appendChild(note('분류: 학습 데이터의 클래스 분포를 예측합니다. 회귀: 평균값을 예측합니다.')),
});

// kNN — Orange 기본값: 이웃 5, Euclidean, Uniform
learnerWidget({
  type: 'model.knn', learner: 'knn', name: 'kNN', abbr: 'kNN',
  description: '가장 가까운 k개 학습 사례로 예측합니다.',
  keywords: ['nearest neighbors', 'k-nearest'],
  defaults: { nNeighbors: 5, metric: 'euclidean', weights: 'uniform' },
  params: (s) => ({ ...s }),
  controls: (el, api) => el.appendChild(box('이웃',
    spin(api, 'nNeighbors', '이웃 수', 1, 100),
    combo(api, 'metric', '거리', [['euclidean', 'Euclidean'], ['manhattan', 'Manhattan'], ['chebyshev', 'Chebyshev'], ['cosine', 'Cosine']]),
    combo(api, 'weights', '가중치', [['uniform', 'Uniform'], ['distance', 'By Distances']]))),
});

// Tree — Orange 기본값: 이진 트리, 잎 최소 2, 분할 최소 5, 최대 깊이 100, 다수 클래스 95%에서 중단
learnerWidget({
  type: 'model.tree', learner: 'tree', name: 'Tree', abbr: 'Tree',
  description: '조건 분기로 이루어진 의사결정나무. Tree Viewer로 구조를 볼 수 있습니다.',
  keywords: ['decision tree', '의사결정나무'],
  defaults: { limitMinLeaf: true, minLeaf: 2, limitMinInternal: true, minInternal: 5, limitDepth: true, maxDepth: 100, limitMajority: true, sufficientMajority: 95 },
  params: (s) => ({ ...s }),
  controls: (el, api) => el.appendChild(box('매개변수',
    checkbox(api, 'limitMinLeaf', '잎의 최소 사례 수 제한'), spin(api, 'minLeaf', '잎 최소 사례 수', 1, 1000),
    checkbox(api, 'limitMinInternal', '이보다 작은 부분집합은 분할하지 않음'), spin(api, 'minInternal', '분할 최소 사례 수', 1, 1000),
    checkbox(api, 'limitDepth', '최대 깊이 제한'), spin(api, 'maxDepth', '최대 깊이', 1, 1000),
    checkbox(api, 'limitMajority', '다수 클래스 비율에 도달하면 중단 (분류)'), spin(api, 'sufficientMajority', '비율 (%)', 51, 100))),
  main: (el, m) => {
    if (m.type !== 'tree') return;
    const sz = treeSize(m.root);
    el.appendChild(h('table', { class: 'kv-table' },
      h('tr', null, h('th', null, '노드 수'), h('td', null, String(sz.nodes))),
      h('tr', null, h('th', null, '잎 수'), h('td', null, String(sz.leaves))),
      h('tr', null, h('th', null, '깊이'), h('td', null, String(treeDepth(m.root))))));
    el.appendChild(note('Model 출력을 Tree Viewer에 연결하면 나무를 그림으로 볼 수 있습니다.'));
  },
});

// Random Forest — Orange 기본값: 트리 10개, 분할 최소 5, 깊이 제한 없음, 특징 수 자동(√p)
learnerWidget({
  type: 'model.forest', learner: 'forest', name: 'Random Forest', abbr: 'RF',
  description: '부트스트랩 표본으로 만든 여러 트리의 투표/평균으로 예측합니다.',
  keywords: ['random forest', 'ensemble', '랜덤 포레스트'],
  defaults: { nEstimators: 10, useMaxFeatures: false, maxFeatures: 5, useRandomState: false, useMaxDepth: false, maxDepth: 3, useMinSamplesSplit: true, minSamplesSplit: 5 },
  params: (s) => ({ ...s }),
  controls: (el, api) => {
    el.appendChild(box('기본 속성', spin(api, 'nEstimators', '트리 수', 1, 500),
      checkbox(api, 'useMaxFeatures', '각 분할에서 고려할 특징 수 지정'), spin(api, 'maxFeatures', '특징 수', 1, 1000),
      checkbox(api, 'useRandomState', '재현 가능한 학습 (고정 시드)')));
    el.appendChild(box('성장 제어', checkbox(api, 'useMaxDepth', '최대 깊이 제한'), spin(api, 'maxDepth', '최대 깊이', 1, 100),
      checkbox(api, 'useMinSamplesSplit', '이보다 작은 부분집합은 분할하지 않음'), spin(api, 'minSamplesSplit', '최소 사례 수', 2, 1000)));
    if (Number(api.settings.nEstimators) > 100) el.appendChild(note('트리가 많으면 저사양 기기에서 메모리와 시간이 많이 듭니다.', 'warn'));
  },
});

// Logistic Regression — Orange 기본값: Ridge(L2), C=1
const C_VALUES = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 0.7, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
learnerWidget({
  type: 'model.logreg', learner: 'logreg', name: 'Logistic Regression', abbr: 'LR',
  description: '정규화된 로지스틱 회귀 분류기. 계수(Coefficients)를 출력합니다.',
  keywords: ['logistic', 'classification', '로지스틱'],
  defaults: { penalty: 'l2', C: 1 },
  params: (s) => ({ ...s }),
  controls: (el, api) => el.appendChild(box('정규화',
    radio(api, 'penalty', null, [['l1', 'Lasso (L1)'], ['l2', 'Ridge (L2)'], ['none', '없음']]),
    api.settings.penalty !== 'none' ? combo(api, 'C', '강도 C', C_VALUES.map((c) => [c, `C = ${c}`])) : null,
    note('C가 작을수록 정규화가 강해집니다.'))),
  extraOutputs: [{ id: 'coefficients', name: 'Coefficients', type: 'Data' }],
  extra: (m) => ({ coefficients: coefTable(m) }),
  main: (el, m) => renderCoefs(el, m),
});

// Linear Regression — Orange 기본값: 정규화 없음(OLS), alpha 0.0001, 절편 포함
const ALPHAS = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000];
learnerWidget({
  type: 'model.linreg', learner: 'linreg', name: 'Linear Regression', abbr: 'LinR',
  description: '최소제곱 선형 회귀(Ridge, Lasso, Elastic net 정규화 선택 가능).',
  keywords: ['linear', 'regression', 'ols', 'ridge', 'lasso', '회귀'],
  defaults: { reg: 'ols', alpha: 0.0001, l1Ratio: 0.5, fitIntercept: true },
  params: (s) => ({ ...s }),
  controls: (el, api) => el.appendChild(box('정규화',
    radio(api, 'reg', null, [['ols', '없음 (OLS)'], ['ridge', 'Ridge (L2)'], ['lasso', 'Lasso (L1)'], ['elastic', 'Elastic net']]),
    api.settings.reg !== 'ols' ? combo(api, 'alpha', 'Alpha', ALPHAS.map((a) => [a, String(a)])) : null,
    api.settings.reg === 'elastic' ? spin(api, 'l1Ratio', 'L1 비율', 0, 1, 0.05) : null,
    checkbox(api, 'fitIntercept', '절편 학습'))),
  extraOutputs: [{ id: 'coefficients', name: 'Coefficients', type: 'Data' }],
  extra: (m) => ({ coefficients: coefTable(m) }),
  main: (el, m) => renderCoefs(el, m),
});

// Naive Bayes
learnerWidget({
  type: 'model.naivebayes', learner: 'naivebayes', name: 'Naive Bayes', abbr: 'NB',
  description: '변수 독립을 가정한 베이즈 분류기. 수치형 변수는 등빈도 4구간으로 이산화합니다(Orange 방식).',
  keywords: ['bayes', 'probabilistic', '베이즈'],
  defaults: {}, params: () => ({}),
  controls: (el) => el.appendChild(note('설정할 매개변수가 없습니다. 분류 문제에만 사용할 수 있습니다.')),
});

function coefTable(m: Model): Table | null {
  const rows = coefRows(m);
  if (!rows) return null;
  const cols = rows.header.map((name, j) => ({ variable: { name, kind: 'continuous' as const, decimals: 4 }, data: Float64Array.from(rows.rows, (r) => r.values[j]) }));
  return makeTable('Coefficients', cols, null, [{ variable: { name: 'name', kind: 'string' }, data: rows.rows.map((r) => r.name) }]);
}

function coefRows(m: Model): { header: string[]; rows: Array<{ name: string; values: number[] }> } | null {
  if (m.type === 'linreg') {
    return { header: ['coef'], rows: [{ name: 'intercept', values: [m.intercept] }, ...m.enc.outNames.map((n, j) => ({ name: n, values: [m.coef[j]] }))] };
  }
  if (m.type === 'logreg') {
    const cls = m.target.classValues!;
    const header = m.binary ? [cls[1]] : cls;
    const k = m.k, p = m.p;
    const at = (c: number, j: number) => m.W[c * (p + 1) + j];
    return {
      header,
      rows: [{ name: 'intercept', values: header.map((_, c) => at(c, p)) }, ...m.enc.outNames.map((n, j) => ({ name: n, values: Array.from({ length: k }, (_, c) => at(c, j)) }))],
    };
  }
  return null;
}

function renderCoefs(el: HTMLElement, m: Model): void {
  const rows = coefRows(m);
  if (!rows) return;
  el.appendChild(h('div', { class: 'main-scroll' }, h('table', { class: 'grid-table' },
    h('thead', null, h('tr', null, h('th', null, '변수'), ...rows.header.map((x) => h('th', null, x)))),
    h('tbody', null, ...rows.rows.map((r) => h('tr', null, h('td', null, r.name), ...r.values.map((v) => h('td', { class: 'num' }, formatNumber(v, 4)))))))));
}

// ------------------------------------------------------------------ Tree Viewer
registerWidget({
  type: 'visualize.treeviewer',
  name: 'Tree Viewer',
  category: 'visualize',
  abbr: 'TV',
  description: 'Tree 모델의 분기 구조를 그림으로 보여줍니다.',
  keywords: ['tree', 'visualize'],
  inputs: [{ id: 'tree', name: 'Tree', type: 'Model', default: true }],
  outputs: [],
  windowSize: [960, 620],
  defaultSettings: () => ({ maxDepth: 4 }),
  execute(inputs, _s, ctx) {
    const m = inputs.tree as Model | null;
    if (!m) { ctx.info('Tree 모델을 연결하세요.'); return { outputs: {} }; }
    if (m.type !== 'tree') throw new Error('Tree Viewer는 Tree 위젯의 Model만 표시할 수 있습니다.');
    return { outputs: {} };
  },
  render({ controls, main }, api) {
    const m = api.inputs.tree as Model | null;
    controls.appendChild(box('표시', row('최대 깊이', (() => {
      const sel = h('select', null, ...[2, 3, 4, 5, 6, 8, 10, 100].map((d) => h('option', { value: String(d) }, d === 100 ? '전체' : String(d))));
      sel.value = String(api.settings.maxDepth);
      sel.addEventListener('change', () => api.update({ maxDepth: Number(sel.value) }));
      return sel;
    })())));
    if (!m || m.type !== 'tree') { emptyMain(main, 'Tree 모델이 없습니다.'); return; }
    const sz = treeSize(m.root);
    controls.appendChild(box('정보', h('div', { class: 'info-text' }, `노드 ${sz.nodes} · 잎 ${sz.leaves} · 깊이 ${treeDepth(m.root)}`)));
    const isCls = m.target.kind === 'classification';
    const cv = m.target.classValues ?? [];
    const maxD = Number(api.settings.maxDepth);
    // 레이아웃: 잎 순서대로 x, 깊이로 y
    type Pos = { node: TreeNode; x: number; y: number; label: string; cond: string };
    const items: Pos[] = [];
    const edges: Array<[Pos, Pos]> = [];
    let leafX = 0;
    const condText = (parent: TreeNode & { leaf: false }, left: boolean) => {
      const f = m.feats[parent.feature];
      if (parent.threshold !== undefined) return `${left ? '≤' : '>'} ${formatNumber(parent.threshold, 3)}`;
      const v = f.values![parent.equals!];
      return left ? `= ${v}` : `≠ ${v}`;
    };
    const lay = (node: TreeNode, depth: number, cond: string): Pos => {
      const label = node.leaf || depth >= maxD ? '' : m.feats[node.feature].name;
      if (node.leaf || depth >= maxD) {
        const pos = { node, x: leafX++, y: depth, label, cond };
        items.push(pos); return pos;
      }
      const l = lay(node.left, depth + 1, condText(node, true));
      const r = lay(node.right, depth + 1, condText(node, false));
      const pos = { node, x: (l.x + r.x) / 2, y: depth, label, cond };
      items.push(pos); edges.push([pos, l], [pos, r]);
      return pos;
    };
    lay(m.root, 0, '');
    const NW = 150, NH = 64, GX = 18, GY = 50;
    const width = leafX * (NW + GX) + 40, height = (Math.max(...items.map((i) => i.y)) + 1) * (NH + GY) + 40;
    const svgNs = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(svgNs, 'svg');
    svgEl.setAttribute('width', String(width)); svgEl.setAttribute('height', String(height)); svgEl.setAttribute('class', 'tree-svg');
    const cx = (p: Pos) => 20 + p.x * (NW + GX) + NW / 2;
    const cy = (p: Pos) => 20 + p.y * (NH + GY);
    for (const [a, b] of edges) {
      const path = document.createElementNS(svgNs, 'path');
      path.setAttribute('d', `M${cx(a)},${cy(a) + NH} C${cx(a)},${cy(a) + NH + GY / 2} ${cx(b)},${cy(b) - GY / 2} ${cx(b)},${cy(b)}`);
      path.setAttribute('class', 'tree-edge');
      path.setAttribute('stroke-width', String(1 + 6 * (b.node.n / m.root.n)));
      svgEl.appendChild(path);
      const txt = document.createElementNS(svgNs, 'text');
      txt.setAttribute('x', String((cx(a) + cx(b)) / 2)); txt.setAttribute('y', String(cy(b) - 8)); txt.setAttribute('class', 'tree-cond');
      txt.textContent = b.cond;
      svgEl.appendChild(txt);
    }
    for (const it of items) {
      const g = document.createElementNS(svgNs, 'g');
      const x = cx(it) - NW / 2, y = cy(it);
      const rect = document.createElementNS(svgNs, 'rect');
      rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y)); rect.setAttribute('width', String(NW)); rect.setAttribute('height', String(NH)); rect.setAttribute('rx', '6');
      rect.setAttribute('class', 'tree-node');
      g.appendChild(rect);
      const node = it.node;
      const lines: string[] = [];
      if (isCls) {
        const tot = node.dist.reduce((a, b) => a + b, 0) || 1;
        lines.push(`${cv[node.value]}`, `${((node.dist[node.value] / tot) * 100).toFixed(1)}% · ${node.n}건`);
        // 클래스 분포 막대
        let acc = 0;
        node.dist.forEach((d, k) => {
          const bar = document.createElementNS(svgNs, 'rect');
          bar.setAttribute('x', String(x + 6 + (acc / tot) * (NW - 12))); bar.setAttribute('y', String(y + NH - 12));
          bar.setAttribute('width', String((d / tot) * (NW - 12))); bar.setAttribute('height', '6');
          bar.setAttribute('fill', discreteColor(k));
          g.appendChild(bar); acc += d;
        });
      } else lines.push(`${formatNumber(node.value, 3)}`, `${node.n}건`);
      if (it.label) lines.push(it.label);
      lines.forEach((l, k) => {
        const t = document.createElementNS(svgNs, 'text');
        t.setAttribute('x', String(x + NW / 2)); t.setAttribute('y', String(y + 16 + k * 15));
        t.setAttribute('class', k === 2 ? 'tree-split' : 'tree-text');
        t.textContent = l.length > 22 ? l.slice(0, 21) + '…' : l;
        g.appendChild(t);
      });
      svgEl.appendChild(g);
    }
    const scroller = h('div', { class: 'main-scroll tree-scroll' }, svgEl);
    main.appendChild(scroller);
    // 처음 열 때 뿌리 노드가 보이도록 가로 스크롤을 맞춘다(사용자가 스크롤한 위치는 창이 복원)
    const rootPos = items[items.length - 1];
    requestAnimationFrame(() => { if (scroller.scrollLeft === 0) scroller.scrollLeft = Math.max(0, cx(rootPos) - scroller.clientWidth / 2); });
  },
});
