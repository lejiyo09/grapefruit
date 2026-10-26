/** Evaluate 카테고리: Test and Score, Predictions, Confusion Matrix, ROC Analysis */
import { registerWidget } from '../engine/registry';
import type { ViewApi } from '../engine/types';
import { type Table, type Column, takeRows } from '../core/table';
import { renderDataTable } from '../ui/datatable';
import { formatNumber } from '../core/stats';
import type { LearnerSpec, Model, Prediction } from '../ml/models';
import { type Results, type Sampling, CLASSIFICATION_METRICS, REGRESSION_METRICS, scoreResults, confusion, rocCurve } from '../ml/evaluate';
import { targetIn } from '../ml/encode';
import { h } from '../ui/dom';
import { box, checkbox, combo, note, radio, emptyMain, button } from '../ui/controls';
import { Plot, discreteColor, plotSize } from '../ui/plot';
import { waiting, tableInput } from './common';

export type ResultsWithData = Results & { data: Table };

const NFOLDS = [2, 3, 5, 10, 20];
const NREPEATS = [2, 3, 5, 10, 20, 50, 100];
const SAMPLE_SIZES = [5, 10, 20, 25, 30, 33, 40, 50, 60, 66, 70, 75, 80, 90, 95];

// ------------------------------------------------------------------ Test and Score
interface TSSettings { resampling: Sampling['method']; nFolds: number; cvStratified: boolean; nRepeats: number; sampleSize: number; shuffleStratified: boolean; target: number }

registerWidget({
  type: 'evaluate.testandscore',
  name: 'Test and Score',
  category: 'evaluate',
  abbr: 'T&S',
  description: '학습기들을 교차검증 등으로 평가하고 성능 지표를 비교합니다.',
  keywords: ['cross validation', 'evaluate', 'accuracy', '교차검증', '평가'],
  inputs: [
    { id: 'data', name: 'Data', type: 'Data', default: true },
    { id: 'testData', name: 'Test Data', type: 'Data' },
    { id: 'learners', name: 'Learner', type: 'Learner', multiple: true, default: true },
  ],
  outputs: [{ id: 'results', name: 'Evaluation Results', type: 'Results', default: true }, { id: 'predictions', name: 'Predictions', type: 'Data' }],
  windowSize: [900, 520],
  // Orange 기본값: 교차검증 5-fold(n_folds 인덱스 2), 층화, 반복 무작위 표본 10회 × 66%
  defaultSettings: (): TSSettings => ({ resampling: 'cv', nFolds: 5, cvStratified: true, nRepeats: 10, sampleSize: 66, shuffleStratified: true, target: -1 }),
  async execute(inputs, s: TSSettings, ctx) {
    const data = tableInput(inputs.data);
    const learners = (inputs.learners as LearnerSpec[]) ?? [];
    if (!data) return waiting(ctx, 'Data를 연결하세요.');
    if (!learners.length) return waiting(ctx, 'Learner(학습기 위젯)를 하나 이상 연결하세요.');
    if (!data.classVar) throw new Error('데이터에 목표 변수가 없습니다. Select Columns에서 Target을 지정하세요.');
    const sampling: Sampling =
      s.resampling === 'cv' ? { method: 'cv', folds: s.nFolds, stratified: s.cvStratified }
        : s.resampling === 'random' ? { method: 'random', repeats: s.nRepeats, trainPct: s.sampleSize, stratified: s.shuffleStratified }
          : { method: s.resampling } as Sampling;
    const testData = tableInput(inputs.testData);
    if (s.resampling === 'test' && !testData) return waiting(ctx, 'Test Data 입력을 연결하세요.');
    if (data.nRows > 20000 && s.resampling !== 'test' && s.resampling !== 'train') ctx.warn('행이 많아 평가에 시간이 오래 걸릴 수 있습니다. 취소 버튼으로 중단할 수 있습니다.');
    const r = await ctx.compute<Results>('crossValidate', { data, learners, sampling, testData });
    const evalData = s.resampling === 'test' ? testData! : data;
    const results: ResultsWithData = { ...r, data: evalData };
    r.errors.forEach((e, i) => { if (e) ctx.warn(`${r.learnerNames[i]}: ${e}`); });
    return { outputs: { results, predictions: predictionsTable(results) }, view: results };
  },
  render({ controls, main }, api: ViewApi<TSSettings>) {
    const s = api.settings;
    controls.appendChild(box('표본 추출',
      radio(api, 'resampling', null, [['cv', '교차검증 (Cross validation)'], ['random', '무작위 표본 반복 (Random sampling)'], ['loo', 'Leave one out'], ['train', '학습 데이터로 평가 (Test on train data)'], ['test', '테스트 데이터로 평가 (Test on test data)']]),
      s.resampling === 'cv' ? combo(api, 'nFolds', '폴드 수', NFOLDS.map((n) => [n, String(n)])) : null,
      s.resampling === 'cv' ? checkbox(api, 'cvStratified', '층화 (Stratified)') : null,
      s.resampling === 'random' ? combo(api, 'nRepeats', '반복 횟수', NREPEATS.map((n) => [n, String(n)])) : null,
      s.resampling === 'random' ? combo(api, 'sampleSize', '학습 데이터 비율', SAMPLE_SIZES.map((n) => [n, `${n} %`])) : null,
      s.resampling === 'random' ? checkbox(api, 'shuffleStratified', '층화 (Stratified)') : null));
    const r = api.view as ResultsWithData | null;
    if (r?.kind === 'classification') {
      controls.appendChild(box('목표 클래스', combo(api, 'target', null, [[-1, '(클래스 평균)'], ...r.classValues!.map((v, i) => [i, v] as [number, string])])));
    }
    if (api.message) controls.appendChild(note(api.message, api.status === 'error' ? 'error' : 'warn'));
    if (!r) { emptyMain(main, api.status === 'running' ? '평가 중…' : api.message || '결과 없음'); return; }
    const metrics = r.kind === 'classification' ? CLASSIFICATION_METRICS : REGRESSION_METRICS;
    const scores = r.learnerNames.map((_, i) => (r.errors[i] ? null : scoreResults(r, i, s.target)));
    const best = metrics.map((mt) => {
      const vals = scores.map((sc) => (sc ? sc[mt] : NaN)).filter((v) => !Number.isNaN(v));
      if (!vals.length) return NaN;
      return ['MSE', 'RMSE', 'MAE'].includes(mt) ? Math.min(...vals) : Math.max(...vals);
    });
    const rowsEl = r.learnerNames.map((name, i) => h('tr', null, h('td', null, name),
      ...(scores[i]
        ? metrics.map((mt, j) => h('td', { class: `num${scores[i]![mt] === best[j] && r.learnerNames.length > 1 ? ' best' : ''}` }, fmt3(scores[i]![mt])))
        : [h('td', { colspan: metrics.length, class: 'err' }, r.errors[i] ?? '')])));
    main.appendChild(h('div', { class: 'main-scroll' },
      h('table', { class: 'grid-table scores' },
        h('thead', null, h('tr', null, h('th', null, 'Model'), ...metrics.map((mt) => h('th', null, mt)))),
        h('tbody', null, ...rowsEl)),
      h('div', { class: 'plot-stat' }, `${r.kind === 'classification' ? '분류' : '회귀'} · 목표: ${r.targetName} · 평가 행 ${r.actual.length.toLocaleString()}`)));
  },
});

/** Orange 점수 표기: 소수 셋째 자리 */
const fmt3 = (v: number) => (Number.isNaN(v) ? '?' : v.toFixed(3));

/**
 * Orange Predictions 표 보기: 모델마다 "0.00 : 1.00 : 0.00 → 클래스" 한 열과 error(1 − 실제 클래스 확률).
 * 회귀는 예측값과 error(|실제 − 예측|). 특징이 50개를 넘으면(이미지 임베딩 등) 표에서는 생략한다.
 */
function predictionDisplay(data: Table, models: Model[], preds: Array<Prediction | null>): Table {
  const n = data.nRows;
  const cols: Column[] = [];
  models.forEach((m, mi) => {
    const p = preds[mi];
    if (!p) return;
    const y = targetIn(data, m.target.name, m.target.classValues);
    if (m.target.kind === 'classification') {
      const cv = m.target.classValues!;
      cols.push({ variable: { name: m.learner.name, kind: 'string' }, data: Array.from({ length: n }, (_, i) => {
        const pr = Array.from({ length: p.k }, (_, c) => p.probs![i * p.k + c].toFixed(2)).join(' : ');
        return `${pr} → ${cv[p.values[i]] ?? '?'}`;
      }) });
      if (y) cols.push({ variable: { name: 'error', kind: 'continuous', decimals: 3 }, data: Float64Array.from({ length: n }, (_, i) => (Number.isNaN(y[i]) ? NaN : 1 - p.probs![i * p.k + y[i]])) });
    } else {
      cols.push({ variable: { name: m.learner.name, kind: 'continuous', decimals: 3 }, data: p.values });
      if (y) cols.push({ variable: { name: 'error', kind: 'continuous', decimals: 3 }, data: Float64Array.from({ length: n }, (_, i) => Math.abs(y[i] - p.values[i])) });
    }
  });
  return { ...data, attributes: data.attributes.length > 50 ? [] : data.attributes, metas: [...cols, ...data.metas] };
}

/** 평가 결과를 원본 데이터 + 예측 열(메타) 테이블로 */
function predictionsTable(r: ResultsWithData): Table {
  const base = takeRows(r.data, r.rowIndices);
  const extra: Column[] = [];
  r.learnerNames.forEach((name, li) => {
    if (r.errors[li]) return;
    if (r.kind === 'classification') {
      extra.push({ variable: { name, kind: 'discrete', values: [...r.classValues!] }, data: Float64Array.from(r.predicted[li]) });
      const K = r.classValues!.length;
      const probs = r.probs[li];
      if (probs) r.classValues!.forEach((cv, k) => extra.push({ variable: { name: `${name} (${cv})`, kind: 'continuous', decimals: 3 }, data: Float64Array.from({ length: r.actual.length }, (_, i) => probs[i * K + k]) }));
    } else extra.push({ variable: { name, kind: 'continuous', decimals: 3 }, data: Float64Array.from(r.predicted[li]) });
  });
  extra.push({ variable: { name: 'Fold', kind: 'continuous', decimals: 0 }, data: Float64Array.from(r.folds, (f) => f + 1) });
  return { ...base, metas: [...base.metas, ...extra] };
}

// ------------------------------------------------------------------ Predictions
registerWidget({
  type: 'evaluate.predictions',
  name: 'Predictions',
  category: 'evaluate',
  abbr: 'Pred',
  description: '학습된 모델로 새 데이터를 예측하고, 목표 값이 있으면 성능도 보여줍니다.',
  keywords: ['predict', 'score', '예측'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }, { id: 'predictors', name: 'Predictors', type: 'Model', multiple: true, default: true }],
  // Orange: Selected Predictions(기본), Predictions, Evaluation Results
  outputs: [{ id: 'selected', name: 'Selected Predictions', type: 'Data', default: true }, { id: 'predictions', name: 'Predictions', type: 'Data' }, { id: 'results', name: 'Evaluation Results', type: 'Results' }],
  windowSize: [960, 560],
  defaultSettings: () => ({ showProbs: true, selection: [] as number[] }),
  async execute(inputs, s: { selection: number[] }, ctx) {
    const data = tableInput(inputs.data);
    const models = (inputs.predictors as Model[]) ?? [];
    if (!data) return waiting(ctx, 'Data를 연결하세요.');
    if (!models.length) return waiting(ctx, 'Predictors(Model 출력)를 연결하세요.');
    const preds: Array<Prediction | null> = [];
    const errors: Array<string | null> = [];
    for (const m of models) {
      try { preds.push(await ctx.compute<Prediction>('predict', { model: m, data })); errors.push(null); } catch (e) {
        if (ctx.signal.aborted) throw e;
        preds.push(null); errors.push((e as Error).message); ctx.warn(`${m.learner.name}: ${(e as Error).message}`);
      }
    }
    const extra: Column[] = [];
    models.forEach((m, i) => {
      const p = preds[i];
      if (!p) return;
      if (m.target.kind === 'classification') {
        extra.push({ variable: { name: m.learner.name, kind: 'discrete', values: [...m.target.classValues!] }, data: p.values });
        m.target.classValues!.forEach((cv, k) => extra.push({ variable: { name: `${m.learner.name} (${cv})`, kind: 'continuous', decimals: 3 }, data: Float64Array.from({ length: data.nRows }, (_, r) => p.probs![r * p.k + k]) }));
      } else extra.push({ variable: { name: m.learner.name, kind: 'continuous', decimals: 3 }, data: p.values });
    });
    const out: Table = { ...data, metas: [...data.metas, ...extra] };
    // 목표 값이 있으면 평가 결과 생성(모든 모델이 같은 목표를 가질 때)
    let results: ResultsWithData | null = null;
    const m0 = models[0];
    const sameTarget = models.every((m) => m.target.name === m0.target.name && m.target.kind === m0.target.kind);
    const y = sameTarget ? targetIn(data, m0.target.name, m0.target.classValues) : null;
    if (y) {
      const keep: number[] = [];
      for (let i = 0; i < y.length; i++) if (!Number.isNaN(y[i])) keep.push(i);
      if (keep.length) {
        const K = m0.target.classValues?.length ?? 0;
        results = {
          kind: m0.target.kind, targetName: m0.target.name, classValues: m0.target.classValues,
          rowIndices: Int32Array.from(keep), actual: Float64Array.from(keep, (i) => y[i]), folds: new Int32Array(keep.length),
          learnerNames: models.map((m) => m.learner.name),
          predicted: preds.map((p) => (p ? Float64Array.from(keep, (i) => p.values[i]) : new Float64Array(keep.length).fill(NaN))),
          probs: preds.map((p) => (p?.probs ? Float64Array.from({ length: keep.length * K }, (_, j) => p.probs![keep[Math.floor(j / K)] * K + (j % K)]) : null)),
          errors, repeated: false, data,
        };
      }
    }
    const sel = (s.selection ?? []).filter((i) => i < out.nRows);
    const display = predictionDisplay(data, models, preds);
    return { outputs: { selected: sel.length ? takeRows(out, sel) : null, predictions: out, results }, view: { out, results, nPred: extra.length, display } };
  },
  render({ controls, main }, api) {
    const v = api.view as { out: Table; results: ResultsWithData | null } | null;
    controls.appendChild(note('예측 열은 메타 변수로 추가되어 출력됩니다.'));
    if (api.message) controls.appendChild(note(api.message, 'warn'));
    if (!v) { emptyMain(main, api.message || '예측 결과가 없습니다.'); return; }
    if (v.results) {
      const r = v.results;
      const metrics = r.kind === 'classification' ? CLASSIFICATION_METRICS : REGRESSION_METRICS;
      main.appendChild(h('table', { class: 'grid-table scores' },
        h('thead', null, h('tr', null, h('th', null, 'Model'), ...metrics.map((m) => h('th', null, m)))),
        h('tbody', null, ...r.learnerNames.map((n, i) => {
          if (r.errors[i]) return h('tr', null, h('td', null, n), h('td', { colspan: metrics.length, class: 'err' }, r.errors[i]!));
          const sc = scoreResults(r, i);
          return h('tr', null, h('td', null, n), ...metrics.map((m) => h('td', { class: 'num' }, fmt3(sc[m]))));
        }))));
    }
    const host = h('div', { class: 'dt-host' });
    main.appendChild(host);
    const shown = (v as { display?: Table }).display ?? v.out;
    if (shown.attributes.length === 0 && v.out.attributes.length > 50) main.appendChild(note(`특징 ${v.out.attributes.length}개는 표에서 생략했습니다(출력에는 포함).`));
    renderDataTable(host, shown, {
      colorByClass: true,
      selected: new Set((api.settings.selection as number[] | undefined) ?? []),
      onSelect: (rows) => api.update({ selection: rows }),
    });
  },
});

// ------------------------------------------------------------------ Confusion Matrix
interface CMSettings { learner: number; quantity: 'count' | 'predicted' | 'actual'; selection: Array<[number, number]>; appendPredictions: boolean }

registerWidget({
  type: 'evaluate.confusionmatrix',
  name: 'Confusion Matrix',
  category: 'evaluate',
  abbr: 'CM',
  description: '실제 클래스와 예측 클래스의 교차표. 칸을 클릭하면 해당 사례를 출력합니다.',
  keywords: ['confusion', 'error matrix', '혼동행렬'],
  inputs: [{ id: 'results', name: 'Evaluation Results', type: 'Results', default: true }],
  outputs: [{ id: 'selected', name: 'Selected Data', type: 'Data', default: true }, { id: 'data', name: 'Data', type: 'Data' }],
  windowSize: [760, 520],
  defaultSettings: (): CMSettings => ({ learner: 0, quantity: 'count', selection: [], appendPredictions: true }),
  execute(inputs, s: CMSettings, ctx) {
    const r = inputs.results as ResultsWithData | null;
    if (!r) return waiting(ctx, 'Evaluation Results를 연결하세요.');
    if (r.kind !== 'classification') throw new Error('Confusion Matrix는 분류 결과에만 사용할 수 있습니다.');
    const li = Math.min(s.learner, r.learnerNames.length - 1);
    const pred = r.predicted[li];
    const sel = new Set(s.selection.map(([a, b]) => `${a},${b}`));
    const rows: number[] = [];
    for (let i = 0; i < r.actual.length; i++) if (sel.has(`${r.actual[i]},${pred[i]}`)) rows.push(i);
    const annotate = (idx: number[]) => {
      const base = takeRows(r.data, idx.map((i) => r.rowIndices[i]));
      if (!s.appendPredictions) return base;
      return { ...base, metas: [...base.metas, { variable: { name: r.learnerNames[li], kind: 'discrete' as const, values: [...r.classValues!] }, data: Float64Array.from(idx, (i) => pred[i]) }] };
    };
    return { outputs: { selected: rows.length ? annotate(rows) : null, data: annotate(Array.from({ length: r.actual.length }, (_, i) => i)) } };
  },
  render({ controls, main }, api: ViewApi<CMSettings>) {
    const r = api.inputs.results as ResultsWithData | null;
    if (!r || r.kind !== 'classification') { emptyMain(main, api.message || '분류 평가 결과가 없습니다.'); return; }
    const s = api.settings;
    controls.appendChild(box('학습기', combo(api, 'learner', null, r.learnerNames.map((n, i) => [i, n]))));
    controls.appendChild(box('표시 값', radio(api, 'quantity', null, [['count', '사례 수'], ['actual', '실제 클래스 대비 비율'], ['predicted', '예측 클래스 대비 비율']])));
    controls.appendChild(box('선택', button('정답 선택', () => api.update({ selection: r.classValues!.map((_, i) => [i, i] as [number, number]) })),
      button('오답 선택', () => api.update({ selection: r.classValues!.flatMap((_, a) => r.classValues!.map((__, b) => [a, b] as [number, number]).filter(([x, y]) => x !== y)) })),
      button('선택 해제', () => api.update({ selection: [] })), checkbox(api, 'appendPredictions', '출력에 예측 열 추가')));
    const li = Math.min(s.learner, r.learnerNames.length - 1);
    if (r.errors[li]) { emptyMain(main, r.errors[li]!); return; }
    const K = r.classValues!.length;
    const cm = confusion(r.actual, r.predicted[li], K);
    const rowT = cm.map((row) => row.reduce((a, b) => a + b, 0));
    const colT = cm[0].map((_, j) => cm.reduce((a, row) => a + row[j], 0));
    const sel = new Set(s.selection.map(([a, b]) => `${a},${b}`));
    const maxCell = Math.max(1, ...cm.flat());
    const cell = (a: number, b: number) => {
      const v = cm[a][b];
      const txt = s.quantity === 'count' ? String(v) : s.quantity === 'actual' ? `${rowT[a] ? ((v / rowT[a]) * 100).toFixed(1) : '0'} %` : `${colT[b] ? ((v / colT[b]) * 100).toFixed(1) : '0'} %`;
      const intensity = v / maxCell;
      const bg = a === b ? `rgba(80,200,120,${0.12 + 0.6 * intensity})` : `rgba(240,90,80,${0.08 + 0.6 * intensity})`;
      return h('td', {
        class: `cm-cell${sel.has(`${a},${b}`) ? ' sel' : ''}`, style: `background:${bg}`,
        onclick: (ev: MouseEvent) => {
          const next = ev.shiftKey || ev.ctrlKey ? new Set(sel) : new Set<string>();
          const key = `${a},${b}`;
          if (next.has(key)) next.delete(key); else next.add(key);
          api.update({ selection: [...next].map((k) => k.split(',').map(Number) as [number, number]) });
        },
      }, txt);
    };
    main.appendChild(h('div', { class: 'main-scroll' },
      h('div', { class: 'cm-caption' }, '예측 (Predicted) →'),
      h('table', { class: 'cm-table' },
        h('thead', null, h('tr', null, h('th', { class: 'cm-corner' }, '실제 ↓'), ...r.classValues!.map((v) => h('th', null, v)), h('th', null, 'Σ'))),
        h('tbody', null,
          ...r.classValues!.map((v, a) => h('tr', null, h('th', null, v), ...r.classValues!.map((_, b) => cell(a, b)), h('td', { class: 'cm-sum' }, String(rowT[a])))),
          h('tr', null, h('th', null, 'Σ'), ...colT.map((c) => h('td', { class: 'cm-sum' }, String(c))), h('td', { class: 'cm-sum' }, String(rowT.reduce((x, y) => x + y, 0))))))));
  },
});

// ------------------------------------------------------------------ ROC Analysis
registerWidget({
  type: 'evaluate.roc',
  name: 'ROC Analysis',
  category: 'evaluate',
  abbr: 'ROC',
  description: '분류기의 ROC 곡선과 AUC를 그립니다.',
  keywords: ['roc', 'auc', 'curve'],
  inputs: [{ id: 'results', name: 'Evaluation Results', type: 'Results', default: true }],
  outputs: [],
  windowSize: [820, 600],
  defaultSettings: () => ({ target: 0, showDiagonal: true }),
  execute(inputs, _s, ctx) {
    const r = inputs.results as Results | null;
    if (!r) return waiting(ctx, 'Evaluation Results를 연결하세요.');
    if (r.kind !== 'classification') throw new Error('ROC Analysis는 분류 결과에만 사용할 수 있습니다.');
    return { outputs: {} };
  },
  render({ controls, main }, api) {
    const r = api.inputs.results as Results | null;
    if (!r || r.kind !== 'classification') { emptyMain(main, '분류 평가 결과가 없습니다.'); return; }
    const target = Math.min(Number(api.settings.target), r.classValues!.length - 1);
    controls.appendChild(box('목표 클래스', combo(api, 'target', null, r.classValues!.map((v, i) => [i, v]))));
    controls.appendChild(box('표시', checkbox(api, 'showDiagonal', '대각선(무작위 분류기)')));
    const [W, H] = plotSize(main, 360);
    const size = Math.min(W - 60, H);
    const wrap = h('div', { class: 'plot-wrap' });
    main.appendChild(wrap);
    const p = new Plot(wrap, size + 60, size, { r: 16 });
    p.axes({ lo: 0, hi: 1, label: 'FP Rate (1-Specificity)' }, { lo: 0, hi: 1, label: 'TP Rate (Sensitivity)' });
    const sx = p.scaleX(0, 1), sy = p.scaleY(0, 1);
    const { ctx } = p;
    if (api.settings.showDiagonal) { ctx.setLineDash([4, 4]); ctx.strokeStyle = p.grid; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(sx(0), sy(0)); ctx.lineTo(sx(1), sy(1)); ctx.stroke(); ctx.setLineDash([]); }
    const legend: Array<{ label: string; color: string }> = [];
    r.learnerNames.forEach((name, li) => {
      if (!r.probs[li] || r.errors[li]) return;
      const roc = rocCurve(r, li, target);
      ctx.strokeStyle = discreteColor(li); ctx.lineWidth = 2;
      ctx.beginPath();
      roc.fpr.forEach((f, k) => (k ? ctx.lineTo(sx(f), sy(roc.tpr[k])) : ctx.moveTo(sx(f), sy(roc.tpr[k]))));
      ctx.stroke();
      legend.push({ label: `${name} (AUC ${formatNumber(roc.auc, 3)})`, color: discreteColor(li) });
    });
    p.legend(legend, p.m.l + p.pw - 230, p.m.t + p.ph - legend.length * 18 - 16);
  },
});

