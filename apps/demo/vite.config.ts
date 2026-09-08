import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: '../../assets/out',
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
