import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table identities (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      owner_id uuid not null references records(id),
      channel text not null,
      address_normalized text not null,
      address_display text not null,
      label text,
      verified boolean not null default false,
      created_at timestamptz not null default now(),
      archived_at timestamptz,
      constraint identities_channel_check check (channel in ('email', 'phone', 'telegram'))
    )`.execute(db);
  await sql`
    create unique index identities_live_address
      on identities (workspace_id, channel, address_normalized) where archived_at is null`.execute(db);
  await sql`create index identities_owner on identities (owner_id)`.execute(db);

  // One live organization per NIP; only records that carry the key at all take part.
  await sql`
    create unique index records_live_nip
      on records (workspace_id, (data->>'nip')) where archived_at is null and data ? 'nip'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index records_live_nip`.execute(db);
  await sql`drop table identities`.execute(db);
}
