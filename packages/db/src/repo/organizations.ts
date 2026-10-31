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
