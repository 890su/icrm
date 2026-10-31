import type { CompiledConfig } from '@icrm/core';
import { recomputingKeys, type DB } from '@icrm/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

/** The config as the UI needs it: compiled internals (ASTs, dependency sets, `src`) are left out. */
export function registerMetaRoutes(
  app: FastifyInstance, o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string },
): void {
  const fields = [...o.cfg.fields.values()].map(
    ({ src, ast, filterAst, deps, clock, signature, was, ...f }) => f,
  );
  const sets = [...o.cfg.sets.values()].map(({ src, ...s }) => s);
  const rules = o.cfg.rules.map(({ src, whenAst, validateAst, defaultAsts, ...r }) => r);

  app.get('/meta', async () => ({
    timezone: o.cfg.timezone,
    fields,
    sets,
    rules,
    recomputing: await recomputingKeys(o.db, o.workspaceId),
  }));
}
