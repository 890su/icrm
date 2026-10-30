import {
  evaluateRecord, fieldStatesOf,
  type CompiledConfig, type EvalResult, type FieldState, type RecordError, type RecordState, type Value,
} from '@icrm/core';
import type { Kysely, Transaction } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { appendChangeLog, type ChangeEntry } from '../repo/change-log.js';
import { linksFrom } from '../repo/links.js';
import { insertRecord, loadRecords, writeRecord, writeSets, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import type { DB } from '../schema.js';
import { archived, notFound, recordError, SaveFailed, versionConflict } from './errors.js';

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
}

export type SaveResult = { ok: true; record: RecordView } | { ok: false; errors: RecordError[] };

export interface CreateInput {
  userId: string;
  title: string;
  data?: Record<string, Value>;
  sets?: string[];
}

export interface UpdateInput {
  id: string;
  userId: string;
  expectedVersion: number;
  title?: string;
  data?: Record<string, Value>;
  enableSets?: string[];
  disableSets?: string[];
}

const MANUAL = 'manual';
const RULE_PREFIX = 'rule:';

/** Structural equality of stored values; a missing key equals `null`. */
function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === y) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  if (Array.isArray(x) || Array.isArray(y)) {
    return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => sameValue(v, y[i]));
  }
  const kx = Object.keys(x) as (keyof typeof x)[];
  return kx.length === Object.keys(y).length && kx.every((k) => Object.hasOwn(y, k) && sameValue(x[k], y[k]));
}

const stateOf = (r: StoredRecord): RecordState => ({ data: { ...r.data, title: r.title }, sets: new Map(r.sets) });

/**
 * The save pipeline: every create/update of a record goes through here, in one transaction.
 * Any error rolls the whole transaction back and comes back as `{ok: false, errors}`.
 */
export class RecordService {
  private readonly db: Kysely<DB>;
  private readonly cfg: CompiledConfig;
  private readonly workspaceId: string;
  private readonly now: () => Date;

  constructor(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date }) {
    this.db = o.db;
    this.cfg = o.cfg;
    this.workspaceId = o.workspaceId;
    this.now = o.now ?? (() => new Date());
  }

  async get(id: string): Promise<RecordView | null> {
    const rec = (await loadRecords(this.db, [id])).get(id);
    if (rec === undefined || rec.workspaceId !== this.workspaceId) return null;
    return this.view(this.db, rec);
  }

  create(i: CreateInput): Promise<SaveResult> {
    return this.inTransaction(async (tx) => {
      const id = uuidv7();
      const errors: RecordError[] = [];
      const sets = new Map<string, string>();
      this.enableManualSets(sets, i.sets ?? [], errors);
      const input = this.knownInput({ ...i.data, title: i.title }, null, errors);
      if (errors.length > 0) throw new SaveFailed(errors);

      const userChangedKeys = new Set(Object.keys(input));
      const next: RecordState = { data: input, sets };
      const res = await this.evaluate(tx, id, null, next, userChangedKeys);

      await insertRecord(tx, {
        id, workspaceId: this.workspaceId, title: titleOf(res.state), data: res.state.data, sets: res.state.sets,
        createdBy: i.userId,
      });
      await appendChangeLog(tx, this.changeEntries(id, i.userId, null, res, userChangedKeys));
      await this.runCascade(tx, id, res.changedKeys);
      return this.reload(tx, id);
    });
  }

  update(i: UpdateInput): Promise<SaveResult> {
    return this.inTransaction(async (tx) => {
      const stored = (await loadRecords(tx, [i.id], { forUpdate: true })).get(i.id);
      if (stored === undefined || stored.workspaceId !== this.workspaceId) throw new SaveFailed([notFound(i.id)]);
      if (stored.version !== i.expectedVersion) throw new SaveFailed([versionConflict(i.id)]);
      if (stored.archivedAt !== null) throw new SaveFailed([archived(i.id)]);

      const prev = stateOf(stored);
      const errors: RecordError[] = [];
      const sets = new Map(prev.sets);
      this.enableManualSets(sets, i.enableSets ?? [], errors);
      this.disableManualSets(sets, i.disableSets ?? [], errors);
      const raw = i.title === undefined ? { ...i.data } : { ...i.data, title: i.title };
      const input = this.knownInput(raw, prev, errors);
      if (errors.length > 0) throw new SaveFailed(errors);

      const userChangedKeys = new Set(Object.keys(input).filter((k) => !sameValue(prev.data[k], input[k])));
      const next: RecordState = { data: { ...prev.data, ...input }, sets };
      const res = await this.evaluate(tx, i.id, prev, next, userChangedKeys);

      const written = await writeRecord(
        tx, { ...stored, title: titleOf(res.state), data: res.state.data }, i.expectedVersion,
      );
      if (!written) throw new SaveFailed([versionConflict(i.id)]);
      await writeSets(tx, i.id, stored.sets, res.state.sets);
      await appendChangeLog(tx, this.changeEntries(i.id, i.userId, prev, res, userChangedKeys));
      await this.runCascade(tx, i.id, res.changedKeys);
      return this.reload(tx, i.id);
    });
  }

  private async inTransaction(work: (tx: Transaction<DB>) => Promise<RecordView>): Promise<SaveResult> {
    try {
      return { ok: true, record: await this.db.transaction().execute(work) };
    } catch (e) {
      if (e instanceof SaveFailed) return { ok: false, errors: e.errors };
      throw e;
    }
  }

  /** Refreshes own rollups, runs the engine and fails the save on any error. */
  private async evaluate(
    tx: Db, id: string, prev: RecordState | null, next: RecordState, userChangedKeys: Set<string>,
  ): Promise<EvalResult> {
    await this.refreshOwnRollups(tx, id, next);
    const res = evaluateRecord(this.cfg, prev, next, { now: this.now(), userChangedKeys });
    if (res.errors.length > 0) throw new SaveFailed(res.errors);
    return res;
  }

  /**
   * Task 11 seam: recompute this record's own rollup values into `next.data` before `evaluateRecord`,
   * so formulas and rules see current totals. No-op until rollups are wired in.
   */
  private async refreshOwnRollups(_tx: Db, _id: string, _next: RecordState): Promise<void> {}

  /** Task 11 seam: after this record is written, propagate `changedKeys` to the rollups of linked records. No-op for now. */
  private async runCascade(_tx: Db, _id: string, _changedKeys: Set<string>): Promise<void> {}

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
    const rec = (await loadRecords(tx, [id])).get(id);
    if (rec === undefined) throw new Error(`record ${id} vanished inside its own save`);
    return this.view(tx, rec);
  }

  private async view(tx: Db, rec: StoredRecord): Promise<RecordView> {
    const links: Record<string, string[]> = {};
    for (const set of rec.sets.keys()) {
      for (const key of this.cfg.sets.get(set)?.fields ?? []) {
        if (this.cfg.fields.get(key)?.type !== 'link' || Object.hasOwn(links, key)) continue;
        links[key] = await linksFrom(tx, rec.id, key);
      }
    }
    const { title: _title, ...data } = rec.data;
    const sets = [...rec.sets].map(([key, enabledBy]) => ({ key, enabledBy }));
    return {
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
    };
  }
}

/** The `title` column mirrors `data.title`; a non-text title is stored as "". */
function titleOf(s: RecordState): string {
  const t = s.data.title;
  return typeof t === 'string' ? t : '';
}
