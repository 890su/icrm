import type { Value } from '@icrm/core';
import type { Db } from './types.js';

export interface StoredRecord {
  id: string;
  workspaceId: string;
  title: string;
  data: Record<string, Value>;
  /** set_key -> enabled_by label */
  sets: Map<string, string>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  /** Owning record when this record is a row; set at insert, changed only by a merge of duplicates (`setOwner`). */
  ownerId: string | null;
  ownerField: string | null;
}

/**
 * Loads records with their enabled sets. Ids that do not exist are absent from the map.
 * With `forUpdate` the rows are locked (`SELECT ... FOR UPDATE`) in id order, which gives
 * concurrent savers a consistent lock order and so avoids deadlocks. With `workspaceId` only records of that
 * workspace are loaded (and locked).
 */
export async function loadRecords(
  tx: Db,
  ids: string[],
  opts: { forUpdate?: boolean; workspaceId?: string } = {},
): Promise<Map<string, StoredRecord>> {
  const out = new Map<string, StoredRecord>();
  if (ids.length === 0) return out;
  const unique = [...new Set(ids)];

  let q = tx.selectFrom('records').selectAll().where('id', 'in', unique).orderBy('id');
  if (opts.workspaceId !== undefined) q = q.where('workspace_id', '=', opts.workspaceId);
  if (opts.forUpdate) q = q.forUpdate();
  const rows = await q.execute();
  if (rows.length === 0) return out;

  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      workspaceId: r.workspace_id,
      title: r.title,
      data: r.data as Record<string, Value>,
      sets: new Map(),
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      archivedAt: r.archived_at,
      ownerId: r.owner_id,
      ownerField: r.owner_field,
    });
  }

  const setRows = await tx
    .selectFrom('record_sets')
    .select(['record_id', 'set_key', 'enabled_by'])
    .where('record_id', 'in', [...out.keys()])
    .execute();
  for (const s of setRows) out.get(s.record_id)?.sets.set(s.set_key, s.enabled_by);
  return out;
}

/** Ids of the non-archived rows owned by any of `ownerIds` in the workspace, in id order; not locked. */
export async function liveRowIds(tx: Db, ownerIds: string[], workspaceId: string): Promise<string[]> {
  if (ownerIds.length === 0) return [];
  const rows = await tx.selectFrom('records').select('id')
    .where('owner_id', 'in', ownerIds).where('workspace_id', '=', workspaceId).where('archived_at', 'is', null)
    .orderBy('id').execute();
  return rows.map((r) => r.id);
}

/**
 * Hands rows to another owner of the same owned field (`owner_field` stays): the one change of `owner_id`
 * after insert, made by a merge of duplicates (spec 2a §6). Not a value of the rows: their `version` stays.
 */
export async function setOwner(tx: Db, rowIds: string[], ownerId: string): Promise<void> {
  if (rowIds.length === 0) return;
  await tx.updateTable('records').set({ owner_id: ownerId }).where('id', 'in', rowIds).execute();
}

export async function insertRecord(
  tx: Db,
  r: {
    id: string;
    workspaceId: string;
    title: string;
    data: Record<string, Value>;
    sets: Map<string, string>;
    createdBy: string | null;
    /** Defaults to 1. A save that inserts first and writes the evaluated state later inserts 0. */
    version?: number;
    /** Makes the record a row owned by record `id` through its field `field`. */
    owner?: { id: string; field: string };
  },
): Promise<void> {
  await tx
    .insertInto('records')
    .values({
      id: r.id,
      workspace_id: r.workspaceId,
      title: r.title,
      data: JSON.stringify(r.data),
      created_by: r.createdBy,
      version: r.version,
      owner_id: r.owner?.id ?? null,
      owner_field: r.owner?.field ?? null,
    })
    .execute();
  await writeSets(tx, r.id, new Map(), r.sets);
}

/**
 * Optimistic-lock update of title, data and archived_at: `version = version + 1`,
 * `updated_at = now()`, guarded by `WHERE version = expectedVersion`.
 * Returns false when no row matched (stale version, or the record is gone).
 *
 * Does NOT mutate `r`: `r.version` / `r.updatedAt` stay stale. The caller must re-read
 * the record or set `version = expectedVersion + 1` itself if it keeps using the object.
 */
export async function writeRecord(tx: Db, r: StoredRecord, expectedVersion: number): Promise<boolean> {
  const res = await tx
    .updateTable('records')
    .set((eb) => ({
      title: r.title,
      data: JSON.stringify(r.data),
      updated_at: eb.fn('now', []),
      archived_at: r.archivedAt,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', r.id)
    .where('version', '=', expectedVersion)
    .executeTakeFirst();
  return res.numUpdatedRows === 1n;
}

/** Applies the difference between two set maps: delete removed, insert added, relabel changed. */
export async function writeSets(
  tx: Db,
  recordId: string,
  before: Map<string, string>,
  after: Map<string, string>,
): Promise<void> {
  const removed = [...before.keys()].filter((k) => !after.has(k));
  if (removed.length > 0) {
    await tx.deleteFrom('record_sets').where('record_id', '=', recordId).where('set_key', 'in', removed).execute();
  }

  const added = [...after].filter(([k]) => !before.has(k));
  if (added.length > 0) {
    await tx
      .insertInto('record_sets')
      .values(added.map(([set_key, enabled_by]) => ({ record_id: recordId, set_key, enabled_by })))
      .execute();
  }

  for (const [setKey, label] of after) {
    if (before.has(setKey) && before.get(setKey) !== label) {
      await tx
        .updateTable('record_sets')
        .set({ enabled_by: label })
        .where('record_id', '=', recordId)
        .where('set_key', '=', setKey)
        .execute();
    }
  }
}
