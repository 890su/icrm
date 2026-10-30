import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUri: string;
  }
}

/** One postgres container per test run; test files get their own database via freshDb(). */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  project.provide('pgUri', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
