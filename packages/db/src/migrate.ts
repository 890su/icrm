import { type Kysely, type Migration, type MigrationProvider, Migrator } from 'kysely';
import type { DB } from './schema.js';
import * as m001 from './migrations/001_core.js';

/** In-code provider: no filesystem access, so it is path-independent (Windows, bundlers). */
const migrations: Record<string, Migration> = {
  '001_core': m001,
};

const provider: MigrationProvider = {
  getMigrations: async () => migrations,
};

export async function migrateToLatest(db: Kysely<DB>): Promise<void> {
  const { error } = await new Migrator({ db, provider }).migrateToLatest();
  if (error) throw error;
}
