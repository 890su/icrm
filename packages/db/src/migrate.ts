import { type Kysely, type Migration, type MigrationProvider, Migrator } from 'kysely';
import type { DB } from './schema.js';
import * as m001 from './migrations/001_core.js';
import * as m002 from './migrations/002_rows.js';
import * as m003 from './migrations/003_contacts.js';
import * as m004 from './migrations/004_duplicates.js';

/** In-code provider: no filesystem access, so it is path-independent (Windows, bundlers). */
const migrations: Record<string, Migration> = {
  '001_core': m001,
  '002_rows': m002,
  '003_contacts': m003,
  '004_duplicates': m004,
};

const provider: MigrationProvider = {
  getMigrations: async () => migrations,
};

export async function migrateToLatest(db: Kysely<DB>): Promise<void> {
  const { error } = await new Migrator({ db, provider }).migrateToLatest();
  if (error) throw error;
}
