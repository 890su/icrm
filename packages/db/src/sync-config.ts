import { KEY_RE, type CompiledConfig } from '@icrm/core';
import { sql, type Kysely } from 'kysely';
import type { DB } from './schema.js';
import { RecordService } from './service/record-service.js';

export interface SyncReport {
  /** Field renames (`was:`) whose data was migrated by this run. */
  renamed: { from: string; to: string }[];
  /** Keys present in `records.data` that the config no longer defines, sorted. */
  orphanKeys: string[];
  /** Formula and rollup fields whose definition changed and whose values were recomputed, sorted. */
  recomputed: string[];
  /** Expression indexes created by this run. */
  indexes: string[];
}

/** Records recomputed per transaction. */
const BATCH_SIZE = 500;

/** Postgres truncates identifiers longer than this. */
const MAX_IDENTIFIER = 63;

const renameMarker = (from: string, to: string): string => `${from}→${to}`;

/**
 * Brings the database in line with the config (spec §1.11), for one workspace. Safe to run at every start:
 * a second run with the same config changes nothing.
 *
 * 1. `was:` renames: the key moves inside `records.data` and `links.field_key`, once per `was→key` pair.
 * 2. Orphan keys (in `data`, not in the config) are reported; the data stays.
 * 3. Formula/rollup fields whose definition `signature` differs from the stored one are marked
 *    `recomputing`, recomputed for the records that have the field, then stored as `ok`. If the
 *    recomputation fails the mark stays and the next run recomputes again.
 * 4. Fields with `indexed: true` get an expression index on `data->>'<key>'`.
 */
export async function syncConfig(
  db: Kysely<DB>, cfg: CompiledConfig, workspaceId: string, now: () => Date,
): Promise<SyncReport> {
  const renamed = await migrateRenames(db, cfg, workspaceId);
  const orphanKeys = await findOrphanKeys(db, cfg, workspaceId);

  const stored = await db.selectFrom('config_state').select(['key', 'value', 'status'])
    .where('workspace_id', '=', workspaceId).where('kind', '=', 'signature').execute();
  const storedBy = new Map(stored.map((r) => [r.key, r]));
  const stale = [...cfg.fields.values()]
    .filter((f) => {
      if (f.signature === undefined) return false;
      const was = storedBy.get(f.key);
      return was === undefined || was.value !== f.signature || was.status !== 'ok';
    })
    .map((f) => f.key)
    .sort();
  if (stale.length > 0) {
    for (const key of stale) await markSignature(db, workspaceId, key, storedBy.get(key)?.value ?? '', 'recomputing');
    await recomputeFields(db, cfg, workspaceId, stale, now);
    for (const key of stale) await markSignature(db, workspaceId, key, cfg.fields.get(key)!.signature!, 'ok');
  }

  const indexes = await createIndexes(db, cfg);
  return { renamed, orphanKeys, recomputed: stale, indexes };
}

/**
 * Recomputes the given formula/rollup fields: every non-archived record of the workspace with an enabled
 * set that contains one of the fields is re-evaluated (rules, other formulas and own rollups included),
 * in batches of 500 records per transaction, with change-log source `system`; changes cascade to linked
 * records. Validation errors of individual records do not stop it.
 */
export async function recomputeFields(
  db: Kysely<DB>, cfg: CompiledConfig, workspaceId: string, keys: string[], now: () => Date,
): Promise<void> {
  const sets = new Set(keys.flatMap((k) => [...(cfg.setsOfField.get(k) ?? [])]));
  if (sets.size === 0) return;
  const rows = await db.selectFrom('records')
    .innerJoin('record_sets', 'record_sets.record_id', 'records.id')
    .select('records.id')
    .where('records.workspace_id', '=', workspaceId)
    .where('records.archived_at', 'is', null)
    .where('record_sets.set_key', 'in', [...sets])
    .groupBy('records.id')
    .orderBy('records.id')
    .execute();
  const ids = rows.map((r) => r.id);

  const service = new RecordService({ db, cfg, workspaceId, now });
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await service.recompute(ids.slice(i, i + BATCH_SIZE), null, 'system');
  }
}

/** Keys of the fields currently marked `recomputing`, sorted. */
export async function recomputingKeys(db: Kysely<DB>, workspaceId: string): Promise<string[]> {
  const rows = await db.selectFrom('config_state').select('key')
    .where('workspace_id', '=', workspaceId).where('kind', '=', 'signature').where('status', '=', 'recomputing')
    .orderBy('key').execute();
  return rows.map((r) => r.key);
}

async function markSignature(
  db: Kysely<DB>, workspaceId: string, key: string, value: string, status: 'ok' | 'recomputing',
): Promise<void> {
  await db.insertInto('config_state')
    .values({ workspace_id: workspaceId, key, kind: 'signature', value, status })
    .onConflict((oc) => oc.columns(['workspace_id', 'key', 'kind']).doUpdateSet({
      value, status, updated_at: sql`now()`,
    }))
    .execute();
}

/**
 * Moves `data[was]` to `data[key]` for every field with `was`, unless the record already has `key`
 * (then both stay and the old one shows up as an orphan), and repoints the links. Each rename is one
 * transaction ending with its `config_state` marker; no change-log entries (a system migration).
 */
async function migrateRenames(db: Kysely<DB>, cfg: CompiledConfig, workspaceId: string): Promise<SyncReport['renamed']> {
  const renamed: SyncReport['renamed'] = [];
  for (const field of cfg.fields.values()) {
    const from = field.was;
    const to = field.key;
    if (from === undefined || from === to) continue;
    const marker = renameMarker(from, to);
    const done = await db.selectFrom('config_state').select('key')
      .where('workspace_id', '=', workspaceId).where('kind', '=', 'rename').where('key', '=', marker)
      .executeTakeFirst();
    if (done !== undefined) continue;

    await db.transaction().execute(async (tx) => {
      await sql`
        update records
        set data = (data - ${from}::text) || jsonb_build_object(${to}::text, data -> ${from}::text)
        where workspace_id = ${workspaceId}
          and jsonb_exists(data, ${from}::text) and not jsonb_exists(data, ${to}::text)`.execute(tx);
      await sql`
        update links l
        set field_key = ${to}
        where l.workspace_id = ${workspaceId} and l.field_key = ${from}
          and not exists (
            select 1 from links o where o.field_key = ${to} and o.from_id = l.from_id and o.to_id = l.to_id)`
        .execute(tx);
      await tx.insertInto('config_state')
        .values({ workspace_id: workspaceId, key: marker, kind: 'rename', value: to, status: 'ok' })
        .execute();
    });
    renamed.push({ from, to });
  }
  return renamed;
}

async function findOrphanKeys(db: Kysely<DB>, cfg: CompiledConfig, workspaceId: string): Promise<string[]> {
  const { rows } = await sql<{ k: string }>`
    select distinct jsonb_object_keys(data) as k from records where workspace_id = ${workspaceId}`.execute(db);
  return rows.map((r) => r.k).filter((k) => !cfg.fields.has(k)).sort();
}

async function createIndexes(db: Kysely<DB>, cfg: CompiledConfig): Promise<string[]> {
  const created: string[] = [];
  for (const field of cfg.fields.values()) {
    if (field.indexed !== true) continue;
    const key = field.key;
    // The key goes into SQL text (DDL cannot take parameters), so it must be a plain identifier.
    if (!KEY_RE.test(key)) throw new Error(`cannot index field with key "${key}"`);
    const name = `records_f_${key}`;
    if (name.length > MAX_IDENTIFIER) throw new Error(`index name ${name} is longer than ${MAX_IDENTIFIER} characters`);

    const exists = await sql<{ n: string }>`select 1 as n from pg_indexes where tablename = 'records' and indexname = ${name}`.execute(db);
    if (exists.rows.length > 0) continue;
    await sql.raw(`create index if not exists ${name} on records ((data->>'${key}'))`).execute(db);
    created.push(name);
  }
  return created;
}
