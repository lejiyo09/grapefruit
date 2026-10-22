import './styles/app.css';
import './widgets/data';
import './widgets/transform';
import './widgets/visualize';
import './widgets/model';
import './widgets/evaluate';
import './widgets/unsupervised';
import { startApp } from './app/app';

startApp(document.getElementById('app')!);

// 오프라인 실행을 위한 서비스 워커(배포 빌드에서만)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('서비스 워커 등록 실패', e));
  });
}
