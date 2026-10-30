import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './schema.js';

export function createDb(url: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
  });
}
