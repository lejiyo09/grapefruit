/**
 * CSV / TSV / Orange .tab 파서.
 *
 * 타입 추론 규칙은 Orange의 `Orange.data.variable.is_discrete_values` 와
 * `Orange.data.io_util.guess_data_type` 을 따른다.
 *  - 문자열 열: 고유값 수 ≤ round(n^0.7) 이고 100개 이하이면 범주형, 아니면 문자열(meta)
 *  - 수치 열: 고유값이 {0,1} 또는 {1,2}의 부분집합이면 범주형, 아니면 수치형
 *  - 결측치 토큰: "?", "nan", ".", "", "NA", "~"
 *
 * Orange .tab 3줄 헤더(이름 / 타입 / 플래그)와 단일 헤더 접두어("C#age", "cD#iris")도 지원한다.
 */
import { type Column, type Role, type Table, type Variable, makeTable } from './table';

export const MISSING = new Set(['?', 'nan', '.', '', 'NA', '~']);
const DISCRETE_MAX_VALUES = 3; // == 2 + nan (Orange)
const DISCRETE_MAX_ALLOWED_VALUES = 100;
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(inf|Infinity)$/i;

export function parseDelimited(text: string, delimiter?: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field); field = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = []; i++; continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 20000).split('\n').slice(0, 20);
  const cands = ['\t', ',', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of cands) {
    const counts = sample.filter((l) => l.trim()).map((l) => l.split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.filter((c) => c === counts[0]).length;
    const score = consistent * 1000 + counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Orange의 is_discrete_values. 범주형이면 고유값 Set, 아니면 false, 판정 불가면 null */
export function isDiscreteValues(values: string[]): Set<string> | false | null {
  if (!values.length) return null;
  let isNumeric = true;
  for (let k = 0; k < Math.min(3, values.length); k++) {
    const v = values[k].trim();
    if (!MISSING.has(v) && !NUM_RE.test(v)) { isNumeric = false; break; }
  }
  const maxValues = isNumeric ? DISCRETE_MAX_VALUES : Math.round(values.length ** 0.7);
  const unique = new Set<string>();
  for (const v of values) {
    unique.add(v.trim());
    if (unique.size > maxValues || unique.size > DISCRETE_MAX_ALLOWED_VALUES) return false;
  }
  for (const m of MISSING) unique.delete(m);
  if (!unique.size) return null;
  if (!isNumeric) return unique;
  const floats = new Set<number>();
  for (const u of unique) {
    if (!NUM_RE.test(u)) return unique;
    floats.add(Number(u));
  }
  const subset = (s: number[]) => [...floats].every((f) => s.includes(f));
  return subset([0, 1]) || subset([1, 2]) ? unique : false;
}

function decimalsOf(values: string[]): number {
  let d = 0;
  for (let i = 0; i < values.length && i < 5000; i++) {
    const v = values[i];
    const dot = v.indexOf('.');
    if (dot >= 0 && !/[eE]/.test(v)) d = Math.max(d, v.length - dot - 1);
  }
  return Math.min(d, 5);
}

export interface ColumnSpec {
  name: string;
  kind: 'continuous' | 'discrete' | 'string' | 'auto';
  role: Role | 'skip';
  values?: string[];
}

/** 원시 문자열 열 하나를 Column으로 변환한다. */
export function buildColumn(name: string, raw: string[], kind: ColumnSpec['kind'], values?: string[]): Column {
  const trimmed = raw.map((v) => (v ?? '').trim());
  let k = kind;
  let discreteSet: Set<string> | null = null;
  if (k === 'auto') {
    const disc = isDiscreteValues(trimmed);
    if (disc) { k = 'discrete'; discreteSet = disc; } else {
      k = trimmed.every((v) => MISSING.has(v) || NUM_RE.test(v)) ? 'continuous' : 'string';
    }
  }
  if (k === 'continuous') {
    const data = new Float64Array(trimmed.length);
    for (let i = 0; i < trimmed.length; i++) {
      const v = trimmed[i];
      data[i] = MISSING.has(v) ? NaN : Number(v);
    }
    const variable: Variable = { name, kind: 'continuous', decimals: decimalsOf(trimmed) };
    return { variable, data };
  }
  if (k === 'discrete') {
    let vals = values;
    if (!vals) {
      const set = discreteSet ?? new Set(trimmed.filter((v) => !MISSING.has(v)));
      vals = [...set].sort(naturalCompare);
    } else vals = [...vals];
    const index = new Map(vals.map((v, i) => [v, i]));
    const data = new Float64Array(trimmed.length);
    for (let i = 0; i < trimmed.length; i++) {
      const v = trimmed[i];
      if (MISSING.has(v)) { data[i] = NaN; continue; }
      let idx = index.get(v);
      if (idx === undefined) { idx = vals.length; vals.push(v); index.set(v, idx); }
      data[i] = idx;
    }
    return { variable: { name, kind: 'discrete', values: vals }, data };
  }
  return { variable: { name, kind: 'string' }, data: trimmed.map((v) => (MISSING.has(v) ? '' : v)) };
}

/** Orange .tab 헤더 2행의 값 목록("a b c\ d") 분리 */
function splitEscaped(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
    if (s[i] === ' ') { if (cur) out.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  if (cur) out.push(cur);
  return out;
}

const TYPE_TOKENS: Record<string, ColumnSpec['kind']> = {
  c: 'continuous', continuous: 'continuous', n: 'continuous', numeric: 'continuous',
  d: 'discrete', discrete: 'discrete',
  s: 'string', string: 'string', text: 'string',
  t: 'string', time: 'string',
};
const FLAG_TOKENS: Record<string, Role | 'skip'> = {
  class: 'class', c: 'class', meta: 'meta', m: 'meta', ignore: 'skip', i: 'skip', weight: 'skip', w: 'skip',
};

function isTypeRow(row: string[]): boolean {
  return row.length > 0 && row.every((t) => {
    const s = t.trim();
    return s === '' || s.toLowerCase() in TYPE_TOKENS || s.includes(' ');
  }) && row.some((t) => t.trim() !== '');
}

/** 헤더 정보로부터 열 사양을 추론한다. */
export function inferSpecs(rows: string[][]): { specs: ColumnSpec[]; dataStart: number } {
  const header = rows[0] ?? [];
  // 3줄 헤더(.tab)
  if (rows.length >= 3 && isTypeRow(rows[1])) {
    const types = rows[1];
    const flags = rows[2];
    const specs = header.map((name, j): ColumnSpec => {
      const t = (types[j] ?? '').trim();
      const f = (flags[j] ?? '').trim().toLowerCase();
      let kind: ColumnSpec['kind'] = 'auto';
      let values: string[] | undefined;
      if (t.toLowerCase() in TYPE_TOKENS) kind = TYPE_TOKENS[t.toLowerCase()];
      else if (t.includes(' ')) { kind = 'discrete'; values = splitEscaped(t); }
      let role: ColumnSpec['role'] = 'attribute';
      for (const part of f.split(/\s+/)) if (part in FLAG_TOKENS) role = FLAG_TOKENS[part];
      if (kind === 'string' && role === 'attribute') role = 'meta';
      return { name: name.trim(), kind, role, values };
    });
    return { specs, dataStart: 3 };
  }
  // 단일 헤더 접두어 형식: "cD#name"
  const specs = header.map((h): ColumnSpec => {
    const m = /^([cmiCDST]{1,2})#(.*)$/.exec(h.trim());
    if (!m) return { name: h.trim(), kind: 'auto', role: 'attribute' };
    let kind: ColumnSpec['kind'] = 'auto';
    let role: ColumnSpec['role'] = 'attribute';
    for (const ch of m[1]) {
      if (ch === 'C') kind = 'continuous';
      else if (ch === 'D') kind = 'discrete';
      else if (ch === 'S' || ch === 'T') kind = 'string';
      else if (ch === 'c') role = 'class';
      else if (ch === 'm') role = 'meta';
      else if (ch === 'i') role = 'skip';
    }
    if (kind === 'string' && role === 'attribute') role = 'meta';
    return { name: m[2], kind, role };
  });
  return { specs, dataStart: 1 };
}

export interface ParseResult {
  table: Table;
  specs: ColumnSpec[];
  warnings: string[];
}

/** 텍스트 → Table. overrides로 열별 타입/역할을 바꿀 수 있다(File 위젯의 도메인 편집기). */
export function parseTable(text: string, name: string, overrides?: Record<string, Partial<ColumnSpec>>): ParseResult {
  const rows = parseDelimited(text);
  if (!rows.length) throw new Error('빈 파일입니다.');
  const { specs: inferred, dataStart } = inferSpecs(rows);
  const warnings: string[] = [];
  const ncol = inferred.length;
  // 중복/빈 열 이름 처리 (Orange도 고유한 이름을 만든다)
  const seen = new Map<string, number>();
  inferred.forEach((s, j) => {
    if (!s.name) s.name = `Feature ${j + 1}`;
    const c = seen.get(s.name) ?? 0;
    if (c) { const nn = `${s.name} (${c + 1})`; warnings.push(`중복된 열 이름 '${s.name}'을 '${nn}'으로 바꿨습니다.`); s.name = nn; }
    seen.set(s.name, c + 1);
  });
  const body = rows.slice(dataStart);
  let ragged = 0;
  const raw: string[][] = inferred.map(() => new Array<string>(body.length));
  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    if (r.length !== ncol) ragged++;
    for (let j = 0; j < ncol; j++) raw[j][i] = r[j] ?? '';
  }
  if (ragged) warnings.push(`${ragged}개 행의 열 개수가 헤더와 다릅니다. 부족한 값은 결측치로 처리했습니다.`);

  const attributes: Column[] = [];
  const metas: Column[] = [];
  let classVar: Column | null = null;
  const finalSpecs: ColumnSpec[] = [];
  inferred.forEach((s0, j) => {
    const s = { ...s0, ...(overrides?.[s0.name] ?? {}) } as ColumnSpec;
    if (s.role === 'skip') { finalSpecs.push(s); return; }
    const col = buildColumn(s.name, raw[j], s.kind, s.kind === s0.kind ? s0.values : undefined);
    let role = s.role;
    // 자동 추론으로 문자열이 된 열은 Orange처럼 메타로 보낸다.
    if (col.variable.kind === 'string' && role !== 'meta') role = 'meta';
    finalSpecs.push({ ...s, kind: col.variable.kind, role });
    if (role === 'class') {
      if (classVar) { warnings.push(`목표 변수는 하나만 지원합니다. '${s.name}'은 메타로 이동했습니다.`); metas.push(col); }
      else classVar = col;
    } else if (role === 'meta') metas.push(col);
    else attributes.push(col);
  });
  return { table: makeTable(name, attributes, classVar, metas), specs: finalSpecs, warnings };
}

function escapeField(s: string, delim: string): string {
  return /["\n\r]/.test(s) || s.includes(delim) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Table → CSV 또는 Orange .tab 텍스트 */
export function serializeTable(t: Table, format: 'csv' | 'tab'): string {
  const cols = [...t.attributes, ...(t.classVar ? [t.classVar] : []), ...t.metas];
  const delim = format === 'csv' ? ',' : '\t';
  const lines: string[] = [];
  lines.push(cols.map((c) => escapeField(c.variable.name, delim)).join(delim));
  if (format === 'tab') {
    lines.push(cols.map((c) => (c.variable.kind === 'continuous' ? 'c' : c.variable.kind === 'discrete' ? 'd' : 's')).join(delim));
    lines.push(cols.map((c) => (c === t.classVar ? 'class' : t.metas.includes(c) ? 'meta' : '')).join(delim));
  }
  const miss = format === 'tab' ? '?' : '';
  for (let i = 0; i < t.nRows; i++) {
    lines.push(cols.map((c) => {
      const x = c.data[i];
      if (typeof x === 'string') return escapeField(x, delim);
      if (Number.isNaN(x)) return miss;
      return escapeField(c.variable.kind === 'discrete' ? c.variable.values![x] : String(x), delim);
    }).join(delim));
  }
  return lines.join('\n') + '\n';
}
