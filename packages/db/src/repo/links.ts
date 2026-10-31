import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import type { Db } from './types.js';

/** Targets of `fromId` under `field`, in stored order (position, then created_at). */
export async function linksFrom(tx: Db, fromId: string, field: string): Promise<string[]> {
  const rows = await tx
    .selectFrom('links')
    .select('to_id')
    .where('from_id', '=', fromId)
    .where('field_key', '=', field)
    .orderBy('position')
    .orderBy('created_at')
    .execute();
  return rows.map((r) => r.to_id);
}

/** Link fields of `fromId` that have at least one target. */
export async function linkedFields(tx: Db, fromId: string): Promise<Set<string>> {
  const rows = await tx.selectFrom('links').select('field_key').distinct().where('from_id', '=', fromId).execute();
  return new Set(rows.map((r) => r.field_key));
}

/** Sources linking to `toId` under `field` (created_at, then from_id). */
export async function linksTo(tx: Db, toId: string, field: string): Promise<string[]> {
  const rows = await tx
    .selectFrom('links')
    .select('from_id')
    .where('to_id', '=', toId)
    .where('field_key', '=', field)
    .orderBy('created_at')
    .orderBy('from_id')
    .execute();
  return rows.map((r) => r.from_id);
}

/**
 * Makes the targets of (fromId, field) equal `toIds`, in that order. Rows for targets that
 * stay are kept (only `position` is updated), new targets are inserted, removed ones deleted.
 * Repeated targets are collapsed (first occurrence wins).
 * `added` follows the new order; `removed` follows the previous stored order.
 */
export async function replaceLinks(
  tx: Db,
  workspaceId: string,
  fromId: string,
  field: string,
  toIds: string[],
): Promise<{ added: string[]; removed: string[] }> {
  const wanted = [...new Set(toIds)];
  const existing = await tx
    .selectFrom('links')
    .select(['id', 'to_id', 'position'])
    .where('from_id', '=', fromId)
    .where('field_key', '=', field)
    .orderBy('position')
    .orderBy('created_at')
    .execute();
  const existingByTarget = new Map(existing.map((e) => [e.to_id, e]));
  const wantedSet = new Set(wanted);

  const removedRows = existing.filter((e) => !wantedSet.has(e.to_id));
  if (removedRows.length > 0) {
    await tx.deleteFrom('links').where('id', 'in', removedRows.map((e) => e.id)).execute();
  }

  for (const [position, toId] of wanted.entries()) {
    const row = existingByTarget.get(toId);
    if (row && row.position !== position) {
      await tx.updateTable('links').set({ position }).where('id', '=', row.id).execute();
    }
  }

  const added = wanted.filter((t) => !existingByTarget.has(t));
  if (added.length > 0) {
    await tx
      .insertInto('links')
      .values(
        added.map((toId) => ({
          id: uuidv7(),
          workspace_id: workspaceId,
          field_key: field,
          from_id: fromId,
          to_id: toId,
          position: wanted.indexOf(toId),
        })),
      )
      .execute();
  }

  return { added, removed: removedRows.map((e) => e.to_id) };
}

const MAX_DEPTH = 10000;

/**
 * Ancestors of `startId` following `field` links from from_id to to_id, nearest first
 * (chain A<-B<-C: ancestorsVia(C) = [B, A]). Each ancestor appears once, at its smallest
 * depth. Cyclic data cannot loop: a path may not revisit a node, and depth is capped.
 */
export async function ancestorsVia(tx: Db, startId: string, field: string): Promise<string[]> {
  const res = await sql<{ id: string }>`
    with recursive up(id, depth, path) as (
      select l.to_id, 1, array[l.from_id, l.to_id]
        from links l
       where l.from_id = ${startId} and l.field_key = ${field}
         and l.to_id <> l.from_id
      union all
      select l.to_id, up.depth + 1, up.path || l.to_id
        from up
        join links l on l.from_id = up.id and l.field_key = ${field}
       where not (l.to_id = any(up.path)) and up.depth < ${MAX_DEPTH}
    )
    select id from up group by id order by min(depth), id`.execute(tx);
  return res.rows.map((r) => r.id);
}
