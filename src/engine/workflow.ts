/**
 * 워크플로 엔진: 노드 그래프, 타입 검사, 순환 검사, 변경 감지와 재실행, 취소, 오류 격리.
 *
 * 실행 규칙
 *  1. 노드 설정이나 입력 연결이 바뀌면 해당 노드와 모든 하위 노드를 dirty로 표시한다.
 *  2. 상위 노드가 모두 깨끗한(dirty가 아닌) dirty 노드를 위상 순서대로 한 번에 하나씩 실행한다.
 *     (저사양 기기에서 메모리 피크를 낮추기 위해 병렬 실행하지 않는다)
 *  3. 실행 중인 노드가 다시 dirty가 되면 AbortSignal로 취소하고 다시 실행한다.
 *  4. 한 노드의 오류는 그 노드의 출력만 비우고, 하위 노드는 "입력 없음" 상태가 된다.
 */
import { getWidget, possibleLinks } from './registry';
import {
  type ComputeClient, type EdgeModel, type ExecContext, type NodeModel, type NodeRuntime,
  type ProjectFile, PROJECT_SCHEMA_VERSION,
} from './types';

type Listener = (ev: WorkflowEvent) => void;
export type WorkflowEvent =
  | { kind: 'structure' }
  | { kind: 'node'; id: string }
  | { kind: 'settings'; id: string }
  | { kind: 'title' };

let uid = 0;
export function newId(prefix: string): string {
  uid++;
  return `${prefix}-${Date.now().toString(36)}${uid.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export class Workflow {
  title = '제목 없는 워크플로';
  nodes = new Map<string, NodeModel>();
  edges = new Map<string, EdgeModel>();
  runtime = new Map<string, NodeRuntime>();
  private listeners = new Set<Listener>();
  private running: { id: string; abort: AbortController } | null = null;
  private pumpScheduled = false;
  private paused = false;

  constructor(private compute: ComputeClient) {}

  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(ev: WorkflowEvent) { for (const fn of this.listeners) fn(ev); }

  // ---------------- 구조 편집 ----------------

  addNode(type: string, x: number, y: number, settings?: Record<string, unknown>, id?: string, title?: string): NodeModel {
    const def = getWidget(type);
    if (!def) throw new Error(`알 수 없는 위젯: ${type}`);
    const node: NodeModel = {
      id: id ?? newId('n'),
      type,
      title: title ?? this.uniqueTitle(def.name),
      x, y,
      settings: { ...def.defaultSettings(), ...(settings ?? {}) },
    };
    this.nodes.set(node.id, node);
    this.runtime.set(node.id, { status: 'queued', message: '', progress: 0, outputs: {}, view: null, runtime: {}, dirty: true, lastRunMs: 0 });
    this.emit({ kind: 'structure' });
    this.schedule();
    return node;
  }

  private uniqueTitle(base: string): string {
    const titles = new Set([...this.nodes.values()].map((n) => n.title));
    if (!titles.has(base)) return base;
    for (let i = 2; ; i++) if (!titles.has(`${base} (${i})`)) return `${base} (${i})`;
  }

  removeNode(id: string): void {
    const downstream = this.children(id);
    for (const e of [...this.edges.values()]) if (e.from.node === id || e.to.node === id) this.edges.delete(e.id);
    if (this.running?.id === id) this.running.abort.abort();
    this.nodes.delete(id);
    this.runtime.delete(id);
    for (const d of downstream) this.markDirty(d);
    this.emit({ kind: 'structure' });
  }

  renameNode(id: string, title: string): void {
    const n = this.nodes.get(id);
    if (!n || !title.trim()) return;
    n.title = title.trim();
    this.emit({ kind: 'node', id });
    this.emit({ kind: 'structure' });
  }

  moveNode(id: string, x: number, y: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.x = x; n.y = y;
  }

  parents(id: string): string[] {
    return [...this.edges.values()].filter((e) => e.to.node === id).map((e) => e.from.node);
  }

  children(id: string): string[] {
    return [...new Set([...this.edges.values()].filter((e) => e.from.node === id).map((e) => e.to.node))];
  }

  /** from에서 to로 갈 수 있는 경로가 있는가(순환 검사) */
  reachable(from: string, to: string): boolean {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (x === to) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...this.children(x));
    }
    return false;
  }

  /** 연결 가능 여부 검사. 불가능하면 이유 문자열 */
  canConnect(fromNode: string, outPort: string, toNode: string, inPort: string): string | null {
    if (fromNode === toNode) return '위젯을 자기 자신에 연결할 수 없습니다.';
    const a = this.nodes.get(fromNode), b = this.nodes.get(toNode);
    if (!a || !b) return '노드를 찾을 수 없습니다.';
    const da = getWidget(a.type)!, db = getWidget(b.type)!;
    const out = da.outputs.find((p) => p.id === outPort);
    const inp = db.inputs.find((p) => p.id === inPort);
    if (!out || !inp) return '포트를 찾을 수 없습니다.';
    if (out.type !== inp.type) return `${out.type} 출력은 ${inp.type} 입력에 연결할 수 없습니다.`;
    if (this.reachable(toNode, fromNode)) return '순환 연결은 만들 수 없습니다.';
    for (const e of this.edges.values()) {
      if (e.from.node === fromNode && e.from.port === outPort && e.to.node === toNode && e.to.port === inPort) return '이미 연결되어 있습니다.';
    }
    return null;
  }

  connect(fromNode: string, outPort: string, toNode: string, inPort: string, id?: string): EdgeModel {
    const why = this.canConnect(fromNode, outPort, toNode, inPort);
    if (why) throw new Error(why);
    const db = getWidget(this.nodes.get(toNode)!.type)!;
    const inp = db.inputs.find((p) => p.id === inPort)!;
    if (!inp.multiple) {
      // 단일 입력은 기존 연결을 대체(Orange와 동일)
      for (const e of [...this.edges.values()]) if (e.to.node === toNode && e.to.port === inPort) this.edges.delete(e.id);
    }
    const edge: EdgeModel = { id: id ?? newId('e'), from: { node: fromNode, port: outPort }, to: { node: toNode, port: inPort } };
    this.edges.set(edge.id, edge);
    this.emit({ kind: 'structure' });
    this.markDirty(toNode);
    return edge;
  }

  /** 두 노드를 가장 적절한 채널로 연결(Orange의 자동 채널 선택) */
  autoConnect(fromNode: string, toNode: string): EdgeModel | string {
    const a = this.nodes.get(fromNode), b = this.nodes.get(toNode);
    if (!a || !b) return '노드를 찾을 수 없습니다.';
    const links = possibleLinks(getWidget(a.type)!, getWidget(b.type)!);
    if (!links.length) return `${a.title}의 출력을 ${b.title}에 연결할 수 있는 채널이 없습니다.`;
    let lastErr = '';
    // 아직 비어 있는 입력을 우선 사용
    const used = new Set([...this.edges.values()].filter((e) => e.to.node === toNode).map((e) => e.to.port));
    const ordered = [...links.filter((l) => !used.has(l.inp.id) || l.inp.multiple), ...links];
    for (const l of ordered) {
      const why = this.canConnect(fromNode, l.out.id, toNode, l.inp.id);
      if (!why) return this.connect(fromNode, l.out.id, toNode, l.inp.id);
      lastErr = why;
    }
    return lastErr;
  }

  disconnect(edgeId: string): void {
    const e = this.edges.get(edgeId);
    if (!e) return;
    this.edges.delete(edgeId);
    this.emit({ kind: 'structure' });
    this.markDirty(e.to.node);
  }

  // ---------------- 설정 ----------------

  updateSettings(id: string, patch: Record<string, unknown>, rerun = true): void {
    const n = this.nodes.get(id);
    if (!n) return;
    Object.assign(n.settings, patch);
    this.emit({ kind: 'settings', id });
    if (rerun) this.markDirty(id);
  }

  // ---------------- 실행 ----------------

  /** 노드와 모든 하위 노드를 다시 실행 대상으로 표시 */
  markDirty(id: string): void {
    const stack = [id];
    const seen = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      const rt = this.runtime.get(x);
      if (rt) {
        rt.dirty = true;
        if (rt.status !== 'running') rt.status = 'queued';
        this.emit({ kind: 'node', id: x });
      }
      if (this.running?.id === x) this.running.abort.abort();
      stack.push(...this.children(x));
    }
    this.schedule();
  }

  runAll(): void { for (const id of this.nodes.keys()) this.markDirty(id); }

  cancel(): void {
    if (this.running) this.running.abort.abort();
  }

  /** 실행 일시정지(프로젝트 로딩 중 등) */
  setPaused(p: boolean): void { this.paused = p; if (!p) this.schedule(); }

  isBusy(): boolean { return !!this.running || [...this.runtime.values()].some((r) => r.dirty); }

  private schedule(): void {
    if (this.pumpScheduled || this.paused) return;
    this.pumpScheduled = true;
    setTimeout(() => { this.pumpScheduled = false; void this.pump(); }, 0);
  }

  private topoOrder(): string[] {
    const indeg = new Map<string, number>();
    for (const id of this.nodes.keys()) indeg.set(id, 0);
    for (const e of this.edges.values()) indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
    const q = [...this.nodes.keys()].filter((id) => !indeg.get(id));
    const out: string[] = [];
    while (q.length) {
      const x = q.shift()!;
      out.push(x);
      for (const e of this.edges.values()) if (e.from.node === x) {
        const d = indeg.get(e.to.node)! - 1;
        indeg.set(e.to.node, d);
        if (!d) q.push(e.to.node);
      }
    }
    return out;
  }

  private async pump(): Promise<void> {
    if (this.running || this.paused) return;
    const order = this.topoOrder();
    const next = order.find((id) => {
      const rt = this.runtime.get(id);
      return rt?.dirty && this.parents(id).every((p) => !this.runtime.get(p)?.dirty);
    });
    if (!next) { this.emit({ kind: 'title' }); return; }
    await this.execute(next);
    this.schedule();
  }

  /** 노드 입력 수집: 단일 입력은 값, multiple 입력은 배열 */
  gatherInputs(id: string): Record<string, unknown> {
    const node = this.nodes.get(id)!;
    const def = getWidget(node.type)!;
    const inputs: Record<string, unknown> = {};
    for (const p of def.inputs) inputs[p.id] = p.multiple ? [] : null;
    for (const e of this.edges.values()) {
      if (e.to.node !== id) continue;
      const v = this.runtime.get(e.from.node)?.outputs[e.from.port] ?? null;
      const p = def.inputs.find((pp) => pp.id === e.to.port);
      if (!p) continue;
      if (p.multiple) { if (v !== null && v !== undefined) (inputs[p.id] as unknown[]).push(v); } else inputs[p.id] = v;
    }
    return inputs;
  }

  private async execute(id: string): Promise<void> {
    const node = this.nodes.get(id);
    const rt = this.runtime.get(id);
    if (!node || !rt) return;
    const def = getWidget(node.type)!;
    const abort = new AbortController();
    this.running = { id, abort };
    rt.dirty = false;
    rt.status = 'running';
    rt.progress = 0;
    rt.message = '';
    this.emit({ kind: 'node', id });
    const warnings: string[] = [];
    const infos: string[] = [];
    const ctx: ExecContext = {
      nodeId: id,
      signal: abort.signal,
      compute: <T>(task: string, payload: unknown) => this.compute.run<T>(task, payload, abort.signal, (p) => ctx.progress(p)),
      warn: (m) => warnings.push(m),
      info: (m) => infos.push(m),
      progress: (p) => { rt.progress = p; this.emit({ kind: 'node', id }); },
      runtime: rt.runtime,
    };
    const t0 = performance.now();
    try {
      const inputs = this.gatherInputs(id);
      const res = await def.execute(inputs, node.settings, ctx);
      if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
      rt.outputs = res.outputs ?? {};
      rt.view = res.view ?? null;
      const hasOutput = Object.values(rt.outputs).some((v) => v !== null && v !== undefined);
      rt.status = warnings.length ? 'warning' : (!hasOutput && infos.length && def.outputs.length ? 'waiting' : 'done');
      rt.message = [...warnings, ...infos].join('\n');
    } catch (e) {
      const err = e as Error;
      if (abort.signal.aborted || err.name === 'AbortError') {
        rt.status = rt.dirty ? 'queued' : 'idle';
        rt.message = rt.dirty ? '' : '계산이 취소되었습니다.';
        if (!rt.dirty) { rt.outputs = {}; rt.view = null; }
      } else {
        rt.status = 'error';
        rt.message = err.message || String(err);
        rt.outputs = {};
        rt.view = null;
        console.error(`[${node.title}]`, err);
      }
    } finally {
      rt.lastRunMs = performance.now() - t0;
      rt.progress = 0;
      this.running = null;
      this.emit({ kind: 'node', id });
    }
  }

  // ---------------- 직렬화 ----------------

  toJSON(view?: ProjectFile['view']): ProjectFile {
    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      app: 'grapefruit',
      title: this.title,
      nodes: [...this.nodes.values()].map((n) => ({ ...n, settings: structuredClone(n.settings) })),
      edges: [...this.edges.values()].map((e) => structuredClone(e)),
      view,
    };
  }

  clear(): void {
    this.cancel();
    this.nodes.clear();
    this.edges.clear();
    this.runtime.clear();
    this.emit({ kind: 'structure' });
  }

  load(p: ProjectFile): string[] {
    if (p.app !== 'grapefruit' || typeof p.schemaVersion !== 'number') throw new Error('Grapefruit 프로젝트 파일이 아닙니다.');
    if (p.schemaVersion > PROJECT_SCHEMA_VERSION) throw new Error('더 최신 버전에서 저장된 프로젝트입니다. 앱을 업데이트하세요.');
    const problems: string[] = [];
    this.setPaused(true);
    this.clear();
    this.title = p.title || '제목 없는 워크플로';
    for (const n of p.nodes) {
      if (!getWidget(n.type)) { problems.push(`지원하지 않는 위젯 '${n.type}'을(를) 건너뛰었습니다.`); continue; }
      this.addNode(n.type, n.x, n.y, n.settings, n.id, n.title);
    }
    for (const e of p.edges) {
      try { this.connect(e.from.node, e.from.port, e.to.node, e.to.port, e.id); } catch (err) { problems.push(`연결을 복원하지 못했습니다: ${(err as Error).message}`); }
    }
    this.emit({ kind: 'title' });
    this.setPaused(false);
    return problems;
  }
}
