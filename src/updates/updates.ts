/**
 * 업데이트 센터(업데이트 위젯)
 *  - 새 소식(체인지로그) · 로드맵 · 앱 정보 탭
 *  - 마지막으로 본 버전 이후의 소식이 있으면 상단 버튼에 배지 표시, 업데이트 직후에는 "새 소식" 창 자동 표시
 *  - 배포된 version.json을 주기적으로 확인해 새 빌드가 올라오면 새로고침 안내
 */
import { CHANGELOG, ROADMAP, type ChangelogEntry, type RoadmapStatus } from './changelog';
import { h, clear, toast } from '../ui/dom';

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
declare const __BUILT_AT__: string;

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
export const BUILT_AT = typeof __BUILT_AT__ !== 'undefined' ? __BUILT_AT__ : '';

const LS_SEEN = 'grapefruit.lastSeenVersion';
const LS_AUTOCHECK = 'grapefruit.autoCheckUpdates';
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* 무시 */ } }

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0), pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** lastSeen 이후 새로 나온 항목 */
export function unseenEntries(lastSeen: string | null, entries: ChangelogEntry[] = CHANGELOG): ChangelogEntry[] {
  if (!lastSeen) return entries.slice(0, 1);
  return entries.filter((e) => compareVersions(e.version, lastSeen) > 0);
}

interface RemoteVersion { version: string; buildId: string; builtAt: string }

export class UpdateCenter {
  private badge: HTMLElement;
  private panel: HTMLElement | null = null;
  private remote: RemoteVersion | null = null;
  private lastCheck: Date | null = null;
  private timer: number | null = null;
  private notified = false;
  /** 새로고침 전에 호출(프로젝트 저장 등) */
  beforeReload: () => Promise<void> = async () => {};

  constructor(private button: HTMLElement) {
    this.badge = h('span', { class: 'badge', hidden: true });
    button.appendChild(this.badge);
    button.addEventListener('click', () => (this.panel ? this.close() : this.open('news')));
  }

  start(): void {
    const lastSeen = lsGet(LS_SEEN);
    const unseen = unseenEntries(lastSeen);
    this.setBadge(unseen.length ? String(unseen.length) : '');
    // 이전 버전을 쓰던 사용자가 업데이트된 앱을 처음 열면 새 소식 창을 띄운다(노트 앱의 "What's new"처럼)
    if (lastSeen && unseen.length) setTimeout(() => this.open('news'), 600);
    if (!lastSeen) lsSet(LS_SEEN, '0.0.0');
    if (this.autoCheck()) this.schedule();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.autoCheck()) void this.check(); });
    window.addEventListener('online', () => { if (this.autoCheck()) void this.check(); });
  }

  private autoCheck(): boolean { return lsGet(LS_AUTOCHECK) !== 'off'; }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    setTimeout(() => void this.check(), 5000);
    this.timer = window.setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  private setBadge(text: string, kind: 'news' | 'update' = 'news'): void {
    this.badge.hidden = !text;
    this.badge.textContent = text;
    this.badge.className = `badge ${kind}`;
    this.button.title = kind === 'update' ? '새 버전이 배포되었습니다' : text ? '새 소식이 있습니다' : '업데이트 · 새 소식';
  }

  /** 배포된 version.json 확인. 새 빌드가 있으면 true */
  async check(manual = false): Promise<boolean> {
    if (!navigator.onLine) { if (manual) toast('오프라인 상태라 업데이트를 확인할 수 없습니다.'); return false; }
    try {
      const url = new URL('version.json', document.baseURI);
      url.searchParams.set('t', String(Date.now()));
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = (await res.json()) as RemoteVersion;
      this.remote = info;
      this.lastCheck = new Date();
      const newer = !!info.buildId && info.buildId !== BUILD_ID;
      if (newer) {
        this.setBadge('NEW', 'update');
        if (!this.notified || manual) {
          this.notified = true;
          toast(`새 버전${info.version !== APP_VERSION ? ` v${info.version}` : ''}이 배포되었습니다.`, { action: { label: '지금 업데이트', run: () => void this.applyUpdate() } });
        }
      } else if (manual) toast('최신 버전을 사용하고 있습니다.', { kind: 'success' });
      this.refreshPanel();
      return newer;
    } catch (e) {
      if (manual) toast(BUILD_ID === 'dev' ? '개발 모드에서는 배포 버전을 확인할 수 없습니다.' : `업데이트 확인 실패: ${(e as Error).message}`, { kind: 'error' });
      return false;
    }
  }

  /** 서비스 워커 캐시를 비우고 새로고침 */
  async applyUpdate(): Promise<void> {
    await this.beforeReload();
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
      if (window.caches) for (const k of await caches.keys()) if (k.startsWith('grapefruit-')) await caches.delete(k);
    } catch { /* 무시 */ }
    location.reload();
  }

  open(tab: 'news' | 'roadmap' | 'about'): void {
    this.close();
    this.panel = h('aside', { class: 'update-panel', role: 'dialog', 'aria-label': '업데이트 센터' });
    document.body.appendChild(this.panel);
    this.render(tab);
    // 새 소식을 열면 읽음 처리
    if (tab === 'news') {
      lsSet(LS_SEEN, CHANGELOG[0]?.version ?? APP_VERSION);
      if (!(this.remote && this.remote.buildId !== BUILD_ID)) this.setBadge('');
    }
  }

  close(): void { this.panel?.remove(); this.panel = null; }

  private currentTab: 'news' | 'roadmap' | 'about' = 'news';
  private refreshPanel(): void { if (this.panel) this.render(this.currentTab); }

  private render(tab: 'news' | 'roadmap' | 'about'): void {
    const p = this.panel!;
    this.currentTab = tab;
    clear(p);
    const tabBtn = (id: typeof tab, label: string) => h('button', { class: `tab${tab === id ? ' active' : ''}`, onclick: () => this.render(id) }, label);
    const updateAvailable = this.remote && this.remote.buildId !== BUILD_ID;
    p.appendChild(h('header', { class: 'update-head' },
      h('div', { class: 'update-title' }, h('strong', null, '업데이트 센터'), h('span', { class: 'muted' }, `v${APP_VERSION}`)),
      h('button', { class: 'icon-btn', 'aria-label': '닫기', title: '닫기', onclick: () => this.close() }, '×')));
    if (updateAvailable) {
      p.appendChild(h('div', { class: 'update-banner' },
        h('div', null, h('strong', null, '새 버전이 배포되었습니다'), h('div', { class: 'muted' }, `v${this.remote!.version} · ${new Date(this.remote!.builtAt).toLocaleString()}`)),
        h('button', { class: 'btn primary', onclick: () => void this.applyUpdate() }, '지금 업데이트')));
    }
    p.appendChild(h('nav', { class: 'tabs' }, tabBtn('news', '새 소식'), tabBtn('roadmap', '로드맵'), tabBtn('about', '앱 정보')));
    const body = h('div', { class: 'update-body' });
    p.appendChild(body);
    if (tab === 'news') {
      const lastSeen = lsGet(LS_SEEN);
      for (const e of CHANGELOG) {
        const isNew = !lastSeen || compareVersions(e.version, lastSeen) > 0 || e.version === APP_VERSION;
        body.appendChild(h('article', { class: 'news-item' },
          h('div', { class: 'news-meta' }, h('span', { class: 'ver' }, `v${e.version}`), h('time', null, e.date), isNew && e.version === APP_VERSION ? h('span', { class: 'pill' }, '현재 버전') : null),
          h('h3', null, e.title),
          h('p', null, e.summary),
          section('새 기능', e.added), section('개선', e.improved), section('버그 수정', e.fixed)));
      }
    } else if (tab === 'roadmap') {
      const label: Record<RoadmapStatus, string> = { next: '다음 업데이트', planned: '계획됨', later: '나중에' };
      for (const st of ['next', 'planned', 'later'] as RoadmapStatus[]) {
        const items = ROADMAP.filter((r) => r.status === st);
        if (!items.length) continue;
        body.appendChild(h('h4', { class: `road-head ${st}` }, label[st]));
        for (const r of items) body.appendChild(h('div', { class: 'road-item' }, h('strong', null, r.title), h('div', { class: 'muted' }, r.detail)));
      }
      body.appendChild(h('p', { class: 'muted small' }, '로드맵은 계획이며 순서와 내용은 바뀔 수 있습니다.'));
    } else {
      const auto = h('input', { type: 'checkbox', checked: this.autoCheck() });
      auto.addEventListener('change', () => { lsSet(LS_AUTOCHECK, auto.checked ? 'on' : 'off'); if (auto.checked) this.schedule(); else if (this.timer) clearInterval(this.timer); });
      body.appendChild(h('table', { class: 'kv-table' },
        h('tr', null, h('th', null, '버전'), h('td', null, `v${APP_VERSION}`)),
        h('tr', null, h('th', null, '빌드'), h('td', null, BUILD_ID)),
        h('tr', null, h('th', null, '빌드 시각'), h('td', null, BUILT_AT ? new Date(BUILT_AT).toLocaleString() : '-')),
        h('tr', null, h('th', null, '배포된 최신 빌드'), h('td', null, this.remote ? `${this.remote.buildId}` : '확인 전')),
        h('tr', null, h('th', null, '마지막 확인'), h('td', null, this.lastCheck ? this.lastCheck.toLocaleTimeString() : '-'))));
      body.appendChild(h('label', { class: 'ctl-check' }, auto, '새 버전 자동 확인 (10분마다, 창으로 돌아올 때)'));
      body.appendChild(h('div', { class: 'row-actions' },
        h('button', { class: 'btn', onclick: () => void this.check(true) }, '지금 업데이트 확인'),
        h('button', { class: 'btn', onclick: () => void this.applyUpdate() }, '캐시 지우고 새로고침')));
      body.appendChild(h('p', { class: 'muted small' }, '모든 데이터와 계산은 이 브라우저 안에서만 처리되며 서버로 전송되지 않습니다.'));
    }
  }
}

function section(title: string, items?: string[]): HTMLElement | null {
  if (!items?.length) return null;
  return h('div', { class: 'news-section' }, h('h5', null, title), h('ul', null, ...items.map((i) => h('li', null, i))));
}
