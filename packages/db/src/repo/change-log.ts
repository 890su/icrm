import type { ChangeKind, ChangeSource } from '../schema.js';
import type { Db } from './types.js';

export interface ChangeEntry {
  workspaceId: string;
  recordId: string;
  userId: string | null;
  kind: ChangeKind;
  fieldKey: string | null;
  old: unknown;
  new: unknown;
  source: ChangeSource;
}

// JSON.stringify(undefined) is undefined, so it is mapped to JSON null as well.
const toJson = (v: unknown): string => JSON.stringify(v ?? null);

/** Appends entries in one batch insert. `old`/`new` are always stored as JSON (null -> JSON null). */
export async function appendChangeLog(tx: Db, entries: ChangeEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await tx
    .insertInto('change_log')
    .values(
      entries.map((e) => ({
        workspace_id: e.workspaceId,
        record_id: e.recordId,
        user_id: e.userId,
        kind: e.kind,
        field_key: e.fieldKey,
        old: toJson(e.old),
        new: toJson(e.new),
        source: e.source,
      })),
    )
    .execute();
}
