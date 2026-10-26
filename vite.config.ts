import { defineConfig, type Plugin } from 'vite';
import { readFileSync, cpSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Render는 RENDER_GIT_COMMIT, GitHub Actions는 GITHUB_SHA를 제공한다.
const commit = (process.env.RENDER_GIT_COMMIT || process.env.GITHUB_SHA || '').slice(0, 7);
const buildId = `${pkg.version}-${commit || Date.now().toString(36)}`;
const builtAt = new Date().toISOString();

/** 배포된 빌드를 식별하는 version.json을 생성한다. 앱은 이 파일을 주기적으로 확인해 새 버전을 알린다. */
function versionFile(): Plugin {
  return {
    name: 'grapefruit-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: pkg.version, buildId, builtAt }, null, 2),
      });
    },
  };
}

/**
 * Render Static Site의 Publish Directory를 dist가 아닌 public/build로 지정해도 동작하도록
 * 빌드 결과를 같은 내용으로 복사해 둔다. (정적 파일 원본은 static/ 폴더)
 */
function mirrorOutput(): Plugin {
  return {
    name: 'grapefruit-mirror-output',
    apply: 'build',
    closeBundle() {
      for (const dir of ['public', 'build']) {
        const target = new URL(`./${dir}/`, import.meta.url);
        rmSync(target, { recursive: true, force: true });
        cpSync(new URL('./dist/', import.meta.url), target, { recursive: true });
      }
    },
  };
}

/** 이미지 임베딩 서버 프록시(/embed-api/* → Orange 임베딩 서버). 브라우저 CORS 제한을 피한다 */
const embedProxy = {
  '/embed-api': { target: 'https://api.garaza.io', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/embed-api/, '') },
};

export default defineConfig({
  publicDir: 'static',
  server: { proxy: embedProxy },
  preview: { proxy: embedProxy },
  // 상대 경로로 빌드해 Render 루트 배포와 GitHub Pages 하위 경로 배포 모두에서 동작하게 한다.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILT_AT__: JSON.stringify(builtAt),
  },
  worker: { format: 'es' },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 400,
  },
  plugins: [versionFile(), mirrorOutput()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
