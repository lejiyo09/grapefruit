/**
 * Test and Score 위젯의 평가 로직.
 * Orange 기본값: 교차검증 5-fold, 층화(stratified), random_state=0.
 */
import { type Table, rowsWithClass, takeRows } from '../core/table';
import { getTarget, targetIn, type TargetKind } from './encode';
import { type LearnerSpec, fit, predict, supports } from './models';
import { Rng, range } from './random';

export type Sampling =
  | { method: 'cv'; folds: number; stratified: boolean }
  | { method: 'random'; repeats: number; trainPct: number; stratified: boolean }
  | { method: 'loo' }
  | { method: 'train' }
  | { method: 'test' };

export interface Results {
  kind: TargetKind;
  targetName: string;
  classValues?: string[];
  /** 평가에 사용된 원본 데이터의 행 인덱스 */
  rowIndices: Int32Array;
  actual: Float64Array;
  folds: Int32Array;
  learnerNames: string[];
  predicted: Float64Array[];
  probs: (Float64Array | null)[];
  errors: (string | null)[];
  /** 반복 평가(random sampling)에서는 같은 행이 여러 번 등장할 수 있다 */
  repeated: boolean;
}

function stratifiedFolds(y: Float64Array, k: number, rng: Rng, stratified: boolean): Int32Array {
  const n = y.length;
  const folds = new Int32Array(n);
  if (!stratified) {
    const idx = range(n); rng.shuffle(idx);
    // scikit-learn KFold: 앞쪽 n % k개 폴드가 한 개씩 더 많다
    let pos = 0;
    for (let f = 0; f < k; f++) {
      const size = Math.floor(n / k) + (f < n % k ? 1 : 0);
      for (let a = 0; a < size; a++) folds[idx[pos++]] = f;
    }
    return folds;
  }
  const byClass = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const c = y[i]; if (!byClass.has(c)) byClass.set(c, []); byClass.get(c)!.push(i); }
  let offset = 0;
  for (const [, rows] of [...byClass.entries()].sort((a, b) => a[0] - b[0])) {
    rng.shuffle(rows);
    rows.forEach((r, j) => { folds[r] = (j + offset) % k; });
    offset += rows.length;
  }
  return folds;
}

export function crossValidate(
  data: Table, learners: LearnerSpec[], sampling: Sampling, testData?: Table | null,
  onProgress?: (p: number) => void, signal?: { aborted: boolean },
): Results {
  const target = getTarget(data);
  const rows = rowsWithClass(data);
  const t = takeRows(data, rows);
  const y = getTarget(t).y;
  const n = t.nRows;
  if (n < 2) throw new Error('평가하려면 목표 값이 있는 행이 2개 이상 필요합니다.');
  const rng = new Rng(0);

  type Split = { train: Int32Array; test: Int32Array; fold: number };
  const splits: Split[] = [];
  let evalTable = t;
  let evalRows = rows;
  let repeated = false;

  if (sampling.method === 'cv') {
    const k = Math.min(sampling.folds, n);
    if (sampling.stratified && target.kind === 'classification') {
      const counts = new Map<number, number>();
      for (let i = 0; i < n; i++) counts.set(y[i], (counts.get(y[i]) ?? 0) + 1);
      const minCount = Math.min(...counts.values());
      if (minCount < k) {
        // scikit-learn도 경고를 내지만 진행한다
      }
    }
    const folds = stratifiedFolds(y, k, rng, sampling.stratified && target.kind === 'classification');
    for (let f = 0; f < k; f++) {
      const tr: number[] = [], te: number[] = [];
      for (let i = 0; i < n; i++) (folds[i] === f ? te : tr).push(i);
      splits.push({ train: Int32Array.from(tr), test: Int32Array.from(te), fold: f });
    }
  } else if (sampling.method === 'loo') {
    if (n > 2000) throw new Error('Leave-one-out은 2,000행 이하에서만 실행합니다(저사양 기기 보호). 교차검증을 사용하세요.');
    for (let i = 0; i < n; i++) {
      const tr = new Int32Array(n - 1);
      for (let a = 0, b = 0; a < n; a++) if (a !== i) tr[b++] = a;
      splits.push({ train: tr, test: Int32Array.of(i), fold: i });
    }
  } else if (sampling.method === 'random') {
    repeated = true;
    const nTrain = Math.max(1, Math.round((n * sampling.trainPct) / 100));
    for (let r = 0; r < sampling.repeats; r++) {
      const idx = range(n); rng.shuffle(idx);
      let order = Array.from(idx);
      if (sampling.stratified && target.kind === 'classification') {
        const folds = stratifiedFolds(y, Math.max(2, Math.round(n / Math.max(1, n - nTrain))), rng, true);
        order = Array.from(idx).sort((a, b) => folds[a] - folds[b]);
        order = [...order.slice(order.length - nTrain), ...order.slice(0, order.length - nTrain)];
      }
      splits.push({ train: Int32Array.from(order.slice(0, nTrain)), test: Int32Array.from(order.slice(nTrain)), fold: r });
    }
  } else if (sampling.method === 'train') {
    splits.push({ train: range(n), test: range(n), fold: 0 });
  } else {
    if (!testData) throw new Error('"Test on test data"를 사용하려면 Test Data 입력을 연결하세요.');
    const ty = targetIn(testData, target.name, target.classValues);
    if (!ty) throw new Error(`테스트 데이터에 목표 변수 '${target.name}'이(가) 없습니다.`);
    const keep: number[] = [];
    for (let i = 0; i < ty.length; i++) if (!Number.isNaN(ty[i])) keep.push(i);
    evalTable = takeRows(testData, keep);
    evalRows = Int32Array.from(keep);
    splits.push({ train: range(n), test: range(evalTable.nRows), fold: 0 });
  }

  const testY = sampling.method === 'test' ? targetIn(evalTable, target.name, target.classValues)! : y;
  const total = splits.reduce((s, sp) => s + sp.test.length, 0);
  const rowIndices = new Int32Array(total);
  const actual = new Float64Array(total);
  const foldsOut = new Int32Array(total);
  {
    let pos = 0;
    for (const sp of splits) for (let a = 0; a < sp.test.length; a++) {
      const r = sp.test[a];
      rowIndices[pos] = evalRows[r]; actual[pos] = testY[r]; foldsOut[pos] = sp.fold; pos++;
    }
  }
  const K = target.classValues?.length ?? 0;
  const predicted: Float64Array[] = [];
  const probs: (Float64Array | null)[] = [];
  const errors: (string | null)[] = [];
  let done = 0;
  const work = learners.length * splits.length;
  for (const spec of learners) {
    const pv = new Float64Array(total).fill(NaN);
    const pp = target.kind === 'classification' ? new Float64Array(total * K) : null;
    let err: string | null = null;
    if (!supports(spec.type, target.kind)) err = `${target.kind === 'classification' ? '분류' : '회귀'}를 지원하지 않는 학습기`;
    else {
      try {
        let pos = 0;
        for (const sp of splits) {
          if (signal?.aborted) throw new Error('취소됨');
          const model = fit(spec, takeRows(t, sp.train), { signal });
          const pred = predict(model, takeRows(evalTable, sp.test));
          pv.set(pred.values, pos);
          if (pp && pred.probs) pp.set(pred.probs, pos * K);
          pos += sp.test.length;
          onProgress?.(++done / work);
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        err = (e as Error).message;
      }
    }
    predicted.push(pv); probs.push(pp); errors.push(err);
  }
  return {
    kind: target.kind, targetName: target.name, classValues: target.classValues,
    rowIndices, actual, folds: foldsOut, learnerNames: learners.map((l) => l.name),
    predicted, probs, errors, repeated,
  };
}

// ---------------- 지표 ----------------

export interface Scores { [metric: string]: number }

export const CLASSIFICATION_METRICS = ['AUC', 'CA', 'F1', 'Prec', 'Recall', 'MCC'] as const;
export const REGRESSION_METRICS = ['MSE', 'RMSE', 'MAE', 'R2'] as const;

export function aucBinary(scores: ArrayLike<number>, positive: ArrayLike<boolean>): number {
  const n = scores.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0, nPos = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let a = i; a <= j; a++) if (positive[idx[a]]) { rankSum += avg; nPos++; }
    i = j + 1;
  }
  const nNeg = n - nPos;
  if (!nPos || !nNeg) return NaN;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export function confusion(actual: Float64Array, pred: Float64Array, K: number): number[][] {
  const m = Array.from({ length: K }, () => new Array<number>(K).fill(0));
  for (let i = 0; i < actual.length; i++) if (!Number.isNaN(pred[i])) m[actual[i]][pred[i]]++;
  return m;
}

/**
 * target = -1 이면 Orange의 "(Average over classes)": 클래스 비율 가중 평균.
 * 이진 분류에서 target을 지정하지 않으면 Orange처럼 두 번째 클래스를 양성으로 본다.
 */
export function classificationScores(r: Results, li: number, target = -1): Scores {
  const K = r.classValues!.length;
  const pred = r.predicted[li];
  const probs = r.probs[li];
  const n = r.actual.length;
  const cm = confusion(r.actual, pred, K);
  let correct = 0;
  for (let c = 0; c < K; c++) correct += cm[c][c];
  const support = cm.map((row) => row.reduce((a, b) => a + b, 0));
  const perClass = (c: number) => {
    const tp = cm[c][c];
    let fp = 0; for (let a = 0; a < K; a++) if (a !== c) fp += cm[a][c];
    const fn = support[c] - tp;
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    let auc = NaN;
    if (probs) {
      const s = new Float64Array(n);
      const pos = new Array<boolean>(n);
      for (let i = 0; i < n; i++) { s[i] = probs[i * K + c]; pos[i] = r.actual[i] === c; }
      auc = aucBinary(s, pos);
    }
    return { prec, rec, f1, auc };
  };
  let prec = 0, rec = 0, f1 = 0, auc = 0;
  const effTarget = target >= 0 ? target : K === 2 ? -2 : -1;
  if (effTarget >= 0 || effTarget === -2) {
    const pc = perClass(effTarget === -2 ? 1 : effTarget);
    ({ prec, rec, f1, auc } = pc);
    if (effTarget === -2) auc = perClass(1).auc;
  } else {
    let aucW = 0;
    for (let c = 0; c < K; c++) {
      const pc = perClass(c);
      const w = support[c] / n;
      prec += w * pc.prec; rec += w * pc.rec; f1 += w * pc.f1;
      if (!Number.isNaN(pc.auc)) { auc += w * pc.auc; aucW += w; }
    }
    auc = aucW ? auc / aucW : NaN;
  }
  return { AUC: auc, CA: correct / n, F1: f1, Prec: prec, Recall: rec, MCC: mcc(cm) };
}

/** 다중 클래스 MCC (scikit-learn matthews_corrcoef) */
export function mcc(cm: number[][]): number {
  const K = cm.length;
  let s = 0, c = 0;
  const t = new Array<number>(K).fill(0), p = new Array<number>(K).fill(0);
  for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) { s += cm[a][b]; t[a] += cm[a][b]; p[b] += cm[a][b]; if (a === b) c += cm[a][b]; }
  const num = c * s - t.reduce((acc, tk, k) => acc + tk * p[k], 0);
  const den = Math.sqrt((s * s - p.reduce((a, b) => a + b * b, 0)) * (s * s - t.reduce((a, b) => a + b * b, 0)));
  return den ? num / den : 0;
}

export function regressionScores(r: Results, li: number): Scores {
  const pred = r.predicted[li];
  const y = r.actual;
  const n = y.length;
  let se = 0, ae = 0, ym = 0;
  for (let i = 0; i < n; i++) ym += y[i];
  ym /= n;
  let st = 0;
  for (let i = 0; i < n; i++) { const e = y[i] - pred[i]; se += e * e; ae += Math.abs(e); st += (y[i] - ym) ** 2; }
  const mse = se / n;
  return { MSE: mse, RMSE: Math.sqrt(mse), MAE: ae / n, R2: st ? 1 - se / st : NaN };
}

export function scoreResults(r: Results, li: number, target = -1): Scores {
  return r.kind === 'classification' ? classificationScores(r, li, target) : regressionScores(r, li);
}

/** ROC 곡선 점 (FPR, TPR) */
export function rocCurve(r: Results, li: number, cls: number): { fpr: number[]; tpr: number[]; auc: number } {
  const K = r.classValues!.length;
  const probs = r.probs[li]!;
  const n = r.actual.length;
  const items = Array.from({ length: n }, (_, i) => ({ s: probs[i * K + cls], pos: r.actual[i] === cls }));
  items.sort((a, b) => b.s - a.s);
  const P = items.filter((x) => x.pos).length, N = n - P;
  const fpr = [0], tpr = [0];
  let tp = 0, fp = 0;
  for (let i = 0; i < n; i++) {
    if (items[i].pos) tp++; else fp++;
    if (i === n - 1 || items[i + 1].s !== items[i].s) { fpr.push(N ? fp / N : 0); tpr.push(P ? tp / P : 0); }
  }
  return { fpr, tpr, auc: aucBinary(items.map((x) => x.s), items.map((x) => x.pos)) };
}
