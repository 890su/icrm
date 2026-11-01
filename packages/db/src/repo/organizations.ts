import { sql } from 'kysely';
import type { Db } from './types.js';

/** Live records with the `organization` set whose `email_domains` contain `domain`, by title then id. */
export async function organizationsByEmailDomain(
  tx: Db, workspaceId: string, domain: string,
): Promise<{ id: string; title: string }[]> {
  return tx.selectFrom('records as r').select(['r.id', 'r.title'])
    .where('r.workspace_id', '=', workspaceId).where('r.archived_at', 'is', null)
    .where((eb) => eb.exists(eb.selectFrom('record_sets as s').select('s.record_id')
      .whereRef('s.record_id', '=', 'r.id').where('s.set_key', '=', 'organization')))
    .where(sql<boolean>`jsonb_typeof(r.data->'email_domains') = 'array' and jsonb_exists(r.data->'email_domains', ${domain})`)
    .orderBy('r.title').orderBy('r.id').execute();
}

/** The live record with the `organization` set and this (normalised) NIP, or undefined. */
export async function organizationByNip(tx: Db, workspaceId: string, nip: string): Promise<string | undefined> {
  const row = await tx.selectFrom('records as r').select('r.id')
    .where('r.workspace_id', '=', workspaceId).where('r.archived_at', 'is', null)
    .where(sql<string>`r.data->>'nip'`, '=', nip)
    .where((eb) => eb.exists(eb.selectFrom('record_sets as s').select('s.record_id')
      .whereRef('s.record_id', '=', 'r.id').where('s.set_key', '=', 'organization')))
    .orderBy('r.id').limit(1).executeTakeFirst();
  return row?.id;
}

/**
 * Live records with the `organization` set whose normalised name in `record_search` equals `nameNorm`
 * (not empty: an empty name is no key), with their NIPs (null when none), oldest first; at most `limit`.
 */
export async function organizationsByName(
  tx: Db, workspaceId: string, nameNorm: string, limit = 50,
): Promise<{ id: string; title: string; nip: string | null }[]> {
  if (nameNorm === '') return [];
  return tx.selectFrom('record_search as rs').innerJoin('records as r', 'r.id', 'rs.record_id')
    .select(['r.id', 'r.title', sql<string | null>`nullif(r.data->>'nip', '')`.as('nip')])
    .where('rs.workspace_id', '=', workspaceId).where('rs.kind', '=', 'organization').where('rs.name_norm', '=', nameNorm)
    .where('r.workspace_id', '=', workspaceId).where('r.archived_at', 'is', null)
    .where((eb) => eb.exists(eb.selectFrom('record_sets as s').select('s.record_id')
      .whereRef('s.record_id', '=', 'r.id').where('s.set_key', '=', 'organization')))
    .orderBy('r.created_at').orderBy('r.id').limit(limit).execute();
}
