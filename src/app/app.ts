/** 앱 셸: 상단 막대, 위젯 팔레트, 캔버스, 상태 표시줄, 자동 저장 */
import { Workflow } from '../engine/workflow';
import { WorkerCompute } from '../engine/compute';
import { allWidgets } from '../engine/registry';
import { CATEGORIES, type ProjectFile } from '../engine/types';
import { Canvas } from '../ui/canvas';
import { WindowManager } from '../ui/windows';
import { h, download, toast, pickFile } from '../ui/dom';
import { UpdateCenter, APP_VERSION } from '../updates/updates';
import * as db from '../storage/db';
import { EXAMPLES } from './examples';

const AUTOSAVE_KEY = 'autosave';
/** 페이지를 닫을 때 IndexedDB 저장이 끝나기 전에 종료될 수 있어, 동기식 localStorage에도 백업한다 */
const LS_AUTOSAVE = 'grapefruit.autosave';

interface Autosave { savedAt: string; project: ProjectFile }
const LS_COLLAPSED = 'grapefruit.collapsedCategories';

export function startApp(root: HTMLElement): void {
  const wf = new Workflow(new WorkerCompute());
  const winHost = h('div', { class: 'window-host' });
  let saveTimer: number | undefined;
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = window.setTimeout(() => void saveNow(), 800); };
  const snapshot = (): Autosave => ({ savedAt: new Date().toISOString(), project: wf.toJSON(canvas.view) });
  const saveNow = async () => { await db.put('projects', AUTOSAVE_KEY, snapshot()); };
  const saveSync = () => { clearTimeout(saveTimer); const snap = snapshot(); safeLsSet(LS_AUTOSAVE, JSON.stringify(snap)); void db.put('projects', AUTOSAVE_KEY, snap); };

  const windows = new WindowManager(wf, winHost);
  const canvas = new Canvas(wf, { openNode: (id) => windows.openNode(id), onChange: scheduleSave });
  wf.on((ev) => { if (ev.kind === 'structure' || ev.kind === 'settings') scheduleSave(); });

  // ---------------- 상단 막대 ----------------
  const titleInput = h('input', { class: 'project-title', value: wf.title, 'aria-label': '프로젝트 이름' });
  titleInput.addEventListener('change', () => { wf.title = titleInput.value.trim() || '제목 없는 워크플로'; scheduleSave(); });
  const runState = h('span', { class: 'run-state' });
  const cancelAll = h('button', { class: 'btn small', hidden: true, onclick: () => wf.cancel() }, '계산 취소');
  const updateBtn = h('button', { class: 'btn update-btn', 'aria-label': '업데이트 센터' }, h('span', { class: 'bell', 'aria-hidden': 'true' }), h('span', { class: 'label' }, '업데이트'));
  const examplesBtn = h('button', { class: 'btn' }, '예제 ▾');
  examplesBtn.addEventListener('click', (ev) => {
    const r = examplesBtn.getBoundingClientRect();
    canvas.showMenu(r.left, r.bottom + 4, EXAMPLES.map((ex) => ({ label: `${ex.title} — ${ex.description}`, run: () => loadProject(structuredClone(ex.project), true) })), '예제 워크플로');
    ev.stopPropagation();
  });
  const paletteToggle = h('button', { class: 'icon-btn palette-toggle', title: '위젯 목록 접기/펼치기', 'aria-label': '위젯 목록 접기/펼치기' }, '☰');
  paletteToggle.addEventListener('click', () => root.classList.toggle('palette-hidden'));
  const header = h('header', { class: 'topbar' },
    paletteToggle,
    h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }), h('span', { class: 'brand-name' }, 'Grapefruit'), h('span', { class: 'brand-ver' }, `v${APP_VERSION}`)),
    titleInput,
    h('nav', { class: 'top-actions' },
      h('button', { class: 'btn', title: '새 워크플로', onclick: () => newProject() }, '새로 만들기'),
      h('button', { class: 'btn', title: '프로젝트 파일 열기 (.json)', onclick: () => void openProjectFile() }, '열기'),
      h('button', { class: 'btn', title: '프로젝트 파일로 저장 (Ctrl+S)', onclick: () => saveProjectFile() }, '저장'),
      examplesBtn),
    h('div', { class: 'top-right' }, runState, cancelAll, updateBtn));

  // ---------------- 팔레트 ----------------
  const collapsed = new Set<string>(parseJson(safeLs(LS_COLLAPSED)) ?? []);
  const search = h('input', { type: 'search', class: 'search', placeholder: '위젯 검색 (예: tree, 산점도)', 'aria-label': '위젯 검색' });
  const list = h('div', { class: 'palette-list' });
  const renderPalette = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const cat of CATEGORIES) {
      const ws = allWidgets().filter((w) => w.category === cat.id && (!q || w.name.toLowerCase().includes(q) || w.keywords?.some((k) => k.toLowerCase().includes(q)) || w.description.toLowerCase().includes(q)));
      if (!ws.length) continue;
      const open = !!q || !collapsed.has(cat.id);
      list.appendChild(h('button', {
        class: 'cat-head', style: `--cat:${cat.color}`, 'aria-expanded': String(open),
        onclick: () => {
          if (collapsed.has(cat.id)) collapsed.delete(cat.id); else collapsed.add(cat.id);
          safeLsSet(LS_COLLAPSED, JSON.stringify([...collapsed]));
          renderPalette();
        },
      }, h('span', { class: 'cat-dot' }), cat.name, h('span', { class: 'muted small' }, String(ws.length))));
      if (!open) continue;
      list.appendChild(h('div', { class: 'cat-items' }, ...ws.map((w) => {
        const item = h('button', { class: 'palette-item', draggable: true, title: w.description, onclick: () => canvas.addWidgetNear(w.type) },
          h('span', { class: 'mini-icon', style: `--cat:${cat.color}` }, w.abbr), h('span', { class: 'pi-name' }, w.name));
        item.addEventListener('dragstart', (ev) => { ev.dataTransfer!.setData('application/x-grapefruit-widget', w.type); ev.dataTransfer!.effectAllowed = 'copy'; });
        return item;
      })));
    }
  };
  search.addEventListener('input', renderPalette);
  renderPalette();
  const palette = h('aside', { class: 'palette' }, search, list);

  // ---------------- 상태 표시줄 ----------------
  const status = h('footer', { class: 'statusbar' });
  const refreshStatus = () => {
    const rts = [...wf.runtime.values()];
    const running = [...wf.runtime.entries()].find(([, r]) => r.status === 'running');
    const errors = rts.filter((r) => r.status === 'error').length;
    const queued = rts.filter((r) => r.dirty).length;
    runState.textContent = running ? `계산 중: ${wf.nodes.get(running[0])?.title}${queued ? ` (+${queued})` : ''}` : '';
    cancelAll.hidden = !running;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    status.textContent = `위젯 ${wf.nodes.size} · 연결 ${wf.edges.size}${errors ? ` · 오류 ${errors}` : ''}${mem ? ` · 메모리 ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : ''} · 이 브라우저에 자동 저장`;
  };
  let statusQueued = false;
  wf.on(() => { if (!statusQueued) { statusQueued = true; requestAnimationFrame(() => { statusQueued = false; refreshStatus(); }); } });
  setInterval(refreshStatus, 5000);

  root.append(header, h('div', { class: 'workspace' }, palette, canvas.el), status, winHost);

  // ---------------- 업데이트 센터 ----------------
  const updates = new UpdateCenter(updateBtn);
  updates.beforeReload = async () => { saveSync(); await saveNow(); };
  updates.start();

  // ---------------- 프로젝트 ----------------
  function loadProject(p: ProjectFile, fit = false) {
    windows.closeAll();
    const problems = wf.load(p);
    titleInput.value = wf.title;
    if (p.view && !fit) canvas.setView(p.view); else requestAnimationFrame(() => canvas.fit());
    for (const m of problems) toast(m, { kind: 'error' });
    scheduleSave();
  }
  function newProject() {
    if (wf.nodes.size && !confirm('현재 워크플로를 지우고 새로 시작할까요? (파일로 저장하지 않은 내용은 사라집니다)')) return;
    windows.closeAll();
    wf.clear();
    wf.title = '제목 없는 워크플로';
    titleInput.value = wf.title;
    canvas.setView({ x: 0, y: 0, zoom: 1 });
    scheduleSave();
  }
  function saveProjectFile() {
    const name = (wf.title || 'workflow').replace(/[\\/:*?"<>|]+/g, '_');
    download(`${name}.grapefruit.json`, JSON.stringify(wf.toJSON(canvas.view), null, 2), 'application/json');
    toast('프로젝트를 저장했습니다. 내 컴퓨터에서 연 데이터 파일은 프로젝트에 포함되지 않으니 함께 보관하세요.');
  }
  async function openProjectFile() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const p = JSON.parse(await f.text()) as ProjectFile;
      loadProject(p);
      if (p.nodes.some((n) => n.type === 'data.file' && n.settings.source === 'local')) toast('내 컴퓨터 파일을 쓰는 File 위젯은, 이 브라우저에 파일이 없으면 다시 선택해야 합니다.');
    } catch (e) { toast(`프로젝트를 열 수 없습니다: ${(e as Error).message}`, { kind: 'error' }); }
  }

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveProjectFile(); }
  });
  window.addEventListener('pagehide', saveSync);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSync(); });

  // 자동 저장 복원, 없으면 기본 예제
  void (async () => {
    const fromDb = await db.get<Autosave>('projects', AUTOSAVE_KEY);
    const fromLs = parseJson<Autosave>(safeLs(LS_AUTOSAVE));
    const saved = [fromDb, fromLs].filter((x): x is Autosave => !!x?.project).sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
    if (saved && saved.project.nodes?.length) loadProject(saved.project);
    else loadProject(structuredClone(EXAMPLES[0].project), true);
  })();
  (window as unknown as { grapefruit: unknown }).grapefruit = { wf, canvas, windows };
}

function parseJson<T>(s: string | null): T | null { try { return s ? (JSON.parse(s) as T) : null; } catch { return null; } }
function safeLs(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function safeLsSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* 무시 */ } }
