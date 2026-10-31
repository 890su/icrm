import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** jsonb column: read as parsed JSON, written as a JSON string (pg would otherwise mangle arrays). */
type Json = ColumnType<unknown, string | null | undefined, string | null>;

export type ChangeKind = 'value' | 'set' | 'link' | 'archive';
export type ChangeSource = 'user' | 'rule' | 'cascade' | 'system';
export type ConfigStateKind = 'signature' | 'rename';
export type ConfigStateStatus = 'ok' | 'recomputing';

export interface WorkspacesTable {
  id: string;
  name: string;
  created_at: Generated<Date>;
}

export interface UsersTable {
  id: string;
  workspace_id: string;
  email: string;
  password_hash: string | null;
  name: string;
  contact_record_id: string | null;
  created_at: Generated<Date>;
  disabled_at: NullableTimestamp;
}

export interface RecordsTable {
  id: string;
  workspace_id: string;
  title: string;
  data: ColumnType<Record<string, unknown>, string | undefined, string>;
  version: Generated<number>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  archived_at: NullableTimestamp;
  /** Set when this record is a row owned by another record; both or neither with owner_field. */
  owner_id: string | null;
  owner_field: string | null;
}

export interface RecordSetsTable {
  record_id: string;
  set_key: string;
  enabled_by: string;
  enabled_at: Generated<Date>;
}

export interface LinksTable {
  id: string;
  workspace_id: string;
  field_key: string;
  from_id: string;
  to_id: string;
  position: number;
  created_at: Generated<Date>;
}

export interface ChangeLogTable {
  id: Generated<string>; // bigserial arrives as string from pg
  workspace_id: string;
  record_id: string;
  user_id: string | null;
  at: Generated<Date>;
  kind: ChangeKind;
  field_key: string | null;
  old: Json;
  new: Json;
  source: ChangeSource;
}

export interface FilesTable {
  id: string;
  workspace_id: string;
  record_id: string | null;
  message_id: string | null;
  name: string;
  mime: string;
  size: ColumnType<string, number | string, number | string>; // bigint arrives as string
  storage_key: string;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface ConfigStateTable {
  workspace_id: string;
  key: string;
  kind: ConfigStateKind;
  value: string;
  status: Generated<ConfigStateStatus>;
  updated_at: Generated<Date>;
}

export interface DB {
  workspaces: WorkspacesTable;
  users: UsersTable;
  records: RecordsTable;
  record_sets: RecordSetsTable;
  links: LinksTable;
  change_log: ChangeLogTable;
  files: FilesTable;
  config_state: ConfigStateTable;
}

export type RecordRow = Selectable<RecordsTable>;
export type NewRecordRow = Insertable<RecordsTable>;
export type RecordPatch = Updateable<RecordsTable>;
