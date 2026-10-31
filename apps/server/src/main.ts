import { fileURLToPath } from 'node:url';
import { ConfigError } from '@icrm/core';
import { loadConfigDir } from '@icrm/core/node';
import { createDb, ensureWorkspace, migrateToLatest, syncConfig } from '@icrm/db';
import { buildServer } from './server.js';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL ?? fail('DATABASE_URL is required');
const apiToken = process.env.ICRM_API_TOKEN ?? fail('ICRM_API_TOKEN is required');
const configDir = process.env.ICRM_CONFIG_DIR ?? fileURLToPath(new URL('../../../config', import.meta.url));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3100);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`Invalid PORT: ${process.env.PORT}`);

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
  (report) => app.log.info(report, 'config synced'),
  (err: unknown) => app.log.error(err, 'config sync failed'),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.destroy()).then(() => process.exit(0));
  });
}

await app.listen({ host, port });
