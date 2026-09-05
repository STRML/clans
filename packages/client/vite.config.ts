import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Serve the committed asset outputs from the repo root at /assets/.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  publicDir: false,
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  resolve: {
    alias: { '/assets': `${repoRoot}assets/out` },
  },
  test: { name: 'client', environment: 'node', include: ['src/**/*.test.ts'] },
});
