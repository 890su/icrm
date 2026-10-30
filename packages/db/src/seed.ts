import type { Kysely } from 'kysely';
import { uuidv7 } from 'uuidv7';
import type { DB } from './schema.js';

export const SYSTEM_USER_EMAIL = 'system@local';

/**
 * Upserts the workspace and its system user. Safe to call repeatedly:
 * returns the same ids every time.
 */
export async function ensureWorkspace(
  db: Kysely<DB>,
  name: string,
): Promise<{ workspaceId: string; systemUserId: string }> {
  return db.transaction().execute(async (trx) => {
    // no-op update so RETURNING yields the existing row on conflict
    const ws = await trx
      .insertInto('workspaces')
      .values({ id: uuidv7(), name })
      .onConflict((oc) => oc.column('name').doUpdateSet({ name }))
      .returning('id')
      .executeTakeFirstOrThrow();
    const user = await trx
      .insertInto('users')
      .values({
        id: uuidv7(),
        workspace_id: ws.id,
        email: SYSTEM_USER_EMAIL,
        password_hash: null,
        name: 'System',
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'email']).doUpdateSet({ name: 'System' }))
      .returning('id')
      .executeTakeFirstOrThrow();
    return { workspaceId: ws.id, systemUserId: user.id };
  });
}
