import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, inject } from 'vitest';
import { createDb, ensureWorkspace, migrateToLatest, type DB } from '../src/index.js';

// Set by global-setup.ts. Declared here so that it travels with the .d.ts of this module,
// which is how other packages (apps/server) see it when they import `@icrm/db/testing`.
declare module 'vitest' {
  export interface ProvidedContext {
    pgUri: string;
  }
}

const opened: Kysely<DB>[] = [];

// Importing this module from a test file registers the cleanup for that file.
afterAll(async () => {
  await Promise.all(opened.splice(0).map((db) => db.destroy()));
});

/**
 * Creates a new empty database `t_<random>` on the shared test server, migrates it
 * and seeds the 'default' workspace. Pools are closed automatically after the file.
 */
export async function freshDb(): Promise<{ db: Kysely<DB>; workspaceId: string; userId: string }> {
  const baseUri = inject('pgUri');
  const name = `t_${randomBytes(8).toString('hex')}`;

  const admin = new pg.Client({ connectionString: baseUri });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUri);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());
  opened.push(db);
  await migrateToLatest(db);
  const { workspaceId, systemUserId } = await ensureWorkspace(db, 'default');
  return { db, workspaceId, userId: systemUserId };
}
