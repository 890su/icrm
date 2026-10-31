import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// The testcontainers setup lives in @icrm/db; vitest wants a file path for globalSetup.
const dbGlobalSetup = createRequire(import.meta.url).resolve('@icrm/db/testing/global-setup');

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'], // tsc -b also emits compiled tests to dist/
    globalSetup: [dbGlobalSetup],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
