import {
  fieldStatesOf,
  type CompiledConfig, type EvalResult, type FieldState, type RecordError, type RecordState, type Value,
} from '@icrm/core';
import type { Kysely, Transaction } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { appendChangeLog, type ChangeEntry } from '../repo/change-log.js';
import { ancestorsVia, linksFrom, replaceLinks } from '../repo/links.js';
import { insertRecord, loadRecords, writeRecord, writeSets, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import type { DB } from '../schema.js';
import {
  archiveSeeds, changedSetKeys, evaluateWithRollups, runCascade, type CascadeSeed,
} from './cascade.js';
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
  /** Targets per link field, checked like `setLinks` against the sets given in `sets`. */
  links?: Record<string, string[]>;
}

export interface SetLinksInput {
  id: string;
  userId: string;
  field: string;
  targetIds: string[];
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

      // The row goes in first (version 0) so that links can point from it; the evaluated state
      // is written over it below, which makes it version 1.
      await insertRecord(tx, {
        id, workspaceId: this.workspaceId, title: i.title, data: input, sets, createdBy: i.userId, version: 0,
      });
      const linkInput = Object.entries(i.links ?? {});
      for (const [field, targetIds] of linkInput) errors.push(...await this.linkErrors(tx, id, sets, field, targetIds));
      if (errors.length > 0) throw new SaveFailed(errors);
      const changedLinks: LinkChange[] = [];
      for (const [field, targetIds] of linkInput) {
        const change = await this.replaceLinksLogged(tx, id, i.userId, field, targetIds);
        if (change !== null) changedLinks.push(change);
      }

      const userChangedKeys = new Set(Object.keys(input));
      const next: RecordState = { data: input, sets: new Map(sets) };
      const res = await this.evaluate(tx, id, null, next, userChangedKeys);

      const inserted = (await loadRecords(tx, [id])).get(id)!;
      if (!(await writeRecord(tx, { ...inserted, title: titleOf(res.state), data: res.state.data }, 0))) {
        throw new Error(`record ${id} changed inside its own create`);
      }
      await writeSets(tx, id, sets, res.state.sets);
      await appendChangeLog(tx, this.changeEntries(id, i.userId, null, res, userChangedKeys));
      await this.cascade(tx, i.userId, [{
        recordId: id, changedKeys: res.changedKeys, changedSets: new Set(res.state.sets.keys()), changedLinks,
      }]);
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
      await this.cascade(tx, i.userId, [{
        recordId: i.id, changedKeys: res.changedKeys, changedSets: changedSetKeys(prev.sets, res.state.sets),
        changedLinks: [],
      }]);
      return this.reload(tx, i.id);
    });
  }

  /**
   * Replaces the targets of link field `field` (spec §1.5 checks), logs the change, refreshes the record's
   * own rollups, re-evaluates and writes it (version bump), then cascades to the old and new targets.
   * Setting the targets the record already has is a no-op.
   */
  setLinks(i: SetLinksInput): Promise<SaveResult> {
    return this.inTransaction(async (tx) => {
      const stored = await this.lockEditable(tx, i.id);
      const errors = await this.linkErrors(tx, i.id, stored.sets, i.field, i.targetIds);
      if (errors.length > 0) throw new SaveFailed(errors);
      const change = await this.replaceLinksLogged(tx, i.id, i.userId, i.field, i.targetIds);
      if (change === null) return this.view(tx, stored);

      const prev = stateOf(stored);
      const next: RecordState = { data: { ...prev.data }, sets: new Map(prev.sets) };
      const userChangedKeys = new Set<string>();
      const res = await this.evaluate(tx, i.id, prev, next, userChangedKeys);
      const written = await writeRecord(tx, { ...stored, title: titleOf(res.state), data: res.state.data }, stored.version);
      if (!written) throw new SaveFailed([versionConflict(i.id)]);
      await writeSets(tx, i.id, stored.sets, res.state.sets);
      await appendChangeLog(tx, this.changeEntries(i.id, i.userId, prev, res, userChangedKeys));
      await this.cascade(tx, i.userId, [{
        recordId: i.id, changedKeys: res.changedKeys, changedSets: changedSetKeys(prev.sets, res.state.sets),
        changedLinks: [change],
      }]);
      return this.reload(tx, i.id);
    });
  }

  /**
   * Archives the record (version bump, `archive` log entry) and cascades to every rollup over a link
   * touching it, in both directions: archived records drop out of rollups.
   */
  archive(i: ArchiveInput): Promise<SaveResult> {
    return this.inTransaction(async (tx) => {
      const stored = await this.lockEditable(tx, i.id);
      const archivedAt = this.now();
      if (!(await writeRecord(tx, { ...stored, archivedAt }, stored.version))) {
        throw new SaveFailed([versionConflict(i.id)]);
      }
      await appendChangeLog(tx, [{
        workspaceId: this.workspaceId, recordId: i.id, userId: i.userId, kind: 'archive', fieldKey: null,
        old: null, new: archivedAt.toISOString(), source: 'user',
      }]);
      await this.cascade(tx, i.userId, await archiveSeeds(tx, this.cfg, i.id));
      return this.reload(tx, i.id);
    });
  }

  /** Locks the record for a save: it must exist in this workspace and not be archived. */
  private async lockEditable(tx: Db, id: string): Promise<StoredRecord> {
    const stored = (await loadRecords(tx, [id], { forUpdate: true })).get(id);
    if (stored === undefined || stored.workspaceId !== this.workspaceId) throw new SaveFailed([notFound(id)]);
    if (stored.archivedAt !== null) throw new SaveFailed([archived(id)]);
    return stored;
  }

  /**
   * Spec §1.5 checks for setting `targetIds` on link field `field` of record `id` with enabled `sets`:
   * the field is a link of an enabled set (`unknown_field`), `cardinality: one` allows one target
   * (`link_cardinality`), each target exists in this workspace, is not archived and has one of
   * `target_sets` (`link_target`), and a hierarchical link must not close a cycle (`link_cycle`).
   */
  private async linkErrors(
    tx: Db, id: string, sets: Map<string, string>, field: string, targetIds: string[],
  ): Promise<RecordError[]> {
    const def = this.cfg.fields.get(field);
    const inEnabledSet = [...(this.cfg.setsOfField.get(field) ?? [])].some((s) => sets.has(s));
    if (def?.type !== 'link' || !inEnabledSet) {
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
      if (t === undefined || t.workspaceId !== this.workspaceId) {
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

  private async inTransaction(work: (tx: Transaction<DB>) => Promise<RecordView>): Promise<SaveResult> {
    try {
      return { ok: true, record: await this.db.transaction().execute(work) };
    } catch (e) {
      if (e instanceof SaveFailed) return { ok: false, errors: e.errors };
      throw e;
    }
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

  /** After the originating record is written: propagates its changes to the rollups of linked records. */
  private async cascade(tx: Db, userId: string, seeds: CascadeSeed[]): Promise<void> {
    const errors = await runCascade(tx, this.cfg, seeds, this.now(), this.workspaceId, userId);
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
