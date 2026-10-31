import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { describe, expect, test } from 'vitest';
import { ensureWorkspace, migrateToLatest } from '../src/index.js';
import { freshDb } from './setup-pg.js';

describe('db schema', () => {
  test('migrations create core tables and are idempotent', async () => {
    const { db } = await freshDb();
    await migrateToLatest(db);
    const t = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = current_schema()`.execute(db);
    expect(t.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(
      ['workspaces', 'users', 'records', 'record_sets', 'links', 'change_log', 'files', 'config_state']));
  });

  test('migration 002 adds owner columns and the pair check', async () => {
    const { db, workspaceId } = await freshDb();
    await expect(
      sql`insert into records (id, workspace_id, title, owner_field) values (${uuidv7()}, ${workspaceId}, 'x', 'expenses')`.execute(db),
    ).rejects.toThrow(/records_owner_pair/);
  });

  test('migration 003: identities channel check and unique live address', async () => {
    const { db, workspaceId, userId } = await freshDb();
    const owner = uuidv7();
    await db.insertInto('records').values({ id: owner, workspace_id: workspaceId, title: 'o', created_by: userId }).execute();
    const row = { workspace_id: workspaceId, owner_id: owner, channel: 'email', address_normalized: 'a@b.pl', address_display: 'A@b.pl' };
    await expect(db.insertInto('identities').values({ id: uuidv7(), ...row, channel: 'sms' }).execute())
      .rejects.toThrow(/identities_channel_check/);
    const first = uuidv7();
    await db.insertInto('identities').values({ id: first, ...row }).execute();
    await expect(db.insertInto('identities').values({ id: uuidv7(), ...row }).execute())
      .rejects.toMatchObject({ code: '23505', constraint: 'identities_live_address' });
    await db.updateTable('identities').set({ archived_at: new Date() }).where('id', '=', first).execute();
    await db.insertInto('identities').values({ id: uuidv7(), ...row }).execute();
  });

  test('migration 003: a live NIP is unique, archived records free it', async () => {
    const { db, workspaceId } = await freshDb();
    const mk = (nip: string | null) => db.insertInto('records').values({
      id: uuidv7(), workspace_id: workspaceId, title: 'o', data: JSON.stringify(nip === null ? {} : { nip }),
    }).execute();
    await mk('1234563218');
    await mk(null);
    await mk(null);
    await expect(mk('1234563218')).rejects.toMatchObject({ code: '23505', constraint: 'records_live_nip' });
    await db.updateTable('records').set({ archived_at: new Date() }).where(sql<boolean>`data->>'nip' = '1234563218'`).execute();
    await mk('1234563218');
  });

  test('ensureWorkspace is idempotent and seeds system@local', async () => {
    const { db } = await freshDb();
    const a = await ensureWorkspace(db, 'default');
    const b = await ensureWorkspace(db, 'default');
    expect(a).toEqual(b);
    const u = await db.selectFrom('users').selectAll().where('id', '=', a.systemUserId).executeTakeFirstOrThrow();
    expect(u).toMatchObject({ email: 'system@local', name: 'System', password_hash: null, workspace_id: a.workspaceId });
    const other = await ensureWorkspace(db, 'other');
    expect(other.workspaceId).not.toBe(a.workspaceId);
    expect(other.systemUserId).not.toBe(a.systemUserId);
  });

  test('records default version 1 and data {}; set key and link triple are unique', async () => {
    const { db, workspaceId, userId } = await freshDb();
    const mk = async (title: string) => {
      const id = uuidv7();
      await db.insertInto('records').values({ id, workspace_id: workspaceId, title, created_by: userId }).execute();
      return id;
    };
    const a = await mk('a');
    const b = await mk('b');
    const rec = await db.selectFrom('records').selectAll().where('id', '=', a).executeTakeFirstOrThrow();
    expect(rec.version).toBe(1);
    expect(rec.data).toEqual({});

    await db.insertInto('record_sets').values({ record_id: a, set_key: 'task', enabled_by: 'user' }).execute();
    await expect(
      db.insertInto('record_sets').values({ record_id: a, set_key: 'task', enabled_by: 'user' }).execute(),
    ).rejects.toMatchObject({ code: '23505' });

    const link = { workspace_id: workspaceId, field_key: 'parent', from_id: a, to_id: b, position: 0 };
    await db.insertInto('links').values({ id: uuidv7(), ...link }).execute();
    await expect(
      db.insertInto('links').values({ id: uuidv7(), ...link }).execute(),
    ).rejects.toMatchObject({ code: '23505' });
    // same pair under another field is fine
    await db.insertInto('links').values({ id: uuidv7(), ...link, field_key: 'related' }).execute();
  });
});
