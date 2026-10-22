/** Orange 위젯 창의 왼쪽 컨트롤 영역(gui.comboBox, gui.spin, gui.checkBox 등)에 해당하는 요소 */
import type { ViewApi } from '../engine/types';
import type { Table, Column } from '../core/table';
import { allColumns } from '../core/table';
import { h } from './dom';

type Api = ViewApi<any>;

export function box(title: string | null, ...children: (Node | null | false)[]): HTMLElement {
  return h('fieldset', { class: 'ctl-box' }, title ? h('legend', null, title) : null, ...children.filter(Boolean) as Node[]);
}

export function row(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'ctl-row' }, h('span', { class: 'ctl-label' }, label), control);
}

export function checkbox(api: Api, key: string, label: string, opts: { rerun?: boolean } = {}): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: !!api.settings[key] });
  input.addEventListener('change', () => (opts.rerun === false ? api.silentUpdate({ [key]: input.checked }) : api.update({ [key]: input.checked })));
  return h('label', { class: 'ctl-check' }, input, h('span', null, label));
}

export function spin(api: Api, key: string, label: string, min: number, max: number, step = 1): HTMLElement {
  const input = h('input', { type: 'number', min, max, step, value: String(api.settings[key]) });
  input.addEventListener('change', () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = Number(api.settings[key]);
    v = Math.min(max, Math.max(min, v));
    input.value = String(v);
    api.update({ [key]: v });
  });
  return row(label, input);
}

export function slider(api: Api, key: string, label: string, min: number, max: number, step = 1, fmt: (v: number) => string = String): HTMLElement {
  const out = h('span', { class: 'ctl-value' }, fmt(Number(api.settings[key])));
  const input = h('input', { type: 'range', min, max, step, value: String(api.settings[key]) });
  input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); });
  input.addEventListener('change', () => api.update({ [key]: Number(input.value) }));
  return h('label', { class: 'ctl-row' }, h('span', { class: 'ctl-label' }, label), h('span', { class: 'ctl-slider' }, input, out));
}

export function combo(api: Api, key: string, label: string | null, options: Array<[string | number, string]>, opts: { onChange?: (v: string) => void } = {}): HTMLElement {
  const sel = h('select', null, ...options.map(([v, l]) => h('option', { value: String(v) }, l)));
  sel.value = String(api.settings[key] ?? '');
  sel.addEventListener('change', () => {
    const orig = options.find(([v]) => String(v) === sel.value)?.[0];
    if (opts.onChange) opts.onChange(sel.value); else api.update({ [key]: orig });
  });
  return label ? row(label, sel) : sel;
}

export function radio(api: Api, key: string, label: string | null, options: Array<[string | number, string]>): HTMLElement {
  const name = `r-${api.nodeId}-${key}`;
  return h('div', { class: 'ctl-radio', role: 'radiogroup' },
    label ? h('div', { class: 'ctl-label' }, label) : null,
    ...options.map(([v, l]) => {
      const input = h('input', { type: 'radio', name, value: String(v), checked: api.settings[key] === v });
      input.addEventListener('change', () => { if (input.checked) api.update({ [key]: v }); });
      return h('label', { class: 'ctl-check' }, input, h('span', null, l));
    }));
}

export function textInput(api: Api, key: string, label: string, placeholder = ''): HTMLElement {
  const input = h('input', { type: 'text', value: String(api.settings[key] ?? ''), placeholder });
  input.addEventListener('change', () => api.update({ [key]: input.value }));
  return row(label, input);
}

export function button(label: string, onclick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`, onclick }, label);
}

export function note(text: string, kind: 'info' | 'warn' | 'error' = 'info'): HTMLElement {
  return h('div', { class: `ctl-note ${kind}` }, text);
}

/** 변수 선택 콤보(Orange gui.comboBox + DomainModel) */
export function varCombo(api: Api, key: string, label: string | null, table: Table | null, filter: (c: Column) => boolean, opts: { none?: string } = {}): HTMLElement {
  const cols = table ? allColumns(table).filter(filter) : [];
  const options: Array<[string, string]> = [];
  if (opts.none) options.push(['', opts.none]);
  for (const c of cols) options.push([c.variable.name, `${kindIcon(c)} ${c.variable.name}`]);
  return combo(api, key, label, options);
}

export function kindIcon(c: Column): string {
  return c.variable.kind === 'continuous' ? 'N' : c.variable.kind === 'discrete' ? 'C' : 'S';
}

export function varBadge(c: Column): HTMLElement {
  return h('span', { class: `var-badge ${c.variable.kind}`, title: c.variable.kind === 'continuous' ? '수치형' : c.variable.kind === 'discrete' ? '범주형' : '문자열' }, kindIcon(c));
}

export function emptyMain(main: HTMLElement, msg: string): void {
  main.appendChild(h('div', { class: 'empty-main' }, msg));
}
