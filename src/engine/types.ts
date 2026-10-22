/** 위젯 정의와 실행 컨텍스트 타입 */

export type PortType = 'Data' | 'Learner' | 'Model' | 'Results' | 'Distances';

export interface PortDef {
  id: string;
  name: string;
  type: PortType;
  /** 여러 연결을 받을 수 있는 입력(예: Test and Score의 Learner) */
  multiple?: boolean;
  /** Orange의 기본(default) 채널. 연결 시 우선 선택된다 */
  default?: boolean;
}

/** 기본 카테고리 + 애드온이 추가하는 카테고리(예: 'geo') */
export type CategoryId = 'data' | 'transform' | 'visualize' | 'model' | 'evaluate' | 'unsupervised' | (string & {});

export interface Category {
  id: CategoryId;
  name: string;
  /** Orange 카테고리 배경색 (Orange/widgets/<category>/__init__.py 의 BACKGROUND) */
  color: string;
  /** 애드온 카테고리면 애드온 id */
  addon?: string;
}

export const CATEGORIES: Category[] = [
  { id: 'data', name: 'Data', color: '#FFD39F' },
  { id: 'transform', name: 'Transform', color: '#FF9D5E' },
  { id: 'visualize', name: 'Visualize', color: '#FFB7B1' },
  { id: 'model', name: 'Model', color: '#FAC1D9' },
  { id: 'evaluate', name: 'Evaluate', color: '#C3F3F3' },
  { id: 'unsupervised', name: 'Unsupervised', color: '#CAE1EF' },
];

/** 애드온 카테고리 등록(기본 카테고리 뒤에 붙는다) */
export function registerCategory(c: Category): void {
  if (!CATEGORIES.some((x) => x.id === c.id)) CATEGORIES.push(c);
}

export function categoryOf(id: CategoryId): Category {
  return CATEGORIES.find((c) => c.id === id) ?? { id, name: id, color: '#cccccc' };
}

export interface ComputeClient {
  run<T>(task: string, payload: unknown, signal: AbortSignal, onProgress?: (p: number) => void): Promise<T>;
}

export interface ExecContext {
  nodeId: string;
  signal: AbortSignal;
  /** Web Worker에서 무거운 계산을 실행한다 */
  compute<T>(task: string, payload: unknown): Promise<T>;
  warn(msg: string): void;
  info(msg: string): void;
  progress(p: number): void;
  /** 위젯이 기억해야 하는 비직렬화 상태(예: 학습된 결과) */
  runtime: Record<string, unknown>;
}

export interface ExecResult {
  outputs: Record<string, unknown>;
  /** 위젯 창 렌더링용 데이터(저장되지 않음) */
  view?: unknown;
}

export type Inputs = Record<string, unknown>;

export interface ViewApi<S> {
  nodeId: string;
  title: string;
  settings: S;
  inputs: Inputs;
  outputs: Record<string, unknown>;
  view: unknown;
  status: NodeStatus;
  message: string;
  /** 설정 변경 → 노드 재실행 */
  update(patch: Partial<S>): void;
  /** 화면만 다시 그림(재실행 없음) */
  rerender(): void;
  /** 설정 저장만(재실행/재렌더 없음) */
  silentUpdate(patch: Partial<S>): void;
  /** 위젯 창이 닫혔는지 */
  closed(): boolean;
}

export interface WidgetDef<S = any> {
  type: string;
  name: string;
  category: CategoryId;
  /** 노드 아이콘에 표시할 짧은 약어 */
  abbr: string;
  description: string;
  keywords?: string[];
  inputs: PortDef[];
  outputs: PortDef[];
  defaultSettings(): S;
  execute(inputs: Inputs, settings: S, ctx: ExecContext): Promise<ExecResult> | ExecResult;
  /** 위젯 창 내용. controls(왼쪽 설정 영역)와 main(오른쪽 결과 영역)에 그린다 */
  render?(parts: { controls: HTMLElement; main: HTMLElement }, api: ViewApi<S>): void;
  /** 위젯 창에 main 영역이 없는 경우 */
  controlsOnly?: boolean;
  windowSize?: [number, number];
}

export type NodeStatus = 'idle' | 'waiting' | 'queued' | 'running' | 'done' | 'warning' | 'error';

export interface NodeModel {
  id: string;
  type: string;
  title: string;
  x: number;
  y: number;
  settings: Record<string, unknown>;
}

export interface EdgeModel {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface NodeRuntime {
  status: NodeStatus;
  message: string;
  progress: number;
  outputs: Record<string, unknown>;
  view: unknown;
  runtime: Record<string, unknown>;
  dirty: boolean;
  lastRunMs: number;
}

export const PROJECT_SCHEMA_VERSION = 1;

export interface ProjectFile {
  schemaVersion: number;
  app: 'grapefruit';
  title: string;
  nodes: NodeModel[];
  edges: EdgeModel[];
  view?: { x: number; y: number; zoom: number };
}
