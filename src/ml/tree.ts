/**
 * 결정 트리. Orange TreeLearner(분류: 정보 이득, 회귀: 분산 감소, 이진 분할)와
 * Random Forest(scikit-learn 방식: 지니, 부트스트랩, 특징 부분집합)에서 함께 사용한다.
 * 데이터는 원본 열을 그대로 사용하며, 범주형 변수는 "값 = v / 그 외" 이진 분할을 한다.
 */
import { type Table, findColumn } from '../core/table';
import { Rng } from './random';
import type { TargetKind } from './encode';

export interface FeatureDesc { name: string; kind: 'c' | 'd'; values?: string[] }

export type TreeNode =
  | { leaf: true; n: number; dist: number[]; value: number }
  | {
      leaf: false; n: number; dist: number[]; value: number;
      feature: number; threshold?: number; equals?: number;
      left: TreeNode; right: TreeNode; leftShare: number;
    };

export interface TreeParams {
  minLeaf: number;
  minInternal: number;
  maxDepth: number;
  sufficientMajority: number; // 0..1, 분류에서만
  criterion: 'entropy' | 'gini';
  maxFeatures?: number; // 랜덤 포레스트
}

export function describeFeatures(t: Table): FeatureDesc[] {
  return t.attributes
    .filter((c) => c.variable.kind !== 'string')
    .map((c) => (c.variable.kind === 'discrete'
      ? { name: c.variable.name, kind: 'd' as const, values: [...c.variable.values!] }
      : { name: c.variable.name, kind: 'c' as const }));
}

/** 특징 설명에 맞춰 테이블의 열을 가져온다(범주형 값은 이름으로 재매핑) */
export function featureColumns(t: Table, feats: FeatureDesc[]): Float64Array[] {
  return feats.map((f) => {
    const c = findColumn(t, f.name);
    if (!c) throw new Error(`입력 데이터에 모델 학습에 사용한 변수 '${f.name}'이(가) 없습니다.`);
    const d = c.data as Float64Array;
    if (f.kind === 'c') return d;
    const lookup = new Map(f.values!.map((v, i) => [v, i]));
    const remap = (c.variable.values ?? []).map((v) => lookup.get(v) ?? NaN);
    return Float64Array.from(d, (x) => (Number.isNaN(x) ? NaN : remap[x]));
  });
}

function impurityCls(counts: Float64Array, total: number, crit: 'entropy' | 'gini'): number {
  if (total <= 0) return 0;
  let s = 0;
  if (crit === 'gini') {
    for (let k = 0; k < counts.length; k++) { const p = counts[k] / total; s += p * p; }
    return 1 - s;
  }
  for (let k = 0; k < counts.length; k++) if (counts[k] > 0) { const p = counts[k] / total; s -= p * Math.log2(p); }
  return s;
}

export function buildTree(
  cols: Float64Array[], feats: FeatureDesc[], y: Float64Array, kind: TargetKind, nClasses: number,
  rows: Int32Array, params: TreeParams, rng?: Rng,
): TreeNode {
  const isCls = kind === 'classification';

  const summarize = (idx: Int32Array): { dist: number[]; value: number } => {
    if (isCls) {
      const dist = new Array<number>(nClasses).fill(0);
      for (let i = 0; i < idx.length; i++) dist[y[idx[i]]]++;
      let best = 0;
      for (let k = 1; k < nClasses; k++) if (dist[k] > dist[best]) best = k;
      return { dist, value: best };
    }
    let s = 0;
    for (let i = 0; i < idx.length; i++) s += y[idx[i]];
    return { dist: [], value: idx.length ? s / idx.length : NaN };
  };

  const grow = (idx: Int32Array, depth: number): TreeNode => {
    const { dist, value } = summarize(idx);
    const n = idx.length;
    const leaf: TreeNode = { leaf: true, n, dist, value };
    if (n < params.minInternal || depth >= params.maxDepth || n < 2 * params.minLeaf) return leaf;
    if (isCls) {
      const maj = Math.max(...dist) / n;
      if (maj >= params.sufficientMajority) return leaf;
    } else {
      let allSame = true;
      for (let i = 1; i < n; i++) if (y[idx[i]] !== y[idx[0]]) { allSame = false; break; }
      if (allSame) return leaf;
    }

    let candidates = feats.map((_, j) => j);
    if (params.maxFeatures && params.maxFeatures < feats.length && rng) {
      rng.shuffle(candidates);
      candidates = candidates.slice(0, params.maxFeatures);
    }

    let bestGain = 1e-12;
    let best: { feature: number; threshold?: number; equals?: number } | null = null;

    // 부모 불순도
    let parentImp: number;
    const cnt = new Float64Array(nClasses);
    if (isCls) { for (let i = 0; i < n; i++) cnt[y[idx[i]]]++; parentImp = impurityCls(cnt, n, params.criterion); } else {
      let s = 0, s2 = 0;
      for (let i = 0; i < n; i++) { const v = y[idx[i]]; s += v; s2 += v * v; }
      parentImp = s2 / n - (s / n) ** 2;
    }

    for (const j of candidates) {
      const col = cols[j];
      // 결측치가 아닌 행만 분할 평가에 사용
      const known: number[] = [];
      for (let i = 0; i < n; i++) if (!Number.isNaN(col[idx[i]])) known.push(idx[i]);
      const m = known.length;
      if (m < 2 * params.minLeaf) continue;
      const knownFrac = m / n;

      if (feats[j].kind === 'c') {
        known.sort((a, b) => col[a] - col[b]);
        if (isCls) {
          const left = new Float64Array(nClasses);
          const right = new Float64Array(nClasses);
          for (const r of known) right[y[r]]++;
          const imp0 = impurityCls(right, m, params.criterion);
          for (let i = 0; i < m - 1; i++) {
            const r = known[i];
            left[y[r]]++; right[y[r]]--;
            const nl = i + 1, nr = m - nl;
            if (col[known[i]] === col[known[i + 1]] || nl < params.minLeaf || nr < params.minLeaf) continue;
            const gain = knownFrac * (imp0 - (nl / m) * impurityCls(left, nl, params.criterion) - (nr / m) * impurityCls(right, nr, params.criterion));
            if (gain > bestGain) { bestGain = gain; best = { feature: j, threshold: (col[known[i]] + col[known[i + 1]]) / 2 }; }
          }
        } else {
          let sl = 0, sl2 = 0, sr = 0, sr2 = 0;
          for (const r of known) { sr += y[r]; sr2 += y[r] * y[r]; }
          const var0 = sr2 / m - (sr / m) ** 2;
          for (let i = 0; i < m - 1; i++) {
            const v = y[known[i]];
            sl += v; sl2 += v * v; sr -= v; sr2 -= v * v;
            const nl = i + 1, nr = m - nl;
            if (col[known[i]] === col[known[i + 1]] || nl < params.minLeaf || nr < params.minLeaf) continue;
            const vl = sl2 / nl - (sl / nl) ** 2, vr = sr2 / nr - (sr / nr) ** 2;
            const gain = knownFrac * (var0 - (nl / m) * vl - (nr / m) * vr);
            if (gain > bestGain) { bestGain = gain; best = { feature: j, threshold: (col[known[i]] + col[known[i + 1]]) / 2 }; }
          }
        }
      } else {
        const k = feats[j].values!.length;
        if (k < 2) continue;
        if (isCls) {
          const byVal = Array.from({ length: k }, () => new Float64Array(nClasses));
          const nv = new Float64Array(k);
          const tot = new Float64Array(nClasses);
          for (const r of known) { byVal[col[r]][y[r]]++; nv[col[r]]++; tot[y[r]]++; }
          const imp0 = impurityCls(tot, m, params.criterion);
          for (let v = 0; v < k; v++) {
            const nl = nv[v], nr = m - nl;
            if (nl < params.minLeaf || nr < params.minLeaf) continue;
            const rest = tot.map((t, c) => t - byVal[v][c]);
            const gain = knownFrac * (imp0 - (nl / m) * impurityCls(byVal[v], nl, params.criterion) - (nr / m) * impurityCls(rest, nr, params.criterion));
            if (gain > bestGain) { bestGain = gain; best = { feature: j, equals: v }; }
            if (k === 2) break;
          }
        } else {
          const s = new Float64Array(k), s2 = new Float64Array(k), nv = new Float64Array(k);
          let ts = 0, ts2 = 0;
          for (const r of known) { const v = y[r]; s[col[r]] += v; s2[col[r]] += v * v; nv[col[r]]++; ts += v; ts2 += v * v; }
          const var0 = ts2 / m - (ts / m) ** 2;
          for (let v = 0; v < k; v++) {
            const nl = nv[v], nr = m - nl;
            if (nl < params.minLeaf || nr < params.minLeaf) continue;
            const vl = s2[v] / nl - (s[v] / nl) ** 2;
            const vr = (ts2 - s2[v]) / nr - ((ts - s[v]) / nr) ** 2;
            const gain = knownFrac * (var0 - (nl / m) * vl - (nr / m) * vr);
            if (gain > bestGain) { bestGain = gain; best = { feature: j, equals: v }; }
            if (k === 2) break;
          }
        }
      }
    }
    if (!best || parentImp <= 0) return leaf;

    const col = cols[best.feature];
    const goesLeft = (x: number) => (best!.threshold !== undefined ? x <= best!.threshold : x === best!.equals);
    const L: number[] = [], R: number[] = [], M: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = col[idx[i]];
      if (Number.isNaN(x)) M.push(idx[i]); else (goesLeft(x) ? L : R).push(idx[i]);
    }
    // 결측치는 더 큰 가지로 보낸다
    const leftShare = L.length / Math.max(1, L.length + R.length);
    if (leftShare >= 0.5) L.push(...M); else R.push(...M);
    if (L.length < params.minLeaf || R.length < params.minLeaf) return leaf;
    return {
      leaf: false, n, dist, value, feature: best.feature, threshold: best.threshold, equals: best.equals, leftShare,
      left: grow(Int32Array.from(L), depth + 1), right: grow(Int32Array.from(R), depth + 1),
    };
  };

  return grow(rows, 0);
}

/** 한 행에 대해 잎 노드를 찾는다. 결측치는 학습 데이터가 많았던 쪽으로 보낸다. */
export function findLeaf(node: TreeNode, cols: Float64Array[], i: number): TreeNode {
  let cur = node;
  while (!cur.leaf) {
    const x = cols[cur.feature][i];
    let left: boolean;
    if (Number.isNaN(x)) left = cur.leftShare >= 0.5;
    else left = cur.threshold !== undefined ? x <= cur.threshold : x === cur.equals;
    cur = left ? cur.left : cur.right;
  }
  return cur;
}

export function treeDepth(node: TreeNode): number {
  return node.leaf ? 0 : 1 + Math.max(treeDepth(node.left), treeDepth(node.right));
}

export function treeSize(node: TreeNode): { nodes: number; leaves: number } {
  if (node.leaf) return { nodes: 1, leaves: 1 };
  const a = treeSize(node.left), b = treeSize(node.right);
  return { nodes: 1 + a.nodes + b.nodes, leaves: a.leaves + b.leaves };
}
