import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table records
      add column owner_id uuid references records(id),
      add column owner_field text,
      add constraint records_owner_pair check ((owner_id is null) = (owner_field is null))`.execute(db);
  await sql`create index records_owner on records (owner_id) where owner_id is not null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index records_owner`.execute(db);
  await sql`
    alter table records
      drop constraint records_owner_pair,
      drop column owner_field,
      drop column owner_id`.execute(db);
}
