import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'assets', environment: 'node', include: ['src/**/*.test.ts'] },
});
