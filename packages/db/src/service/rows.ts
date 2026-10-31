import { ownedFieldsOf, type CompiledConfig, type RecordError, type Value } from '@icrm/core';
import { linksFrom } from '../repo/links.js';
import { loadRecords, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import type { CascadeSeed } from './cascade.js';
import { archived, recordError, SaveFailed, versionConflict } from './errors.js';
import type { CreateInput, UpdateInput } from './record-service.js';

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

/** Deletion of an existing row (Task 5). */
export interface DeleteRowOp {
  id: string;
  delete: true;
}

export type RowOp = NewRowOp | ChangeRowOp | DeleteRowOp;

type LinkChange = CascadeSeed['changedLinks'][number];

/**
 * The save steps of `RecordService` the batch runs its rows through: inside the caller's transaction,
 * without a cascade, with exactly the validation of a normal create/update.
 */
export interface RowSteps {
  cfg: CompiledConfig;
  workspaceId: string;
  createIn(tx: Db, i: CreateInput, owner: { id: string; field: string }): Promise<{ id: string; seed: CascadeSeed; sets: Map<string, string> }>;
  updateIn(tx: Db, i: UpdateInput, stored: StoredRecord): Promise<{ seed: CascadeSeed }>;
  /** Replaces the targets of the owner's link field and logs a `link` entry; null when unchanged. */
  replaceLinksLogged(tx: Db, id: string, userId: string, field: string, targetIds: string[]): Promise<LinkChange | null>;
}

/** The record the rows belong to: already locked (or inserted at version 0), not yet evaluated. */
export interface RowOwner {
  id: string;
  userId: string;
  /** The owner's sets before its evaluation: stored ones plus `sets`/`enableSets` of this save. */
  sets: Map<string, string>;
}

/** What the batch wrote: seeds of every saved row, and the owner's changed owned links (for its seed). */
export interface RowsResult {
  seeds: CascadeSeed[];
  changedLinks: LinkChange[];
}

export const NO_ROWS: RowsResult = { seeds: [], changedLinks: [] };

const isDelete = (op: RowOp): op is DeleteRowOp => 'delete' in op && op.delete === true;
const isChange = (op: RowOp): op is ChangeRowOp => 'id' in op && !isDelete(op);

function deleteRow(): never {
  throw new Error('row delete is Task 5');
}

/**
 * Saves the rows of an owner (spec §1.12) inside the owner's save, before the owner is evaluated, so that
 * the owner's rollups see the rows' new values. The caller has locked the owner; then:
 *
 * 1. Every field of `rows` must be an owned link of the owner's `sets` (`unknown_field`, with `field`).
 *    This is structural: the batch stops here, later checks would be meaningless.
 * 2. Every existing row the batch names is locked in one `loadRecords(..., {forUpdate: true})` (id order).
 * 3. Per field, in batch order: `cardinality: one` with more than one row afterwards is `link_cardinality`
 *    (with `field`); each op is applied — a change through `updateIn` after the checks owned by this owner
 *    and field (`link_owned`), not archived (`archived`), at its version (`version_conflict`); a new row
 *    through `createIn` with the owner, then it must have one of the field's `target_sets` (`link_target`).
 *    Every error of op `index` of `field` gets `row: {field, index}`; a bad op does not stop the others, so
 *    all bad rows are reported. A row named twice in the batch is a `validation` error of the later op.
 * 4. Any error rolls back everything (`SaveFailed`). Otherwise each owned link becomes the stored targets
 *    (changed rows keep their places) followed by the new rows in batch order, logged at the owner.
 *
 * Nothing cascades here: the caller cascades once over the returned seeds and its own.
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

  const errors: RecordError[] = [];
  const atRow = (field: string, index: number) => (e: RecordError): RecordError => ({ ...e, row: { field, index } });

  const named = new Set<string>();
  /** `field index` of ops naming a row an earlier op named. */
  const repeated = new Set<string>();
  for (const field of fields) {
    for (const [index, op] of rows[field]!.entries()) {
      if (!('id' in op)) continue;
      if (named.has(op.id)) {
        repeated.add(`${field} ${index}`);
        errors.push(atRow(field, index)(recordError('validation', `Строка ${op.id} указана в пакете больше одного раза`)));
      }
      named.add(op.id);
    }
  }
  const locked = await loadRecords(tx, [...named], { forUpdate: true });

  const seeds: CascadeSeed[] = [];
  const targets = new Map<string, string[]>();
  for (const field of fields) {
    const def = cfg.fields.get(field)!;
    const ops = rows[field]!;
    const before = await linksFrom(tx, owner.id, field);
    const added = ops.filter((op) => !('id' in op)).length;
    if (def.cardinality === 'one' && before.length + added > 1) {
      errors.push(recordError('link_cardinality', `Поле «${def.label}» допускает только одну связь`, { field }));
    }
    const newIds: string[] = [];
    for (const [index, op] of ops.entries()) {
      if (repeated.has(`${field} ${index}`)) continue;
      try {
        if (isDelete(op)) {
          deleteRow();
        } else if (isChange(op)) {
          const stored = locked.get(op.id);
          if (stored === undefined || stored.workspaceId !== steps.workspaceId
            || stored.ownerId !== owner.id || stored.ownerField !== field) {
            throw new SaveFailed([recordError(
              'link_owned', `Поле «${def.label}»: запись ${op.id} не является строкой этого поля этой записи`, { field },
            )]);
          }
          if (stored.archivedAt !== null) throw new SaveFailed([archived(op.id)]);
          if (stored.version !== op.version) throw new SaveFailed([versionConflict(op.id)]);
          const { seed } = await steps.updateIn(tx, {
            id: op.id, userId: owner.userId, expectedVersion: op.version, title: op.title, data: op.data,
            enableSets: op.enableSets, disableSets: op.disableSets,
          }, stored);
          seeds.push(seed);
        } else {
          const { id, seed, sets } = await steps.createIn(
            tx, { userId: owner.userId, title: op.title ?? '', data: op.data, sets: op.sets }, { id: owner.id, field },
          );
          const wanted = def.target_sets ?? [];
          if (!wanted.some((s) => sets.has(s))) {
            const names = wanted.map((s) => `«${cfg.sets.get(s)?.label ?? s}»`).join(', ');
            throw new SaveFailed([recordError('link_target', `Поле «${def.label}»: у строки нет набора ${names}`, { field })]);
          }
          seeds.push(seed);
          newIds.push(id);
        }
      } catch (e) {
        if (!(e instanceof SaveFailed)) throw e;
        errors.push(...e.errors.map(atRow(field, index)));
      }
    }
    targets.set(field, [...before, ...newIds]);
  }
  if (errors.length > 0) throw new SaveFailed(errors);

  const changedLinks: LinkChange[] = [];
  for (const [field, ids] of targets) {
    const change = await steps.replaceLinksLogged(tx, owner.id, owner.userId, field, ids);
    if (change !== null) changedLinks.push(change);
  }
  return { seeds, changedLinks };
}
