/**
 * Render "Web Service"로 배포했을 때 쓰는 의존성 없는 정적 파일 서버.
 * (Static Site로 배포하면 이 파일은 쓰이지 않는다)
 *  - dist/가 없으면 먼저 빌드한다(빌드 명령을 npm install만 적어 둔 경우 대비)
 *  - PORT 환경 변수(Render가 지정)를 사용, 0.0.0.0에 바인딩
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');

if (!existsSync(join(dist, 'index.html'))) {
  console.log('dist/가 없어 빌드합니다…');
  execSync('npx vite build', { cwd: root, stdio: 'inherit' });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.tab': 'text/tab-separated-values; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.wasm': 'application/wasm',
};

const EMBED_SERVER = 'https://api.garaza.io';

/** /embed-api/* → Orange 이미지 임베딩 서버로 전달(브라우저 CORS 제한 회피) */
async function proxyEmbedding(req, res) {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const target = EMBED_SERVER + req.url.replace(/^\/embed-api/, '');
    const r = await fetch(target, { method: req.method, headers: { 'Content-Type': req.headers['content-type'] ?? 'application/octet-stream' }, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
}

createServer((req, res) => {
  if (req.url?.startsWith('/embed-api/')) { void proxyEmbedding(req, res); return; }
  let path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || !statSync(file).isFile()) file = join(dist, 'index.html');
  const name = file.slice(dist.length);
  const cache = /^[\\/]assets[\\/]/.test(name) ? 'public, max-age=31536000, immutable'
    : /(index\.html|version\.json|sw\.js)$/.test(name) ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  res.end(readFileSync(file));
}).listen(Number(process.env.PORT) || 10000, '0.0.0.0', () => console.log(`Grapefruit 서버 실행 중: 포트 ${process.env.PORT || 10000}`));
