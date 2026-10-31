import type { CompiledConfig, RecordError, RecordState, Value } from '@icrm/core';
import type { StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import type { RecordView } from './record-service.js';

/** What a behaviour hook runs with: the save's transaction and config, and the clock and user of the save. */
export interface BehaviorContext {
  tx: Db;
  cfg: CompiledConfig;
  workspaceId: string;
  now: Date;
  userId: string;
}

/**
 * Code attached to a set (contacts, organizations, ...): hooks `RecordService` calls at fixed points of every
 * save of a record with that set, inside the save's transaction. Errors a hook returns fail the save (rolled
 * back, `{ok: false, errors}`).
 */
export interface SetBehavior {
  set: string;
  /** Before evaluation of a record whose pre-evaluation sets include `set`; may change `input` in place
   *  (links of a new record are already stored). `prev` is null on create. */
  beforeEvaluate?(ctx: BehaviorContext, r: {
    id: string; prev: RecordState | null; input: Record<string, Value>; sets: Map<string, string>;
  }): Promise<RecordError[]>;
  /** After values, sets and links of the save are written (every `persist`), before the cascade, for a
   *  record whose evaluated sets include `set`. */
  afterWrite?(ctx: BehaviorContext, r: { record: StoredRecord; prev: RecordState | null }): Promise<RecordError[]>;
  /** After `archiveIn` archived records; `records` are those of them that had `set`. */
  archived?(ctx: BehaviorContext, records: StoredRecord[]): Promise<void>;
  /** Extra properties of the view of a record that has `set`. */
  extendView?(tx: Db, rec: StoredRecord, view: RecordView): Promise<void>;
}

/** The behaviours of `list` whose set is among `sets`, in list order. */
export function behaviorsOf(list: readonly SetBehavior[], sets: ReadonlyMap<string, string>): SetBehavior[] {
  return list.filter((b) => sets.has(b.set));
}
