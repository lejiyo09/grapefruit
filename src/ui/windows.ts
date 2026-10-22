/**
 * 위젯 창(Orange의 위젯 대화상자). 왼쪽 컨트롤 영역 + 오른쪽 결과 영역 + 아래 상태 표시줄.
 * 창은 여러 개 열 수 있고, 끌어서 옮기거나 크기를 바꿀 수 있다.
 * 노드가 다시 실행되면 창 내용을 다시 그린다(스크롤 위치 유지).
 */
import type { Workflow } from '../engine/workflow';
import { getWidget } from '../engine/registry';
import { categoryOf, type ViewApi } from '../engine/types';
import { h, clear } from './dom';

interface OpenWindow { el: HTMLElement; render: () => void; unsub: () => void; lastStatus: string; closed: boolean }

export class WindowManager {
  private open = new Map<string, OpenWindow>();
  private z = 100;

  constructor(private wf: Workflow, private host: HTMLElement) {
    wf.on((ev) => {
      if (ev.kind === 'structure') for (const id of [...this.open.keys()]) if (!wf.nodes.has(id)) this.close(id);
    });
  }

  isOpen(id: string): boolean { return this.open.has(id); }

  openNode(id: string): void {
    const existing = this.open.get(id);
    if (existing) { existing.el.style.zIndex = String(++this.z); return; }
    const node = this.wf.nodes.get(id);
    if (!node) return;
    const def = getWidget(node.type)!;
    const cat = categoryOf(def.category);
    const [w0, h0] = def.windowSize ?? [720, 480];
    const W = Math.min(w0, window.innerWidth - 16), H = Math.min(h0, window.innerHeight - 70);
    const offset = (this.open.size % 6) * 28;
    const left = Math.max(8, Math.min(window.innerWidth - W - 8, (window.innerWidth - W) / 2 + offset));
    const top = Math.max(56, Math.min(window.innerHeight - H - 8, 80 + offset));

    const titleEl = h('span', { class: 'win-title' }, node.title);
    const statusEl = h('span', { class: 'win-status' });
    const controls = h('div', { class: 'win-controls' });
    const main = h('div', { class: 'win-main' });
    const footerMsg = h('span', { class: 'win-msg' });
    const progress = h('div', { class: 'win-progress' });
    const cancelBtn = h('button', { class: 'btn small', hidden: true, onclick: () => this.wf.cancel() }, '취소');
    const help = h('div', { class: 'win-help', hidden: true }, def.description);
    const el = h('section', {
      class: `widget-window${def.controlsOnly ? ' controls-only' : ''}`, role: 'dialog', 'aria-label': node.title,
      style: `left:${left}px;top:${top}px;width:${W}px;height:${H}px;z-index:${++this.z};--cat:${cat.color}`,
    },
    h('header', { class: 'win-head' },
      h('span', { class: 'mini-icon', style: `--cat:${cat.color}` }, def.abbr), titleEl, statusEl,
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: '도움말', 'aria-label': '도움말', onclick: () => { help.hidden = !help.hidden; } }, '?'),
      h('button', { class: 'icon-btn', title: '닫기 (Esc)', 'aria-label': '닫기', onclick: () => this.close(id) }, '×')),
    help,
    h('div', { class: 'win-body' }, controls, def.controlsOnly ? null : main),
    h('footer', { class: 'win-foot' }, progress, footerMsg, cancelBtn));
    this.host.appendChild(el);

    el.addEventListener('pointerdown', () => { el.style.zIndex = String(++this.z); });
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !(ev.target as HTMLElement).closest('input,select,textarea')) this.close(id); });
    this.makeDraggable(el, el.querySelector('.win-head') as HTMLElement);

    let renderQueued = false;
    const win: OpenWindow = { el, render: () => {}, unsub: () => {}, lastStatus: '', closed: false };
    const render = () => {
      renderQueued = false;
      if (win.closed) return;
      const n = this.wf.nodes.get(id);
      const rt = this.wf.runtime.get(id);
      if (!n || !rt) return;
      titleEl.textContent = n.title;
      const scrolls = [...el.querySelectorAll('.main-scroll, .win-controls, .win-main, .dt-scroll')].map((s) => [s.className, s.scrollTop, s.scrollLeft] as const);
      clear(controls); clear(main);
      const api: ViewApi<any> = {
        nodeId: id,
        title: n.title,
        settings: n.settings,
        inputs: this.wf.gatherInputs(id),
        outputs: rt.outputs,
        view: rt.view,
        status: rt.status,
        message: rt.message,
        update: (patch) => this.wf.updateSettings(id, patch as Record<string, unknown>),
        silentUpdate: (patch) => this.wf.updateSettings(id, patch as Record<string, unknown>, false),
        rerender: () => queue(),
        closed: () => win.closed,
      };
      try {
        def.render?.({ controls, main }, api);
      } catch (e) {
        console.error(e);
        main.appendChild(h('div', { class: 'ctl-note error' }, `화면을 그리는 중 오류: ${(e as Error).message}`));
      }
      for (const [cls, st, sl] of scrolls) {
        const s = el.getElementsByClassName(cls.split(' ')[0])[0] as HTMLElement | undefined;
        if (s) { s.scrollTop = st; s.scrollLeft = sl; }
      }
      updateStatus();
    };
    const queue = () => { if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); } };
    const updateStatus = () => {
      const rt = this.wf.runtime.get(id);
      if (!rt) return;
      const labels: Record<string, string> = { idle: '', waiting: '입력 대기', queued: '대기 중', running: '계산 중…', done: '', warning: '경고', error: '오류' };
      statusEl.textContent = labels[rt.status] ?? '';
      statusEl.dataset.status = rt.status;
      footerMsg.textContent = rt.status === 'running' ? '계산 중…' : rt.message.split('\n')[0] || (rt.status === 'done' ? `완료 (${Math.round(rt.lastRunMs)}ms)` : '');
      footerMsg.title = rt.message;
      footerMsg.dataset.status = rt.status;
      progress.style.setProperty('--p', String(rt.status === 'running' ? Math.max(0.03, rt.progress) : 0));
      cancelBtn.hidden = rt.status !== 'running';
      el.classList.toggle('busy', rt.status === 'running' || rt.status === 'queued');
    };
    win.render = render;
    win.unsub = this.wf.on((ev) => {
      if (ev.kind === 'node' && ev.id === id) {
        const rt = this.wf.runtime.get(id);
        if (!rt) return;
        updateStatus();
        // 실행이 끝났을 때만 다시 그림(진행률 이벤트에는 다시 그리지 않음)
        if (rt.status !== 'running' && rt.status !== 'queued' && win.lastStatus !== `${rt.status}:${rt.lastRunMs}`) {
          win.lastStatus = `${rt.status}:${rt.lastRunMs}`;
          queue();
        }
      } else if (ev.kind === 'structure') queue();
    });
    // 창 크기를 바꾸면 그래프를 다시 그림
    let lastW = 0, lastH = 0, t: number | undefined;
    const ro = new ResizeObserver(() => {
      const r = main.getBoundingClientRect();
      if (Math.abs(r.width - lastW) < 8 && Math.abs(r.height - lastH) < 8) return;
      lastW = r.width; lastH = r.height;
      clearTimeout(t);
      t = window.setTimeout(queue, 150);
    });
    ro.observe(el);
    const unsubWf = win.unsub;
    win.unsub = () => { unsubWf(); ro.disconnect(); };
    this.open.set(id, win);
    requestAnimationFrame(render);
  }

  close(id: string): void {
    const w = this.open.get(id);
    if (!w) return;
    w.closed = true;
    w.unsub();
    w.el.remove();
    this.open.delete(id);
  }

  closeAll(): void { for (const id of [...this.open.keys()]) this.close(id); }

  private makeDraggable(el: HTMLElement, handle: HTMLElement) {
    handle.addEventListener('pointerdown', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      const sx = ev.clientX, sy = ev.clientY;
      const ox = el.offsetLeft, oy = el.offsetTop;
      handle.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent) => {
        el.style.left = `${Math.max(-el.offsetWidth + 80, Math.min(window.innerWidth - 80, ox + e.clientX - sx))}px`;
        el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy))}px`;
      };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
}
