import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { collectBuildInfo } from './scripts/build-info.mjs';

export default defineConfig(({ command, mode }) => {
  const buildInfo = collectBuildInfo(fileURLToPath(new URL('.', import.meta.url)), command, mode);
  return {
  define: { __MINTDOWN_BUILD_INFO__: JSON.stringify(buildInfo) },
  plugins: [react(), { name: 'mintdown-build-provenance', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(buildInfo, null, 2) });
  } }],
  worker: { format: 'es' },
  // remark's entity decoder has an official DOM-free implementation. Use it
  // consistently in the editor and export Worker; the browser entry needs document.
  resolve: { alias: [
    { find: /^decode-named-character-reference$/, replacement:
      fileURLToPath(new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url)) },
    { find: /^hast-util-from-html-isomorphic$/, replacement:
      fileURLToPath(new URL('./node_modules/hast-util-from-html-isomorphic/index.js', import.meta.url)) },
  ] },
  server: {
    watch: {
      ignored: ['**/tests/.windows-file-smoke-*/**', '**/tests/.native-*/**', '**/tests/.layout-evidence/**', '**/.cargo-home/**', '**/src-tauri/target/**'],
    },
  },
  test: {
    environment: 'jsdom', setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/.layout-evidence/**', '**/.native-*/**', '**/.windows-file-smoke-*/**'],
  },
}; });
