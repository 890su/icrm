import { fileURLToPath } from 'node:url';
import { ConfigError } from '@icrm/core';
import { loadConfigDir } from '@icrm/core/node';
import { createDb, DuplicateService, ensureWorkspace, migrateToLatest, syncConfig } from '@icrm/db';
import { buildServer } from './server.js';
import { logSyncReport } from './sync-log.js';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const MIN_TOKEN_LENGTH = 16;

/** An env value; empty counts as unset. */
const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
};

const databaseUrl = env('DATABASE_URL') ?? fail('DATABASE_URL is required');
const apiToken = env('ICRM_API_TOKEN') ?? fail('ICRM_API_TOKEN is required');
if (apiToken.length < MIN_TOKEN_LENGTH) fail(`ICRM_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
const configDir = env('ICRM_CONFIG_DIR') ?? fileURLToPath(new URL('../../../config', import.meta.url));
const host = env('HOST') ?? '127.0.0.1';
const port = Number(env('PORT') ?? 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid PORT: ${env('PORT')}`);

// The config is checked before anything touches the database.
const cfg = await loadConfigDir(configDir).catch((e: unknown) => {
  if (!(e instanceof ConfigError)) throw e;
  return fail(e.issues.map((i) => `${i.file}${i.line === undefined ? '' : `:${i.line}`} ${i.path} — ${i.message}`).join('\n'));
});

const db = createDb(databaseUrl);
await migrateToLatest(db);
const { workspaceId, systemUserId } = await ensureWorkspace(db, 'default');

const app = buildServer({ db, cfg, workspaceId, systemUserId, apiToken, logger: true });

// Recomputation after a config change can take a while: the API serves meanwhile and /meta
// reports the fields still being recomputed.
syncConfig(db, cfg, workspaceId, () => new Date()).then(
  (report) => logSyncReport(app.log, report),
  (err: unknown) => app.log.error(err, 'config sync failed'),
).then(
  // Records saved before the name index existed (or under another normalisation) get their rows.
  () => new DuplicateService({ db, cfg, workspaceId }).reindex(),
).then(
  (rows) => app.log.info({ rows }, 'duplicate index rebuilt'),
  (err: unknown) => app.log.error(err, 'duplicate index rebuild failed'),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().then(() => db.destroy()).then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('shutdown failed', err);
        process.exit(1);
      },
    );
  });
}

await app.listen({ host, port });
