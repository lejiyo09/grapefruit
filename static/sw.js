/*
 * Grapefruit 서비스 워커: 오프라인 실행 지원.
 *  - 페이지(HTML)와 version.json: 네트워크 우선 → 실패 시 캐시
 *  - 해시가 붙은 빌드 산출물, 데이터셋, 아이콘: 캐시 우선
 * 새 버전 감지는 앱이 version.json을 직접 확인해서 처리한다.
 */
const CACHE = 'grapefruit-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k.startsWith('grapefruit-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const networkFirst = req.mode === 'navigate' || url.pathname.endsWith('/version.json') || url.pathname.endsWith('/index.html');
  if (networkFirst) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res.ok && !url.pathname.endsWith('/version.json')) (await caches.open(CACHE)).put(req.mode === 'navigate' ? './' : req, res.clone());
        return res;
      } catch {
        return (await caches.match(req.mode === 'navigate' ? './' : req)) || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
