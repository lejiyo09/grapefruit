/**
 * 학습기(Learner)와 모델(Model).
 * 학습기와 모델은 모두 직렬화 가능한 순수 데이터(JSON 호환 + TypedArray)로 표현해
 * Web Worker와 메인 스레드 사이를 자유롭게 오갈 수 있게 한다.
 */
import { type Table, rowsWithClass, takeRows } from '../core/table';
import { type Encoder, type Target, type TargetKind, encode, fitEncoder, getTarget } from './encode';
import { type FeatureDesc, type TreeNode, buildTree, describeFeatures, featureColumns, findLeaf } from './tree';
import { lbfgs, choleskySolve } from './optimize';
import { Rng, range } from './random';
import { type MLPNet, type Activation, type Solver, trainMLP, predictMLP, parseHidden } from './mlp';

export type LearnerType = 'constant' | 'knn' | 'tree' | 'forest' | 'logreg' | 'linreg' | 'naivebayes' | 'mlp';

export interface LearnerSpec {
  type: LearnerType;
  name: string;
  params: Record<string, unknown>;
}

export interface ModelBase {
  learner: LearnerSpec;
  target: { kind: TargetKind; name: string; classValues?: string[] };
  nTrain: number;
}

export type Model = ModelBase & (
  | { type: 'constant'; probs?: number[]; value: number }
  | { type: 'knn'; enc: Encoder; X: Float64Array; y: Float64Array; p: number }
  | { type: 'tree'; feats: FeatureDesc[]; root: TreeNode }
  | { type: 'forest'; feats: FeatureDesc[]; trees: TreeNode[] }
  | { type: 'logreg'; enc: Encoder; W: Float64Array; p: number; k: number; binary: boolean }
  | { type: 'linreg'; enc: Encoder; coef: Float64Array; intercept: number }
  | { type: 'naivebayes'; feats: FeatureDesc[]; cuts: (number[] | null)[]; logClass: number[]; logCond: number[][][] }
  | { type: 'mlp'; enc: Encoder; net: MLPNet }
);

export interface Prediction {
  values: Float64Array;
  /** 분류일 때 n×k 확률(row-major) */
  probs: Float64Array | null;
  k: number;
}

export interface FitOptions { signal?: { aborted: boolean }; onProgress?: (p: number) => void }

/** 학습기가 지원하는 문제 유형 */
export function supports(type: LearnerType, kind: TargetKind): boolean {
  if (type === 'logreg' || type === 'naivebayes') return kind === 'classification';
  if (type === 'linreg') return kind === 'regression';
  return true;
}

export function fit(spec: LearnerSpec, data: Table, opts: FitOptions = {}): Model {
  const target0 = getTarget(data);
  if (!supports(spec.type, target0.kind)) {
    throw new Error(`${spec.name}은(는) ${target0.kind === 'classification' ? '분류' : '회귀'} 문제를 지원하지 않습니다.`);
  }
  const t = takeRows(data, rowsWithClass(data));
  if (!t.nRows) throw new Error('목표 변수 값이 있는 행이 없습니다.');
  const target = getTarget(t);
  const base: ModelBase = {
    learner: spec,
    target: { kind: target.kind, name: target.name, classValues: target.classValues },
    nTrain: t.nRows,
  };
  const P = spec.params;
  switch (spec.type) {
    case 'constant': return { ...base, type: 'constant', ...fitConstant(target) };
    case 'knn': {
      const enc = fitEncoder(t, false);
      const { X, p } = encode(enc, t);
      return { ...base, type: 'knn', enc, X, y: Float64Array.from(target.y), p };
    }
    case 'tree': {
      const feats = describeFeatures(t);
      const cols = featureColumns(t, feats);
      const root = buildTree(cols, feats, target.y, target.kind, target.classValues?.length ?? 0, range(t.nRows), {
        minLeaf: P.limitMinLeaf ? Number(P.minLeaf) : 1,
        minInternal: P.limitMinInternal ? Number(P.minInternal) : 2,
        maxDepth: P.limitDepth ? Number(P.maxDepth) : Infinity,
        sufficientMajority: P.limitMajority ? Number(P.sufficientMajority) / 100 : 1.01,
        criterion: 'entropy',
      });
      return { ...base, type: 'tree', feats, root };
    }
    case 'forest': {
      const feats = describeFeatures(t);
      const cols = featureColumns(t, feats);
      const nTrees = Number(P.nEstimators ?? 10);
      const rng = new Rng(P.useRandomState ? 0 : (Date.now() & 0xffffffff));
      const isCls = target.kind === 'classification';
      const nf = feats.length;
      const maxFeatures = P.useMaxFeatures ? Math.min(nf, Number(P.maxFeatures)) : isCls ? Math.max(1, Math.round(Math.sqrt(nf))) : nf;
      const trees: TreeNode[] = [];
      for (let b = 0; b < nTrees; b++) {
        if (opts.signal?.aborted) throw new Error('취소됨');
        const rows = new Int32Array(t.nRows);
        for (let i = 0; i < t.nRows; i++) rows[i] = rng.int(t.nRows);
        trees.push(buildTree(cols, feats, target.y, target.kind, target.classValues?.length ?? 0, rows, {
          minLeaf: 1,
          minInternal: P.useMinSamplesSplit ? Number(P.minSamplesSplit) : 2,
          maxDepth: P.useMaxDepth ? Number(P.maxDepth) : Infinity,
          sufficientMajority: 1.01,
          criterion: 'gini',
          maxFeatures,
        }, rng));
      }
      return { ...base, type: 'forest', feats, trees };
    }
    case 'logreg': return { ...base, type: 'logreg', ...fitLogReg(t, target, P, opts) };
    case 'linreg': return { ...base, type: 'linreg', ...fitLinReg(t, target, P) };
    case 'naivebayes': return { ...base, type: 'naivebayes', ...fitNaiveBayes(t, target) };
    case 'mlp': {
      // Orange NNBase 전처리: Continuize + Impute + Normalize(표준화)
      const enc = fitEncoder(t, true);
      const { X, n, p } = encode(enc, t);
      const net = trainMLP(Float32Array.from(X), n, p, target.y, target.kind, target.classValues?.length ?? 0, {
        hidden: parseHidden(String(P.hidden ?? '100,')),
        activation: (P.activation ?? 'relu') as Activation,
        solver: (P.solver ?? 'adam') as Solver,
        alpha: Number(P.alpha ?? 0.0001),
        maxIter: Number(P.maxIter ?? 200),
        seed: P.replicable === false ? null : 1, // Orange: random_state=1 if replicable
      }, opts.onProgress, opts.signal);
      return { ...base, type: 'mlp', enc, net };
    }
  }
}

function fitConstant(target: Target): { probs?: number[]; value: number } {
  const y = target.y;
  if (target.kind === 'classification') {
    const k = target.classValues!.length;
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < y.length; i++) counts[y[i]]++;
    const probs = counts.map((c) => c / y.length);
    return { probs, value: counts.indexOf(Math.max(...counts)) };
  }
  let s = 0;
  for (let i = 0; i < y.length; i++) s += y[i];
  return { value: s / y.length };
}

// ---------- 로지스틱 회귀 (scikit-learn LogisticRegression, lbfgs / multinomial) ----------
function fitLogReg(t: Table, target: Target, P: Record<string, unknown>, opts: FitOptions) {
  const enc = fitEncoder(t, false);
  const { X, n, p } = encode(enc, t);
  const nk = target.classValues!.length;
  const binary = nk === 2;
  const k = binary ? 1 : nk;
  const C = Number(P.C ?? 1);
  const penalty = String(P.penalty ?? 'l2');
  const y = target.y;
  const dim = k * (p + 1);
  const lam = penalty === 'none' ? 0 : 1 / C;
  // 목적함수: 0.5*lam*||W||^2 (L2) 또는 lam*||W||_1 근사 + sum logloss
  const l1eps = 1e-6;
  const z = new Float64Array(k);
  const W = lbfgs((w, g) => {
    g.fill(0);
    let loss = 0;
    for (let i = 0; i < n; i++) {
      const row = i * p;
      for (let c = 0; c < k; c++) {
        let s = w[c * (p + 1) + p];
        const off = c * (p + 1);
        for (let j = 0; j < p; j++) s += w[off + j] * X[row + j];
        z[c] = s;
      }
      if (binary) {
        const yi = y[i] === 1 ? 1 : 0;
        const s = z[0];
        // log(1+exp(-s)) 안정 계산
        loss += s > 0 ? Math.log1p(Math.exp(-s)) + (1 - yi) * s : Math.log1p(Math.exp(s)) - yi * s;
        const pr = 1 / (1 + Math.exp(-s));
        const d = pr - yi;
        for (let j = 0; j < p; j++) g[j] += d * X[row + j];
        g[p] += d;
      } else {
        let mx = -Infinity;
        for (let c = 0; c < k; c++) mx = Math.max(mx, z[c]);
        let se = 0;
        for (let c = 0; c < k; c++) se += Math.exp(z[c] - mx);
        const lse = mx + Math.log(se);
        loss += lse - z[y[i]];
        for (let c = 0; c < k; c++) {
          const d = Math.exp(z[c] - lse) - (c === y[i] ? 1 : 0);
          const off = c * (p + 1);
          for (let j = 0; j < p; j++) g[off + j] += d * X[row + j];
          g[off + p] += d;
        }
      }
    }
    if (lam > 0) {
      for (let c = 0; c < k; c++) {
        const off = c * (p + 1);
        for (let j = 0; j < p; j++) {
          const wj = w[off + j];
          if (penalty === 'l1') { const a = Math.sqrt(wj * wj + l1eps); loss += lam * a; g[off + j] += (lam * wj) / a; } else { loss += 0.5 * lam * wj * wj; g[off + j] += lam * wj; }
        }
      }
    }
    return loss;
  }, new Float64Array(dim), { maxIter: 300, signal: opts.signal });
  if (penalty === 'l1') for (let i = 0; i < W.length; i++) if (Math.abs(W[i]) < 1e-4) W[i] = 0;
  return { enc, W, p, k, binary };
}

// ---------- 선형 회귀 (OLS / Ridge / Lasso / Elastic net) ----------
function fitLinReg(t: Table, target: Target, P: Record<string, unknown>) {
  const enc = fitEncoder(t, false);
  const { X, n, p } = encode(enc, t);
  const y = target.y;
  const reg = String(P.reg ?? 'ols');
  const alpha = Number(P.alpha ?? 0.0001);
  const fitIntercept = P.fitIntercept !== false;
  const xm = new Float64Array(p);
  let ym = 0;
  if (fitIntercept) {
    for (let i = 0; i < n; i++) { ym += y[i]; for (let j = 0; j < p; j++) xm[j] += X[i * p + j]; }
    ym /= n; for (let j = 0; j < p; j++) xm[j] /= n;
  }
  let coef: Float64Array;
  if (reg === 'ols' || reg === 'ridge') {
    const A = new Float64Array(p * p);
    const b = new Float64Array(p);
    for (let i = 0; i < n; i++) {
      const r = i * p;
      const yi = y[i] - ym;
      for (let a = 0; a < p; a++) {
        const xa = X[r + a] - xm[a];
        b[a] += xa * yi;
        for (let c = a; c < p; c++) A[a * p + c] += xa * (X[r + c] - xm[c]);
      }
    }
    for (let a = 0; a < p; a++) for (let c = 0; c < a; c++) A[a * p + c] = A[c * p + a];
    const ridge = reg === 'ridge' ? alpha : 0;
    // OLS에서 특이행렬(예: one-hot 다중공선성)이면 아주 작은 정규화로 최소노름 해에 근사
    let sol: Float64Array | null = null;
    for (const eps of [ridge, ridge + 1e-10, ridge + 1e-8, ridge + 1e-6, ridge + 1e-4]) {
      const M = Float64Array.from(A);
      for (let a = 0; a < p; a++) M[a * p + a] += eps;
      sol = choleskySolve(M, b, p);
      if (sol) break;
    }
    coef = sol ?? new Float64Array(p);
  } else {
    // 좌표하강법: (1/2n)||y - Xw||^2 + alpha*l1*||w||_1 + 0.5*alpha*(1-l1)*||w||^2
    const l1 = reg === 'lasso' ? 1 : Number(P.l1Ratio ?? 0.5);
    const Xc = new Float64Array(n * p);
    for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) Xc[i * p + j] = X[i * p + j] - xm[j];
    const r = Float64Array.from(y, (v) => v - ym);
    const sq = new Float64Array(p);
    for (let j = 0; j < p; j++) { let s = 0; for (let i = 0; i < n; i++) s += Xc[i * p + j] ** 2; sq[j] = s / n; }
    coef = new Float64Array(p);
    for (let it = 0; it < 1000; it++) {
      let maxDelta = 0;
      for (let j = 0; j < p; j++) {
        if (!sq[j]) continue;
        let rho = 0;
        for (let i = 0; i < n; i++) rho += Xc[i * p + j] * r[i];
        rho = rho / n + sq[j] * coef[j];
        const thr = alpha * l1;
        const nw = Math.sign(rho) * Math.max(Math.abs(rho) - thr, 0) / (sq[j] + alpha * (1 - l1));
        const d = nw - coef[j];
        if (d) { for (let i = 0; i < n; i++) r[i] -= d * Xc[i * p + j]; coef[j] = nw; maxDelta = Math.max(maxDelta, Math.abs(d)); }
      }
      if (maxDelta < 1e-7) break;
    }
  }
  let intercept = 0;
  if (fitIntercept) { intercept = ym; for (let j = 0; j < p; j++) intercept -= coef[j] * xm[j]; }
  return { enc, coef, intercept };
}

// ---------- 나이브 베이즈 (Orange NaiveBayesLearner) ----------
function fitNaiveBayes(t: Table, target: Target) {
  const feats = describeFeatures(t);
  const cols = featureColumns(t, feats);
  const K = target.classValues!.length;
  const y = target.y;
  const N = t.nRows;
  // 연속 변수는 등빈도 4구간으로 이산화(Orange 기본 Discretize = EqualFreq(n=4))
  const cuts: (number[] | null)[] = feats.map((f, j) => {
    if (f.kind === 'd') return null;
    return splitEqFreq(cols[j], 4);
  });
  const classCount = new Array<number>(K).fill(0);
  for (let i = 0; i < N; i++) classCount[y[i]]++;
  const logClass = classCount.map((c) => Math.log((c + 1) / (N + K)));
  const logCond = feats.map((f, j) => {
    const nv = f.kind === 'd' ? f.values!.length : cuts[j]!.length + 1;
    const cont = Array.from({ length: nv }, () => new Array<number>(K).fill(0));
    for (let i = 0; i < N; i++) {
      const v = binOf(cols[j][i], cuts[j]);
      if (v >= 0) cont[v][y[i]]++;
    }
    // log P(class | value) = log((n(v,c)+1) / (n(v)+K))
    return cont.map((row) => {
      const tot = row.reduce((a, b) => a + b, 0);
      return row.map((c) => Math.log((c + 1) / (tot + K)));
    });
  });
  return { feats, cuts, logClass, logCond };
}

function binOf(x: number, cuts: number[] | null): number {
  if (Number.isNaN(x)) return -1;
  if (!cuts) return x;
  let b = 0;
  while (b < cuts.length && x >= cuts[b]) b++;
  return b;
}

/** Orange `_discretize.split_eq_freq` (EqualFreq 이산화의 경계값) */
export function splitEqFreq(col: ArrayLike<number>, n: number): number[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < col.length; i++) { const v = col[i]; if (!Number.isNaN(v)) counts.set(v, (counts.get(v) ?? 0) + 1); }
  const vals = [...counts.keys()].sort((a, b) => a - b);
  const llen = vals.length;
  if (n >= llen) return vals.slice(1).map((v, i) => (vals[i] + v) / 2);
  let N = 0;
  for (const c of counts.values()) N += c;
  let toGo = n, inthis = 0, prevel = -1, inone = N / toGo;
  const points: number[] = [];
  for (let i = 0; i < llen; i++) {
    const v = vals[i], k = counts.get(v)!;
    if (toGo <= 1) break;
    inthis += k;
    if (inthis < inone || i === 0) prevel = v;
    else {
      if (i < llen - 1 && inthis - inone < k / 2) {
        const vn = vals[i + 1];
        points.push((vn + v) / 2);
        N -= inthis; inthis = 0; prevel = vn;
      } else {
        points.push((prevel + v) / 2);
        N -= inthis - k; inthis = k; prevel = v;
      }
      toGo--;
      if (toGo) inone = N / toGo;
    }
  }
  return points;
}

// ---------- 예측 ----------
export function predict(model: Model, data: Table): Prediction {
  const n = data.nRows;
  const isCls = model.target.kind === 'classification';
  const K = isCls ? model.target.classValues!.length : 0;
  const values = new Float64Array(n);
  const probs = isCls ? new Float64Array(n * K) : null;

  const finish = () => {
    if (probs) for (let i = 0; i < n; i++) {
      let best = 0;
      for (let c = 1; c < K; c++) if (probs[i * K + c] > probs[i * K + best]) best = c;
      values[i] = best;
    }
    return { values, probs, k: K };
  };

  switch (model.type) {
    case 'constant':
      for (let i = 0; i < n; i++) {
        if (probs) for (let c = 0; c < K; c++) probs[i * K + c] = model.probs![c];
        else values[i] = model.value;
      }
      return finish();
    case 'knn': {
      const { X } = encode(model.enc, data);
      const p = model.p;
      const kk = Math.min(Number(model.learner.params.nNeighbors ?? 5), model.nTrain);
      const metric = String(model.learner.params.metric ?? 'euclidean');
      const weights = String(model.learner.params.weights ?? 'uniform');
      const m = model.nTrain;
      const D = model.X;
      const normsTrain = metric === 'cosine' ? rowNorms(D, m, p) : null;
      const dist = new Float64Array(m);
      const order = new Int32Array(m);
      for (let i = 0; i < n; i++) {
        const qi = i * p;
        let qn = 0;
        if (normsTrain) { for (let j = 0; j < p; j++) qn += X[qi + j] ** 2; qn = Math.sqrt(qn) || 1; }
        for (let r = 0; r < m; r++) {
          const ri = r * p;
          let s = 0;
          if (metric === 'manhattan') for (let j = 0; j < p; j++) s += Math.abs(X[qi + j] - D[ri + j]);
          else if (metric === 'chebyshev') for (let j = 0; j < p; j++) s = Math.max(s, Math.abs(X[qi + j] - D[ri + j]));
          else if (metric === 'cosine') { for (let j = 0; j < p; j++) s += (X[qi + j] / qn - D[ri + j] / normsTrain![r]) ** 2; s = Math.sqrt(s); }
          else { for (let j = 0; j < p; j++) s += (X[qi + j] - D[ri + j]) ** 2; s = Math.sqrt(s); }
          dist[r] = s; order[r] = r;
        }
        partialSort(order, dist, kk);
        if (probs) {
          let tot = 0;
          for (let a = 0; a < kk; a++) {
            const r = order[a];
            const w = weights === 'distance' ? (dist[r] === 0 ? 1e12 : 1 / dist[r]) : 1;
            probs[i * K + model.y[r]] += w; tot += w;
          }
          for (let c = 0; c < K; c++) probs[i * K + c] /= tot;
        } else {
          let s = 0, tot = 0;
          for (let a = 0; a < kk; a++) {
            const r = order[a];
            const w = weights === 'distance' ? (dist[r] === 0 ? 1e12 : 1 / dist[r]) : 1;
            s += w * model.y[r]; tot += w;
          }
          values[i] = s / tot;
        }
      }
      return finish();
    }
    case 'tree':
    case 'forest': {
      const cols = featureColumns(data, model.feats);
      const trees = model.type === 'tree' ? [model.root] : model.trees;
      for (let i = 0; i < n; i++) {
        for (const tr of trees) {
          const leaf = findLeaf(tr, cols, i);
          if (probs) {
            const tot = leaf.dist.reduce((a, b) => a + b, 0) || 1;
            for (let c = 0; c < K; c++) probs[i * K + c] += leaf.dist[c] / tot / trees.length;
          } else values[i] += leaf.value / trees.length;
        }
      }
      return finish();
    }
    case 'logreg': {
      const { X } = encode(model.enc, data);
      const { W, p, k } = model;
      for (let i = 0; i < n; i++) {
        if (model.binary) {
          let s = W[p];
          for (let j = 0; j < p; j++) s += W[j] * X[i * p + j];
          const p1 = 1 / (1 + Math.exp(-s));
          probs![i * 2] = 1 - p1; probs![i * 2 + 1] = p1;
        } else {
          let mx = -Infinity;
          const z = new Float64Array(k);
          for (let c = 0; c < k; c++) {
            let s = W[c * (p + 1) + p];
            for (let j = 0; j < p; j++) s += W[c * (p + 1) + j] * X[i * p + j];
            z[c] = s; mx = Math.max(mx, s);
          }
          let se = 0;
          for (let c = 0; c < k; c++) { z[c] = Math.exp(z[c] - mx); se += z[c]; }
          for (let c = 0; c < k; c++) probs![i * K + c] = z[c] / se;
        }
      }
      return finish();
    }
    case 'linreg': {
      const { X } = encode(model.enc, data);
      const p = model.coef.length;
      for (let i = 0; i < n; i++) {
        let s = model.intercept;
        for (let j = 0; j < p; j++) s += model.coef[j] * X[i * p + j];
        values[i] = s;
      }
      return finish();
    }
    case 'mlp': {
      const { X } = encode(model.enc, data);
      const out = predictMLP(model.net, Float32Array.from(X), n, K);
      if (probs) probs.set(out.subarray(0, n * K)); else for (let i = 0; i < n; i++) values[i] = out[i];
      return finish();
    }
    case 'naivebayes': {
      const cols = featureColumns(data, model.feats);
      for (let i = 0; i < n; i++) {
        const lp = model.logClass.slice();
        model.feats.forEach((_, j) => {
          const v = binOf(cols[j][i], model.cuts[j]);
          if (v < 0 || v >= model.logCond[j].length) return;
          for (let c = 0; c < K; c++) lp[c] += model.logCond[j][v][c] - model.logClass[c];
        });
        const mx = Math.max(...lp);
        let se = 0;
        for (let c = 0; c < K; c++) { lp[c] = Math.exp(lp[c] - mx); se += lp[c]; }
        for (let c = 0; c < K; c++) probs![i * K + c] = lp[c] / se;
      }
      return finish();
    }
  }
}

function rowNorms(X: Float64Array, n: number, p: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < p; j++) s += X[i * p + j] ** 2; out[i] = Math.sqrt(s) || 1; }
  return out;
}

/** order의 앞쪽 k개가 가장 작은 거리(오름차순)가 되도록 부분 정렬 */
function partialSort(order: Int32Array, dist: Float64Array, k: number): void {
  // 작은 k에 적합한 선택 정렬 + 안정적인 순서(동률은 인덱스 순)
  for (let a = 0; a < k; a++) {
    let best = a;
    for (let b = a + 1; b < order.length; b++) {
      const db = dist[order[b]], dbest = dist[order[best]];
      if (db < dbest || (db === dbest && order[b] < order[best])) best = b;
    }
    const tmp = order[a]; order[a] = order[best]; order[best] = tmp;
  }
}

/** 모델 설명(위젯 창과 Data Info용) */
export function describeModel(m: Model): string {
  const kind = m.target.kind === 'classification' ? '분류' : '회귀';
  return `${m.learner.name} (${kind}, 목표: ${m.target.name}, 학습 ${m.nTrain}행)`;
}
