/**
 * 학습용 특징 행렬 변환기.
 * Orange SklLearner의 기본 전처리(Continuize → RemoveNaNColumns → SklImpute)를 따른다.
 *  - 범주형: 값마다 지시변수(one-hot, Continuize.Indicators)
 *  - 결측치: 학습 데이터의 평균으로 대체(SklImpute)
 *  - normalize=true 이면 평균 0, 표준편차 1로 표준화(k-Means, PCA 등에서 사용)
 * 학습 시 만든 Encoder를 모델에 저장해 두고, 예측할 때 같은 변환을 적용한다.
 */
import { type Table, type Column, findColumn } from '../core/table';
import { mean, std } from '../core/stats';

export type FeatureEnc =
  | { name: string; kind: 'c'; mean: number; scale: number }
  | { name: string; kind: 'd'; values: string[]; freqs: number[] };

export interface Encoder {
  features: FeatureEnc[];
  normalize: boolean;
  outNames: string[];
}

export interface Matrix {
  X: Float64Array; // row-major n×p
  n: number;
  p: number;
}

export function fitEncoder(t: Table, normalize = false): Encoder {
  const features: FeatureEnc[] = [];
  const outNames: string[] = [];
  for (const c of t.attributes) {
    const v = c.variable;
    const d = c.data as Float64Array;
    if (v.kind === 'continuous') {
      const m = mean(d);
      if (Number.isNaN(m)) continue; // RemoveNaNColumns
      const s = normalize ? std(d) : 1;
      features.push({ name: v.name, kind: 'c', mean: m, scale: s > 1e-12 ? s : 1 });
      outNames.push(v.name);
    } else if (v.kind === 'discrete') {
      const k = v.values!.length;
      const counts = new Array<number>(k).fill(0);
      let tot = 0;
      for (let i = 0; i < d.length; i++) if (!Number.isNaN(d[i])) { counts[d[i]]++; tot++; }
      if (!tot) continue;
      features.push({ name: v.name, kind: 'd', values: [...v.values!], freqs: counts.map((c2) => c2 / tot) });
      for (const val of v.values!) outNames.push(`${v.name}=${val}`);
    }
  }
  return { features, normalize, outNames };
}

function mapDiscrete(col: Column, values: string[]): Int32Array {
  const src = col.variable.values ?? [];
  const lookup = new Map(values.map((v, i) => [v, i]));
  const remap = src.map((v) => lookup.get(v) ?? -1);
  const d = col.data as Float64Array;
  const out = new Int32Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = Number.isNaN(d[i]) ? -1 : remap[d[i]];
  return out;
}

export function encode(enc: Encoder, t: Table): Matrix {
  const n = t.nRows;
  const p = enc.outNames.length;
  const X = new Float64Array(n * p);
  let j = 0;
  for (const f of enc.features) {
    const col = findColumn(t, f.name);
    if (!col) throw new Error(`입력 데이터에 모델 학습에 사용한 변수 '${f.name}'이(가) 없습니다.`);
    if (f.kind === 'c') {
      if (col.variable.kind !== 'continuous') throw new Error(`변수 '${f.name}'의 타입이 학습 때와 다릅니다.`);
      const d = col.data as Float64Array;
      for (let i = 0; i < n; i++) {
        const v = Number.isNaN(d[i]) ? f.mean : d[i];
        X[i * p + j] = enc.normalize ? (v - f.mean) / f.scale : v;
      }
      j++;
    } else {
      if (col.variable.kind !== 'discrete') throw new Error(`변수 '${f.name}'의 타입이 학습 때와 다릅니다.`);
      const idx = mapDiscrete(col, f.values);
      const k = f.values.length;
      for (let i = 0; i < n; i++) {
        const vi = idx[i];
        for (let a = 0; a < k; a++) X[i * p + j + a] = vi < 0 ? f.freqs[a] : vi === a ? 1 : 0;
      }
      j += k;
    }
  }
  return { X, n, p };
}

export type TargetKind = 'classification' | 'regression';

export interface Target {
  kind: TargetKind;
  name: string;
  y: Float64Array;
  classValues?: string[];
}

export function getTarget(t: Table): Target {
  const c = t.classVar;
  if (!c) throw new Error('목표 변수(target)가 없습니다. Select Columns 위젯에서 목표 변수를 지정하세요.');
  if (c.variable.kind === 'discrete') {
    return { kind: 'classification', name: c.variable.name, y: c.data as Float64Array, classValues: [...c.variable.values!] };
  }
  if (c.variable.kind === 'continuous') return { kind: 'regression', name: c.variable.name, y: c.data as Float64Array };
  throw new Error('문자열 변수는 목표 변수로 사용할 수 없습니다.');
}

/** 테이블의 목표 변수 값을 학습 때의 클래스 값 순서로 재매핑 */
export function targetIn(t: Table, name: string, classValues?: string[]): Float64Array | null {
  const c = t.classVar && t.classVar.variable.name === name ? t.classVar : findColumn(t, name);
  if (!c || c.variable.kind === 'string') return null;
  const d = c.data as Float64Array;
  if (!classValues) return d;
  const m = mapDiscrete(c, classValues);
  return Float64Array.from(m, (v) => (v < 0 ? NaN : v));
}
