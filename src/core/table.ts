/**
 * Orange의 Table/Domain 개념을 열(column) 단위로 재구성한 데이터 모델.
 *
 * - continuous(수치형): Float64Array, 결측치 = NaN
 * - discrete(범주형): Float64Array에 values 배열의 인덱스 저장, 결측치 = NaN
 * - string(문자열): string[], 결측치 = ''
 *
 * Orange처럼 변수는 역할(attribute / class / meta)을 가진다.
 * 테이블은 불변(immutable)으로 취급한다. 변환 함수는 항상 새 테이블을 만들고,
 * 바뀌지 않은 열은 배열을 복사하지 않고 공유한다(메모리 절약).
 */

export type VarKind = 'continuous' | 'discrete' | 'string';
export type Role = 'attribute' | 'class' | 'meta';

export interface Variable {
  name: string;
  kind: VarKind;
  /** discrete 전용: 값 목록 */
  values?: string[];
  /** continuous 전용: 표시할 소수 자릿수 */
  decimals?: number;
}

export type ColumnData = Float64Array | string[];

export interface Column {
  variable: Variable;
  data: ColumnData;
}

export interface Table {
  name: string;
  nRows: number;
  attributes: Column[];
  classVar: Column | null;
  metas: Column[];
  /** 행 고유 ID. 선택 데이터(Selected Data) 전달과 데이터 병합 추적에 사용 */
  ids: Int32Array;
}

let nextId = 1;
export function newIds(n: number): Int32Array {
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) ids[i] = nextId++;
  return ids;
}

export function isNumericVar(v: Variable): boolean {
  return v.kind === 'continuous' || v.kind === 'discrete';
}

export function contVar(name: string, decimals = 3): Variable {
  return { name, kind: 'continuous', decimals };
}
export function discVar(name: string, values: string[]): Variable {
  return { name, kind: 'discrete', values };
}
export function strVar(name: string): Variable {
  return { name, kind: 'string' };
}

export function makeTable(
  name: string,
  attributes: Column[],
  classVar: Column | null,
  metas: Column[] = [],
  ids?: Int32Array,
): Table {
  const first = attributes[0] ?? classVar ?? metas[0];
  const nRows = first ? first.data.length : ids ? ids.length : 0;
  for (const c of [...attributes, ...(classVar ? [classVar] : []), ...metas]) {
    if (c.data.length !== nRows) throw new Error(`열 '${c.variable.name}'의 길이(${c.data.length})가 행 수(${nRows})와 다릅니다.`);
  }
  return { name, nRows, attributes, classVar, metas, ids: ids ?? newIds(nRows) };
}

export function allColumns(t: Table): Column[] {
  return [...t.attributes, ...(t.classVar ? [t.classVar] : []), ...t.metas];
}

export function columnRole(t: Table, c: Column): Role {
  if (t.classVar === c) return 'class';
  if (t.metas.includes(c)) return 'meta';
  return 'attribute';
}

export function findColumn(t: Table, name: string): Column | undefined {
  return allColumns(t).find((c) => c.variable.name === name);
}

export function isMissing(c: Column, i: number): boolean {
  const v = c.data[i];
  return typeof v === 'number' ? Number.isNaN(v) : v === '' || v === undefined;
}

export function formatValue(v: Variable, x: number | string): string {
  if (typeof x === 'string') return x === '' ? '?' : x;
  if (Number.isNaN(x)) return '?';
  if (v.kind === 'discrete') return v.values?.[x] ?? '?';
  const d = v.decimals ?? 3;
  return Number.isInteger(x) && d <= 3 ? String(x) : x.toFixed(d);
}

export function cellText(c: Column, i: number): string {
  return formatValue(c.variable, c.data[i] as number | string);
}

/** 행 인덱스로 부분 테이블을 만든다. */
export function takeRows(t: Table, idx: ArrayLike<number>, name = t.name): Table {
  const take = (c: Column): Column => {
    if (Array.isArray(c.data)) {
      const src = c.data;
      const out = new Array<string>(idx.length);
      for (let i = 0; i < idx.length; i++) out[i] = src[idx[i]];
      return { variable: c.variable, data: out };
    }
    const src = c.data as Float64Array;
    const out = new Float64Array(idx.length);
    for (let i = 0; i < idx.length; i++) out[i] = src[idx[i]];
    return { variable: c.variable, data: out };
  };
  const ids = new Int32Array(idx.length);
  for (let i = 0; i < idx.length; i++) ids[i] = t.ids[idx[i]];
  return {
    name,
    nRows: idx.length,
    attributes: t.attributes.map(take),
    classVar: t.classVar ? take(t.classVar) : null,
    metas: t.metas.map(take),
    ids,
  };
}

export function filterRows(t: Table, pred: (i: number) => boolean, name?: string): Table {
  const idx: number[] = [];
  for (let i = 0; i < t.nRows; i++) if (pred(i)) idx.push(i);
  return takeRows(t, idx, name);
}

/** ID 집합에 속하는 행만 남긴다(선택 데이터 처리). */
export function rowsByIds(t: Table, ids: Set<number>): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < t.nRows; i++) if (ids.has(t.ids[i])) out.push(i);
  return Int32Array.from(out);
}

/** 이산형 열의 값별 개수 */
export function valueCounts(c: Column): number[] {
  const k = c.variable.values?.length ?? 0;
  const counts = new Array<number>(k).fill(0);
  const d = c.data as Float64Array;
  for (let i = 0; i < d.length; i++) if (!Number.isNaN(d[i])) counts[d[i]]++;
  return counts;
}

/** 클래스 변수의 행 인덱스 배열(결측치 없는 행) */
export function rowsWithClass(t: Table): Int32Array {
  if (!t.classVar) return new Int32Array(0);
  const d = t.classVar.data as Float64Array;
  const out: number[] = [];
  for (let i = 0; i < d.length; i++) if (!Number.isNaN(d[i])) out.push(i);
  return Int32Array.from(out);
}

/** 대략적인 메모리 사용량(바이트) */
export function estimateBytes(t: Table): number {
  let b = t.ids.byteLength;
  for (const c of allColumns(t)) {
    if (Array.isArray(c.data)) {
      for (let i = 0; i < c.data.length; i++) b += 16 + c.data[i].length * 2;
    } else b += (c.data as Float64Array).byteLength;
  }
  return b;
}

export function describeTable(t: Table | null | undefined): string {
  if (!t) return '데이터 없음';
  const cls = t.classVar ? `, 목표: ${t.classVar.variable.name}` : '';
  return `${t.nRows.toLocaleString()}행 × ${t.attributes.length}변수${cls}${t.metas.length ? `, 메타 ${t.metas.length}` : ''}`;
}

export function isTable(x: unknown): x is Table {
  return !!x && typeof x === 'object' && 'attributes' in x && 'nRows' in x && 'ids' in x;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
