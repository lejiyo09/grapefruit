/** Transform 카테고리: Select Columns, Select Rows, Data Sampler, Impute, Continuize, Discretize, Unique, Randomize, Transpose, Concatenate, Merge Data */
import { registerWidget } from '../engine/registry';
import type { ViewApi } from '../engine/types';
import {
  type Table, type Column, type Variable, type Role, allColumns, columnRole, findColumn, takeRows, makeTable,
  newIds, valueCounts, cellText,
} from '../core/table';
import { mean, std, minMax } from '../core/stats';
import { formatNumber } from '../core/stats';
import { splitEqFreq } from '../ml/models';
import { Rng, range } from '../ml/random';
import { h } from '../ui/dom';
import { box, checkbox, combo, note, radio, spin, button, varBadge, emptyMain, row } from '../ui/controls';
import { waiting, tableInput } from './common';

const RANDOM_SEED = 42; // Orange 위젯 공통 고정 시드

/** 여러 소스(열 + 행 인덱스, -1은 결측)에서 하나의 열을 만든다. 범주형 값은 이름 기준으로 합친다. */
export function gatherColumn(variable: Variable, parts: Array<{ col: Column | undefined; rows: ArrayLike<number> }>): Column {
  const n = parts.reduce((s, p) => s + p.rows.length, 0);
  if (variable.kind === 'string') {
    const out = new Array<string>(n);
    let k = 0;
    for (const p of parts) for (let i = 0; i < p.rows.length; i++) {
      const r = p.rows[i];
      out[k++] = !p.col || r < 0 ? '' : typeof p.col.data[r] === 'string' ? (p.col.data[r] as string) : cellText(p.col, r).replace(/^\?$/, '');
    }
    return { variable, data: out };
  }
  const out = new Float64Array(n);
  let values = variable.values ? [...variable.values] : undefined;
  let k = 0;
  for (const p of parts) {
    let remap: number[] | null = null;
    if (variable.kind === 'discrete' && p.col) {
      const src = p.col.variable.values ?? [];
      remap = src.map((v) => {
        let idx = values!.indexOf(v);
        if (idx < 0) { values!.push(v); idx = values!.length - 1; }
        return idx;
      });
    }
    for (let i = 0; i < p.rows.length; i++) {
      const r = p.rows[i];
      if (!p.col || r < 0) { out[k++] = NaN; continue; }
      const x = p.col.data[r];
      if (typeof x === 'string') { out[k++] = variable.kind === 'continuous' ? Number(x) || NaN : NaN; continue; }
      out[k++] = Number.isNaN(x) ? NaN : remap ? remap[x] : x;
    }
  }
  if (values) variable = { ...variable, values };
  return { variable, data: out };
}

// ------------------------------------------------------------------ Select Columns
type ColRole = Role | 'ignore';
interface SelectColumnsSettings { roles: Record<string, ColRole> }

registerWidget({
  type: 'transform.selectcolumns',
  name: 'Select Columns',
  category: 'transform',
  abbr: 'SC',
  description: '변수의 역할(특징/목표/메타/무시)을 지정합니다.',
  keywords: ['features', 'target', 'class', 'meta', '열 선택', '목표 변수'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [640, 520],
  defaultSettings: (): SelectColumnsSettings => ({ roles: {} }),
  execute(inputs, s: SelectColumnsSettings, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const attributes: Column[] = [], metas: Column[] = [];
    let classVar: Column | null = null;
    for (const c of allColumns(t)) {
      let role: ColRole = s.roles[c.variable.name] ?? columnRole(t, c);
      if (role === 'ignore') continue;
      if (role === 'attribute' && c.variable.kind === 'string') { ctx.warn(`문자열 변수 '${c.variable.name}'은(는) 특징이 될 수 없어 메타로 옮겼습니다.`); role = 'meta'; }
      if (role === 'class') {
        if (classVar) { ctx.warn(`목표 변수는 하나만 지원합니다. '${c.variable.name}'은(는) 메타로 옮겼습니다.`); role = 'meta'; }
        else if (c.variable.kind === 'string') { ctx.warn(`문자열 변수 '${c.variable.name}'은(는) 목표가 될 수 없습니다.`); role = 'meta'; }
        else { classVar = c; continue; }
      }
      (role === 'meta' ? metas : attributes).push(c);
    }
    return { outputs: { data: { ...t, attributes, classVar, metas } } };
  },
  render({ controls, main }, api: ViewApi<SelectColumnsSettings>) {
    const t = tableInput(api.inputs.data);
    controls.appendChild(note('각 변수의 역할을 고르세요. 분류/회귀 모델을 학습하려면 목표(Target) 변수가 하나 필요합니다.'));
    controls.appendChild(button('원래대로', () => api.update({ roles: {} })));
    if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
    const filter = h('input', { type: 'search', placeholder: '변수 검색…', class: 'search' });
    const roleNames: Array<[ColRole, string]> = [['attribute', 'Feature'], ['class', 'Target'], ['meta', 'Meta'], ['ignore', 'Ignored']];
    const tbody = h('tbody');
    const rowsEls = allColumns(t).map((c) => {
      const cur = api.settings.roles[c.variable.name] ?? columnRole(t, c);
      const sel = h('select', null, ...roleNames.map(([v, l]) => h('option', { value: v }, l)));
      sel.value = cur;
      sel.addEventListener('change', () => api.update({ roles: { ...api.settings.roles, [c.variable.name]: sel.value as ColRole } }));
      const tr = h('tr', { 'data-name': c.variable.name.toLowerCase() }, h('td', null, varBadge(c)), h('td', null, c.variable.name), h('td', null, sel));
      tbody.appendChild(tr);
      return tr;
    });
    filter.addEventListener('input', () => {
      const q = filter.value.toLowerCase();
      for (const r of rowsEls) r.style.display = r.dataset.name!.includes(q) ? '' : 'none';
    });
    main.appendChild(filter);
    main.appendChild(h('div', { class: 'main-scroll' }, h('table', { class: 'grid-table' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, '변수'), h('th', null, '역할'))), tbody)));
  },
});

// ------------------------------------------------------------------ Select Rows
interface Condition { variable: string; op: string; a: string; b: string }
const OPS: Record<'continuous' | 'discrete' | 'string', Array<[string, string]>> = {
  continuous: [['eq', 'equals'], ['ne', 'is not'], ['lt', 'is below'], ['le', 'is at most'], ['gt', 'is greater than'], ['ge', 'is at least'], ['between', 'is between'], ['outside', 'is outside'], ['defined', 'is defined']],
  discrete: [['is', 'is'], ['isnot', 'is not'], ['oneof', 'is one of'], ['defined', 'is defined']],
  string: [['eq', 'equals'], ['ne', 'is not'], ['contains', 'contains'], ['begins', 'begins with'], ['ends', 'ends with'], ['defined', 'is defined']],
};

function conditionTest(t: Table, c: Condition): ((i: number) => boolean) | null {
  const col = findColumn(t, c.variable);
  if (!col) return null;
  const k = col.variable.kind;
  if (k === 'string') {
    const d = col.data as string[];
    const a = c.a;
    switch (c.op) {
      case 'eq': return (i) => d[i] === a;
      case 'ne': return (i) => d[i] !== a;
      case 'contains': return (i) => d[i].includes(a);
      case 'begins': return (i) => d[i].startsWith(a);
      case 'ends': return (i) => d[i].endsWith(a);
      default: return (i) => d[i] !== '';
    }
  }
  const d = col.data as Float64Array;
  if (k === 'discrete') {
    const vals = col.variable.values!;
    const set = new Set(c.a.split('|').map((v) => vals.indexOf(v)).filter((x) => x >= 0));
    const one = vals.indexOf(c.a);
    switch (c.op) {
      case 'is': return (i) => d[i] === one;
      case 'isnot': return (i) => !Number.isNaN(d[i]) && d[i] !== one;
      case 'oneof': return (i) => set.has(d[i]);
      default: return (i) => !Number.isNaN(d[i]);
    }
  }
  const a = Number(c.a), b = Number(c.b);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  switch (c.op) {
    case 'eq': return (i) => d[i] === a;
    case 'ne': return (i) => !Number.isNaN(d[i]) && d[i] !== a;
    case 'lt': return (i) => d[i] < a;
    case 'le': return (i) => d[i] <= a;
    case 'gt': return (i) => d[i] > a;
    case 'ge': return (i) => d[i] >= a;
    case 'between': return (i) => d[i] >= lo && d[i] <= hi;
    case 'outside': return (i) => d[i] < lo || d[i] > hi;
    default: return (i) => !Number.isNaN(d[i]);
  }
}

registerWidget({
  type: 'transform.selectrows',
  name: 'Select Rows',
  category: 'transform',
  abbr: 'SR',
  description: '조건에 맞는 행을 골라냅니다(모든 조건을 만족하는 행).',
  keywords: ['filter', 'query', '필터', '조건'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'matching', name: 'Matching Data', type: 'Data', default: true }, { id: 'unmatched', name: 'Unmatched Data', type: 'Data' }],
  windowSize: [640, 420],
  controlsOnly: true,
  defaultSettings: () => ({ conditions: [] as Condition[] }),
  execute(inputs, s: { conditions: Condition[] }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const tests = s.conditions.map((c) => {
      const f = conditionTest(t, c);
      if (!f) ctx.warn(`변수 '${c.variable}'이(가) 입력 데이터에 없어 조건을 무시했습니다.`);
      return f;
    }).filter(Boolean) as Array<(i: number) => boolean>;
    const yes: number[] = [], no: number[] = [];
    for (let i = 0; i < t.nRows; i++) (tests.every((f) => f(i)) ? yes : no).push(i);
    return { outputs: { matching: yes.length ? takeRows(t, yes) : null, unmatched: no.length ? takeRows(t, no) : null }, view: { yes: yes.length, no: no.length } };
  },
  render({ controls }, api) {
    const t = tableInput(api.inputs.data);
    if (!t) { controls.appendChild(note('입력 데이터가 없습니다.', 'warn')); return; }
    const conds = api.settings.conditions as Condition[];
    const cols = allColumns(t);
    const list = h('div', { class: 'cond-list' });
    const commit = (next: Condition[]) => api.update({ conditions: next });
    conds.forEach((c, idx) => {
      const col = findColumn(t, c.variable);
      const varSel = h('select', null, ...cols.map((cc) => h('option', { value: cc.variable.name }, cc.variable.name)));
      varSel.value = c.variable;
      varSel.addEventListener('change', () => {
        const nc = findColumn(t, varSel.value)!;
        const next = [...conds];
        next[idx] = { variable: varSel.value, op: OPS[nc.variable.kind][0][0], a: nc.variable.kind === 'discrete' ? nc.variable.values![0] ?? '' : '', b: '' };
        commit(next);
      });
      const kind = col?.variable.kind ?? 'continuous';
      const opSel = h('select', null, ...OPS[kind].map(([v, l]) => h('option', { value: v }, l)));
      opSel.value = c.op;
      opSel.addEventListener('change', () => { const next = [...conds]; next[idx] = { ...c, op: opSel.value }; commit(next); });
      const valueEls: HTMLElement[] = [];
      if (c.op !== 'defined') {
        if (kind === 'discrete' && c.op !== 'oneof') {
          const vs = h('select', null, ...col!.variable.values!.map((v) => h('option', { value: v }, v)));
          vs.value = c.a;
          vs.addEventListener('change', () => { const next = [...conds]; next[idx] = { ...c, a: vs.value }; commit(next); });
          valueEls.push(vs);
        } else if (kind === 'discrete') {
          const chosen = new Set(c.a.split('|').filter(Boolean));
          valueEls.push(h('div', { class: 'oneof' }, ...col!.variable.values!.map((v) => {
            const cb = h('input', { type: 'checkbox', checked: chosen.has(v) });
            cb.addEventListener('change', () => { if (cb.checked) chosen.add(v); else chosen.delete(v); const next = [...conds]; next[idx] = { ...c, a: [...chosen].join('|') }; commit(next); });
            return h('label', { class: 'ctl-check' }, cb, v);
          })));
        } else {
          const ia = h('input', { type: kind === 'continuous' ? 'number' : 'text', value: c.a, step: 'any' });
          ia.addEventListener('change', () => { const next = [...conds]; next[idx] = { ...c, a: ia.value }; commit(next); });
          valueEls.push(ia);
          if (c.op === 'between' || c.op === 'outside') {
            const ib = h('input', { type: 'number', value: c.b, step: 'any' });
            ib.addEventListener('change', () => { const next = [...conds]; next[idx] = { ...c, b: ib.value }; commit(next); });
            valueEls.push(h('span', null, ' ~ '), ib);
          }
        }
      }
      list.appendChild(h('div', { class: 'cond-row' }, varSel, opSel, ...valueEls,
        h('button', { class: 'icon-btn', title: '조건 삭제', 'aria-label': '조건 삭제', onclick: () => commit(conds.filter((_, j) => j !== idx)) }, '×')));
    });
    controls.appendChild(box('조건 (모두 만족)', list,
      button('+ 조건 추가', () => {
        const c0 = cols[0];
        commit([...conds, { variable: c0.variable.name, op: OPS[c0.variable.kind][0][0], a: c0.variable.kind === 'discrete' ? c0.variable.values![0] ?? '' : '', b: '' }]);
      }),
      button('모두 삭제', () => commit([]))));
    const v = api.view as { yes: number; no: number } | null;
    if (v) controls.appendChild(box('결과', h('div', { class: 'info-text' }, `입력 ${t.nRows}행 → 일치 ${v.yes}행, 불일치 ${v.no}행`)));
  },
});

// ------------------------------------------------------------------ Data Sampler
interface SamplerSettings { samplingType: 'proportion' | 'size' | 'cv' | 'bootstrap'; proportion: number; size: number; replacement: boolean; folds: number; selectedFold: number; useSeed: boolean; stratify: boolean }

function stratifiedOrder(t: Table, rng: Rng): Int32Array {
  // 클래스별로 섞은 뒤 교차 배치해 앞부분이 클래스 비율을 유지하게 한다
  const groups = new Map<number, number[]>();
  const y = t.classVar && t.classVar.variable.kind === 'discrete' ? (t.classVar.data as Float64Array) : null;
  for (let i = 0; i < t.nRows; i++) { const k = y ? y[i] : 0; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(i); }
  const keyed: Array<[number, number]> = [];
  for (const rows of groups.values()) { rng.shuffle(rows); rows.forEach((r, j) => keyed.push([(j + rng.next()) / rows.length, r])); }
  keyed.sort((a, b) => a[0] - b[0]);
  return Int32Array.from(keyed.map((k) => k[1]));
}

registerWidget({
  type: 'transform.sampler',
  name: 'Data Sampler',
  category: 'transform',
  abbr: 'Smp',
  description: '데이터에서 표본을 뽑습니다(비율, 개수, 교차검증 폴드, 부트스트랩).',
  keywords: ['sample', 'split', 'train test', '표본', '분할'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'sample', name: 'Data Sample', type: 'Data', default: true }, { id: 'remaining', name: 'Remaining Data', type: 'Data' }],
  windowSize: [420, 520],
  controlsOnly: true,
  defaultSettings: (): SamplerSettings => ({ samplingType: 'proportion', proportion: 70, size: 1, replacement: false, folds: 10, selectedFold: 1, useSeed: true, stratify: false }),
  execute(inputs, s: SamplerSettings, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const rng = new Rng(s.useSeed ? RANDOM_SEED : (Math.random() * 2 ** 32) >>> 0);
    const n = t.nRows;
    let sample: number[] = [], rest: number[] = [];
    if (s.samplingType === 'bootstrap') {
      const counts = new Uint32Array(n);
      for (let i = 0; i < n; i++) { const r = rng.int(n); sample.push(r); counts[r]++; }
      for (let i = 0; i < n; i++) if (!counts[i]) rest.push(i);
    } else if (s.samplingType === 'size' && s.replacement) {
      for (let i = 0; i < s.size; i++) sample.push(rng.int(n));
      const used = new Set(sample);
      rest = Array.from(range(n)).filter((i) => !used.has(i));
    } else {
      const order = s.stratify ? stratifiedOrder(t, rng) : (() => { const o = range(n); rng.shuffle(o); return o; })();
      if (s.samplingType === 'cv') {
        const k = Math.max(2, Math.min(s.folds, n));
        const f = Math.min(k, Math.max(1, s.selectedFold)) - 1;
        // Orange: 선택한 폴드를 제외한 나머지가 Data Sample, 선택한 폴드가 Remaining Data
        Array.from(order).forEach((r, j) => ((j % k) === f ? rest : sample).push(r));
      } else {
        const m = s.samplingType === 'size' ? Math.min(n, s.size) : Math.round((n * s.proportion) / 100);
        if (s.samplingType === 'size' && s.size > n) ctx.warn('표본 크기가 데이터보다 커서 전체 데이터를 출력합니다.');
        sample = Array.from(order.subarray(0, m));
        rest = Array.from(order.subarray(m));
      }
      sample.sort((a, b) => a - b); rest.sort((a, b) => a - b);
    }
    return {
      outputs: { sample: sample.length ? takeRows(t, sample) : null, remaining: rest.length ? takeRows(t, rest) : null },
      view: { sample: sample.length, rest: rest.length, n },
    };
  },
  render({ controls }, api: ViewApi<SamplerSettings>) {
    const s = api.settings;
    controls.appendChild(box('표본 추출 방식',
      radio(api, 'samplingType', null, [['proportion', '비율 고정 (Fixed proportion)'], ['size', '개수 고정 (Fixed sample size)'], ['cv', '교차검증 폴드 (Cross validation)'], ['bootstrap', '부트스트랩 (Bootstrap)']]),
      s.samplingType === 'proportion' ? spin(api, 'proportion', '비율 (%)', 1, 100) : null,
      s.samplingType === 'size' ? spin(api, 'size', '표본 크기', 1, 10_000_000) : null,
      s.samplingType === 'size' ? checkbox(api, 'replacement', '복원 추출') : null,
      s.samplingType === 'cv' ? spin(api, 'folds', '폴드 수', 2, 100) : null,
      s.samplingType === 'cv' ? spin(api, 'selectedFold', '선택한 폴드', 1, 100) : null));
    controls.appendChild(box('옵션', checkbox(api, 'useSeed', '재현 가능한 표본 (고정 시드)'), checkbox(api, 'stratify', '층화 추출 (목표 변수 비율 유지)')));
    const v = api.view as { sample: number; rest: number; n: number } | null;
    if (v) controls.appendChild(box('결과', h('div', { class: 'info-text' }, `입력 ${v.n}행 → 표본 ${v.sample}행, 나머지 ${v.rest}행`)));
  },
});

// ------------------------------------------------------------------ Impute
type ImputeMethod = 'leave' | 'average' | 'value' | 'random' | 'drop';
registerWidget({
  type: 'transform.impute',
  name: 'Impute',
  category: 'transform',
  abbr: 'Imp',
  description: '결측치를 평균/최빈값, 고정값, 무작위 값으로 채우거나 해당 행을 제거합니다.',
  keywords: ['missing', 'nan', '결측치'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [420, 400],
  controlsOnly: true,
  // Orange 기본값: "Don't impute" (OWImpute._default_method_index = Method.Leave)
  defaultSettings: () => ({ method: 'leave' as ImputeMethod, value: 0 }),
  execute(inputs, s: { method: ImputeMethod; value: number }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    if (s.method === 'leave') return { outputs: { data: t } };
    if (s.method === 'drop') {
      const keep: number[] = [];
      for (let i = 0; i < t.nRows; i++) if (t.attributes.every((c) => !Number.isNaN((c.data as Float64Array)[i]))) keep.push(i);
      return { outputs: { data: takeRows(t, keep) }, view: { removed: t.nRows - keep.length } };
    }
    const rng = new Rng(RANDOM_SEED);
    let filled = 0;
    const attributes = t.attributes.map((c) => {
      const d = c.data as Float64Array;
      let fill: () => number;
      if (s.method === 'average') {
        if (c.variable.kind === 'discrete') { const cnt = valueCounts(c); const m = cnt.indexOf(Math.max(...cnt)); fill = () => m; }
        else { const m = mean(d); fill = () => m; }
      } else if (s.method === 'value') {
        fill = () => (c.variable.kind === 'discrete' ? 0 : s.value);
      } else {
        const known = d.filter((x) => !Number.isNaN(x));
        fill = () => (known.length ? known[rng.int(known.length)] : NaN);
      }
      if (!d.some((x) => Number.isNaN(x))) return c;
      const out = Float64Array.from(d, (x) => { if (Number.isNaN(x)) { filled++; return fill(); } return x; });
      return { variable: c.variable, data: out };
    });
    return { outputs: { data: { ...t, attributes } }, view: { filled } };
  },
  render({ controls }, api) {
    controls.appendChild(box('기본 방법', radio(api, 'method', null, [
      ['leave', "대체하지 않음 (Don't impute)"], ['average', '평균/최빈값 (Average/Most frequent)'], ['value', '고정값 (Fixed value)'],
      ['random', '무작위 값 (Random values)'], ['drop', '결측 행 제거 (Remove instances with unknown values)']]),
      api.settings.method === 'value' ? spin(api, 'value', '수치형 고정값', -1e12, 1e12, 0.1) : null,
      api.settings.method === 'value' ? note('범주형 변수는 첫 번째 값으로 채웁니다.') : null));
    const v = api.view as { filled?: number; removed?: number } | null;
    if (v?.filled !== undefined) controls.appendChild(note(`${v.filled}개 값을 채웠습니다.`));
    if (v?.removed !== undefined) controls.appendChild(note(`${v.removed}개 행을 제거했습니다.`));
  },
});

// ------------------------------------------------------------------ Continuize
type CatTreat = 'firstAsBase' | 'mostFrequentAsBase' | 'indicators' | 'remove' | 'ordinal' | 'normalizedOrdinal';
type NumTreat = 'leave' | 'standardize' | 'center' | 'scale' | 'normalize01' | 'normalize11';
registerWidget({
  type: 'transform.continuize',
  name: 'Continuize',
  category: 'transform',
  abbr: 'Cnt',
  description: '범주형 변수를 수치형으로 바꾸고(원-핫 등), 수치형 변수를 표준화/정규화합니다.',
  keywords: ['one-hot', 'dummy', 'normalize', 'standardize', '정규화', '표준화'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [460, 520],
  controlsOnly: true,
  defaultSettings: () => ({ categorical: 'firstAsBase' as CatTreat, numeric: 'leave' as NumTreat }),
  execute(inputs, s: { categorical: CatTreat; numeric: NumTreat }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const attributes: Column[] = [];
    for (const c of t.attributes) {
      const d = c.data as Float64Array;
      if (c.variable.kind === 'discrete') {
        const vals = c.variable.values!;
        if (s.categorical === 'remove') continue;
        if (s.categorical === 'ordinal' || s.categorical === 'normalizedOrdinal') {
          const div = s.categorical === 'normalizedOrdinal' ? Math.max(1, vals.length - 1) : 1;
          attributes.push({ variable: { name: c.variable.name, kind: 'continuous', decimals: s.categorical === 'ordinal' ? 0 : 3 }, data: Float64Array.from(d, (x) => x / div) });
          continue;
        }
        let base = -1;
        if (s.categorical === 'firstAsBase') base = 0;
        if (s.categorical === 'mostFrequentAsBase') { const cnt = valueCounts(c); base = cnt.indexOf(Math.max(...cnt)); }
        if (vals.length === 2 && base >= 0) {
          const other = 1 - base;
          attributes.push({ variable: { name: `${c.variable.name}=${vals[other]}`, kind: 'continuous', decimals: 0 }, data: Float64Array.from(d, (x) => (Number.isNaN(x) ? NaN : x === other ? 1 : 0)) });
          continue;
        }
        vals.forEach((v, vi) => {
          if (vi === base) return;
          attributes.push({ variable: { name: `${c.variable.name}=${v}`, kind: 'continuous', decimals: 0 }, data: Float64Array.from(d, (x) => (Number.isNaN(x) ? NaN : x === vi ? 1 : 0)) });
        });
      } else if (c.variable.kind === 'continuous') {
        if (s.numeric === 'leave') { attributes.push(c); continue; }
        const m = mean(d), sd = std(d);
        const [lo, hi] = minMax(d.filter((x) => !Number.isNaN(x)));
        const span = hi - lo || 1;
        const f: (x: number) => number = {
          standardize: (x: number) => (x - m) / (sd || 1),
          center: (x: number) => x - m,
          scale: (x: number) => x / (sd || 1),
          normalize01: (x: number) => (x - lo) / span,
          normalize11: (x: number) => (2 * (x - lo)) / span - 1,
        }[s.numeric];
        attributes.push({ variable: { ...c.variable, decimals: 3 }, data: Float64Array.from(d, f) });
      }
    }
    return { outputs: { data: { ...t, attributes } } };
  },
  render({ controls }, api) {
    controls.appendChild(box('범주형 변수', radio(api, 'categorical', null, [
      ['firstAsBase', '첫 번째 값을 기준 (First value as base)'], ['mostFrequentAsBase', '최빈값을 기준 (Most frequent as base)'],
      ['indicators', '원-핫 인코딩 (One-hot encoding)'], ['remove', '제거 (Remove)'], ['ordinal', '순서형 정수 (Treat as ordinal)'], ['normalizedOrdinal', '정규화된 순서형 (Divide by number of values)']])));
    controls.appendChild(box('수치형 변수', radio(api, 'numeric', null, [
      ['leave', '그대로 (Keep as it is)'], ['standardize', '표준화 μ=0, σ²=1'], ['center', '중심화 μ=0'], ['scale', '스케일 σ²=1'],
      ['normalize11', '구간 [-1, 1]로 정규화'], ['normalize01', '구간 [0, 1]로 정규화']])));
    controls.appendChild(note('목표 변수와 메타 변수는 바꾸지 않습니다.'));
  },
});

// ------------------------------------------------------------------ Discretize
export function discretizeColumn(c: Column, method: 'eqfreq' | 'eqwidth', n: number): Column | null {
  const d = c.data as Float64Array;
  let cuts: number[];
  if (method === 'eqfreq') cuts = [...new Set(splitEqFreq(d, n))];
  else {
    const [lo, hi] = minMax(d.filter((x) => !Number.isNaN(x)));
    if (!Number.isFinite(lo) || lo === hi) return null;
    const w = (hi - lo) / n;
    cuts = Array.from({ length: n - 1 }, (_, i) => lo + w * (i + 1));
  }
  if (!cuts.length) return null;
  const dec = Math.max(c.variable.decimals ?? 2, 1) + 1;
  const f = (x: number) => formatNumber(Number(x.toFixed(dec)), dec);
  const values = cuts.length ? ['< ' + f(cuts[0]), ...cuts.slice(1).map((ct, i) => `${f(cuts[i])} - ${f(ct)}`), '≥ ' + f(cuts[cuts.length - 1])] : [];
  const data = Float64Array.from(d, (x) => { if (Number.isNaN(x)) return NaN; let b = 0; while (b < cuts.length && x >= cuts[b]) b++; return b; });
  return { variable: { name: c.variable.name, kind: 'discrete', values }, data };
}

registerWidget({
  type: 'transform.discretize',
  name: 'Discretize',
  category: 'transform',
  abbr: 'Dsc',
  description: '수치형 특징을 구간(범주)으로 나눕니다.',
  keywords: ['bin', 'binning', '구간', '이산화'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [420, 380],
  controlsOnly: true,
  defaultSettings: () => ({ method: 'eqfreq', n: 4 }),
  execute(inputs, s: { method: 'eqfreq' | 'eqwidth' | 'keep' | 'remove'; n: number }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const attributes: Column[] = [];
    for (const c of t.attributes) {
      if (c.variable.kind !== 'continuous' || s.method === 'keep') { attributes.push(c); continue; }
      if (s.method === 'remove') continue;
      const dc = discretizeColumn(c, s.method, s.n);
      if (dc) attributes.push(dc); else ctx.warn(`'${c.variable.name}'은(는) 값이 하나뿐이라 제거했습니다.`);
    }
    return { outputs: { data: { ...t, attributes } } };
  },
  render({ controls }, api) {
    controls.appendChild(box('기본 방법', radio(api, 'method', null, [['keep', '그대로 유지 (Keep numeric)'], ['remove', '제거 (Remove)'], ['eqfreq', '등빈도 (Equal frequency)'], ['eqwidth', '등간격 (Equal width)']]),
      spin(api, 'n', '구간 수', 2, 20)));
  },
});

// ------------------------------------------------------------------ Unique
registerWidget({
  type: 'transform.unique',
  name: 'Unique',
  category: 'transform',
  abbr: 'Unq',
  description: '중복 행을 제거합니다.',
  keywords: ['duplicate', 'distinct', '중복'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'data', name: 'Unique Data', type: 'Data', default: true }],
  windowSize: [420, 420],
  controlsOnly: true,
  defaultSettings: () => ({ groupBy: [] as string[], tiebreaker: 'first' }),
  execute(inputs, s: { groupBy: string[]; tiebreaker: string }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const cols = s.groupBy.length ? s.groupBy.map((n) => findColumn(t, n)).filter(Boolean) as Column[] : t.attributes;
    const groups = new Map<string, number[]>();
    for (let i = 0; i < t.nRows; i++) {
      const key = cols.map((c) => String(c.data[i])).join('\u0001');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(i);
    }
    const rng = new Rng(RANDOM_SEED);
    const keep: number[] = [];
    for (const rows of groups.values()) {
      if (s.tiebreaker === 'none') { if (rows.length === 1) keep.push(rows[0]); continue; }
      const pick = s.tiebreaker === 'last' ? rows[rows.length - 1] : s.tiebreaker === 'middle' ? rows[Math.floor((rows.length - 1) / 2)] : s.tiebreaker === 'random' ? rows[rng.int(rows.length)] : rows[0];
      keep.push(pick);
    }
    keep.sort((a, b) => a - b);
    return { outputs: { data: takeRows(t, keep) }, view: { before: t.nRows, after: keep.length } };
  },
  render({ controls }, api) {
    const t = tableInput(api.inputs.data);
    if (t) {
      const chosen = new Set(api.settings.groupBy as string[]);
      controls.appendChild(box('비교할 변수 (비우면 모든 특징)', h('div', { class: 'check-list' }, ...allColumns(t).map((c) => {
        const cb = h('input', { type: 'checkbox', checked: chosen.has(c.variable.name) });
        cb.addEventListener('change', () => { if (cb.checked) chosen.add(c.variable.name); else chosen.delete(c.variable.name); api.update({ groupBy: [...chosen] }); });
        return h('label', { class: 'ctl-check' }, cb, varBadge(c), c.variable.name);
      }))));
    }
    controls.appendChild(box('중복 시 남길 행', combo(api, 'tiebreaker', null, [['first', '첫 번째 행'], ['last', '마지막 행'], ['middle', '가운데 행'], ['random', '무작위 행'], ['none', '중복된 행 모두 제거']])));
    const v = api.view as { before: number; after: number } | null;
    if (v) controls.appendChild(note(`${v.before}행 → ${v.after}행`));
  },
});

// ------------------------------------------------------------------ Randomize
registerWidget({
  type: 'transform.randomize',
  name: 'Randomize',
  category: 'transform',
  abbr: 'Rnd',
  description: '선택한 열의 값을 행 사이에서 섞습니다(순열 검정, 기준선 비교용).',
  keywords: ['shuffle', 'permute', '섞기'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [420, 380],
  controlsOnly: true,
  defaultSettings: () => ({ shuffleClass: true, shuffleAttrs: false, shuffleMetas: false, scopeProp: 80, randomSeed: false }),
  execute(inputs, s: { shuffleClass: boolean; shuffleAttrs: boolean; shuffleMetas: boolean; scopeProp: number; randomSeed: boolean }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const rng = new Rng(s.randomSeed ? RANDOM_SEED : (Math.random() * 2 ** 32) >>> 0);
    const m = Math.round((t.nRows * s.scopeProp) / 100);
    const pick = range(t.nRows); rng.shuffle(pick);
    const rows = Array.from(pick.subarray(0, m));
    const shuffled = [...rows]; rng.shuffle(shuffled);
    const shuffleCol = (c: Column): Column => {
      if (Array.isArray(c.data)) { const out = [...c.data]; rows.forEach((r, i) => { out[r] = (c.data as string[])[shuffled[i]]; }); return { variable: c.variable, data: out }; }
      const src = c.data as Float64Array;
      const out = Float64Array.from(src);
      rows.forEach((r, i) => { out[r] = src[shuffled[i]]; });
      return { variable: c.variable, data: out };
    };
    return {
      outputs: {
        data: {
          ...t,
          attributes: s.shuffleAttrs ? t.attributes.map(shuffleCol) : t.attributes,
          classVar: s.shuffleClass && t.classVar ? shuffleCol(t.classVar) : t.classVar,
          metas: s.shuffleMetas ? t.metas.map(shuffleCol) : t.metas,
        },
      },
    };
  },
  render({ controls }, api) {
    controls.appendChild(box('섞을 열', checkbox(api, 'shuffleClass', '목표 변수 (Classes)'), checkbox(api, 'shuffleAttrs', '특징 (Features)'), checkbox(api, 'shuffleMetas', '메타 (Metas)')));
    controls.appendChild(box('섞을 행 비율', spin(api, 'scopeProp', '비율 (%)', 1, 100), checkbox(api, 'randomSeed', '재현 가능한 결과 (고정 시드)')));
  },
});

// ------------------------------------------------------------------ Transpose
registerWidget({
  type: 'transform.transpose',
  name: 'Transpose',
  category: 'transform',
  abbr: 'T',
  description: '행과 열을 바꿉니다(수치형 특징만). 특징 이름은 "Feature name" 메타 열이 됩니다.',
  keywords: ['pivot', '전치'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [420, 300],
  controlsOnly: true,
  defaultSettings: () => ({ featureNames: '' }),
  execute(inputs, s: { featureNames: string }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const numeric = t.attributes.filter((c) => c.variable.kind === 'continuous');
    if (numeric.length < t.attributes.length) ctx.warn('범주형 특징은 전치에서 제외했습니다.');
    if (t.nRows > 5000) throw new Error('5,000행을 넘는 데이터는 전치하면 열이 너무 많아집니다. Data Sampler로 줄이세요.');
    const nameCol = s.featureNames ? findColumn(t, s.featureNames) : null;
    const names: string[] = [];
    const used = new Set<string>();
    for (let i = 0; i < t.nRows; i++) {
      let nm = nameCol ? cellText(nameCol, i) : `Feature ${i + 1}`;
      while (used.has(nm)) nm += '_';
      used.add(nm); names.push(nm);
    }
    const attributes: Column[] = names.map((nm, i) => ({ variable: { name: nm, kind: 'continuous', decimals: 3 } as Variable, data: Float64Array.from(numeric, (c) => (c.data as Float64Array)[i]) }));
    const meta: Column = { variable: { name: 'Feature name', kind: 'string' }, data: numeric.map((c) => c.variable.name) };
    return { outputs: { data: makeTable(`${t.name} (transposed)`, attributes, null, [meta]) } };
  },
  render({ controls }, api) {
    const t = tableInput(api.inputs.data);
    const opts: Array<[string, string]> = [['', '일반 이름 (Feature 1, 2, …)']];
    if (t) for (const c of [...t.metas, ...(t.classVar ? [t.classVar] : [])]) if (c.variable.kind !== 'continuous') opts.push([c.variable.name, c.variable.name]);
    controls.appendChild(box('새 열 이름', combo(api, 'featureNames', null, opts)));
  },
});

// ------------------------------------------------------------------ Concatenate
registerWidget({
  type: 'transform.concatenate',
  name: 'Concatenate',
  category: 'transform',
  abbr: 'Cat',
  description: '여러 데이터를 행 방향으로 이어 붙입니다.',
  keywords: ['append', 'union', 'rbind', '합치기'],
  inputs: [{ id: 'primary', name: 'Primary Data', type: 'Data' }, { id: 'additional', name: 'Additional Data', type: 'Data', multiple: true, default: true }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [440, 380],
  controlsOnly: true,
  defaultSettings: () => ({ merge: 'union', addSource: false, sourceName: 'Source ID', sourceRole: 'class' }),
  execute(inputs, s: { merge: 'union' | 'intersection'; addSource: boolean; sourceName: string; sourceRole: Role }, ctx) {
    const primary = tableInput(inputs.primary);
    const extra = (inputs.additional as unknown[]).map(tableInput).filter(Boolean) as Table[];
    const tables = [...(primary ? [primary] : []), ...extra];
    if (!tables.length) return waiting(ctx);
    type Slot = { role: Role; variable: Variable };
    const slots = new Map<string, Slot>();
    const addFrom = (t: Table) => { for (const c of allColumns(t)) if (!slots.has(c.variable.name)) slots.set(c.variable.name, { role: columnRole(t, c), variable: c.variable }); };
    if (primary) addFrom(primary); else if (s.merge === 'union') tables.forEach(addFrom);
    else {
      addFrom(tables[0]);
      for (const name of [...slots.keys()]) if (!tables.every((t) => findColumn(t, name))) slots.delete(name);
    }
    const attributes: Column[] = [], metas: Column[] = [];
    let classVar: Column | null = null;
    for (const [name, slot] of slots) {
      const parts = tables.map((t) => ({ col: findColumn(t, name), rows: range(t.nRows) }));
      const col = gatherColumn(slot.variable, parts);
      if (slot.role === 'class' && !classVar) classVar = col; else if (slot.role === 'meta') metas.push(col); else attributes.push(col);
    }
    if (s.addSource) {
      const values = tables.map((t) => t.name);
      const data = new Float64Array(tables.reduce((n, t) => n + t.nRows, 0));
      let k = 0;
      tables.forEach((t, ti) => { for (let i = 0; i < t.nRows; i++) data[k++] = ti; });
      const col: Column = { variable: { name: s.sourceName || 'Source ID', kind: 'discrete', values: values.map((v, i) => values.indexOf(v) !== i ? `${v} (${i + 1})` : v) }, data };
      if (s.sourceRole === 'class') { if (classVar) metas.push(classVar); classVar = col; } else if (s.sourceRole === 'meta') metas.push(col); else attributes.push(col);
    }
    const ids = new Int32Array(tables.reduce((n, t) => n + t.nRows, 0));
    let k = 0;
    for (const t of tables) { ids.set(t.ids, k); k += t.nRows; }
    return { outputs: { data: makeTable(tables[0].name, attributes, classVar, metas, ids) } };
  },
  render({ controls }, api) {
    controls.appendChild(box('변수 합치기 (Primary Data가 없을 때)', radio(api, 'merge', null, [['union', '모든 변수 (합집합)'], ['intersection', '공통 변수만 (교집합)']])));
    controls.appendChild(box('출처 표시', checkbox(api, 'addSource', '출처(Source ID) 열 추가'),
      api.settings.addSource ? combo(api, 'sourceRole', '역할', [['class', 'Target'], ['attribute', 'Feature'], ['meta', 'Meta']]) : null));
    controls.appendChild(note('Primary Data가 연결되어 있으면 그 변수 구성을 사용합니다.'));
  },
});

// ------------------------------------------------------------------ Merge Data
registerWidget({
  type: 'transform.merge',
  name: 'Merge Data',
  category: 'transform',
  abbr: 'Mrg',
  description: '두 데이터를 키(행 번호 또는 변수 값)로 연결해 열 방향으로 합칩니다.',
  keywords: ['join', 'merge', '병합', '조인'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }, { id: 'extra', name: 'Extra Data', type: 'Data' }],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [460, 360],
  controlsOnly: true,
  defaultSettings: () => ({ mode: 'left', key: '', extraKey: '' }),
  execute(inputs, s: { mode: 'left' | 'inner' | 'outer'; key: string; extraKey: string }, ctx) {
    const a = tableInput(inputs.data), b = tableInput(inputs.extra);
    if (!a || !b) return waiting(ctx, 'Data와 Extra Data를 모두 연결하세요.');
    const keyOf = (t: Table, name: string): string[] => {
      if (!name) return Array.from({ length: t.nRows }, (_, i) => String(i));
      const c = findColumn(t, name);
      if (!c) throw new Error(`키 변수 '${name}'이(가) 없습니다.`);
      return Array.from({ length: t.nRows }, (_, i) => cellText(c, i));
    };
    const ka = keyOf(a, s.key), kb = keyOf(b, s.extraKey || s.key);
    const bIndex = new Map<string, number>();
    kb.forEach((k, i) => { if (k !== '?' && !bIndex.has(k)) bIndex.set(k, i); });
    const ra: number[] = [], rb: number[] = [];
    const matchedB = new Set<number>();
    ka.forEach((k, i) => {
      const j = k === '?' ? undefined : bIndex.get(k);
      if (j === undefined && s.mode === 'inner') return;
      ra.push(i); rb.push(j ?? -1);
      if (j !== undefined) matchedB.add(j);
    });
    if (s.mode === 'outer') kb.forEach((_, j) => { if (!matchedB.has(j)) { ra.push(-1); rb.push(j); } });
    const namesA = new Set(allColumns(a).map((c) => c.variable.name));
    const build = (cols: Column[], from: 'a' | 'b') => cols.map((c) => {
      if (from === 'a') {
        const other = s.mode === 'outer' && s.key && c.variable.name === s.key ? findColumn(b, s.extraKey || s.key) : undefined;
        if (other) return mergeKey(c, other);
        return gatherColumn(c.variable, [{ col: c, rows: ra }]);
      }
      return gatherColumn(c.variable, [{ col: c, rows: rb }]);
    });
    // outer join에서 키 열은 양쪽 값을 합친다
    const mergeKey = (ca: Column, cb: Column) => {
      const left = gatherColumn(ca.variable, [{ col: ca, rows: ra }]);
      const right = gatherColumn({ ...left.variable }, [{ col: cb, rows: rb }]);
      const d = left.data;
      if (Array.isArray(d)) return { variable: left.variable, data: d.map((x, i) => x || (right.data as string[])[i]) } as Column;
      return { variable: right.variable, data: Float64Array.from(d as Float64Array, (x, i) => (Number.isNaN(x) ? (right.data as Float64Array)[i] : x)) } as Column;
    };
    const extraAttrs = b.attributes.filter((c) => !namesA.has(c.variable.name));
    const extraMetas = [...b.metas, ...(b.classVar && a.classVar ? [b.classVar] : [])].filter((c) => !namesA.has(c.variable.name));
    const classVar = a.classVar ? build([a.classVar], 'a')[0] : b.classVar && !namesA.has(b.classVar.variable.name) ? build([b.classVar], 'b')[0] : null;
    const out = makeTable(a.name, [...build(a.attributes, 'a'), ...build(extraAttrs, 'b')], classVar, [...build(a.metas, 'a'), ...build(extraMetas, 'b')]);
    out.ids = Int32Array.from(ra, (r, i) => (r >= 0 ? a.ids[r] : rb[i] >= 0 ? b.ids[rb[i]] : 0));
    if (out.ids.some((x) => x === 0)) out.ids = newIds(out.nRows);
    return { outputs: { data: out }, view: { matched: matchedB.size, rows: out.nRows } };
  },
  render({ controls }, api) {
    const a = tableInput(api.inputs.data), b = tableInput(api.inputs.extra);
    controls.appendChild(box('병합 방식', radio(api, 'mode', null, [['left', 'Extra Data의 열 덧붙이기 (Left join)'], ['inner', '일치하는 행만 (Inner join)'], ['outer', '모든 행 합치기 (Outer join)']])));
    const keyOpts = (t: Table | null): Array<[string, string]> => [['', '행 번호 (Row index)'], ...(t ? allColumns(t).map((c) => [c.variable.name, c.variable.name] as [string, string]) : [])];
    controls.appendChild(box('일치 기준',
      row('Data의 키', combo(api, 'key', null, keyOpts(a))),
      row('Extra Data의 키', combo(api, 'extraKey', null, [['', '(같은 이름)'], ...keyOpts(b).slice(1)]))));
    const v = api.view as { matched: number; rows: number } | null;
    if (v) controls.appendChild(note(`Extra Data에서 ${v.matched}행이 일치 → 출력 ${v.rows}행`));
  },
});

