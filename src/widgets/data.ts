/** Data 카테고리: File, Datasets, Data Table, Data Info, Feature Statistics, Save Data */
import { registerWidget } from '../engine/registry';
import type { ExecContext, ViewApi } from '../engine/types';
import { type Table, type Column, newIds, allColumns, describeTable, estimateBytes, formatBytes, takeRows, valueCounts } from '../core/table';
import type { ColumnSpec, ParseResult } from '../core/io';
import { serializeTable } from '../core/io';
import { mean, median, minMax, countMissing, coefficientOfVariation, entropy } from '../core/stats';
import { formatNumber } from '../core/stats';
import { h, download, toast } from '../ui/dom';
import { box, combo, note, radio, button, checkbox, varBadge, emptyMain } from '../ui/controls';
import { renderDataTable, columnsSummary } from '../ui/datatable';
import { discreteColor } from '../ui/plot';
import * as db from '../storage/db';
import { waiting, tableInput } from './common';

export interface BuiltinDataset { file: string; title: string; description: string; rows: number; features: number; target: string }

/** Orange에 포함된 기본 데이터셋 (Orange/datasets/*.tab 원본) */
export const BUILTIN_DATASETS: BuiltinDataset[] = [
  { file: 'iris', title: 'Iris', description: '붓꽃 3종의 꽃받침·꽃잎 측정값. 분류 입문용 고전 데이터셋.', rows: 150, features: 4, target: '분류 (3클래스)' },
  { file: 'titanic', title: 'Titanic', description: '타이타닉 탑승자의 등급·나이·성별과 생존 여부.', rows: 2201, features: 3, target: '분류 (생존)' },
  { file: 'heart_disease', title: 'Heart disease', description: '클리블랜드 심장병 환자 데이터. 결측치 포함.', rows: 303, features: 13, target: '분류 (혈관 협착)' },
  { file: 'housing', title: 'Housing', description: '보스턴 주택 가격(MEDV) 회귀 데이터.', rows: 506, features: 13, target: '회귀 (MEDV)' },
  { file: 'zoo', title: 'Zoo', description: '동물 101종의 특징과 분류(포유류·조류 등). 이름은 메타 변수.', rows: 101, features: 16, target: '분류 (7클래스)' },
];

const textCache = new Map<string, string>();

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const cached = textCache.get(url);
  if (cached) return cached;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error(`파일을 가져올 수 없습니다(네트워크 또는 CORS 문제): ${url}`);
  }
  if (!res.ok) throw new Error(`파일을 가져올 수 없습니다 (HTTP ${res.status}): ${url}`);
  const text = await res.text();
  if (text.length < 5_000_000) textCache.set(url, text);
  return text;
}

export function datasetUrl(file: string): string {
  return new URL(`datasets/${file}.tab`, document.baseURI).href;
}

// ------------------------------------------------------------------ File
interface FileSettings {
  source: 'builtin' | 'local' | 'url';
  dataset: string;
  fileKey: string;
  fileName: string;
  url: string;
  overrides: Record<string, Partial<ColumnSpec>>;
}

interface FileView { specs: ColumnSpec[]; warnings: string[]; table: Table; sourceLabel: string; bytes: number }

async function loadSourceText(s: FileSettings, ctx: ExecContext): Promise<{ text: string; name: string; label: string }> {
  if (s.source === 'builtin') {
    const ds = BUILTIN_DATASETS.find((d) => d.file === s.dataset) ?? BUILTIN_DATASETS[0];
    return { text: await fetchText(datasetUrl(ds.file), ctx.signal), name: ds.file, label: `기본 데이터셋: ${ds.title}` };
  }
  if (s.source === 'url') {
    if (!s.url) throw new Error('URL을 입력하세요.');
    return { text: await fetchText(s.url, ctx.signal), name: s.url.split('/').pop()?.replace(/\.\w+$/, '') || 'data', label: s.url };
  }
  if (!s.fileKey) throw new Error('파일을 선택하세요.');
  let text = textCache.get(`local:${s.fileKey}`);
  if (!text) {
    const stored = await db.get<db.StoredFile>('files', s.fileKey);
    if (!stored) throw new Error(`'${s.fileName}' 파일 원본이 이 브라우저에 저장되어 있지 않습니다. [파일 열기]로 다시 선택하세요.`);
    text = stored.text;
    textCache.set(`local:${s.fileKey}`, text);
  }
  return { text, name: s.fileName.replace(/\.\w+$/, ''), label: s.fileName };
}

registerWidget({
  type: 'data.file',
  name: 'File',
  category: 'data',
  abbr: 'File',
  description: 'CSV, TSV, Orange .tab 파일이나 기본 데이터셋을 읽습니다.',
  keywords: ['csv', 'load', 'open', '파일', '불러오기'],
  inputs: [],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [760, 520],
  defaultSettings: (): FileSettings => ({ source: 'builtin', dataset: 'iris', fileKey: '', fileName: '', url: '', overrides: {} }),
  async execute(_in, s: FileSettings, ctx) {
    const src = await loadSourceText(s, ctx);
    const res = await ctx.compute<ParseResult>('parse', { text: src.text, name: src.name, overrides: s.overrides });
    res.table.ids = newIds(res.table.nRows); // Worker에서 만든 ID는 메인 스레드 ID와 겹칠 수 있다
    for (const w of res.warnings) ctx.warn(w);
    if (!res.table.nRows) ctx.warn('데이터 행이 없습니다.');
    const view: FileView = { specs: res.specs, warnings: res.warnings, table: res.table, sourceLabel: src.label, bytes: src.text.length };
    return { outputs: { data: res.table }, view };
  },
  render({ controls, main }, api: ViewApi<FileSettings>) {
    const s = api.settings;
    controls.appendChild(box('소스',
      radio(api, 'source', null, [['builtin', '기본 데이터셋'], ['local', '내 컴퓨터의 파일'], ['url', 'URL']]),
    ));
    if (s.source === 'builtin') {
      controls.appendChild(box('데이터셋', combo(api, 'dataset', null, BUILTIN_DATASETS.map((d) => [d.file, `${d.title} (${d.rows}행)`]), {
        onChange: (v) => api.update({ dataset: v, overrides: {} }),
      })));
    } else if (s.source === 'local') {
      const openBtn = button('파일 열기…', () => input.click(), 'primary');
      const input = h('input', { type: 'file', accept: '.csv,.tsv,.tab,.txt,text/csv', style: 'display:none' });
      input.addEventListener('change', async () => {
        const f = input.files?.[0];
        if (!f) return;
        if (f.size > 200 * 1024 * 1024) { toast('200MB를 넘는 파일은 저사양 기기에서 열 수 없습니다.', { kind: 'error' }); return; }
        const text = await f.text();
        const key = await db.hashText(text);
        textCache.set(`local:${key}`, text);
        if (text.length <= db.MAX_STORED_FILE_BYTES) await db.put('files', key, { name: f.name, text, size: f.size, savedAt: new Date().toISOString() } satisfies db.StoredFile);
        else toast('파일이 커서 브라우저에 저장하지 않았습니다. 새로고침 후에는 다시 선택해야 합니다.');
        api.update({ source: 'local', fileKey: key, fileName: f.name, overrides: {} });
      });
      controls.appendChild(box('파일', h('div', { class: 'ctl-file' }, h('span', { class: 'file-name' }, s.fileName || '선택된 파일 없음'), openBtn, input),
        note('파일은 이 브라우저(IndexedDB)에만 저장되며 서버로 전송되지 않습니다.')));
    } else {
      const inp = h('input', { type: 'url', value: s.url, placeholder: 'https://…/data.csv' });
      controls.appendChild(box('URL', inp, button('불러오기', () => api.update({ url: inp.value.trim(), overrides: {} }), 'primary'),
        note('다른 사이트의 파일은 CORS를 허용해야 불러올 수 있습니다(예: raw.githubusercontent.com).')));
    }
    const v = api.view as FileView | null;
    if (!v) { emptyMain(main, api.message || (api.status === 'running' ? '불러오는 중…' : '데이터 없음')); return; }
    controls.appendChild(box('정보',
      h('div', { class: 'info-text' }, v.sourceLabel), h('div', { class: 'info-text' }, describeTable(v.table)),
      h('div', { class: 'info-text' }, `${columnsSummary(v.table)} · 원본 ${formatBytes(v.bytes)}`),
      ...v.warnings.map((w) => note(w, 'warn'))));

    // 도메인 편집기 (Orange File 위젯의 열 타입/역할 편집)
    const draft: Record<string, Partial<ColumnSpec>> = structuredClone(s.overrides);
    const tbl = h('table', { class: 'domain-editor' },
      h('thead', null, h('tr', null, h('th', null, '이름'), h('th', null, '타입'), h('th', null, '역할'), h('th', null, '값'))),
      h('tbody', null, ...v.specs.map((sp) => {
        const col = allColumns(v.table).find((c) => c.variable.name === sp.name);
        const typeSel = h('select', null, ...[['continuous', '수치형 (numeric)'], ['discrete', '범주형 (categorical)'], ['string', '문자열 (text)']].map(([val, l]) => h('option', { value: val }, l)));
        typeSel.value = draft[sp.name]?.kind ?? sp.kind;
        const roleSel = h('select', null, ...[['attribute', 'feature'], ['class', 'target'], ['meta', 'meta'], ['skip', 'skip']].map(([val, l]) => h('option', { value: val }, l)));
        roleSel.value = draft[sp.name]?.role ?? sp.role;
        typeSel.addEventListener('change', () => { draft[sp.name] = { ...draft[sp.name], kind: typeSel.value as ColumnSpec['kind'] }; });
        roleSel.addEventListener('change', () => { draft[sp.name] = { ...draft[sp.name], role: roleSel.value as ColumnSpec['role'] }; });
        const vals = col?.variable.kind === 'discrete' ? col.variable.values!.join(', ') : '';
        return h('tr', null, h('td', null, sp.name), h('td', null, typeSel), h('td', null, roleSel), h('td', { class: 'vals', title: vals }, vals));
      })));
    main.appendChild(h('div', { class: 'main-scroll' }, tbl));
    main.appendChild(h('div', { class: 'main-actions' },
      button('초기화', () => api.update({ overrides: {} })),
      button('적용', () => api.update({ overrides: draft }), 'primary')));
  },
});

// ------------------------------------------------------------------ Datasets
registerWidget({
  type: 'data.datasets',
  name: 'Datasets',
  category: 'data',
  abbr: 'DS',
  description: '앱에 포함된 기본 데이터셋 목록에서 데이터를 선택합니다.',
  keywords: ['sample', 'example', '예제'],
  inputs: [],
  outputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  windowSize: [720, 420],
  defaultSettings: () => ({ dataset: 'iris' }),
  async execute(_in, s: { dataset: string }, ctx) {
    const ds = BUILTIN_DATASETS.find((d) => d.file === s.dataset);
    if (!ds) return waiting(ctx, '데이터셋을 선택하세요.');
    const text = await fetchText(datasetUrl(ds.file), ctx.signal);
    const res = await ctx.compute<ParseResult>('parse', { text, name: ds.file });
    res.table.ids = newIds(res.table.nRows);
    return { outputs: { data: res.table } };
  },
  render({ controls, main }, api) {
    controls.appendChild(note('행을 클릭하면 해당 데이터셋을 출력합니다. 데이터셋은 앱과 함께 배포되어 오프라인에서도 사용할 수 있습니다.'));
    main.appendChild(h('div', { class: 'main-scroll' }, h('table', { class: 'grid-table selectable' },
      h('thead', null, h('tr', null, ...['제목', '행', '변수', '목표', '설명'].map((t) => h('th', null, t)))),
      h('tbody', null, ...BUILTIN_DATASETS.map((d) => h('tr', { class: d.file === api.settings.dataset ? 'sel' : '', onclick: () => api.update({ dataset: d.file }) },
        h('td', null, d.title), h('td', { class: 'num' }, d.rows), h('td', { class: 'num' }, d.features), h('td', null, d.target), h('td', null, d.description)))))));
  },
});

// ------------------------------------------------------------------ Data Table
interface TableSettings { selection: number[]; colorByClass: boolean }
registerWidget({
  type: 'data.table',
  name: 'Data Table',
  category: 'data',
  abbr: 'Tbl',
  description: '데이터를 표로 보여주고, 선택한 행을 출력합니다.',
  keywords: ['spreadsheet', 'view', '표'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'selected', name: 'Selected Data', type: 'Data', default: true }, { id: 'data', name: 'Data', type: 'Data' }],
  windowSize: [860, 560],
  defaultSettings: (): TableSettings => ({ selection: [], colorByClass: true }),
  execute(inputs, s: TableSettings, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const sel = s.selection.filter((i) => i < t.nRows);
    return { outputs: { selected: sel.length ? takeRows(t, sel) : null, data: t } };
  },
  render({ controls, main }, api: ViewApi<TableSettings>) {
    const t = tableInput(api.inputs.data);
    if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
    controls.appendChild(box('정보', h('div', { class: 'info-text' }, describeTable(t)), h('div', { class: 'info-text' }, columnsSummary(t)),
      h('div', { class: 'info-text' }, `선택: ${api.settings.selection.length}행`)));
    controls.appendChild(box('표시', checkbox(api, 'colorByClass', '목표 값으로 색칠', { rerun: false })));
    controls.lastElementChild!.addEventListener('change', () => api.rerender());
    controls.appendChild(box('선택', button('선택 해제', () => api.update({ selection: [] })),
      note('클릭: 선택, Shift: 범위, Ctrl: 추가/제거')));
    const host = h('div', { class: 'dt-host' });
    main.appendChild(host);
    renderDataTable(host, t, {
      selected: new Set(api.settings.selection),
      colorByClass: api.settings.colorByClass,
      onSelect: (rows) => api.update({ selection: rows }),
    });
  },
});

// ------------------------------------------------------------------ Data Info
registerWidget({
  type: 'data.info',
  name: 'Data Info',
  category: 'data',
  abbr: 'Info',
  description: '데이터셋의 크기, 변수 구성, 결측치, 메모리 사용량을 보여줍니다.',
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [],
  windowSize: [520, 420],
  controlsOnly: false,
  defaultSettings: () => ({}),
  execute(inputs, _s, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    return { outputs: {} };
  },
  render({ controls, main }, api) {
    const t = tableInput(api.inputs.data);
    controls.appendChild(note('입력 데이터의 요약 정보입니다.'));
    if (!t) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
    const cols = allColumns(t);
    const missingCells = cols.reduce((s, c) => s + countMissing(c.data), 0);
    const totalCells = cols.length * t.nRows;
    const kinds = (list: Column[]) => {
      const n = (k: string) => list.filter((c) => c.variable.kind === k).length;
      return [n('discrete') && `범주형 ${n('discrete')}`, n('continuous') && `수치형 ${n('continuous')}`, n('string') && `문자열 ${n('string')}`].filter(Boolean).join(', ') || '없음';
    };
    const target = t.classVar
      ? t.classVar.variable.kind === 'discrete' ? `범주형 '${t.classVar.variable.name}' (${t.classVar.variable.values!.length}개 값)` : `수치형 '${t.classVar.variable.name}'`
      : '없음';
    const rows: Array<[string, string]> = [
      ['이름', t.name],
      ['크기', `${t.nRows.toLocaleString()}행, ${cols.length}열`],
      ['특징(Features)', `${t.attributes.length}개 (${kinds(t.attributes)})`],
      ['목표(Target)', target],
      ['메타(Metas)', `${t.metas.length}개 (${kinds(t.metas)})`],
      ['결측치', totalCells ? `${missingCells.toLocaleString()}개 (${((missingCells / totalCells) * 100).toFixed(1)}%)` : '-'],
      ['메모리(추정)', formatBytes(estimateBytes(t))],
    ];
    main.appendChild(h('table', { class: 'kv-table' }, ...rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))));
  },
});

// ------------------------------------------------------------------ Feature Statistics
interface FSRow { col: Column; mean: number; median: number; dispersion: number; min: string; max: string; missing: number; dist: number[] }
registerWidget({
  type: 'data.featurestats',
  name: 'Feature Statistics',
  category: 'data',
  abbr: 'FS',
  description: '변수별 평균, 중앙값, 분산도, 최솟값/최댓값, 결측치를 보여줍니다.',
  keywords: ['statistics', 'summary', '통계'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [{ id: 'reduced', name: 'Reduced Data', type: 'Data', default: true }, { id: 'stats', name: 'Statistics', type: 'Data' }],
  windowSize: [900, 520],
  defaultSettings: () => ({ selected: [] as string[] }),
  execute(inputs, s: { selected: string[] }, ctx) {
    const t = tableInput(inputs.data);
    if (!t) return waiting(ctx);
    const rows: FSRow[] = allColumns(t).map((c) => {
      if (c.variable.kind === 'string') {
        return { col: c, mean: NaN, median: NaN, dispersion: NaN, min: '', max: '', missing: countMissing(c.data), dist: [] };
      }
      const d = c.data as Float64Array;
      if (c.variable.kind === 'discrete') {
        const counts = valueCounts(c);
        const mode = counts.indexOf(Math.max(...counts));
        return { col: c, mean: NaN, median: NaN, dispersion: entropy(counts), min: '', max: '', missing: countMissing(d), dist: counts, modeLabel: c.variable.values![mode] } as FSRow;
      }
      const [lo, hi] = minMax(d.filter((x) => !Number.isNaN(x)));
      const bins = new Array<number>(10).fill(0);
      for (const x of d) if (!Number.isNaN(x)) bins[Math.min(9, Math.floor(((x - lo) / (hi - lo || 1)) * 10))]++;
      return { col: c, mean: mean(d), median: median(d), dispersion: coefficientOfVariation(d), min: formatNumber(lo), max: formatNumber(hi), missing: countMissing(d), dist: bins };
    });
    const sel = s.selected.filter((n) => t.attributes.some((c) => c.variable.name === n));
    const reduced = sel.length ? { ...t, attributes: t.attributes.filter((c) => sel.includes(c.variable.name)) } : null;
    return { outputs: { reduced }, view: rows };
  },
  render({ controls, main }, api) {
    const rows = api.view as FSRow[] | null;
    controls.appendChild(note('행을 클릭해 변수를 선택하면 선택한 특징만 포함한 Reduced Data를 출력합니다. 분산도: 수치형은 변동계수(CV), 범주형은 엔트로피.'));
    controls.appendChild(button('선택 해제', () => api.update({ selected: [] })));
    if (!rows) { emptyMain(main, '입력 데이터가 없습니다.'); return; }
    const t = tableInput(api.inputs.data)!;
    const sel = new Set(api.settings.selected as string[]);
    const spark = (r: FSRow) => {
      const c = h('canvas', { width: 100, height: 24, class: 'spark' });
      const g = c.getContext('2d')!;
      const mx = Math.max(1, ...r.dist);
      const w = 100 / Math.max(1, r.dist.length);
      r.dist.forEach((v, i) => { g.fillStyle = r.col.variable.kind === 'discrete' ? discreteColor(i) : '#7aa7d8'; g.fillRect(i * w + 1, 24 - (v / mx) * 22, w - 2, (v / mx) * 22); });
      return c;
    };
    main.appendChild(h('div', { class: 'main-scroll' }, h('table', { class: 'grid-table selectable' },
      h('thead', null, h('tr', null, ...['', '이름', '분포', '평균', '중앙값', '분산도', '최소', '최대', '결측'].map((x) => h('th', null, x)))),
      h('tbody', null, ...rows.map((r) => {
        const name = r.col.variable.name;
        const isAttr = t.attributes.includes(r.col);
        return h('tr', {
          class: sel.has(name) ? 'sel' : '',
          onclick: () => { if (!isAttr) return; if (sel.has(name)) sel.delete(name); else sel.add(name); api.update({ selected: [...sel] }); },
        },
        h('td', null, varBadge(r.col)), h('td', null, name), h('td', null, r.dist.length ? spark(r) : ''),
        h('td', { class: 'num' }, Number.isNaN(r.mean) ? ((r as any).modeLabel ?? '') : formatNumber(r.mean)),
        h('td', { class: 'num' }, Number.isNaN(r.median) ? '' : formatNumber(r.median)),
        h('td', { class: 'num' }, Number.isNaN(r.dispersion) ? '' : formatNumber(r.dispersion)),
        h('td', { class: 'num' }, r.min), h('td', { class: 'num' }, r.max),
        h('td', { class: 'num' }, `${r.missing} (${t.nRows ? ((r.missing / t.nRows) * 100).toFixed(0) : 0}%)`));
      })))));
  },
});

// ------------------------------------------------------------------ Save Data
registerWidget({
  type: 'data.save',
  name: 'Save Data',
  category: 'data',
  abbr: 'Save',
  description: '데이터를 CSV 또는 Orange .tab 파일로 내려받습니다.',
  keywords: ['export', 'download', '저장'],
  inputs: [{ id: 'data', name: 'Data', type: 'Data', default: true }],
  outputs: [],
  windowSize: [420, 300],
  controlsOnly: true,
  defaultSettings: () => ({ format: 'csv', filename: '' }),
  execute(inputs, _s, ctx) {
    if (!tableInput(inputs.data)) return waiting(ctx);
    return { outputs: {} };
  },
  render({ controls }, api) {
    const t = tableInput(api.inputs.data);
    controls.appendChild(box('형식', radio(api, 'format', null, [['csv', 'CSV (쉼표 구분, 헤더 1줄)'], ['tab', 'Orange .tab (타입·역할 헤더 포함)']])));
    if (!t) { controls.appendChild(note('입력 데이터가 없습니다.', 'warn')); return; }
    controls.appendChild(h('div', { class: 'info-text' }, describeTable(t)));
    controls.appendChild(button('내려받기', () => {
      const fmt = api.settings.format as 'csv' | 'tab';
      download(`${t.name || 'data'}.${fmt}`, serializeTable(t, fmt), fmt === 'csv' ? 'text/csv' : 'text/tab-separated-values');
    }, 'primary'));
    if ((t.classVar || t.metas.length) && api.settings.format === 'csv') controls.appendChild(note('CSV는 목표/메타 역할 정보를 저장하지 않습니다. 역할을 보존하려면 .tab 형식을 사용하세요.'));
  },
});

