import type { WidgetDef, PortDef, PortType } from './types';

const widgets = new Map<string, WidgetDef>();
const listeners = new Set<() => void>();

/** 위젯 목록이 바뀔 때(애드온 설치/제거) 알림 */
export function onRegistryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerWidget(def: WidgetDef): void {
  if (widgets.has(def.type)) throw new Error(`위젯 타입 중복: ${def.type}`);
  widgets.set(def.type, def);
  for (const fn of listeners) fn();
}

export function unregisterWidget(type: string): void {
  if (widgets.delete(type)) for (const fn of listeners) fn();
}

export function getWidget(type: string): WidgetDef | undefined {
  return widgets.get(type);
}

export function allWidgets(): WidgetDef[] {
  return [...widgets.values()];
}

export function compatible(out: PortType, inp: PortType): boolean {
  // Orange에서 Model은 Learner를 받는 곳(Predictions의 Predictors)과 구분되지만,
  // Model 출력은 Model 입력에만, Learner는 Learner 입력에만 연결한다.
  return out === inp;
}

/** 두 위젯 사이에 가능한 (출력, 입력) 포트 쌍. 기본 채널 우선 정렬 */
export function possibleLinks(from: WidgetDef, to: WidgetDef): Array<{ out: PortDef; inp: PortDef }> {
  const pairs: Array<{ out: PortDef; inp: PortDef; score: number }> = [];
  for (const out of from.outputs) {
    for (const inp of to.inputs) {
      if (!compatible(out.type, inp.type)) continue;
      pairs.push({ out, inp, score: (out.default ? 2 : 0) + (inp.default ? 2 : 0) + (out.name === inp.name ? 1 : 0) });
    }
  }
  return pairs.sort((a, b) => b.score - a.score);
}
