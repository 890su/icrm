import type { CompiledConfig } from '@icrm/core';
import { RecordService, type DB } from '@icrm/db';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerAuth } from './auth.js';
import { registerErrorHandling } from './errors.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerQueryRoutes } from './routes/query.js';
import { registerRecordRoutes } from './routes/records.js';

export interface ServerOptions {
  db: Kysely<DB>;
  cfg: CompiledConfig;
  workspaceId: string;
  /** All writes made through the API are attributed to this user. */
  systemUserId: string;
  apiToken: string;
  now?: () => Date;
  logger?: FastifyServerOptions['logger'];
}

/** Thin HTTP layer over RecordService / queryRecords; every route needs the bearer token. */
export function buildServer(o: ServerOptions): FastifyInstance {
  const now = o.now ?? ((): Date => new Date());
  const app = Fastify({ logger: o.logger ?? false });
  registerErrorHandling(app);
  registerAuth(app, o.apiToken);

  const service = new RecordService({ db: o.db, cfg: o.cfg, workspaceId: o.workspaceId, now });
  registerMetaRoutes(app, o);
  registerRecordRoutes(app, { service, systemUserId: o.systemUserId });
  registerQueryRoutes(app, { db: o.db, cfg: o.cfg, workspaceId: o.workspaceId, now });
  return app;
}
