import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists pg_trgm`.execute(db);
  // Normalised names (and addresses) of contacts and organizations, written by the behaviours of those sets.
  // A row may outlive its record's set or life: queries check the record itself.
  await sql`
    create table record_search (
      record_id uuid not null references records(id),
      workspace_id uuid not null,
      kind text not null,
      name_norm text not null,
      address_norm text,
      primary key (record_id, kind),
      constraint record_search_kind_check check (kind in ('contact', 'organization'))
    )`.execute(db);
  await sql`create index record_search_name_trgm on record_search using gin (name_norm gin_trgm_ops)`.execute(db);
  await sql`create index record_search_workspace_kind on record_search (workspace_id, kind)`.execute(db);
  // Pairs a user declared "not duplicates"; a_id < b_id keeps one row per pair.
  await sql`
    create table duplicate_dismissals (
      workspace_id uuid not null,
      a_id uuid not null references records(id),
      b_id uuid not null references records(id),
      created_by uuid,
      created_at timestamptz not null default now(),
      primary key (workspace_id, a_id, b_id),
      constraint duplicate_dismissals_order check (a_id < b_id)
    )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table duplicate_dismissals`.execute(db);
  await sql`drop table record_search`.execute(db);
}
