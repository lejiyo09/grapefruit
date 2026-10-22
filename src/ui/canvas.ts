/**
 * 워크플로 캔버스(Orange Canvas 스타일).
 *  - 노드: 카테고리 색 원형 아이콘 + 왼쪽 입력 / 오른쪽 출력 고리 + 제목
 *  - 출력 고리에서 끌어 다른 위젯에 놓으면 연결, 빈 곳에 놓으면 연결 가능한 위젯 빠른 메뉴
 *  - 빈 곳 드래그: 이동(팬), Ctrl+휠/핀치: 확대·축소, Delete: 선택 삭제
 * DOM 노드는 위젯 수만큼만 만들고, 연결선은 하나의 SVG에 그린다.
 */
import type { Workflow } from '../engine/workflow';
import { getWidget, allWidgets, possibleLinks } from '../engine/registry';
import { CATEGORIES, type WidgetDef, type NodeModel } from '../engine/types';
import { h, svg, toast } from './dom';

const NODE_R = 32; // 아이콘 반지름
const ANCHOR_GAP = 8;

export interface CanvasCallbacks {
  openNode(id: string): void;
  onChange(): void;
}

export class Canvas {
  el: HTMLElement;
  private world: HTMLElement;
  private edgeLayer: SVGSVGElement;
  private tempPath: SVGPathElement;
  private nodeEls = new Map<string, HTMLElement>();
  private selectedNodes = new Set<string>();
  private selectedEdge: string | null = null;
  view = { x: 0, y: 0, zoom: 1 };
  private menu: HTMLElement | null = null;

  constructor(private wf: Workflow, private cb: CanvasCallbacks) {
    this.edgeLayer = svg('svg', { class: 'edge-layer' });
    this.tempPath = svg('path', { class: 'edge temp' });
    this.edgeLayer.appendChild(this.tempPath);
    this.world = h('div', { class: 'world' });
    this.world.appendChild(this.edgeLayer);
    this.el = h('div', { class: 'canvas', tabindex: 0, 'aria-label': '워크플로 캔버스' }, this.world,
      h('div', { class: 'zoom-ctl' },
        h('button', { class: 'icon-btn', title: '확대', 'aria-label': '확대', onclick: () => this.zoomBy(1.2) }, '+'),
        h('button', { class: 'icon-btn', title: '축소', 'aria-label': '축소', onclick: () => this.zoomBy(1 / 1.2) }, '−'),
        h('button', { class: 'icon-btn', title: '전체 보기', 'aria-label': '전체 보기', onclick: () => this.fit() }, '⤢')),
      h('div', { class: 'canvas-hint' }, '왼쪽 목록에서 위젯을 끌어오거나 클릭해 추가하세요. 위젯 오른쪽 고리를 끌어 다른 위젯에 연결합니다.'));
    wf.on((ev) => {
      if (ev.kind === 'structure') this.sync();
      else if (ev.kind === 'node') { this.updateNode(ev.id); this.drawEdges(); }
    });
    this.bindCanvasEvents();
    this.sync();
  }

  // ---------------- 좌표 ----------------
  toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [(clientX - r.left - this.view.x) / this.view.zoom, (clientY - r.top - this.view.y) / this.view.zoom];
  }
  center(): [number, number] {
    const r = this.el.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  private applyView() {
    this.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
    this.el.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`;
    this.el.style.backgroundSize = `${24 * this.view.zoom}px ${24 * this.view.zoom}px`;
  }
  zoomBy(f: number, cx?: number, cy?: number) {
    const r = this.el.getBoundingClientRect();
    const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
    const z = Math.min(2.5, Math.max(0.3, this.view.zoom * f));
    this.view.x = px - ((px - this.view.x) * z) / this.view.zoom;
    this.view.y = py - ((py - this.view.y) * z) / this.view.zoom;
    this.view.zoom = z;
    this.applyView();
  }
  fit() {
    const nodes = [...this.wf.nodes.values()];
    const r = this.el.getBoundingClientRect();
    if (!nodes.length) { this.view = { x: 0, y: 0, zoom: 1 }; this.applyView(); return; }
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const x0 = Math.min(...xs) - 80, x1 = Math.max(...xs) + 80, y0 = Math.min(...ys) - 60, y1 = Math.max(...ys) + 90;
    const z = Math.min(1.4, Math.max(0.3, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
    this.view = { zoom: z, x: r.width / 2 - ((x0 + x1) / 2) * z, y: r.height / 2 - ((y0 + y1) / 2) * z };
    this.applyView();
  }
  setView(v?: { x: number; y: number; zoom: number }) { if (v) { this.view = { ...v }; this.applyView(); } }

  // ---------------- 노드 ----------------
  sync(): void {
    for (const [id, el] of this.nodeEls) if (!this.wf.nodes.has(id)) { el.remove(); this.nodeEls.delete(id); this.selectedNodes.delete(id); }
    for (const n of this.wf.nodes.values()) {
      if (!this.nodeEls.has(n.id)) this.nodeEls.set(n.id, this.createNode(n));
      this.updateNode(n.id);
    }
    if (this.selectedEdge && !this.wf.edges.has(this.selectedEdge)) this.selectedEdge = null;
    this.drawEdges();
    this.el.classList.toggle('empty', this.wf.nodes.size === 0);
    this.applyView();
  }

  private createNode(n: NodeModel): HTMLElement {
    const def = getWidget(n.type)!;
    const cat = CATEGORIES.find((c) => c.id === def.category)!;
    const icon = h('div', { class: 'node-icon', style: `--cat:${cat.color}` }, h('span', { class: 'abbr' }, def.abbr));
    const inA = def.inputs.length ? h('div', { class: 'anchor in', title: def.inputs.map((p) => p.name).join(', ') }) : null;
    const outA = def.outputs.length ? h('div', { class: 'anchor out', title: `${def.outputs.map((p) => p.name).join(', ')}\n끌어서 연결` }) : null;
    const el = h('div', { class: 'node', 'data-id': n.id, tabindex: 0, role: 'button', 'aria-label': `${n.title} 위젯` },
      h('div', { class: 'node-body' }, inA, icon, outA, h('div', { class: 'node-status' }), h('div', { class: 'node-progress' })),
      h('div', { class: 'node-title' }, n.title), h('div', { class: 'node-msg' }));
    this.world.appendChild(el);

    // 노드 이동 / 선택
    icon.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      this.closeMenu();
      if (!this.selectedNodes.has(n.id)) {
        if (!ev.shiftKey) this.selectedNodes.clear();
        this.selectedNodes.add(n.id);
      } else if (ev.shiftKey) this.selectedNodes.delete(n.id);
      this.selectedEdge = null;
      this.refreshSelection();
      const start = this.toWorld(ev.clientX, ev.clientY);
      const orig = new Map([...this.selectedNodes].map((id) => [id, { x: this.wf.nodes.get(id)!.x, y: this.wf.nodes.get(id)!.y }]));
      let moved = false;
      icon.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent) => {
        const [wx, wy] = this.toWorld(e.clientX, e.clientY);
        const dx = wx - start[0], dy = wy - start[1];
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        for (const [id, o] of orig) {
          this.wf.moveNode(id, Math.round(o.x + dx), Math.round(o.y + dy));
          this.positionNode(id);
        }
        this.drawEdges();
      };
      const up = () => {
        icon.removeEventListener('pointermove', move);
        icon.removeEventListener('pointerup', up);
        if (moved) this.cb.onChange();
      };
      icon.addEventListener('pointermove', move);
      icon.addEventListener('pointerup', up);
    });
    icon.addEventListener('dblclick', () => this.cb.openNode(n.id));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') this.cb.openNode(n.id); });
    el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.nodeMenu(n.id, ev.clientX, ev.clientY); });
    el.querySelector('.node-title')!.addEventListener('dblclick', () => this.rename(n.id));

    // 출력 고리에서 연결 끌기
    if (outA) outA.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.dragLink(n.id, ev); });
    // 입력 고리에서 끌면 기존 연결을 떼어 다시 연결
    if (inA) inA.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      const e = [...this.wf.edges.values()].reverse().find((x) => x.to.node === n.id);
      if (!e) return;
      this.wf.disconnect(e.id);
      this.dragLink(e.from.node, ev);
    });
    return el;
  }

  private positionNode(id: string) {
    const n = this.wf.nodes.get(id), el = this.nodeEls.get(id);
    if (n && el) el.style.transform = `translate(${n.x - 60}px, ${n.y - NODE_R}px)`;
  }

  private updateNode(id: string) {
    const n = this.wf.nodes.get(id), el = this.nodeEls.get(id), rt = this.wf.runtime.get(id);
    if (!n || !el || !rt) return;
    this.positionNode(id);
    el.querySelector('.node-title')!.textContent = n.title;
    el.dataset.status = rt.status;
    const st = el.querySelector('.node-status') as HTMLElement;
    st.textContent = rt.status === 'error' ? '!' : rt.status === 'warning' ? '!' : rt.status === 'waiting' ? 'i' : '';
    st.title = rt.message;
    const pr = el.querySelector('.node-progress') as HTMLElement;
    pr.style.setProperty('--p', String(rt.status === 'running' ? Math.max(0.05, rt.progress) : 0));
    const msg = el.querySelector('.node-msg') as HTMLElement;
    msg.textContent = rt.status === 'error' ? rt.message.split('\n')[0] : '';
    el.title = rt.message || n.title;
  }

  private refreshSelection() {
    for (const [id, el] of this.nodeEls) el.classList.toggle('selected', this.selectedNodes.has(id));
    this.drawEdges();
  }

  // ---------------- 연결선 ----------------
  private anchorPos(nodeId: string, side: 'in' | 'out'): [number, number] {
    const n = this.wf.nodes.get(nodeId)!;
    return [n.x + (side === 'out' ? NODE_R + ANCHOR_GAP : -(NODE_R + ANCHOR_GAP)), n.y];
  }

  private pathD(a: [number, number], b: [number, number]): string {
    const dx = Math.max(40, Math.abs(b[0] - a[0]) * 0.5);
    return `M${a[0]},${a[1]} C${a[0] + dx},${a[1]} ${b[0] - dx},${b[1]} ${b[0]},${b[1]}`;
  }

  drawEdges(): void {
    for (const el of [...this.edgeLayer.querySelectorAll('g.edge-g')]) el.remove();
    for (const e of this.wf.edges.values()) {
      if (!this.wf.nodes.has(e.from.node) || !this.wf.nodes.has(e.to.node)) continue;
      const a = this.anchorPos(e.from.node, 'out'), b = this.anchorPos(e.to.node, 'in');
      const d = this.pathD(a, b);
      const val = this.wf.runtime.get(e.from.node)?.outputs[e.from.port];
      const active = val !== null && val !== undefined;
      const fromDef = getWidget(this.wf.nodes.get(e.from.node)!.type)!;
      const toDef = getWidget(this.wf.nodes.get(e.to.node)!.type)!;
      const outName = fromDef.outputs.find((p) => p.id === e.from.port)?.name ?? e.from.port;
      const inName = toDef.inputs.find((p) => p.id === e.to.port)?.name ?? e.to.port;
      const g = svg('g', { class: `edge-g${this.selectedEdge === e.id ? ' selected' : ''}` });
      const hit = svg('path', { d, class: 'edge-hit' });
      const path = svg('path', { d, class: `edge${active ? ' active' : ''}` });
      const label = svg('text', { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 - 6, class: 'edge-label' });
      label.textContent = outName === inName ? outName : `${outName} → ${inName}`;
      const title = svg('title');
      title.textContent = `${outName} → ${inName}${active ? '' : ' (데이터 없음)'}\n클릭 후 Delete로 삭제`;
      g.append(hit, path, label, title);
      g.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.selectedEdge = e.id; this.selectedNodes.clear(); this.refreshSelection(); this.el.focus(); });
      g.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.showMenu(ev.clientX, ev.clientY, [{ label: '연결 삭제', run: () => this.wf.disconnect(e.id) }]);
      });
      this.edgeLayer.insertBefore(g, this.tempPath);
    }
  }

  private dragLink(fromId: string, ev: PointerEvent) {
    const start = this.anchorPos(fromId, 'out');
    this.el.setPointerCapture(ev.pointerId);
    this.el.classList.add('linking');
    const move = (e: PointerEvent) => {
      const p = this.toWorld(e.clientX, e.clientY);
      this.tempPath.setAttribute('d', this.pathD(start, p));
      const target = this.nodeAt(e.clientX, e.clientY);
      for (const [id, el] of this.nodeEls) el.classList.toggle('drop-target', id === target && id !== fromId);
    };
    const up = (e: PointerEvent) => {
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.classList.remove('linking');
      this.tempPath.setAttribute('d', '');
      for (const el of this.nodeEls.values()) el.classList.remove('drop-target');
      const target = this.nodeAt(e.clientX, e.clientY);
      if (target && target !== fromId) this.connectTo(fromId, target, e.clientX, e.clientY);
      else if (!target) this.quickMenu(fromId, e.clientX, e.clientY);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
  }

  private nodeAt(clientX: number, clientY: number): string | null {
    const [x, y] = this.toWorld(clientX, clientY);
    for (const n of this.wf.nodes.values()) if (Math.abs(n.x - x) < NODE_R + 14 && Math.abs(n.y - y) < NODE_R + 14) return n.id;
    return null;
  }

  /** 두 위젯 연결: 가능한 채널이 여러 개면 메뉴로 고른다(Orange의 링크 편집 대화상자 대신) */
  private connectTo(from: string, to: string, cx: number, cy: number) {
    const a = getWidget(this.wf.nodes.get(from)!.type)!, b = getWidget(this.wf.nodes.get(to)!.type)!;
    const links = possibleLinks(a, b).filter((l) => !this.wf.canConnect(from, l.out.id, to, l.inp.id));
    if (!links.length) {
      const r = this.wf.autoConnect(from, to);
      if (typeof r === 'string') toast(r, { kind: 'error' });
      return;
    }
    const used = new Set([...this.wf.edges.values()].filter((e) => e.to.node === to).map((e) => e.to.port));
    const free = links.filter((l) => !used.has(l.inp.id) || l.inp.multiple);
    const top = free[0] ?? links[0];
    const ambiguous = links.length > 1 && (free.length > 1 && (free[1].out.default === top.out.default && free[1].inp.default === top.inp.default));
    if (!ambiguous) {
      try { this.wf.connect(from, top.out.id, to, top.inp.id); this.cb.onChange(); } catch (e) { toast((e as Error).message, { kind: 'error' }); }
      return;
    }
    this.showMenu(cx, cy, links.map((l) => ({
      label: `${l.out.name} → ${l.inp.name}`,
      run: () => { try { this.wf.connect(from, l.out.id, to, l.inp.id); this.cb.onChange(); } catch (e) { toast((e as Error).message, { kind: 'error' }); } },
    })), '연결할 채널 선택');
  }

  /** 빈 곳에 연결을 놓았을 때: 연결 가능한 위젯 검색 메뉴 */
  private quickMenu(fromId: string, cx: number, cy: number) {
    const from = getWidget(this.wf.nodes.get(fromId)!.type)!;
    const cands = allWidgets().filter((w) => possibleLinks(from, w).length);
    const [wx, wy] = this.toWorld(cx, cy);
    this.widgetPicker(cx, cy, cands, (w) => {
      const n = this.wf.addNode(w.type, Math.round(wx + 60), Math.round(wy));
      const r = this.wf.autoConnect(fromId, n.id);
      if (typeof r === 'string') toast(r, { kind: 'error' });
      this.cb.onChange();
    });
  }

  widgetPicker(cx: number, cy: number, widgets: WidgetDef[], pick: (w: WidgetDef) => void) {
    this.closeMenu();
    const input = h('input', { type: 'search', placeholder: '위젯 검색…', class: 'search' });
    const list = h('div', { class: 'picker-list' });
    let items: WidgetDef[] = [];
    let active = 0;
    const render = () => {
      const q = input.value.trim().toLowerCase();
      items = widgets.filter((w) => !q || w.name.toLowerCase().includes(q) || w.keywords?.some((k) => k.toLowerCase().includes(q)) || w.description.includes(q));
      active = Math.min(active, Math.max(0, items.length - 1));
      list.replaceChildren(...items.map((w, i) => {
        const cat = CATEGORIES.find((c) => c.id === w.category)!;
        return h('button', { class: `picker-item${i === active ? ' active' : ''}`, onclick: () => { this.closeMenu(); pick(w); } },
          h('span', { class: 'mini-icon', style: `--cat:${cat.color}` }, w.abbr), h('span', null, w.name), h('span', { class: 'muted small' }, cat.name));
      }));
    };
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter' && items[active]) { this.closeMenu(); pick(items[active]); }
      else if (e.key === 'Escape') this.closeMenu();
    });
    render();
    this.menu = h('div', { class: 'popup picker', style: this.popupPos(cx, cy, 300, 360) }, input, list);
    document.body.appendChild(this.menu);
    input.focus();
  }

  private popupPos(cx: number, cy: number, w: number, hh: number): string {
    const x = Math.min(cx, window.innerWidth - w - 8), y = Math.min(cy, window.innerHeight - hh - 8);
    return `left:${Math.max(8, x)}px;top:${Math.max(8, y)}px;width:${w}px`;
  }

  showMenu(cx: number, cy: number, items: Array<{ label: string; run: () => void; danger?: boolean }>, title?: string) {
    this.closeMenu();
    this.menu = h('div', { class: 'popup menu', role: 'menu', style: this.popupPos(cx, cy, 220, items.length * 34 + 40) },
      title ? h('div', { class: 'menu-title' }, title) : null,
      ...items.map((it) => h('button', { class: `menu-item${it.danger ? ' danger' : ''}`, role: 'menuitem', onclick: () => { this.closeMenu(); it.run(); } }, it.label)));
    document.body.appendChild(this.menu);
    (this.menu.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  closeMenu() { this.menu?.remove(); this.menu = null; }

  private nodeMenu(id: string, cx: number, cy: number) {
    this.showMenu(cx, cy, [
      { label: '열기', run: () => this.cb.openNode(id) },
      { label: '이름 바꾸기', run: () => this.rename(id) },
      { label: '다시 실행', run: () => this.wf.markDirty(id) },
      { label: '복제', run: () => this.duplicate(id) },
      { label: '삭제', run: () => { this.wf.removeNode(id); this.cb.onChange(); }, danger: true },
    ], this.wf.nodes.get(id)?.title);
  }

  private duplicate(id: string) {
    const n = this.wf.nodes.get(id);
    if (!n) return;
    this.wf.addNode(n.type, n.x + 40, n.y + 40, structuredClone(n.settings));
    this.cb.onChange();
  }

  rename(id: string) {
    const n = this.wf.nodes.get(id);
    if (!n) return;
    const el = this.nodeEls.get(id)!.querySelector('.node-title') as HTMLElement;
    const input = h('input', { type: 'text', value: n.title, class: 'rename' });
    el.replaceChildren(input);
    input.focus(); input.select();
    const done = (ok: boolean) => { if (ok) this.wf.renameNode(id, input.value); el.textContent = this.wf.nodes.get(id)?.title ?? ''; this.cb.onChange(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
    input.addEventListener('blur', () => done(true));
  }

  deleteSelection() {
    if (this.selectedEdge) { this.wf.disconnect(this.selectedEdge); this.selectedEdge = null; this.cb.onChange(); return; }
    if (!this.selectedNodes.size) return;
    for (const id of [...this.selectedNodes]) this.wf.removeNode(id);
    this.selectedNodes.clear();
    this.cb.onChange();
  }

  /** 새 위젯을 겹치지 않는 위치에 추가 */
  addWidgetNear(type: string, x?: number, y?: number): NodeModel {
    let [cx, cy] = x !== undefined && y !== undefined ? [x, y] : this.center();
    const taken = (px: number, py: number) => [...this.wf.nodes.values()].some((n) => Math.abs(n.x - px) < 90 && Math.abs(n.y - py) < 90);
    let tries = 0;
    while (taken(cx, cy) && tries++ < 30) { cx += 140; if (tries % 4 === 0) { cx -= 560; cy += 120; } }
    const n = this.wf.addNode(type, Math.round(cx), Math.round(cy));
    this.selectedNodes = new Set([n.id]);
    this.refreshSelection();
    this.cb.onChange();
    return n;
  }

  // ---------------- 캔버스 이벤트 ----------------
  private bindCanvasEvents() {
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    this.el.addEventListener('pointerdown', (ev) => {
      if ((ev.target as HTMLElement).closest('.node, .zoom-ctl')) return;
      this.closeMenu();
      this.el.focus();
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        return;
      }
      this.selectedNodes.clear(); this.selectedEdge = null; this.refreshSelection();
      const sx = ev.clientX, sy = ev.clientY, vx = this.view.x, vy = this.view.y;
      this.el.setPointerCapture(ev.pointerId);
      this.el.classList.add('panning');
      const move = (e: PointerEvent) => {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const r = this.el.getBoundingClientRect();
          if (pinchDist) this.zoomBy(d / pinchDist, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
          pinchDist = d;
          return;
        }
        this.view.x = vx + (e.clientX - sx); this.view.y = vy + (e.clientY - sy);
        this.applyView();
      };
      const up = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (pointers.size) return;
        this.el.removeEventListener('pointermove', move);
        this.el.removeEventListener('pointerup', up);
        this.el.removeEventListener('pointercancel', up);
        this.el.classList.remove('panning');
      };
      this.el.addEventListener('pointermove', move);
      this.el.addEventListener('pointerup', up);
      this.el.addEventListener('pointercancel', up);
    });
    this.el.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = this.el.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) this.zoomBy(Math.exp(-ev.deltaY * 0.0025), ev.clientX - r.left, ev.clientY - r.top);
      else { this.view.x -= ev.deltaX; this.view.y -= ev.deltaY; this.applyView(); }
    }, { passive: false });
    this.el.addEventListener('dblclick', (ev) => {
      if ((ev.target as HTMLElement).closest('.node')) return;
      const [wx, wy] = this.toWorld(ev.clientX, ev.clientY);
      this.widgetPicker(ev.clientX, ev.clientY, allWidgets(), (w) => this.addWidgetNear(w.type, wx, wy));
    });
    this.el.addEventListener('keydown', (ev) => {
      if ((ev.target as HTMLElement).tagName === 'INPUT') return;
      if (ev.key === 'Delete' || ev.key === 'Backspace') { this.deleteSelection(); ev.preventDefault(); }
      if (ev.key === 'Escape') this.closeMenu();
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') { this.selectedNodes = new Set(this.wf.nodes.keys()); this.refreshSelection(); ev.preventDefault(); }
    });
    // 팔레트에서 끌어 놓기
    this.el.addEventListener('dragover', (ev) => { if (ev.dataTransfer?.types.includes('application/x-grapefruit-widget')) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
    this.el.addEventListener('drop', (ev) => {
      const type = ev.dataTransfer?.getData('application/x-grapefruit-widget');
      if (!type) return;
      ev.preventDefault();
      const [wx, wy] = this.toWorld(ev.clientX, ev.clientY);
      this.addWidgetNear(type, wx, wy);
    });
    document.addEventListener('pointerdown', (ev) => { if (this.menu && !this.menu.contains(ev.target as Node)) this.closeMenu(); });
  }
}
