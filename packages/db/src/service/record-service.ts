import {
  fieldStatesOf, ownedFieldsOf, readonlyErrors,
  type CompiledConfig, type EvalResult, type FieldState, type RecordError, type RecordState, type Value,
} from '@icrm/core';
import { sql, type Kysely } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { appendChangeLog, type ChangeEntry } from '../repo/change-log.js';
import { ancestorsVia, linksFrom, replaceLinks } from '../repo/links.js';
import { insertRecord, liveRowIds, loadRecords, writeRecord, writeSets, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import type { DB } from '../schema.js';
import {
  archiveSeeds, CASCADE_LIMIT, cascadeLimitError, changedSetKeys, evaluateWithRollups, recompute, runCascade,
  type CascadeBudget, type CascadeSeed,
} from './cascade.js';
import { behaviorsOf, type BehaviorContext, type SetBehavior } from './behaviors.js';
import { archived, notFound, recordError, SaveFailed, uniqueViolation, versionConflict } from './errors.js';
import { fieldInEnabledSet, sameValue } from './fields.js';
import { withRetry } from './retry.js';
import { noRows, requireTargetSet, saveRows, type RowOp, type RowSteps } from './rows.js';

export interface RecordView {
  id: string;
  title: string;
  /** Stored values without `title` (it is the `title` property). */
  data: Record<string, Value>;
  /** Enabled sets, sorted by key. */
  sets: { key: string; enabledBy: string }[];
  /** Targets of every link field of the enabled sets. */
  links: Record<string, string[]>;
  version: number;
  fieldStates: Record<string, FieldState>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** The owner of a row (spec §1.12) and its owned field; both null for a record that is not a row. */
  ownerId: string | null;
  ownerField: string | null;
  /**
   * The non-archived rows (spec §1.12) per owned link field of the enabled sets, in link order. Present on
   * `get` and on the result of a save, only for a record with at least one owned field among its enabled sets
   * (then every such field has a key, possibly `[]`); omitted otherwise. One level: a row's own rows are
   * not expanded here (`get` of the row shows them).
   */
  rows?: Record<string, RowView[]>;
}

/** A row as shown inside its owner: a record view without its own `rows`. */
export type RowView = Omit<RecordView, 'rows'>;

export type SaveResult = { ok: true; record: RecordView } | { ok: false; errors: RecordError[] };

/** The errors (required, validate, ...) one recomputed record has under the current config. */
export interface RecomputeError {
  recordId: string;
  errors: RecordError[];
}

export interface CreateInput {
  userId: string;
  title: string;
  data?: Record<string, Value>;
  sets?: string[];
  /** Targets per link field, checked like `setLinks` against the sets given in `sets`. */
  links?: Record<string, string[]>;
  /** Rows per owned link field of the sets given in `sets` (spec §1.12, `saveRows`). */
  rows?: Record<string, RowOp[]>;
  /** A save by the system itself: may set `managed` fields (in `data` and `links`). */
  system?: boolean;
}

export interface SetLinksInput {
  id: string;
  userId: string;
  field: string;
  targetIds: string[];
  /** A save by the system itself: `field` may be `managed`. */
  system?: boolean;
}

export interface ArchiveInput {
  id: string;
  userId: string;
}

type LinkChange = CascadeSeed['changedLinks'][number];

export interface UpdateInput {
  id: string;
  userId: string;
  expectedVersion: number;
  title?: string;
  data?: Record<string, Value>;
  enableSets?: string[];
  disableSets?: string[];
  /** Rows per owned link field of the stored sets plus `enableSets` (spec §1.12, `saveRows`). */
  rows?: Record<string, RowOp[]>;
  /** A save by the system itself: may set `managed` fields in `data`. */
  system?: boolean;
}

/**
 * The saves of one `transaction`: each checks, locks and logs like the public method of its name, but does
 * not cascade, and returns the record as stored right after its write. Run them one at a time.
 */
export interface TxOps {
  readonly tx: Db;
  create(i: CreateInput): Promise<StoredRecord>;
  update(i: UpdateInput): Promise<StoredRecord>;
  setLinks(i: SetLinksInput): Promise<StoredRecord>;
  archive(i: ArchiveInput): Promise<StoredRecord>;
  /** The view of record `id` of this workspace as it is now in the transaction (`not_found` otherwise). */
  view(id: string): Promise<RecordView>;
}

export type TxResult<T> = { ok: true; value: T } | { ok: false; errors: RecordError[] };

/** What the ops of one transaction collect for its one cascade. */
interface TxAcc {
  seeds: CascadeSeed[];
  budget: CascadeBudget;
}

/** A record `insertIn` inserted (version 0) and `finishCreateIn` has yet to evaluate. */
export interface Inserted {
  id: string;
  input: Record<string, Value>;
  sets: Map<string, string>;
  changedLinks: LinkChange[];
}

/** Checked input of an update, before evaluation. */
interface PreparedUpdate {
  prev: RecordState;
  sets: Map<string, string>;
  input: Record<string, Value>;
}

const MANUAL = 'manual';
const RULE_PREFIX = 'rule:';

const stateOf = (r: StoredRecord): RecordState => ({ data: { ...r.data, title: r.title }, sets: new Map(r.sets) });

/**
 * The save pipeline: every create/update of a record goes through here, in one transaction.
 * Any error rolls the whole transaction back and comes back as `{ok: false, errors}`. A transaction that
 * Postgres aborts as a deadlock victim or serialization failure is re-run from scratch (`withRetry`);
 * after the last attempt that error is thrown. A unique violation of a constraint in `UNIQUE_ERRORS` comes
 * back as its error. Several saves can share one transaction and one cascade (`transaction`).
 *
 * Behaviours of sets (`SetBehavior`) hook into every save: `beforeEvaluate` in `finishCreateIn` and
 * `finishUpdateIn` (so rows get them too), `afterWrite` at the end of `persist`, `archived` at the end of
 * `archiveIn`, `extendView` in `view`. Fields marked `managed` are only set by saves with `system: true`.
 */
export class RecordService {
  private readonly db: Kysely<DB>;
  private readonly cfg: CompiledConfig;
  private readonly workspaceId: string;
  private readonly now: () => Date;
  private readonly cascadeLimit: number;
  private readonly behaviors: readonly SetBehavior[];

  /** `cascadeLimit` (default `CASCADE_LIMIT`) is the cascade limit of one transaction; tests lower it. */
  constructor(o: {
    db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date; cascadeLimit?: number;
    behaviors?: SetBehavior[];
  }) {
    this.db = o.db;
    this.cfg = o.cfg;
    this.workspaceId = o.workspaceId;
    this.now = o.now ?? (() => new Date());
    this.cascadeLimit = o.cascadeLimit ?? CASCADE_LIMIT;
    this.behaviors = o.behaviors ?? [];
  }

  async get(id: string): Promise<RecordView | null> {
    const rec = (await loadRecords(this.db, [id])).get(id);
    if (rec === undefined || rec.workspaceId !== this.workspaceId) return null;
    return this.view(this.db, rec);
  }

  /**
   * Creates a record. With `rows` (spec §1.12) the owner is inserted first (version 0), then its rows are
   * saved (`saveRows`), then the owner is evaluated (its rollups see the rows) and written; one cascade
   * over the rows and the owner follows.
   */
  create(i: CreateInput): Promise<SaveResult> {
    return this.save(i.userId, (ops) => ops.create(i));
  }

  /**
   * Updates a record. With `rows` the owner is locked and its input checked first, then its rows are saved
   * (`saveRows`), then the owner is evaluated (its rollups see the rows) and written; one cascade over the
   * rows and the owner follows, which also refreshes the rows' rollups over the owner.
   *
   * A row (spec §1.12) is locked after its owner (`lockWithOwner`) and must keep one of the `target_sets`
   * of its owned field (`link_target`, with that field), as a change op of its owner's batch must.
   */
  update(i: UpdateInput): Promise<SaveResult> {
    return this.save(i.userId, (ops) => ops.update(i));
  }

  /**
   * Replaces the targets of link field `field` (spec §1.5 checks), logs the change, refreshes the record's
   * own rollups, re-evaluates and writes it (version bump), then cascades to the old and new targets.
   * Setting the targets the record already has is a no-op. A change of a field the rules make `readonly`
   * (judged by the stored state, as for values) is rejected; the re-evaluation sees the new links, so a
   * rule's `require` on the field is checked against them.
   *
   * On an owned field (spec §1.12) `targetIds` may only reorder and drop the record's current rows
   * (`link_owned` otherwise): the dropped rows are locked (after the record, in id order) and archived with
   * their own rows, as by a `delete` op. A row is locked after its owner (`lockWithOwner`).
   */
  setLinks(i: SetLinksInput): Promise<SaveResult> {
    return this.save(i.userId, (ops) => ops.setLinks(i));
  }

  /**
   * Archives the record (version bump, `archive` log entry) and cascades to every rollup over a link
   * touching it, in both directions: archived records drop out of rollups.
   *
   * Spec §1.12: the rows the record owns are archived with it, recursively (logged `cascade`, counted
   * against the cascade limit); links stay. Archiving a row deletes it: it also leaves its owner's owned
   * link, and the owner is re-evaluated and written (version bump, `link` entry). The row is locked after
   * its owner (`lockWithOwner`; a row whose owner is archived is `archived`). A row of an owned field the
   * owner's rules make `readonly` (judged by the owner's stored state) is `readonly`. Archiving the owner
   * itself is always allowed.
   */
  archive(i: ArchiveInput): Promise<SaveResult> {
    return this.save(i.userId, (ops) => ops.archive(i));
  }

  /**
   * Runs `work` in one transaction. Its `ops` save like the public methods (same checks, locks, logs and
   * behaviours) but do not cascade: the seeds and cascade budget of every op are collected, and ONE cascade
   * over them runs after `work`, before commit (the cascade limit is the transaction's). Any error (of an
   * op, a behaviour, the cascade) rolls everything back and comes back as `{ok: false, errors}`; `work`
   * must not catch an op's error and go on. A deadlock or serialization failure re-runs `work` from scratch
   * (`withRetry`), so `work` must have no effects outside the transaction.
   */
  transaction<T>(userId: string, work: (ops: TxOps) => Promise<T>): Promise<TxResult<T>> {
    return this.run(userId, work, async (_tx, value) => value);
  }

  private async save(userId: string, op: (ops: TxOps) => Promise<StoredRecord>): Promise<SaveResult> {
    const res = await this.run(userId, op, (tx, rec) => this.reload(tx, rec.id));
    return res.ok ? { ok: true, record: res.value } : res;
  }

  /** `transaction`, then `finish` on `work`'s value inside the transaction, after the cascade. */
  private async run<T, R>(
    userId: string, work: (ops: TxOps) => Promise<T>, finish: (tx: Db, value: T) => Promise<R>,
  ): Promise<TxResult<R>> {
    try {
      const value = await withRetry(() => this.db.transaction().execute(async (tx) => {
        const acc: TxAcc = { seeds: [], budget: { spent: 0 } };
        const done = await work(this.opsIn(tx, acc));
        await this.cascade(tx, userId, acc.seeds, acc.budget);
        return finish(tx, done);
      }));
      return { ok: true, value };
    } catch (e) {
      if (e instanceof SaveFailed) return { ok: false, errors: e.errors };
      const unique = uniqueViolation(e);
      if (unique !== null) return { ok: false, errors: [unique] };
      throw e;
    }
  }

  private opsIn(tx: Db, acc: TxAcc): TxOps {
    return {
      tx,
      create: (i) => this.createOp(tx, acc, i),
      update: (i) => this.updateOp(tx, acc, i),
      setLinks: (i) => this.setLinksOp(tx, acc, i),
      archive: (i) => this.archiveOp(tx, acc, i),
      view: async (id) => {
        const rec = (await loadRecords(tx, [id], { workspaceId: this.workspaceId })).get(id);
        if (rec === undefined) throw new SaveFailed([notFound(id)]);
        return this.view(tx, rec);
      },
    };
  }

  /** Adds an op's seeds and spent budget to its transaction's; past the cascade limit the save fails. */
  private collect(acc: TxAcc, seeds: CascadeSeed[], spent = 0): void {
    acc.seeds.push(...seeds);
    acc.budget.spent += spent;
    if (acc.budget.spent > this.cascadeLimit) throw new SaveFailed([cascadeLimitError()]);
  }

  private async createOp(tx: Db, acc: TxAcc, i: CreateInput): Promise<StoredRecord> {
    const inserted = await this.insertIn(tx, i);
    const batch = i.rows === undefined
      ? noRows()
      : await saveRows(this.rowSteps(), tx, { id: inserted.id, userId: i.userId, sets: inserted.sets, prev: null }, i.rows);
    const { seed } = await this.finishCreateIn(tx, i.userId, inserted, batch.changedLinks);
    this.collect(acc, [...batch.seeds, seed], batch.budget.spent);
    return this.storedIn(tx, inserted.id);
  }

  private async updateOp(tx: Db, acc: TxAcc, i: UpdateInput): Promise<StoredRecord> {
    const { stored } = await this.lockWithOwner(tx, i.id, i.expectedVersion);
    const prepared = this.prepareUpdate(i, stored);
    const batch = i.rows === undefined
      ? noRows()
      : await saveRows(this.rowSteps(), tx, { id: i.id, userId: i.userId, sets: prepared.sets, prev: prepared.prev }, i.rows);
    const { seed, sets } = await this.finishUpdateIn(tx, i, stored, prepared, batch.changedLinks);
    // A live row keeps one of its field's target sets (spec §1.12), as in its owner's batch.
    if (stored.ownerField !== null) requireTargetSet(this.cfg, stored.ownerField, sets);
    this.collect(acc, [...batch.seeds, seed], batch.budget.spent);
    return this.storedIn(tx, i.id);
  }

  private async setLinksOp(tx: Db, acc: TxAcc, i: SetLinksInput): Promise<StoredRecord> {
    const managed = this.managedErrors([i.field], i.system);
    if (managed.length > 0) throw new SaveFailed(managed);
    // Before any row lock: the holder of the hierarchy lock may cascade into rows other savers lock.
    await this.lockHierarchies(tx, [i.field]);
    const { stored } = await this.lockWithOwner(tx, i.id);
    const errors = await this.linkErrors(tx, i.id, stored.sets, i.field, i.targetIds);
    if (errors.length > 0) throw new SaveFailed(errors);

    const seeds: CascadeSeed[] = [];
    if (this.cfg.fields.get(i.field)!.owned === true) {
      const kept = new Set(i.targetIds);
      const dropped = (await linksFrom(tx, i.id, i.field)).filter((id) => !kept.has(id));
      const rows = await loadRecords(tx, dropped, { forUpdate: true, workspaceId: this.workspaceId });
      for (const row of rows.values()) {
        if (row.archivedAt === null) seeds.push(...await this.archiveIn(tx, row, i.userId, acc.budget));
      }
    }
    const change = await this.replaceLinksLogged(tx, i.id, i.userId, i.field, i.targetIds);
    if (change !== null) {
      const readonly = readonlyErrors(this.cfg, stateOf(stored), new Set([i.field]), this.now());
      if (readonly.length > 0) throw new SaveFailed(readonly);
      seeds.push(await this.relinkedIn(tx, stored, i.userId, change));
    }
    this.collect(acc, seeds);
    return change === null ? stored : this.storedIn(tx, i.id);
  }

  private async archiveOp(tx: Db, acc: TxAcc, i: ArchiveInput): Promise<StoredRecord> {
    const { stored, owner } = await this.lockWithOwner(tx, i.id);
    if (owner !== undefined && stored.ownerField !== null) {
      // A readonly owned field (judged by the owner's stored state) freezes its membership.
      const readonly = readonlyErrors(this.cfg, stateOf(owner), new Set([stored.ownerField]), this.now());
      if (readonly.length > 0) throw new SaveFailed(readonly);
    }

    const seeds = await this.archiveIn(tx, stored, i.userId, acc.budget);
    if (owner !== undefined && stored.ownerField !== null) {
      const field = stored.ownerField;
      const rest = (await linksFrom(tx, owner.id, field)).filter((id) => id !== i.id);
      const change = await this.replaceLinksLogged(tx, owner.id, i.userId, field, rest);
      if (change !== null) seeds.push(await this.relinkedIn(tx, owner, i.userId, change));
    }
    this.collect(acc, seeds);
    return this.storedIn(tx, i.id);
  }

  /**
   * Re-evaluates the given records after the config changed (spec §1.11), in one transaction: they are
   * locked `FOR UPDATE` in id order, evaluated from their stored state with no user input (own rollups
   * included) and written when anything changed, logged with `source`; what changed then cascades to the
   * rollups of linked records (logged as `cascade`). Missing, foreign and archived records are skipped.
   *
   * Errors of the records themselves (required, validate, ...) do not roll anything back: they are returned
   * per record, in id order. Exceeding the cascade limit is not a record error: it throws and rolls the batch
   * back. A deadlock or serialization failure re-runs the whole transaction (`withRetry`).
   */
  async recompute(ids: string[], userId: string | null, source: 'system'): Promise<RecomputeError[]> {
    return withRetry(() => this.db.transaction().execute(async (tx) => {
      const records = await loadRecords(tx, ids, { forUpdate: true });
      const errors: RecomputeError[] = [];
      const seeds: CascadeSeed[] = [];
      for (const id of [...records.keys()].sort()) {
        const rec = records.get(id)!;
        if (rec.workspaceId !== this.workspaceId || rec.archivedAt !== null) continue;
        const res = await recompute(tx, this.cfg, rec, this.now(), this.workspaceId, userId, source);
        if (res.seed !== null) seeds.push(res.seed);
        if (res.errors.length > 0) errors.push({ recordId: id, errors: res.errors });
      }
      const cascadeErrors = await runCascade(tx, this.cfg, seeds, this.now(), this.workspaceId, userId);
      if (cascadeErrors.length > 0) throw new Error(cascadeErrors.map((e) => e.message).join('; '));
      return errors;
    }));
  }

  /**
   * Serialises edits of each hierarchical link field among `fields` within the workspace (a transaction
   * advisory lock), so that two concurrent saves cannot each pass the cycle check and together close a
   * cycle. Taken in key order, before any row lock, so lock holders never wait for each other in a ring.
   */
  private async lockHierarchies(tx: Db, fields: string[]): Promise<void> {
    const hierarchical = [...new Set(fields)].filter((f) => {
      const def = this.cfg.fields.get(f);
      return def?.type === 'link' && def.hierarchical === true;
    });
    for (const field of hierarchical.sort()) {
      await sql`select pg_advisory_xact_lock(hashtext(${this.workspaceId} || ':' || ${field}))`.execute(tx);
    }
  }

  /**
   * Locks the record for a save: it must exist in this workspace (`not_found`), have `expectedVersion` when
   * one is given (`version_conflict`) and not be archived (`archived`). Checked in that order.
   */
  private async lockEditable(tx: Db, id: string, expectedVersion?: number): Promise<StoredRecord> {
    const stored = (await loadRecords(tx, [id], { forUpdate: true })).get(id);
    if (stored === undefined || stored.workspaceId !== this.workspaceId) throw new SaveFailed([notFound(id)]);
    if (expectedVersion !== undefined && stored.version !== expectedVersion) throw new SaveFailed([versionConflict(id)]);
    if (stored.archivedAt !== null) throw new SaveFailed([archived(id)]);
    return stored;
  }

  /**
   * `lockEditable` for a direct save of record `id`; when it is a row (spec §1.12), its owner is locked
   * first (`lockOwnerOf`), keeping the lock order of a batch (owner before rows). Under the locks: a row
   * whose owner is archived is `archived`. `owner` is undefined for a record that is not a row.
   */
  private async lockWithOwner(
    tx: Db, id: string, expectedVersion?: number,
  ): Promise<{ stored: StoredRecord; owner?: StoredRecord }> {
    const owner = await this.lockOwnerOf(tx, id);
    const stored = await this.lockEditable(tx, id, expectedVersion);
    if (owner !== undefined && owner.archivedAt !== null) throw new SaveFailed([archived(id)]);
    return { stored, owner };
  }

  /**
   * Locks the owner of record `id` when `id` is a row of this workspace and returns it (undefined
   * otherwise). The row's `owner_id` is read unlocked: it never changes after insert, so the row locked
   * afterwards has the same owner.
   */
  private async lockOwnerOf(tx: Db, id: string): Promise<StoredRecord | undefined> {
    const peek = (await loadRecords(tx, [id], { workspaceId: this.workspaceId })).get(id);
    const ownerId = peek?.ownerId ?? null;
    if (ownerId === null) return undefined;
    return (await loadRecords(tx, [ownerId], { forUpdate: true, workspaceId: this.workspaceId })).get(ownerId);
  }

  /**
   * The create step, inside the caller's transaction, is `insertIn` then `finishCreateIn`; neither cascades:
   * the seed is for the caller to cascade once everything it saves together is written.
   *
   * `insertIn` validates the input, inserts the record at version 0 (owned by `owner` when given: a row) so
   * that links can point from and to it, and sets its links. `sets` are the manually enabled sets (with
   * closure) before evaluation.
   */
  private async insertIn(tx: Db, i: CreateInput, owner?: { id: string; field: string }): Promise<Inserted> {
    const id = uuidv7();
    const errors = this.managedErrors([...Object.keys(i.data ?? {}), ...Object.keys(i.links ?? {})], i.system);
    const sets = new Map<string, string>();
    this.enableManualSets(sets, i.sets ?? [], errors);
    const input = this.knownInput({ ...i.data, title: i.title }, null, errors);
    if (errors.length > 0) throw new SaveFailed(errors);

    await this.lockHierarchies(tx, Object.keys(i.links ?? {}));
    await insertRecord(tx, {
      id, workspaceId: this.workspaceId, title: i.title, data: input, sets, createdBy: i.userId, version: 0, owner,
    });
    const linkInput = Object.entries(i.links ?? {});
    for (const [field, targetIds] of linkInput) errors.push(...await this.linkErrors(tx, id, sets, field, targetIds));
    if (errors.length > 0) throw new SaveFailed(errors);
    const changedLinks: LinkChange[] = [];
    for (const [field, targetIds] of linkInput) {
      const change = await this.replaceLinksLogged(tx, id, i.userId, field, targetIds);
      if (change !== null) changedLinks.push(change);
    }
    return { id, input, sets, changedLinks };
  }

  /**
   * Second half of the create step: evaluates the inserted record (its rollups and links as stored now) and
   * writes it (version 1). `moreLinks` are link changes made since `insertIn` (the owned links of rows).
   * `sets` are the record's sets after evaluation.
   */
  private async finishCreateIn(
    tx: Db, userId: string, ins: Inserted, moreLinks: LinkChange[],
  ): Promise<{ seed: CascadeSeed; sets: Map<string, string> }> {
    await this.beforeEvaluate(tx, userId, { id: ins.id, prev: null, input: ins.input, sets: ins.sets });
    const userChangedKeys = new Set(Object.keys(ins.input));
    const next: RecordState = { data: ins.input, sets: new Map(ins.sets) };
    const res = await this.evaluate(tx, ins.id, null, next, userChangedKeys);

    const stored = (await loadRecords(tx, [ins.id])).get(ins.id)!;
    await this.persist(tx, stored, null, res, userId, userChangedKeys, 0);
    const seed: CascadeSeed = {
      recordId: ins.id, changedKeys: res.changedKeys, changedSets: new Set(res.state.sets.keys()),
      changedLinks: [...ins.changedLinks, ...moreLinks],
    };
    return { seed, sets: res.state.sets };
  }

  /**
   * The update step, inside the caller's transaction, for `stored` (already locked, of this workspace, at
   * `i.expectedVersion`, not archived). Does not cascade: the returned seed is for the caller.
   */
  private async updateIn(
    tx: Db, i: UpdateInput, stored: StoredRecord,
  ): Promise<{ seed: CascadeSeed; sets: Map<string, string> }> {
    return this.finishUpdateIn(tx, i, stored, this.prepareUpdate(i, stored), []);
  }

  /** First half of `updateIn`: checks the set switches and the input; `sets` are the sets before evaluation. */
  private prepareUpdate(i: UpdateInput, stored: StoredRecord): PreparedUpdate {
    const prev = stateOf(stored);
    const errors = this.managedErrors(Object.keys(i.data ?? {}), i.system);
    const sets = new Map(prev.sets);
    this.enableManualSets(sets, i.enableSets ?? [], errors);
    this.disableManualSets(sets, i.disableSets ?? [], errors);
    const raw = i.title === undefined ? { ...i.data } : { ...i.data, title: i.title };
    const input = this.knownInput(raw, prev, errors);
    if (errors.length > 0) throw new SaveFailed(errors);
    return { prev, sets, input };
  }

  /**
   * Second half of `updateIn`: evaluates and writes the record. `moreLinks` are link changes made in this
   * save before it (the owned links of rows). `sets` are the record's sets after evaluation.
   */
  private async finishUpdateIn(
    tx: Db, i: UpdateInput, stored: StoredRecord, p: PreparedUpdate, moreLinks: LinkChange[],
  ): Promise<{ seed: CascadeSeed; sets: Map<string, string> }> {
    const { prev, input } = p;
    await this.beforeEvaluate(tx, i.userId, { id: i.id, prev, input, sets: p.sets });
    const userChangedKeys = new Set(Object.keys(input).filter((k) => !sameValue(prev.data[k], input[k])));
    const next: RecordState = { data: { ...prev.data, ...input }, sets: p.sets };
    const res = await this.evaluate(tx, i.id, prev, next, userChangedKeys);
    await this.persist(tx, stored, prev, res, i.userId, userChangedKeys, i.expectedVersion);
    const seed: CascadeSeed = {
      recordId: i.id, changedKeys: res.changedKeys, changedSets: changedSetKeys(prev.sets, res.state.sets),
      changedLinks: [...moreLinks],
    };
    return { seed, sets: res.state.sets };
  }

  /**
   * Archives `stored` (locked, not archived; version bump, `archive` entry logged `user`) and then the
   * non-archived rows it owns, recursively, level by level: each level is locked in id order after its
   * owners (already locked), archived and logged `cascade`. Those rows count against the cascade limit in
   * `budget` (exceeding it fails the save). Links stay. Then the `archived` behaviours get the archived
   * records of their set. Returns the seeds (`archiveSeeds`) of every record it archived.
   */
  private async archiveIn(tx: Db, stored: StoredRecord, userId: string, budget: CascadeBudget): Promise<CascadeSeed[]> {
    const archivedAt = this.now();
    const archiveOne = async (rec: StoredRecord, source: 'user' | 'cascade'): Promise<void> => {
      if (!(await writeRecord(tx, { ...rec, archivedAt }, rec.version))) throw new SaveFailed([versionConflict(rec.id)]);
      await appendChangeLog(tx, [{
        workspaceId: this.workspaceId, recordId: rec.id, userId, kind: 'archive', fieldKey: null,
        old: null, new: archivedAt.toISOString(), source,
      }]);
    };
    await archiveOne(stored, 'user');
    const done = [stored.id];
    let level = [stored.id];
    while (level.length > 0) {
      const ids = await liveRowIds(tx, level, this.workspaceId);
      const rows = await loadRecords(tx, ids, { forUpdate: true, workspaceId: this.workspaceId });
      level = [];
      for (const id of ids) {
        const row = rows.get(id);
        if (row === undefined || row.archivedAt !== null) continue; // archived meanwhile
        if (++budget.spent > this.cascadeLimit) throw new SaveFailed([cascadeLimitError()]);
        await archiveOne(row, 'cascade');
        level.push(id);
      }
      done.push(...level);
    }
    const seeds: CascadeSeed[] = [];
    for (const id of done) seeds.push(...await archiveSeeds(tx, this.cfg, id));
    const hooks = this.behaviors.filter((b) => b.archived !== undefined);
    if (hooks.length > 0) {
      const recs = await loadRecords(tx, done);
      const all = done.map((id) => recs.get(id)!);
      for (const b of hooks) {
        const had = all.filter((r) => r.sets.has(b.set));
        if (had.length > 0) await b.archived!(this.ctx(tx, userId), had);
      }
    }
    return seeds;
  }

  /**
   * Re-evaluates locked `stored` after its link `change` (own rollups refreshed against the new links) and
   * writes it (version bump), logged as a user save; returns its seed.
   */
  private async relinkedIn(tx: Db, stored: StoredRecord, userId: string, change: LinkChange): Promise<CascadeSeed> {
    const prev = stateOf(stored);
    const next: RecordState = { data: { ...prev.data }, sets: new Map(prev.sets) };
    const userChangedKeys = new Set<string>();
    const res = await this.evaluate(tx, stored.id, prev, next, userChangedKeys);
    await this.persist(tx, stored, prev, res, userId, userChangedKeys, stored.version);
    return {
      recordId: stored.id, changedKeys: res.changedKeys, changedSets: changedSetKeys(prev.sets, res.state.sets),
      changedLinks: [change],
    };
  }

  /** The steps `saveRows` runs rows through. */
  private rowSteps(): RowSteps {
    return {
      cfg: this.cfg,
      workspaceId: this.workspaceId,
      now: () => this.now(),
      insertIn: (tx, i, owner) => this.insertIn(tx, i, owner),
      finishCreateIn: (tx, userId, inserted) => this.finishCreateIn(tx, userId, inserted, []),
      updateIn: (tx, i, stored) => this.updateIn(tx, i, stored),
      archiveIn: (tx, stored, userId, budget) => this.archiveIn(tx, stored, userId, budget),
      replaceLinksLogged: (tx, id, userId, field, targetIds) => this.replaceLinksLogged(tx, id, userId, field, targetIds),
    };
  }

  /**
   * Writes the evaluated state of `stored` (version check against `expectedVersion`, then bump), its set
   * changes and the change log of a user save; a lost version race is a `version_conflict`. The one place
   * where "write, sets, log" happens for user saves; then the `afterWrite` behaviours of the evaluated sets
   * run on the written record.
   */
  private async persist(
    tx: Db, stored: StoredRecord, prev: RecordState | null, res: EvalResult, userId: string,
    userChangedKeys: Set<string>, expectedVersion: number,
  ): Promise<void> {
    const written = await writeRecord(tx, { ...stored, title: titleOf(res.state), data: res.state.data }, expectedVersion);
    if (!written) throw new SaveFailed([versionConflict(stored.id)]);
    await writeSets(tx, stored.id, stored.sets, res.state.sets);
    await appendChangeLog(tx, this.changeEntries(stored.id, userId, prev, res, userChangedKeys));

    const hooks = behaviorsOf(this.behaviors, res.state.sets).filter((b) => b.afterWrite !== undefined);
    if (hooks.length === 0) return;
    const record = await this.storedIn(tx, stored.id);
    const errors: RecordError[] = [];
    for (const b of hooks) errors.push(...await b.afterWrite!(this.ctx(tx, userId), { record, prev }));
    if (errors.length > 0) throw new SaveFailed(errors);
  }

  /** Runs the `beforeEvaluate` behaviours of `r.sets` (they may change `r.input`); their errors fail the save. */
  private async beforeEvaluate(
    tx: Db, userId: string,
    r: { id: string; prev: RecordState | null; input: Record<string, Value>; sets: Map<string, string> },
  ): Promise<void> {
    const errors: RecordError[] = [];
    for (const b of behaviorsOf(this.behaviors, r.sets)) {
      if (b.beforeEvaluate !== undefined) errors.push(...await b.beforeEvaluate(this.ctx(tx, userId), r));
    }
    if (errors.length > 0) throw new SaveFailed(errors);
  }

  private ctx(tx: Db, userId: string): BehaviorContext {
    return { tx, cfg: this.cfg, workspaceId: this.workspaceId, now: this.now(), userId };
  }

  /** `managed_field` for each of `keys` that is a `managed` field, unless the save is the system's. */
  private managedErrors(keys: string[], system: boolean | undefined): RecordError[] {
    if (system === true) return [];
    return keys.flatMap((key) => {
      const def = this.cfg.fields.get(key);
      return def?.managed === true
        ? [recordError('managed_field', `Поле «${def.label}» заполняется системой`, { field: key })]
        : [];
    });
  }

  /**
   * Spec §1.5 checks for setting `targetIds` on link field `field` of record `id` with enabled `sets`:
   * the field is a link of an enabled set (`unknown_field`), `cardinality: one` allows one target
   * (`link_cardinality`), each target exists in this workspace, is not archived and has one of
   * `target_sets` (`link_target`), and a hierarchical link must not close a cycle (`link_cycle`).
   * On an owned field each target must instead be a non-archived row of record `id` and `field`
   * (`link_owned`): a record becomes a row only through `rows` (spec §1.12).
   */
  private async linkErrors(
    tx: Db, id: string, sets: Map<string, string>, field: string, targetIds: string[],
  ): Promise<RecordError[]> {
    const def = this.cfg.fields.get(field);
    if (def?.type !== 'link' || !fieldInEnabledSet(this.cfg, sets, field)) {
      return [recordError('unknown_field', `Поле "${field}" не является связью включённых наборов записи`, { field })];
    }
    const targets = [...new Set(targetIds)];
    const errors: RecordError[] = [];
    if (def.cardinality === 'one' && targets.length > 1) {
      errors.push(recordError('link_cardinality', `Поле «${def.label}» допускает только одну связь`, { field }));
    }
    const wanted = def.target_sets ?? [];
    const loaded = await loadRecords(tx, targets);
    for (const target of targets) {
      const t = loaded.get(target);
      if (def.owned === true) {
        const row = t !== undefined && t.workspaceId === this.workspaceId && t.ownerId === id && t.ownerField === field;
        if (!row || t.archivedAt !== null) {
          const message = `Поле «${def.label}»: запись ${target} не является строкой этого поля этой записи`;
          errors.push(recordError('link_owned', message, { field }));
        }
      } else if (t === undefined || t.workspaceId !== this.workspaceId) {
        errors.push(recordError('link_target', `Поле «${def.label}»: запись ${target} не найдена`, { field }));
      } else if (t.archivedAt !== null) {
        errors.push(recordError('link_target', `Поле «${def.label}»: запись ${target} в архиве`, { field }));
      } else if (!wanted.some((s) => t.sets.has(s))) {
        const names = wanted.map((s) => `«${this.setLabel(s)}»`).join(', ');
        errors.push(recordError('link_target', `Поле «${def.label}»: у записи ${target} нет набора ${names}`, { field }));
      } else if (def.hierarchical === true && (target === id || (await ancestorsVia(tx, target, field)).includes(id))) {
        errors.push(recordError('link_cycle', `Поле «${def.label}»: связь с ${target} образует цикл`, { field }));
      }
    }
    return errors;
  }

  /** Replaces the targets and logs a `link` entry; null when the targets (and their order) did not change. */
  private async replaceLinksLogged(
    tx: Db, id: string, userId: string, field: string, targetIds: string[],
  ): Promise<LinkChange | null> {
    const before = await linksFrom(tx, id, field);
    const after = [...new Set(targetIds)];
    if (before.length === after.length && before.every((t, n) => t === after[n])) return null;
    await replaceLinks(tx, this.workspaceId, id, field, after);
    await appendChangeLog(tx, [{
      workspaceId: this.workspaceId, recordId: id, userId, kind: 'link', fieldKey: field,
      old: before, new: after, source: 'user',
    }]);
    return { field, otherIds: [...new Set([...before, ...after])] };
  }

  /**
   * Runs the engine with the record's own rollups current (including rollups of sets the rules enable
   * in this save) and fails the save on any error.
   */
  private async evaluate(
    tx: Db, id: string, prev: RecordState | null, next: RecordState, userChangedKeys: Set<string>,
  ): Promise<EvalResult> {
    const res = await evaluateWithRollups(tx, this.cfg, id, prev, next, { now: this.now(), userChangedKeys });
    if (res.errors.length > 0) throw new SaveFailed(res.errors);
    return res;
  }

  /**
   * After the originating record is written: propagates its changes to the rollups of linked records, within
   * what `budget` (rows archived with their owner in this save) has left of the cascade limit.
   */
  private async cascade(
    tx: Db, userId: string, seeds: CascadeSeed[], budget: CascadeBudget = { spent: 0 },
  ): Promise<void> {
    const limit = this.cascadeLimit - budget.spent;
    const errors = await runCascade(tx, this.cfg, seeds, this.now(), this.workspaceId, userId, limit);
    if (errors.length > 0) throw new SaveFailed(errors);
  }

  /**
   * Normalises the input (`""`/whitespace → `null` for non-text fields) and drops keys the config does not
   * know: such a key is an `unknown_field` error when it changes the stored value (always on create).
   */
  private knownInput(
    input: Record<string, Value>, prev: RecordState | null, errors: RecordError[],
  ): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const [key, value] of Object.entries(input)) {
      const field = this.cfg.fields.get(key);
      if (field === undefined) {
        if (prev === null || !sameValue(prev.data[key], value)) {
          errors.push(recordError('unknown_field', `Поле "${key}" не найдено`, { field: key }));
        }
        continue;
      }
      const blank = typeof value === 'string' && value.trim() === '';
      out[key] = blank && field.type !== 'text' ? null : value;
    }
    return out;
  }

  /** Adds each set and its closure as `manual`; sets already enabled keep their label. */
  private enableManualSets(sets: Map<string, string>, keys: string[], errors: RecordError[]): void {
    for (const key of keys) {
      const def = this.cfg.sets.get(key);
      if (def === undefined) {
        errors.push(recordError('unknown_set', `Набор "${key}" не найден`));
      } else if (def.activation === 'rule') {
        errors.push(recordError('set_activation', `Набор «${def.label}» включается только правилом`));
      } else {
        for (const s of def.closure) if (!sets.has(s)) sets.set(s, MANUAL);
      }
    }
  }

  /**
   * Removes manually enabled sets. A set enabled by a rule cannot be switched off by hand
   * (`set_activation`); one required by a set that stays enabled gives `set_required_by`.
   */
  private disableManualSets(sets: Map<string, string>, keys: string[], errors: RecordError[]): void {
    const removed: string[] = [];
    for (const key of keys) {
      const by = sets.get(key);
      if (by === undefined) continue;
      if (by !== MANUAL) {
        errors.push(recordError('set_activation', `Набор «${this.setLabel(key)}» включён правилом, его нельзя выключить вручную`));
        continue;
      }
      sets.delete(key);
      removed.push(key);
    }
    for (const key of removed) {
      const holder = [...sets.keys()].find((s) => this.cfg.sets.get(s)?.closure.includes(key));
      if (holder !== undefined) {
        errors.push(recordError(
          'set_required_by', `Набор «${this.setLabel(key)}» нужен включённому набору «${this.setLabel(holder)}»`,
        ));
      }
    }
  }

  private setLabel(key: string): string {
    return this.cfg.sets.get(key)?.label ?? key;
  }

  private changeEntries(
    recordId: string, userId: string, prev: RecordState | null, res: EvalResult, userChangedKeys: Set<string>,
  ): ChangeEntry[] {
    const base = { workspaceId: this.workspaceId, recordId, userId };
    const entries: ChangeEntry[] = [];
    for (const key of res.changedKeys) {
      entries.push({
        ...base, kind: 'value', fieldKey: key, old: prev?.data[key] ?? null, new: res.state.data[key] ?? null,
        source: userChangedKeys.has(key) ? 'user' : 'rule',
      });
    }
    const before = prev?.sets ?? new Map<string, string>();
    const after = res.state.sets;
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const [was, now] = [before.get(key), after.get(key)];
      if (was === now) continue;
      entries.push({
        ...base, kind: 'set', fieldKey: key, old: was ?? null, new: now ?? null,
        source: (now ?? was)!.startsWith(RULE_PREFIX) ? 'rule' : 'user',
      });
    }
    return entries;
  }

  private async reload(tx: Db, id: string): Promise<RecordView> {
    return this.view(tx, await this.storedIn(tx, id));
  }

  /** Record `id` as stored now in `tx`, which saved it. */
  private async storedIn(tx: Db, id: string): Promise<StoredRecord> {
    const rec = (await loadRecords(tx, [id])).get(id);
    if (rec === undefined) throw new Error(`record ${id} vanished inside its own save`);
    return rec;
  }

  /**
   * The record's view; `withRows: false` (for a row inside its owner) leaves out `rows` and the
   * `extendView` behaviours.
   */
  private async view(tx: Db, rec: StoredRecord, withRows = true): Promise<RecordView> {
    const links: Record<string, string[]> = {};
    for (const set of rec.sets.keys()) {
      for (const key of this.cfg.sets.get(set)?.fields ?? []) {
        if (this.cfg.fields.get(key)?.type !== 'link' || Object.hasOwn(links, key)) continue;
        links[key] = await linksFrom(tx, rec.id, key);
      }
    }
    const { title: _title, ...data } = rec.data;
    const sets = [...rec.sets].map(([key, enabledBy]) => ({ key, enabledBy }));
    const view: RecordView = {
      id: rec.id,
      title: rec.title,
      data,
      sets: sets.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      links,
      version: rec.version,
      fieldStates: Object.fromEntries(fieldStatesOf(this.cfg, stateOf(rec), this.now())),
      createdAt: rec.createdAt.toISOString(),
      updatedAt: rec.updatedAt.toISOString(),
      archivedAt: rec.archivedAt?.toISOString() ?? null,
      ownerId: rec.ownerId,
      ownerField: rec.ownerField,
    };
    if (withRows) {
      const rows = await this.rowsOf(tx, rec, links);
      if (rows !== undefined) view.rows = rows;
      for (const b of behaviorsOf(this.behaviors, rec.sets)) await b.extendView?.(tx, rec, view);
    }
    return view;
  }

  /**
   * Views of the live rows of every owned field of `rec`'s enabled sets, loaded with one query; undefined
   * without owned fields. Only targets owned by `rec` through that very field count as its rows.
   */
  private async rowsOf(tx: Db, rec: StoredRecord, links: Record<string, string[]>): Promise<Record<string, RowView[]> | undefined> {
    const fields = ownedFieldsOf(this.cfg, rec.sets.keys());
    if (fields.length === 0) return undefined;
    const loaded = await loadRecords(tx, fields.flatMap((f) => links[f] ?? []), { workspaceId: this.workspaceId });
    const rows: Record<string, RowView[]> = {};
    for (const field of fields) {
      rows[field] = [];
      for (const id of links[field] ?? []) {
        const row = loaded.get(id);
        if (row === undefined || row.archivedAt !== null || row.ownerId !== rec.id || row.ownerField !== field) continue;
        rows[field].push(await this.view(tx, row, false));
      }
    }
    return rows;
  }
}

/** The `title` column mirrors `data.title`; a non-text title is stored as "". */
function titleOf(s: RecordState): string {
  const t = s.data.title;
  return typeof t === 'string' ? t : '';
}
