import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: '../../assets/out',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: { name: 'client', environment: 'node', include: ['src/**/*.test.ts'] },
});
