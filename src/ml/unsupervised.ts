/** 비지도 학습: k-Means, PCA, 거리 행렬, 계층적 군집(NN-chain), 실루엣 */
import type { Table } from '../core/table';
import { encode, fitEncoder, type Matrix } from './encode';
import { symmetricEigen } from './optimize';
import { Rng } from './random';

// ---------------- k-Means (scikit-learn KMeans: k-means++, n_init, max_iter) ----------------
export interface KMeansResult { labels: Int32Array; centroids: Float64Array; inertia: number; iterations: number }

export function kmeans(m: Matrix, k: number, opts: { nInit?: number; maxIter?: number; init?: 'kmeans++' | 'random'; seed?: number; signal?: { aborted: boolean } } = {}): KMeansResult {
  const { X, n, p } = m;
  if (n < k) throw new Error(`데이터 행 수(${n})가 군집 수(${k})보다 적습니다.`);
  const rng = new Rng(opts.seed ?? 0);
  let best: KMeansResult | null = null;
  for (let run = 0; run < (opts.nInit ?? 10); run++) {
    if (opts.signal?.aborted) throw new Error('취소됨');
    const C = new Float64Array(k * p);
    if ((opts.init ?? 'kmeans++') === 'kmeans++') {
      const first = rng.int(n);
      C.set(X.subarray(first * p, first * p + p), 0);
      const d2 = new Float64Array(n).fill(Infinity);
      for (let c = 1; c < k; c++) {
        let tot = 0;
        for (let i = 0; i < n; i++) {
          let s = 0;
          for (let j = 0; j < p; j++) s += (X[i * p + j] - C[(c - 1) * p + j]) ** 2;
          if (s < d2[i]) d2[i] = s;
          tot += d2[i];
        }
        let r = rng.next() * tot, pick = n - 1;
        for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
        C.set(X.subarray(pick * p, pick * p + p), c * p);
      }
    } else {
      const chosen = new Set<number>();
      for (let c = 0; c < k; c++) {
        let i = rng.int(n);
        while (chosen.has(i) && chosen.size < n) i = rng.int(n);
        chosen.add(i);
        C.set(X.subarray(i * p, i * p + p), c * p);
      }
    }
    const labels = new Int32Array(n);
    let inertia = 0, it = 0;
    for (; it < (opts.maxIter ?? 300); it++) {
      let changed = 0;
      inertia = 0;
      for (let i = 0; i < n; i++) {
        let bd = Infinity, bc = 0;
        for (let c = 0; c < k; c++) {
          let s = 0;
          for (let j = 0; j < p; j++) s += (X[i * p + j] - C[c * p + j]) ** 2;
          if (s < bd) { bd = s; bc = c; }
        }
        if (labels[i] !== bc || it === 0) changed++;
        labels[i] = bc; inertia += bd;
      }
      const sums = new Float64Array(k * p), cnt = new Float64Array(k);
      for (let i = 0; i < n; i++) { const c = labels[i]; cnt[c]++; for (let j = 0; j < p; j++) sums[c * p + j] += X[i * p + j]; }
      let shift = 0;
      for (let c = 0; c < k; c++) {
        if (!cnt[c]) continue; // 빈 군집은 기존 중심 유지
        for (let j = 0; j < p; j++) { const v = sums[c * p + j] / cnt[c]; shift += (v - C[c * p + j]) ** 2; C[c * p + j] = v; }
      }
      if (!changed || shift < 1e-12) break;
    }
    if (!best || inertia < best.inertia) best = { labels, centroids: C, inertia, iterations: it + 1 };
  }
  return best!;
}

/** 실루엣 점수(행별). O(n²) 이므로 호출부에서 행 수를 제한한다. */
export function silhouette(m: Matrix, labels: Int32Array, k: number): Float64Array {
  const { X, n, p } = m;
  const out = new Float64Array(n);
  const sizes = new Float64Array(k);
  for (let i = 0; i < n; i++) sizes[labels[i]]++;
  const sum = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    sum.fill(0);
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      let s = 0;
      for (let j = 0; j < p; j++) s += (X[i * p + j] - X[r * p + j]) ** 2;
      sum[labels[r]] += Math.sqrt(s);
    }
    const own = labels[i];
    if (sizes[own] <= 1) { out[i] = 0; continue; }
    const a = sum[own] / (sizes[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && sizes[c]) b = Math.min(b, sum[c] / sizes[c]);
    out[i] = Number.isFinite(b) ? (b - a) / Math.max(a, b) : 0;
  }
  return out;
}

// ---------------- PCA ----------------
export interface PCAResult {
  components: Float64Array; // d×q (열 = 주성분)
  variance: Float64Array; // 모든 주성분의 분산(고유값)
  ratio: Float64Array;
  means: Float64Array;
  scales: Float64Array;
  names: string[];
}

export function pca(t: Table, normalize: boolean): { result: PCAResult; scores: Float64Array; n: number } {
  const enc = fitEncoder(t, normalize);
  const { X, n, p } = encode(enc, t);
  if (!p) throw new Error('PCA를 계산할 수치형/범주형 변수가 없습니다.');
  const means = new Float64Array(p);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) means[j] += X[i * p + j];
  for (let j = 0; j < p; j++) means[j] /= n;
  const cov = new Float64Array(p * p);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      const xa = X[i * p + a] - means[a];
      for (let b = a; b < p; b++) cov[a * p + b] += xa * (X[i * p + b] - means[b]);
    }
  }
  for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { cov[a * p + b] /= Math.max(1, n - 1); cov[b * p + a] = cov[a * p + b]; }
  const { values, vectors } = symmetricEigen(cov, p);
  // 부호 규약(scikit-learn svd_flip과 유사): 각 성분에서 절댓값이 가장 큰 원소가 양수
  for (let c = 0; c < p; c++) {
    let mi = 0;
    for (let a = 1; a < p; a++) if (Math.abs(vectors[a * p + c]) > Math.abs(vectors[mi * p + c])) mi = a;
    if (vectors[mi * p + c] < 0) for (let a = 0; a < p; a++) vectors[a * p + c] *= -1;
  }
  const total = values.reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  const ratio = Float64Array.from(values, (v) => Math.max(v, 0) / total);
  const scores = new Float64Array(n * p);
  for (let i = 0; i < n; i++) for (let c = 0; c < p; c++) {
    let s = 0;
    for (let a = 0; a < p; a++) s += (X[i * p + a] - means[a]) * vectors[a * p + c];
    scores[i * p + c] = s;
  }
  return {
    result: { components: vectors, variance: Float64Array.from(values, (v) => Math.max(v, 0)), ratio, means, scales: new Float64Array(p).fill(1), names: enc.outNames },
    scores, n,
  };
}

// ---------------- 거리 ----------------
export type Metric = 'euclidean' | 'manhattan' | 'cosine' | 'pearson' | 'chebyshev';

/** 압축(condensed) 상삼각 거리 행렬. 메모리는 n(n-1)/2 × 8바이트 */
export interface DistMatrix { n: number; d: Float64Array; labels: string[]; metric: Metric; rowIds?: Int32Array }

export function condensedIndex(n: number, i: number, j: number): number {
  if (i > j) { const t = i; i = j; j = t; }
  return n * i - (i * (i + 1)) / 2 + (j - i - 1);
}

export function distAt(m: DistMatrix, i: number, j: number): number {
  return i === j ? 0 : m.d[condensedIndex(m.n, i, j)];
}

export function distanceBytes(n: number): number { return (n * (n - 1) / 2) * 8; }

export function computeDistances(mat: Matrix, metric: Metric, labels: string[], signal?: { aborted: boolean }): DistMatrix {
  const { X, n, p } = mat;
  const d = new Float64Array((n * (n - 1)) / 2);
  let norms: Float64Array | null = null;
  let Xc = X;
  if (metric === 'cosine' || metric === 'pearson') {
    if (metric === 'pearson') {
      Xc = new Float64Array(X.length);
      for (let i = 0; i < n; i++) {
        let m = 0; for (let j = 0; j < p; j++) m += X[i * p + j]; m /= p;
        for (let j = 0; j < p; j++) Xc[i * p + j] = X[i * p + j] - m;
      }
    }
    norms = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < p; j++) s += Xc[i * p + j] ** 2; norms[i] = Math.sqrt(s) || 1; }
  }
  let pos = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 63) === 0 && signal?.aborted) throw new Error('취소됨');
    for (let j = i + 1; j < n; j++) {
      let s = 0;
      if (metric === 'euclidean') { for (let a = 0; a < p; a++) s += (X[i * p + a] - X[j * p + a]) ** 2; s = Math.sqrt(s); }
      else if (metric === 'manhattan') for (let a = 0; a < p; a++) s += Math.abs(X[i * p + a] - X[j * p + a]);
      else if (metric === 'chebyshev') for (let a = 0; a < p; a++) s = Math.max(s, Math.abs(X[i * p + a] - X[j * p + a]));
      else {
        for (let a = 0; a < p; a++) s += Xc[i * p + a] * Xc[j * p + a];
        s = 1 - s / (norms![i] * norms![j]);
        if (metric === 'pearson') s = s / 2; // Orange "Pearson correlation" 거리 = (1 - r) / 2
      }
      d[pos++] = s;
    }
  }
  return { n, d, labels, metric };
}

// ---------------- 계층적 군집 ----------------
export type Linkage = 'single' | 'average' | 'weighted' | 'complete' | 'ward';

/** 병합 기록: [a, b, 거리, 크기] (scipy linkage 형식, 군집 번호 n+i = i번째 병합 결과) */
export type LinkageMatrix = Array<[number, number, number, number]>;

/** NN-chain 알고리즘. 시간 O(n²), 메모리 O(n²) (입력 행렬 복사본) */
export function hierarchical(dm: DistMatrix, linkage: Linkage, signal?: { aborted: boolean }): LinkageMatrix {
  const n = dm.n;
  if (n < 2) return [];
  const D = Float64Array.from(dm.d);
  if (linkage === 'ward') for (let i = 0; i < D.length; i++) D[i] = D[i] * D[i];
  const size = new Float64Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const clusterId = Int32Array.from({ length: n }, (_, i) => i);
  const get = (i: number, j: number) => D[condensedIndex(n, i, j)];
  const set = (i: number, j: number, v: number) => { D[condensedIndex(n, i, j)] = v; };
  const merges: Array<[number, number, number, number]> = [];
  const chain: number[] = [];
  let remaining = n;
  while (remaining > 1) {
    if (signal?.aborted) throw new Error('취소됨');
    if (!chain.length) { for (let i = 0; i < n; i++) if (active[i]) { chain.push(i); break; } }
    let a = chain[chain.length - 1];
    let b = -1, best = Infinity;
    const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
    if (prev >= 0) { best = get(a, prev); b = prev; }
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      const v = get(a, k);
      if (v < best) { best = v; b = k; }
    }
    if (b === prev) {
      chain.pop(); chain.pop();
      // a와 b 병합 → b 자리에 새 군집 저장
      if (a > b) { const t = a; a = b; b = t; }
      const na = size[a], nb = size[b];
      for (let k = 0; k < n; k++) {
        if (!active[k] || k === a || k === b) continue;
        const da = get(a, k), db = get(b, k), nk = size[k];
        let v: number;
        switch (linkage) {
          case 'single': v = Math.min(da, db); break;
          case 'complete': v = Math.max(da, db); break;
          case 'average': v = (na * da + nb * db) / (na + nb); break;
          case 'weighted': v = (da + db) / 2; break;
          case 'ward': v = ((na + nk) * da + (nb + nk) * db - nk * best) / (na + nb + nk); break;
        }
        set(b, k, v);
      }
      merges.push([clusterId[a], clusterId[b], linkage === 'ward' ? Math.sqrt(best) : best, na + nb]);
      active[a] = 0;
      size[b] = na + nb;
      clusterId[b] = n + merges.length - 1;
      remaining--;
    } else chain.push(b);
  }
  // scipy처럼 거리 순 정렬 후 번호 재부여
  const order = merges.map((m, i) => ({ m, i })).sort((x, y) => x.m[2] - y.m[2]);
  const remap = new Map<number, number>();
  const out: LinkageMatrix = [];
  for (const { m, i } of order) {
    const a = m[0] >= n ? remap.get(m[0])! : m[0];
    const b = m[1] >= n ? remap.get(m[1])! : m[1];
    remap.set(n + i, n + out.length);
    out.push([Math.min(a, b), Math.max(a, b), m[2], m[3]]);
  }
  return out;
}

/** 상위 k개 군집으로 자르기 → 행별 군집 번호(0..k-1) */
export function cutTopN(Z: LinkageMatrix, n: number, k: number): Int32Array {
  const parent = Int32Array.from({ length: 2 * n - 1 }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const stop = Math.max(0, Z.length - (k - 1));
  for (let i = 0; i < stop; i++) { const [a, b] = Z[i]; parent[find(a)] = n + i; parent[find(b)] = n + i; parent[n + i] = n + i; }
  const roots = new Map<number, number>();
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!roots.has(r)) roots.set(r, roots.size);
    labels[i] = roots.get(r)!;
  }
  return labels;
}

/** 거리 비율로 자르기(Orange "Height ratio") */
export function cutHeight(Z: LinkageMatrix, n: number, height: number): Int32Array {
  const k = Z.length - Z.filter((z) => z[2] <= height).length + 1;
  return cutTopN(Z, n, Math.max(1, k));
}

/** 덴드로그램 잎 순서 */
export function leafOrder(Z: LinkageMatrix, n: number): number[] {
  if (!Z.length) return n ? [0] : [];
  const out: number[] = [];
  const stack = [n + Z.length - 1];
  while (stack.length) {
    const x = stack.pop()!;
    if (x < n) out.push(x); else { const [a, b] = Z[x - n]; stack.push(b, a); }
  }
  return out;
}
