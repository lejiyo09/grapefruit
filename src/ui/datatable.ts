/** 가상 스크롤 표: 화면에 보이는 행만 DOM으로 만든다(수십만 행에서도 가볍게 동작). */
import { type Table, type Column, allColumns, cellText } from '../core/table';
import { discreteColor } from '../ui/plot';
import { h, clear } from './dom';

const ROW_H = 24;

export interface DataTableOptions {
  selected?: Set<number>;
  onSelect?: (rows: number[]) => void;
  colorByClass?: boolean;
  showRoles?: boolean;
}

export function renderDataTable(host: HTMLElement, t: Table, opts: DataTableOptions = {}): void {
  clear(host);
  const cols: Column[] = [...(t.classVar ? [t.classVar] : []), ...t.metas, ...t.attributes];
  const roleOf = (c: Column) => (c === t.classVar ? 'class' : t.metas.includes(c) ? 'meta' : 'attr');
  let order: Int32Array = Int32Array.from({ length: t.nRows }, (_, i) => i);
  let sortCol = -1, sortAsc = true;
  const selected = opts.selected ?? new Set<number>();
  let anchor = -1;

  const colW = cols.map((c) => Math.min(220, Math.max(70, c.variable.name.length * 8 + 28)));
  const idxW = Math.max(48, String(t.nRows).length * 9 + 16);
  const totalW = idxW + colW.reduce((a, b) => a + b, 0);

  const header = h('div', { class: 'dt-header', style: `width:${totalW}px` },
    h('div', { class: 'dt-cell dt-idx', style: `width:${idxW}px` }, '#'),
    ...cols.map((c, j) => h('div', {
      class: `dt-cell dt-head ${roleOf(c)}`, style: `width:${colW[j]}px`, title: `${c.variable.name} (${c.variable.kind}) — 클릭하여 정렬`,
      onclick: () => sortBy(j),
    }, c.variable.name)));
  const spacer = h('div', { class: 'dt-spacer', style: `height:${t.nRows * ROW_H}px;width:${totalW}px` });
  const body = h('div', { class: 'dt-body' }, spacer);
  const scroller = h('div', { class: 'dt-scroll', tabindex: 0 }, header, body);
  host.appendChild(scroller);

  const sortBy = (j: number) => {
    if (sortCol === j) sortAsc = !sortAsc; else { sortCol = j; sortAsc = true; }
    const d = cols[j].data;
    const idx = Array.from({ length: t.nRows }, (_, i) => i);
    if (Array.isArray(d)) idx.sort((a, b) => (d[a] || '￿').localeCompare(d[b] || '￿'));
    else {
      const f = d as Float64Array;
      idx.sort((a, b) => (Number.isNaN(f[a]) ? 1 : Number.isNaN(f[b]) ? -1 : f[a] - f[b]));
    }
    if (!sortAsc) idx.reverse();
    order = Int32Array.from(idx);
    draw(true);
  };

  let lastFirst = -1;
  const pool: HTMLElement[] = [];
  const draw = (force = false) => {
    const top = scroller.scrollTop;
    const height = scroller.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(t.nRows, Math.ceil((top + height) / ROW_H) + 5);
    if (!force && first === lastFirst) return;
    lastFirst = first;
    for (const el of pool) el.remove();
    pool.length = 0;
    for (let r = first; r < last; r++) {
      const i = order[r];
      const sel = selected.has(i);
      const rowEl = h('div', { class: `dt-row${sel ? ' sel' : ''}${r % 2 ? ' odd' : ''}`, style: `top:${r * ROW_H}px;width:${totalW}px` },
        h('div', { class: 'dt-cell dt-idx', style: `width:${idxW}px` }, String(i + 1)),
        ...cols.map((c, j) => {
          const txt = cellText(c, i);
          const style = `width:${colW[j]}px` + (opts.colorByClass && c === t.classVar && c.variable.kind === 'discrete'
            ? `;background:${discreteColor(c.data[i] as number, 0.25)}` : '');
          return h('div', { class: `dt-cell ${roleOf(c)}${c.variable.kind === 'continuous' ? ' num' : ''}${txt === '?' ? ' missing' : ''}`, style, title: txt }, txt);
        }));
      if (opts.onSelect) {
        rowEl.addEventListener('click', (ev) => {
          if (ev.shiftKey && anchor >= 0) {
            const a = order.indexOf(anchor), b = r;
            for (let k = Math.min(a, b); k <= Math.max(a, b); k++) selected.add(order[k]);
          } else if (ev.ctrlKey || ev.metaKey) {
            if (selected.has(i)) selected.delete(i); else selected.add(i);
            anchor = i;
          } else { selected.clear(); selected.add(i); anchor = i; }
          draw(true);
          opts.onSelect!([...selected].sort((x, y) => x - y));
        });
      }
      body.appendChild(rowEl);
      pool.push(rowEl);
    }
  };
  scroller.addEventListener('scroll', () => requestAnimationFrame(() => draw()));
  requestAnimationFrame(() => draw(true));
  draw(true);
}

export function columnsSummary(t: Table): string {
  const cols = allColumns(t);
  const n = (k: string) => cols.filter((c) => c.variable.kind === k).length;
  return `수치형 ${n('continuous')} · 범주형 ${n('discrete')} · 문자열 ${n('string')}`;
}
