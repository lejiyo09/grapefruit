import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';

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

export default defineConfig({
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
  plugins: [versionFile()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
