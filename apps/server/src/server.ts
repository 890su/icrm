import type { CompiledConfig } from '@icrm/core';
import { createServices, type DB } from '@icrm/db';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerAuth } from './auth.js';
import { registerErrorHandling } from './errors.js';
import { registerIdentityRoutes } from './routes/identities.js';
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

/** Clients that send `Content-Type: application/json` with no body (archive, query) get `undefined`, not a 400. */
function acceptEmptyJsonBody(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = body.toString();
    if (text.trim() === '') done(null, undefined);
    else parseJson(req, text, done);
  });
}

/** Thin HTTP layer over the services (records, identities) / queryRecords; every route needs the bearer token. */
export function buildServer(o: ServerOptions): FastifyInstance {
  const now = o.now ?? ((): Date => new Date());
  const app = Fastify({ logger: o.logger ?? false });
  acceptEmptyJsonBody(app);
  registerErrorHandling(app);
  registerAuth(app, o.apiToken);

  const services = createServices({ db: o.db, cfg: o.cfg, workspaceId: o.workspaceId, now });
  registerMetaRoutes(app, o);
  registerRecordRoutes(app, { service: services.records, systemUserId: o.systemUserId });
  registerIdentityRoutes(app, { identities: services.identities, systemUserId: o.systemUserId });
  registerQueryRoutes(app, { db: o.db, cfg: o.cfg, workspaceId: o.workspaceId, now });
  return app;
}
