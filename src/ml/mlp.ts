/**
 * 다층 퍼셉트론(MLP). Orange Neural Network 위젯 = scikit-learn MLPClassifier/MLPRegressor 를 따른다.
 *  - 가중치 초기화: Glorot uniform (logistic 활성화면 범위 √2배 축소, sklearn과 동일)
 *  - 손실: 분류 = 교차 엔트로피(이진은 sigmoid 1개, 다중은 softmax), 회귀 = 제곱오차/2
 *  - L2 정규화: 0.5·α·Σw² / 배치 크기
 *  - 최적화: adam(lr 0.001, β1 0.9, β2 0.999, ε 1e-8), sgd(lr 0.001, 모멘텀 0.9, Nesterov), lbfgs
 *  - 미니배치 = min(200, n), 매 epoch 섞기, 손실이 tol(1e-4)만큼 10 epoch 연속 개선되지 않으면 중단
 * 입력 행렬은 호출하는 쪽에서 표준화한다(Orange NNBase 전처리 = 기본 + Normalize).
 */
import { lbfgs } from './optimize';
import { Rng } from './random';

export type Activation = 'identity' | 'logistic' | 'tanh' | 'relu';
export type Solver = 'lbfgs' | 'sgd' | 'adam';

export interface MLPParams {
  hidden: number[];
  activation: Activation;
  solver: Solver;
  alpha: number;
  maxIter: number;
  seed: number | null;
}

export interface MLPNet {
  sizes: number[]; // [입력, 은닉…, 출력]
  W: Float32Array[]; // 층마다 [in × out] row-major
  b: Float32Array[];
  activation: Activation;
  out: 'softmax' | 'sigmoid' | 'identity';
  iterations: number;
  loss: number;
}

const act = (a: Activation, x: number) => (a === 'relu' ? (x > 0 ? x : 0) : a === 'tanh' ? Math.tanh(x) : a === 'logistic' ? 1 / (1 + Math.exp(-x)) : x);
/** 활성화 출력값 y로 표현한 도함수 */
const dact = (a: Activation, y: number) => (a === 'relu' ? (y > 0 ? 1 : 0) : a === 'tanh' ? 1 - y * y : a === 'logistic' ? y * (1 - y) : 1);

function init(sizes: number[], activation: Activation, rng: Rng): { W: Float32Array[]; b: Float32Array[] } {
  const W: Float32Array[] = [], b: Float32Array[] = [];
  for (let l = 0; l + 1 < sizes.length; l++) {
    const fi = sizes[l], fo = sizes[l + 1];
    const factor = activation === 'logistic' ? 2 : 6;
    const bound = Math.sqrt(factor / (fi + fo));
    W.push(Float32Array.from({ length: fi * fo }, () => (rng.next() * 2 - 1) * bound));
    b.push(Float32Array.from({ length: fo }, () => (rng.next() * 2 - 1) * bound));
  }
  return { W, b };
}

/** 순전파: 각 층 출력(활성화 후)을 반환 */
function forward(net: Pick<MLPNet, 'sizes' | 'W' | 'b' | 'activation' | 'out'>, X: Float32Array, rows: Int32Array | null, n: number): Float32Array[] {
  const acts: Float32Array[] = [];
  const p = net.sizes[0];
  let cur: Float32Array = new Float32Array(n * p);
  if (rows) for (let r = 0; r < n; r++) cur.set(X.subarray(rows[r] * p, rows[r] * p + p), r * p);
  else cur = X.subarray(0, n * p);
  acts.push(cur);
  const L = net.W.length;
  for (let l = 0; l < L; l++) {
    const fi = net.sizes[l], fo = net.sizes[l + 1];
    const W = net.W[l], bb = net.b[l];
    const out = new Float32Array(n * fo);
    for (let r = 0; r < n; r++) {
      const o = r * fo, ii = r * fi;
      out.set(bb, o);
      for (let i = 0; i < fi; i++) {
        const xv = cur[ii + i];
        if (xv === 0) continue;
        const wi = i * fo;
        for (let j = 0; j < fo; j++) out[o + j] += xv * W[wi + j];
      }
    }
    if (l < L - 1) { for (let k = 0; k < out.length; k++) out[k] = act(net.activation, out[k]); }
    else if (net.out === 'sigmoid') { for (let k = 0; k < out.length; k++) out[k] = 1 / (1 + Math.exp(-out[k])); }
    else if (net.out === 'softmax') {
      for (let r = 0; r < n; r++) {
        let mx = -Infinity;
        for (let j = 0; j < fo; j++) mx = Math.max(mx, out[r * fo + j]);
        let s = 0;
        for (let j = 0; j < fo; j++) { const e = Math.exp(out[r * fo + j] - mx); out[r * fo + j] = e; s += e; }
        for (let j = 0; j < fo; j++) out[r * fo + j] /= s;
      }
    }
    acts.push(out);
    cur = out;
  }
  return acts;
}

/** 배치 손실과 기울기(gW, gb에 더함). Y: 분류는 클래스 인덱스, 회귀는 값 */
function lossGrad(net: MLPNet, X: Float32Array, Y: Float64Array, rows: Int32Array, alpha: number, gW: Float32Array[] | null, gb: Float32Array[] | null): number {
  const n = rows.length;
  const acts = forward(net, X, rows, n);
  const L = net.W.length;
  const K = net.sizes[L];
  const outA = acts[L];
  let loss = 0;
  let delta: Float32Array = new Float32Array(n * K);
  for (let r = 0; r < n; r++) {
    const y = Y[rows[r]];
    if (net.out === 'softmax') {
      for (let j = 0; j < K; j++) {
        const pr = outA[r * K + j], t = j === y ? 1 : 0;
        if (t) loss -= Math.log(Math.max(pr, 1e-10));
        delta[r * K + j] = (pr - t) / n;
      }
    } else if (net.out === 'sigmoid') {
      const pr = Math.min(1 - 1e-10, Math.max(1e-10, outA[r])), t = y === 1 ? 1 : 0;
      loss -= t * Math.log(pr) + (1 - t) * Math.log(1 - pr);
      delta[r] = (outA[r] - t) / n;
    } else {
      const d = outA[r] - y;
      loss += (d * d) / 2;
      delta[r] = d / n;
    }
  }
  loss /= n;
  let sw = 0;
  for (const W of net.W) for (let k = 0; k < W.length; k++) sw += W[k] * W[k];
  loss += (0.5 * alpha * sw) / n;
  if (!gW || !gb) return loss;
  for (let l = L - 1; l >= 0; l--) {
    const fi = net.sizes[l], fo = net.sizes[l + 1];
    const a = acts[l], W = net.W[l], GW = gW[l], GB = gb[l];
    for (let r = 0; r < n; r++) {
      const dr = r * fo, ar = r * fi;
      for (let j = 0; j < fo; j++) GB[j] += delta[dr + j];
      for (let i = 0; i < fi; i++) {
        const av = a[ar + i];
        if (av === 0) continue;
        const wi = i * fo;
        for (let j = 0; j < fo; j++) GW[wi + j] += av * delta[dr + j];
      }
    }
    for (let k = 0; k < W.length; k++) GW[k] += (alpha * W[k]) / n;
    if (l === 0) break;
    const prev = new Float32Array(n * fi);
    for (let r = 0; r < n; r++) {
      const dr = r * fo, pr = r * fi;
      for (let i = 0; i < fi; i++) {
        const av = a[pr + i];
        const d = dact(net.activation, av);
        if (d === 0) continue;
        let s = 0;
        const wi = i * fo;
        for (let j = 0; j < fo; j++) s += W[wi + j] * delta[dr + j];
        prev[pr + i] = s * d;
      }
    }
    delta = prev;
  }
  return loss;
}

export function trainMLP(
  X: Float32Array, n: number, p: number, Y: Float64Array, kind: 'classification' | 'regression', nClasses: number,
  params: MLPParams, onProgress?: (p: number) => void, signal?: { aborted: boolean },
): MLPNet {
  const rng = new Rng(params.seed ?? ((Math.random() * 2 ** 32) >>> 0));
  const outSize = kind === 'regression' ? 1 : nClasses === 2 ? 1 : nClasses;
  const sizes = [p, ...params.hidden.filter((h) => h > 0), outSize];
  const { W, b } = init(sizes, params.activation, rng);
  const net: MLPNet = { sizes, W, b, activation: params.activation, out: kind === 'regression' ? 'identity' : nClasses === 2 ? 'sigmoid' : 'softmax', iterations: 0, loss: NaN };
  const all = Int32Array.from({ length: n }, (_, i) => i);
  const zeros = () => ({ gW: W.map((w) => new Float32Array(w.length)), gb: b.map((x) => new Float32Array(x.length)) });

  if (params.solver === 'lbfgs') {
    // 모든 가중치를 하나의 벡터로 펼쳐 L-BFGS로 최적화
    const total = W.reduce((s, w) => s + w.length, 0) + b.reduce((s, x) => s + x.length, 0);
    const pack = (into: Float64Array, ws: Float32Array[], bs: Float32Array[]) => { let o = 0; for (let l = 0; l < ws.length; l++) { for (const v of ws[l]) into[o++] = v; for (const v of bs[l]) into[o++] = v; } };
    const unpack = (from: Float64Array) => { let o = 0; for (let l = 0; l < W.length; l++) { for (let k = 0; k < W[l].length; k++) W[l][k] = from[o++]; for (let k = 0; k < b[l].length; k++) b[l][k] = from[o++]; } };
    const x0 = new Float64Array(total); pack(x0, W, b);
    let it = 0;
    const xb = lbfgs((x, g) => {
      unpack(x);
      const z = zeros();
      const loss = lossGrad(net, X, Y, all, params.alpha, z.gW, z.gb);
      pack(g, z.gW, z.gb);
      onProgress?.(Math.min(0.99, ++it / (params.maxIter * 1.5)));
      return loss;
    }, x0, { maxIter: params.maxIter, tol: 1e-5, signal });
    unpack(xb);
    net.iterations = params.maxIter;
    net.loss = lossGrad(net, X, Y, all, params.alpha, null, null);
    return net;
  }

  const batch = Math.min(200, n);
  const lr = 0.001;
  const m = W.map((w) => new Float32Array(w.length)), v = W.map((w) => new Float32Array(w.length));
  const mb = b.map((x) => new Float32Array(x.length)), vb = b.map((x) => new Float32Array(x.length));
  let t = 0, best = Infinity, noImprove = 0;
  const order = Int32Array.from(all);
  for (let epoch = 0; epoch < params.maxIter; epoch++) {
    if (signal?.aborted) throw new Error('취소됨');
    rng.shuffle(order);
    let epochLoss = 0;
    for (let s = 0; s < n; s += batch) {
      const rows = order.subarray(s, Math.min(n, s + batch));
      const z = zeros();
      epochLoss += lossGrad(net, X, Y, rows, params.alpha, z.gW, z.gb) * rows.length;
      t++;
      const update = (P: Float32Array, G: Float32Array, M: Float32Array, V: Float32Array) => {
        if (params.solver === 'adam') {
          const lrT = (lr * Math.sqrt(1 - 0.999 ** t)) / (1 - 0.9 ** t);
          for (let k = 0; k < P.length; k++) {
            M[k] = 0.9 * M[k] + 0.1 * G[k];
            V[k] = 0.999 * V[k] + 0.001 * G[k] * G[k];
            P[k] -= (lrT * M[k]) / (Math.sqrt(V[k]) + 1e-8);
          }
        } else {
          // sklearn SGDOptimizer: velocity = momentum*v - lr*g; nesterov: update = momentum*velocity - lr*g
          for (let k = 0; k < P.length; k++) {
            M[k] = 0.9 * M[k] - lr * G[k];
            P[k] += 0.9 * M[k] - lr * G[k];
          }
        }
      };
      for (let l = 0; l < W.length; l++) { update(W[l], z.gW[l], m[l], v[l]); update(b[l], z.gb[l], mb[l], vb[l]); }
    }
    epochLoss /= n;
    net.iterations = epoch + 1;
    net.loss = epochLoss;
    onProgress?.((epoch + 1) / params.maxIter);
    // sklearn _update_no_improvement_count (early_stopping=False)
    if (epochLoss > best - 1e-4) noImprove++; else noImprove = 0;
    if (epochLoss < best) best = epochLoss;
    if (noImprove > 10) break;
  }
  return net;
}

/** 예측: 분류는 n×K 확률, 회귀는 n개 값 */
export function predictMLP(net: MLPNet, X: Float32Array, n: number, nClasses: number): Float32Array {
  const outA = forward(net, X, null, n)[net.W.length];
  if (net.out !== 'sigmoid') return outA;
  const pr = new Float32Array(n * 2);
  for (let r = 0; r < n; r++) { pr[r * 2 + 1] = outA[r]; pr[r * 2] = 1 - outA[r]; }
  return nClasses === 2 ? pr : outA;
}

/** "100," 같은 입력에서 은닉층 크기 목록(Orange get_hidden_layers와 같은 정규식) */
export function parseHidden(s: string): number[] {
  const m = String(s).match(/\d+/g);
  return m ? m.map(Number).filter((x) => x > 0) : [];
}
