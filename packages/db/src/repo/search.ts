import { normalizeCompanyName, normalizePersonName, normalizeStreetAddress } from '@icrm/core';
import { sql } from 'kysely';
import type { DuplicateKind } from '../contacts/duplicates.js';
import type { RecordSearchTable } from '../schema.js';
import type { StoredRecord } from './records.js';
import type { Db } from './types.js';

type SearchRow = RecordSearchTable;

/** The kinds of the name index, in the order their rows are written. */
export const SEARCH_KINDS: readonly DuplicateKind[] = ['contact', 'organization'];

/** The key of a record for the duplicate search, per kind (`''` name = no key; null address = none). */
export function searchKeys(kind: DuplicateKind, rec: Pick<StoredRecord, 'title' | 'data'>):
  { nameNorm: string; addressNorm: string | null } {
  if (kind === 'contact') return { nameNorm: normalizePersonName(rec.title), addressNorm: null };
  const address = rec.data.address;
  const addressNorm = typeof address === 'string' ? normalizeStreetAddress(address) : '';
  return { nameNorm: normalizeCompanyName(rec.title), addressNorm: addressNorm === '' ? null : addressNorm };
}

/** The index rows of a record: one per kind among its sets. */
export function searchRowsOf(workspaceId: string, rec: StoredRecord): SearchRow[] {
  return SEARCH_KINDS.filter((k) => rec.sets.has(k)).map((kind): SearchRow => {
    const { nameNorm, addressNorm } = searchKeys(kind, rec);
    return { record_id: rec.id, workspace_id: workspaceId, kind, name_norm: nameNorm, address_norm: addressNorm };
  });
}

/** Upserts `rows` into `record_search`; returns how many were written. */
export async function upsertSearchRows(tx: Db, rows: SearchRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await tx.insertInto('record_search').values(rows)
    .onConflict((oc) => oc.columns(['record_id', 'kind']).doUpdateSet({
      workspace_id: (eb) => eb.ref('excluded.workspace_id'),
      name_norm: (eb) => eb.ref('excluded.name_norm'),
      address_norm: (eb) => eb.ref('excluded.address_norm'),
    })).execute();
  return rows.length;
}

/** Writes the name and address keys of a contact/organization into the index (one row per such set). */
export async function upsertSearch(tx: Db, workspaceId: string, rec: StoredRecord): Promise<void> {
  await upsertSearchRows(tx, searchRowsOf(workspaceId, rec));
}

/** What the candidate search needs of a record that matched on name or address. */
export interface SearchHit {
  id: string;
  title: string;
  data: Record<string, unknown>;
  /** `similarity()` of the normalised names (1 when equal, 0 when either has no key). */
  similarity: number;
  /** The normalised names are equal and not empty. */
  sameName: boolean;
  /** The names are `%`-similar at the threshold (an equal name is similar too). */
  similarName: boolean;
  /** The normalised addresses are equal and not empty. */
  sameAddress: boolean;
}

/**
 * Live records of `kind` (the set still enabled, not archived) whose index row matches `key` by name
 * (equal, or trigram `%` at `threshold`) or, when `byAddress`, by an equal address, or whose
 * `email_domains` hold one of `domains`; never `selfId`, never a pair in `duplicate_dismissals`. Runs `pg_trgm.similarity_threshold`
 * for the transaction, so the caller passes a transaction.
 */
export async function searchHits(
  tx: Db, o: {
    workspaceId: string; kind: DuplicateKind; selfId: string; nameNorm: string; addressNorm: string | null;
    threshold: number; byAddress: boolean; domains?: readonly string[];
  },
): Promise<SearchHit[]> {
  await sql`select set_config('pg_trgm.similarity_threshold', ${String(o.threshold)}, true)`.execute(tx);
  const hasName = o.nameNorm !== '';
  const byAddress = o.byAddress && o.addressNorm !== null ? sql`s.address_norm = ${o.addressNorm}` : sql`false`;
  const byDomain = o.domains !== undefined && o.domains.length > 0
    ? sql`jsonb_exists_any(r.data->'email_domains', ${sql.val([...o.domains])}::text[])` : sql`false`;
  const nameEq = hasName ? sql`(s.name_norm = ${o.nameNorm})` : sql`false`;
  const nameLike = hasName ? sql`(s.name_norm <> '' and s.name_norm % ${o.nameNorm})` : sql`false`;
  const nameSim = hasName ? sql`similarity(s.name_norm, ${o.nameNorm})` : sql`0`;
  const addrEq = o.addressNorm !== null ? sql`(s.address_norm = ${o.addressNorm})` : sql`false`;

  const { rows } = await sql<{ id: string; title: string; data: Record<string, unknown>; sim: number; name_eq: boolean; name_like: boolean; addr_eq: boolean }>`
    select r.id, r.title, r.data, ${nameSim}::float4 as sim, ${nameEq} as name_eq, ${nameLike} as name_like, ${addrEq} as addr_eq
    from record_search s
    join records r on r.id = s.record_id
    where s.workspace_id = ${o.workspaceId} and s.kind = ${o.kind}
      and r.workspace_id = ${o.workspaceId} and r.archived_at is null and r.id <> ${o.selfId}
      and exists (select 1 from record_sets rs where rs.record_id = r.id and rs.set_key = ${o.kind})
      and not exists (
        select 1 from duplicate_dismissals d
        where d.workspace_id = ${o.workspaceId}
          and d.a_id = least(r.id, ${o.selfId}::uuid) and d.b_id = greatest(r.id, ${o.selfId}::uuid))
      and (${nameLike} or ${byAddress} or ${byDomain})`.execute(tx);
  return rows.map((r) => ({
    id: r.id, title: r.title, data: r.data,
    similarity: r.name_eq ? 1 : r.sim,
    sameName: r.name_eq,
    similarName: r.name_like,
    sameAddress: r.addr_eq && o.addressNorm !== null,
  }));
}
