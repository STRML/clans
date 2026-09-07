import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    // e2e/**: the server-side bot-only match proof (Task 11) lives outside src/ like the
    // repo-root Playwright e2e/ dir it's named after, but it's a vitest test, not a
    // Playwright one -- the root vitest.config.ts's own `exclude: ['e2e/**']` only matches
    // the repo-root Playwright directory, not this package-relative one, so it still needs
    // an explicit include here to run under `vitest run`.
    include: ['src/**/*.test.ts', 'e2e/**/*.test.ts'],
  },
});
