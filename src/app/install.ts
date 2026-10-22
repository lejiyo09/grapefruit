/**
 * PWA 설치: 브라우저가 설치 가능하다고 알려 주면(beforeinstallprompt) 상단에 "앱 설치" 버튼을 보여 준다.
 * 설치하면 크롬북 런처에서 별도 창으로 실행되고, 서비스 워커 덕분에 오프라인에서도 열린다.
 */
import { h, toast } from '../ui/dom';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.matchMedia?.('(display-mode: window-controls-overlay)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function createInstallButton(): HTMLButtonElement {
  let deferred: InstallPromptEvent | null = null;
  const btn = h('button', { class: 'btn install-btn', hidden: true, title: '크롬북/PC에 앱으로 설치 (오프라인 사용 가능)' }, '앱 설치');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    btn.hidden = isStandalone();
  });
  btn.addEventListener('click', async () => {
    if (!deferred) {
      toast('주소창 오른쪽의 설치 아이콘(⊕)이나 브라우저 메뉴의 "앱 설치"를 사용하세요.');
      return;
    }
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
    if (outcome === 'accepted') toast('Grapefruit가 설치되었습니다. 런처에서 앱으로 실행할 수 있어요.', { kind: 'success' });
  });
  window.addEventListener('appinstalled', () => { btn.hidden = true; deferred = null; });
  return btn;
}
