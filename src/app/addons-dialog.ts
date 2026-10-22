/** 애드온 대화상자 (Orange: Options → Add-ons) */
import { ADDONS, install, uninstall, isInstalled, isLoaded } from '../addons/manager';
import { h, toast } from '../ui/dom';

export function openAddonDialog(usedTypes: () => Set<string>): void {
  document.querySelector('.addon-dialog')?.remove();
  const body = h('div', { class: 'addon-list' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'modal-overlay addon-dialog', onclick: (e: MouseEvent) => { if (e.target === overlay) close(); } },
    h('section', { class: 'modal', role: 'dialog', 'aria-label': '애드온' },
      h('header', { class: 'update-head' }, h('strong', null, '애드온'), h('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: close }, '×')),
      h('p', { class: 'muted small modal-intro' }, '필요한 위젯 묶음만 내려받아 씁니다. 설치한 애드온은 이 브라우저에 저장되어 오프라인에서도 사용할 수 있습니다.'),
      body));
  document.addEventListener('keydown', onKey);
  const render = () => {
    body.replaceChildren(...ADDONS.map((a) => {
      const installed = isInstalled(a.id) && isLoaded(a.id);
      const progress = h('div', { class: 'addon-progress', hidden: true });
      const btn = h('button', { class: `btn ${installed ? '' : 'primary'}` }, installed ? '제거' : `설치 (${a.size})`);
      btn.addEventListener('click', async () => {
        if (installed) {
          try { uninstall(a.id, usedTypes()); toast(`${a.name} 애드온을 제거했습니다.`); } catch (e) { toast((e as Error).message, { kind: 'error' }); }
          render();
          return;
        }
        btn.disabled = true; btn.textContent = '내려받는 중…'; progress.hidden = false;
        try {
          await install(a.id, (p) => progress.style.setProperty('--p', String(p)));
          toast(`${a.name} 애드온을 설치했습니다. 왼쪽 위젯 목록의 ${a.name} 카테고리를 확인하세요.`, { kind: 'success' });
        } catch (e) {
          toast(`설치 실패: ${(e as Error).message}`, { kind: 'error' });
        }
        render();
      });
      return h('article', { class: 'addon-item' },
        h('div', { class: 'addon-head' },
          h('div', null, h('strong', null, a.name), installed ? h('span', { class: 'pill' }, '설치됨') : null),
          btn),
        h('p', null, a.description),
        h('div', { class: 'small' }, '위젯: ', a.widgets.join(', ')),
        h('div', { class: 'muted small' }, a.credits),
        progress);
    }));
  };
  render();
  document.body.appendChild(overlay);
}
