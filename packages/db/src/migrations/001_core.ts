import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table workspaces (
      id uuid primary key,
      name text not null unique,
      created_at timestamptz not null default now()
    )`.execute(db);

  await sql`
    create table users (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      email text not null,
      password_hash text,
      name text not null,
      contact_record_id uuid,
      created_at timestamptz not null default now(),
      disabled_at timestamptz,
      unique (workspace_id, email)
    )`.execute(db);

  await sql`
    create table records (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      title text not null,
      data jsonb not null default '{}',
      version int not null default 1,
      created_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      archived_at timestamptz
    )`.execute(db);
  await sql`create index records_data_gin on records using gin (data jsonb_path_ops)`.execute(db);
  await sql`create index records_workspace_archived on records (workspace_id, archived_at)`.execute(db);

  await sql`
    create table record_sets (
      record_id uuid not null references records(id),
      set_key text not null,
      enabled_by text not null,
      enabled_at timestamptz not null default now(),
      primary key (record_id, set_key)
    )`.execute(db);
  await sql`create index record_sets_set_key on record_sets (set_key)`.execute(db);

  await sql`
    create table links (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      field_key text not null,
      from_id uuid not null references records(id),
      to_id uuid not null references records(id),
      position int not null default 0,
      created_at timestamptz not null default now(),
      unique (field_key, from_id, to_id)
    )`.execute(db);
  await sql`create index links_from on links (from_id, field_key)`.execute(db);
  await sql`create index links_to on links (to_id, field_key)`.execute(db);

  await sql`
    create table change_log (
      id bigserial primary key,
      workspace_id uuid not null references workspaces(id),
      record_id uuid not null references records(id),
      user_id uuid,
      at timestamptz not null default now(),
      kind text not null,
      field_key text,
      old jsonb,
      new jsonb,
      source text not null
    )`.execute(db);
  await sql`create index change_log_record on change_log (record_id, id)`.execute(db);

  await sql`
    create table files (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      record_id uuid,
      message_id uuid,
      name text not null,
      mime text not null,
      size bigint not null,
      storage_key text not null,
      created_by uuid,
      created_at timestamptz not null default now()
    )`.execute(db);

  await sql`
    create table config_state (
      workspace_id uuid not null references workspaces(id),
      key text not null,
      kind text not null,
      value text not null,
      status text not null default 'ok',
      updated_at timestamptz not null default now(),
      primary key (workspace_id, key, kind)
    )`.execute(db);
}
