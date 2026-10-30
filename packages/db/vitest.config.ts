import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'], // tsc -b also emits compiled tests to dist/
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
