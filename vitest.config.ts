import { defineConfig } from 'vitest/config';

// Vitest 5 no longer reads vitest.workspace.ts; `projects` is its replacement.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
