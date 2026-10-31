import {
  ownedFieldsOf, readonlyErrors, type CompiledConfig, type RecordError, type RecordState, type Value,
} from '@icrm/core';
import { linksFrom } from '../repo/links.js';
import { loadRecords, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import type { CascadeBudget, CascadeSeed } from './cascade.js';
import { archived, recordError, SaveFailed, versionConflict } from './errors.js';
import type { CreateInput, Inserted, UpdateInput } from './record-service.js';

/** A new row: inserted owned by the record being saved, appended to the owned link. */
export interface NewRowOp {
  title?: string;
  data?: Record<string, Value>;
  sets?: string[];
}

/** A change of an existing row of this owner and field, at `version`. */
export interface ChangeRowOp {
  id: string;
  version: number;
  title?: string;
  data?: Record<string, Value>;
  enableSets?: string[];
  disableSets?: string[];
}

/** Deletion of an existing row of this owner and field: the row is archived and leaves the owned link. */
export interface DeleteRowOp {
  id: string;
  delete: true;
}

export type RowOp = NewRowOp | ChangeRowOp | DeleteRowOp;

type LinkChange = CascadeSeed['changedLinks'][number];

/**
 * The save steps of `RecordService` the batch runs its rows through: inside the caller's transaction,
 * without a cascade, with exactly the validation of a normal create/update. `sets` are the evaluated sets.
 */
export interface RowSteps {
  cfg: CompiledConfig;
  workspaceId: string;
  now(): Date;
  /** Validates and inserts a new row (version 0) owned by `owner`; not evaluated yet. */
  insertIn(tx: Db, i: CreateInput, owner: { id: string; field: string }): Promise<Inserted>;
  /** Evaluates and writes a row `insertIn` inserted. */
  finishCreateIn(tx: Db, userId: string, inserted: Inserted): Promise<{ seed: CascadeSeed; sets: Map<string, string> }>;
  updateIn(tx: Db, i: UpdateInput, stored: StoredRecord): Promise<{ seed: CascadeSeed; sets: Map<string, string> }>;
  /**
   * Archives a locked, non-archived row (logged `user`) and, recursively, the rows it owns itself (logged
   * `cascade`, counted in `budget`); returns the seeds of every record it archived. Its links stay.
   */
  archiveIn(tx: Db, stored: StoredRecord, userId: string, budget: CascadeBudget): Promise<CascadeSeed[]>;
  /** Replaces the targets of the owner's link field and logs a `link` entry; null when unchanged. */
  replaceLinksLogged(tx: Db, id: string, userId: string, field: string, targetIds: string[]): Promise<LinkChange | null>;
}

/** The record the rows belong to: already locked (or inserted at version 0), not yet evaluated. */
export interface RowOwner {
  id: string;
  userId: string;
  /** The owner's sets before its evaluation: stored ones plus `sets`/`enableSets` of this save. */
  sets: Map<string, string>;
  /** The owner's stored state (null on create): `readonly` on an owned field is judged by it. */
  prev: RecordState | null;
}

/**
 * What the batch wrote: seeds of every saved or archived row, the owner's changed owned links (for its seed),
 * and the cascade budget the archived rows of deleted rows have used.
 */
export interface RowsResult {
  seeds: CascadeSeed[];
  changedLinks: LinkChange[];
  budget: CascadeBudget;
}

/** The result of a save without `rows`; a fresh object each time, as the owner's seed takes its arrays over. */
export const noRows = (): RowsResult => ({ seeds: [], changedLinks: [], budget: { spent: 0 } });

/**
 * Throws `link_target` (with `field`) unless `sets` (a live row's sets after its save) contain one of the
 * `target_sets` of its owned field `field`: a row must stay a valid target of its owner's link (spec §1.12).
 */
export function requireTargetSet(cfg: CompiledConfig, field: string, sets: Map<string, string>): void {
  // A field that is no longer an owned link (removed or changed in the config) has no target sets to keep.
  const def = cfg.fields.get(field);
  if (def?.owned !== true) return;
  const wanted = def.target_sets ?? [];
  if (wanted.some((s) => sets.has(s))) return;
  const names = wanted.map((s) => `«${cfg.sets.get(s)?.label ?? s}»`).join(', ');
  throw new SaveFailed([recordError('link_target', `Поле «${def.label}»: у строки нет набора ${names}`, { field })]);
}

const isDelete = (op: RowOp): op is DeleteRowOp => 'delete' in op && op.delete === true;
const isChange = (op: RowOp): op is ChangeRowOp => 'id' in op && !isDelete(op);

/**
 * Saves the rows of an owner (spec §1.12) inside the owner's save, before the owner is evaluated, so that
 * the owner's rollups see the rows' new values. The caller has locked the owner (or inserted it at
 * version 0); then:
 *
 * 1. Every field of `rows` must be an owned link of the owner's `sets` (`unknown_field`, with `field`).
 *    This is structural: the batch stops here, later checks would be meaningless.
 * 2. Every existing row of this workspace the batch names is locked in one
 *    `loadRecords(..., {forUpdate: true, workspaceId})` (id order); records of other workspaces are never
 *    locked (they are `link_owned` below). A row named twice is a `validation` error of the later op.
 * 3. Per field, in batch order: `cardinality: one` with more than one row afterwards is `link_cardinality`
 *    (with `field`). When a rule makes the field `readonly` in the owner's stored state (`prev`; never on
 *    create), its membership is frozen: every new and delete op is `readonly` (and is not run); change ops
 *    follow the row's own rules. A change or delete op must name a row of this owner and field (`link_owned`, with
 *    `field`) that is not archived (`archived`: a deleted row stays the owner's, so re-sending a batch that
 *    deleted it fails here). A change op must be at its version (`version_conflict`) and goes through
 *    `updateIn`. A delete op archives the row and its own rows recursively (`archiveIn`). A new op is
 *    validated and inserted (`insertIn`, owned by the owner) but not evaluated yet.
 * 4. Each owned link becomes the stored targets without the deleted rows (changed rows keep their places)
 *    followed by the inserted new rows in batch order, logged at the owner.
 * 5. The new rows are evaluated and written (`finishCreateIn`). They are linked by now, so their rollups
 *    over the owner (`agg: first` substitutions) see the owner's STORED values. Accepted limitation: a row
 *    rule depending on an owner value that this same save changes is checked against the owner's previous
 *    value (the cascade afterwards still stores the row values computed from the new owner value). On
 *    create the owner is stored at version 0 with its raw input, so the rows see that input (the owner's
 *    formulas and rollups are not computed yet); the cascade afterwards brings the rows up to date.
 * 6. Every changed and new row must end up with one of the field's `target_sets` (`link_target`, with
 *    `field`).
 *
 * Every error of op `index` of `field` gets `row: {field, index}` (its own `field`/`rule_id` kept); a bad
 * op does not stop the others, so all bad rows are reported, in batch order (a field's own errors first).
 * Any error rolls everything back (`SaveFailed`). Nothing cascades here: the caller cascades once over the
 * returned seeds and its own.
 */
export async function saveRows(
  steps: RowSteps, tx: Db, owner: RowOwner, rows: Record<string, RowOp[]>,
): Promise<RowsResult> {
  const { cfg } = steps;
  const fields = Object.keys(rows);
  const owned = new Set(ownedFieldsOf(cfg, owner.sets.keys()));
  const unknown = fields.filter((f) => !owned.has(f)).map((field) =>
    recordError('unknown_field', `Поле "${field}" не является владеемой связью включённых наборов записи`, { field }));
  if (unknown.length > 0) throw new SaveFailed(unknown);

  // Errors of the fields themselves, and of each op by `field index`; assembled in batch order at the end.
  const fieldErrors = new Map<string, RecordError[]>();
  const opErrors = new Map<string, RecordError[]>();
  const opKey = (field: string, index: number): string => `${field} ${index}`;
  const fail = (field: string, index: number, errors: RecordError[]): void => {
    const key = opKey(field, index);
    opErrors.set(key, [...opErrors.get(key) ?? [], ...errors.map((e) => ({ ...e, row: { field, index } }))]);
  };
  /** Runs one step of op `index`; a `SaveFailed` becomes that op's errors and the result is null. */
  const attempt = async <T>(field: string, index: number, step: () => Promise<T>): Promise<T | null> => {
    try {
      return await step();
    } catch (e) {
      if (!(e instanceof SaveFailed)) throw e;
      fail(field, index, e.errors);
      return null;
    }
  };

  const named = new Set<string>();
  for (const field of fields) {
    for (const [index, op] of rows[field]!.entries()) {
      if (!('id' in op)) continue;
      if (named.has(op.id)) {
        fail(field, index, [recordError('validation', `Строка ${op.id} указана в пакете больше одного раза`)]);
      }
      named.add(op.id);
    }
  }
  const locked = await loadRecords(tx, [...named], { forUpdate: true, workspaceId: steps.workspaceId });
  /** The locked existing row `id` of this owner and `field`, not archived; otherwise throws. */
  const ownRow = (field: string, id: string): StoredRecord => {
    const stored = locked.get(id);
    if (stored === undefined || stored.ownerId !== owner.id || stored.ownerField !== field) {
      const label = cfg.fields.get(field)!.label;
      throw new SaveFailed([recordError(
        'link_owned', `Поле «${label}»: запись ${id} не является строкой этого поля этой записи`, { field },
      )]);
    }
    if (stored.archivedAt !== null) throw new SaveFailed([archived(id)]);
    return stored;
  };
  const budget: CascadeBudget = { spent: 0 };

  const seeds: CascadeSeed[] = [];
  const inserted: { field: string; index: number; row: Inserted }[] = [];
  const targets = new Map<string, string[]>();
  for (const field of fields) {
    const def = cfg.fields.get(field)!;
    const ops = rows[field]!;
    const before = await linksFrom(tx, owner.id, field);
    const added = ops.filter((op) => !('id' in op)).length;
    const dropped = new Set(ops.filter(isDelete).map((op) => op.id).filter((id) => before.includes(id)));
    if (def.cardinality === 'one' && before.length - dropped.size + added > 1) {
      fieldErrors.set(field, [recordError('link_cardinality', `Поле «${def.label}» допускает только одну связь`, { field })]);
    }
    // A readonly owned field (judged by the owner's stored state) freezes membership: no new or delete ops.
    const frozen = owner.prev === null ? [] : readonlyErrors(cfg, owner.prev, new Set([field]), steps.now());
    const newIds: string[] = [];
    const deleted = new Set<string>();
    for (const [index, op] of ops.entries()) {
      if (opErrors.has(opKey(field, index))) continue; // a row named twice
      if (frozen.length > 0 && !isChange(op)) {
        fail(field, index, frozen);
        continue;
      }
      if (isDelete(op)) {
        await attempt(field, index, async () => {
          const stored = ownRow(field, op.id);
          seeds.push(...await steps.archiveIn(tx, stored, owner.userId, budget));
          deleted.add(op.id);
        });
      } else if (isChange(op)) {
        await attempt(field, index, async () => {
          const stored = ownRow(field, op.id);
          if (stored.version !== op.version) throw new SaveFailed([versionConflict(op.id)]);
          const { seed, sets } = await steps.updateIn(tx, {
            id: op.id, userId: owner.userId, expectedVersion: op.version, title: op.title, data: op.data,
            enableSets: op.enableSets, disableSets: op.disableSets,
          }, stored);
          requireTargetSet(cfg, field, sets);
          seeds.push(seed);
        });
      } else {
        const row = await attempt(field, index, () => steps.insertIn(
          tx, { userId: owner.userId, title: op.title ?? '', data: op.data, sets: op.sets }, { id: owner.id, field },
        ));
        if (row === null) continue;
        inserted.push({ field, index, row });
        newIds.push(row.id);
      }
    }
    targets.set(field, [...before.filter((id) => !deleted.has(id)), ...newIds]);
  }

  // Linked before the new rows are evaluated, so that their rollups over the owner see it.
  const changedLinks: LinkChange[] = [];
  for (const [field, ids] of targets) {
    const change = await steps.replaceLinksLogged(tx, owner.id, owner.userId, field, ids);
    if (change !== null) changedLinks.push(change);
  }
  for (const { field, index, row } of inserted) {
    await attempt(field, index, async () => {
      const { seed, sets } = await steps.finishCreateIn(tx, owner.userId, row);
      requireTargetSet(cfg, field, sets);
      seeds.push(seed);
    });
  }

  const errors: RecordError[] = [];
  for (const field of fields) {
    errors.push(...fieldErrors.get(field) ?? []);
    for (const index of rows[field]!.keys()) errors.push(...opErrors.get(opKey(field, index)) ?? []);
  }
  if (errors.length > 0) throw new SaveFailed(errors);
  return { seeds, changedLinks, budget };
}
