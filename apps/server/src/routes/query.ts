import type { CompiledConfig } from '@icrm/core';
import { queryRecords, type DB, type QueryInput } from '@icrm/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';

// limit/offset are range-checked by queryRecords, which reports them as QueryError (400).
const queryBody = z.strictObject({
  filter: z.string().optional(),
  sort: z.array(z.strictObject({ field: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  includeArchived: z.boolean().optional(),
  includeRows: z.boolean().optional(),
});

export function registerQueryRoutes(
  app: FastifyInstance,
  o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now: () => Date },
): void {
  app.post('/query', async (req) => {
    const q: QueryInput = queryBody.parse(req.body ?? {});
    return queryRecords(o.db, o.cfg, o.workspaceId, q, o.now());
  });
}
