import {
  computeRollup, evaluateRecord, rollupsFedBy, rollupsVia,
  type CompiledConfig, type EvalOptions, type EvalResult, type RecordError, type RecordState, type RelatedRecord,
  type Value,
} from '@icrm/core';
import { appendChangeLog, type ChangeEntry } from '../repo/change-log.js';
import { linksFrom, linksTo } from '../repo/links.js';
import { loadRecords, writeRecord, writeSets, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';

/** Spec §1.8: at most this many record recomputations in the cascade of one save. */
export const CASCADE_LIMIT = 10_000;

/** At most this many evaluations of one record while rules keep enabling sets with uncomputed rollups. */
const MAX_ROLLUP_ROUNDS = 3;

/** What changed on one record, from the cascade's point of view. */
export interface CascadeSeed {
  recordId: string;
  /** `data` keys whose value changed. */
  changedKeys: Set<string>;
  /** Sets that were enabled or disabled on the record. */
  changedSets: Set<string>;
  /** Link fields of this record whose targets changed; `otherIds` = old ∪ new targets. */
  changedLinks: { field: string; otherIds: string[] }[];
}

/** The part of a record its own rollups are computed for; `data` is updated in place. */
export interface RollupHolder {
  id: string;
  data: Record<string, Value>;
  sets: Map<string, string>;
}

const hasField = (cfg: CompiledConfig, sets: Map<string, string>, key: string): boolean =>
  [...(cfg.setsOfField.get(key) ?? [])].some((s) => sets.has(s));

/** Sets present on one side only (a relabel of an enabled set is not a change here). */
export function changedSetKeys(before: Map<string, string>, after: Map<string, string>): Set<string> {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return new Set([...keys].filter((k) => before.has(k) !== after.has(k)));
}

/** Records with the given ids as rollups see them: archived and missing ones dropped, order kept. */
async function relatedRecords(tx: Db, ids: string[]): Promise<RelatedRecord[]> {
  const loaded = await loadRecords(tx, ids);
  const out: RelatedRecord[] = [];
  for (const id of ids) {
    const r = loaded.get(id);
    if (r === undefined || r.archivedAt !== null) continue;
    out.push({ id, data: { ...r.data, title: r.title }, sets: new Set(r.sets.keys()) });
  }
  return out;
}

/**
 * Recomputes every rollup of `rec` that belongs to one of its enabled sets and writes the values into
 * `rec.data`, so that `evaluateRecord` sees current totals. Forward rollups read the targets of the
 * record's own link, inverse ones the records linking to it.
 * Rollups whose keys are in `done` are skipped; the keys computed here are added to it. Returns `done`.
 */
export async function refreshOwnRollups(
  tx: Db, cfg: CompiledConfig, rec: RollupHolder, now: Date, done: Set<string> = new Set(),
): Promise<Set<string>> {
  const related = new Map<string, RelatedRecord[]>();
  for (const r of cfg.rollups) {
    if (done.has(r.key) || !hasField(cfg, rec.sets, r.key)) continue;
    done.add(r.key);
    const cacheKey = `${r.direction}:${r.via}`;
    let records = related.get(cacheKey);
    if (records === undefined) {
      const ids = r.direction === 'forward' ? await linksFrom(tx, rec.id, r.via) : await linksTo(tx, rec.id, r.via);
      records = await relatedRecords(tx, ids);
      related.set(cacheKey, records);
    }
    rec.data[r.key] = computeRollup(cfg, r, records, now);
  }
  return done;
}

/**
 * `evaluateRecord` with the record's own rollups current. Rollups of the sets enabled in `next` are
 * refreshed first; when the rules enable a set with a rollup not computed yet, that rollup is refreshed
 * and the record evaluated again (from `next`), at most `MAX_ROLLUP_ROUNDS` times, after which an
 * `oscillation` error is added. `next` is not mutated.
 */
export async function evaluateWithRollups(
  tx: Db, cfg: CompiledConfig, id: string, prev: RecordState | null, next: RecordState, opts: EvalOptions,
): Promise<EvalResult> {
  const data = { ...next.data };
  const done = await refreshOwnRollups(tx, cfg, { id, data, sets: next.sets }, opts.now);
  for (let round = 1; ; round++) {
    const res = evaluateRecord(cfg, prev, { data, sets: next.sets }, opts);
    const missing = cfg.rollups.some((r) => !done.has(r.key) && hasField(cfg, res.state.sets, r.key));
    if (!missing) return res;
    if (round === MAX_ROLLUP_ROUNDS) {
      const message = `Наборы с итоговыми полями не стабилизировались за ${MAX_ROLLUP_ROUNDS} прохода`;
      return { ...res, errors: [...res.errors, { code: 'oscillation', message }] };
    }
    await refreshOwnRollups(tx, cfg, { id, data, sets: res.state.sets }, opts.now, done);
  }
}

/**
 * Records whose rollups the seeds may have changed, each with the keys of those rollups.
 * A rollup over link L reads, for `inverse`, the records linking to its holder (so the holders of a
 * changed record R are `linksFrom(R, L)`) and, for `forward`, the targets of the holder's own link
 * (holders are `linksTo(R, L)`). A changed link of R affects R's forward rollups over it and the
 * inverse rollups of every old or new target.
 */
async function affectedBy(tx: Db, cfg: CompiledConfig, seeds: CascadeSeed[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const add = (id: string, rollupKey: string): void => {
    const keys = out.get(id) ?? new Set<string>();
    keys.add(rollupKey);
    out.set(id, keys);
  };
  const lookups = new Map<string, string[]>();
  const holders = async (recordId: string, direction: 'forward' | 'inverse', via: string): Promise<string[]> => {
    const cacheKey = `${recordId}:${direction}:${via}`;
    let ids = lookups.get(cacheKey);
    if (ids === undefined) {
      ids = direction === 'inverse' ? await linksFrom(tx, recordId, via) : await linksTo(tx, recordId, via);
      lookups.set(cacheKey, ids);
    }
    return ids;
  };

  for (const seed of seeds) {
    for (const r of rollupsFedBy(cfg, seed.changedKeys, seed.changedSets)) {
      for (const id of await holders(seed.recordId, r.direction, r.via)) add(id, r.key);
    }
    for (const { field, otherIds } of seed.changedLinks) {
      for (const r of rollupsVia(cfg, field)) {
        if (r.direction === 'forward') add(seed.recordId, r.key);
        else for (const id of otherIds) add(id, r.key);
      }
    }
  }
  return out;
}

/**
 * Re-evaluates a locked record after its rollups may have changed and writes it if anything changed.
 * Its own errors (required, validate, oscillation) are ignored: the record did not cause this save,
 * so its computed state is stored anyway. Returns what changed, or null.
 */
async function recompute(
  tx: Db, cfg: CompiledConfig, rec: StoredRecord, now: Date, workspaceId: string, userId: string | null,
): Promise<CascadeSeed | null> {
  const prev: RecordState = { data: { ...rec.data, title: rec.title }, sets: new Map(rec.sets) };
  const res = await evaluateWithRollups(tx, cfg, rec.id, prev, prev, { now, userChangedKeys: new Set() });

  const changedSets = changedSetKeys(prev.sets, res.state.sets);
  const relabelled = [...res.state.sets].some(([k, by]) => prev.sets.has(k) && prev.sets.get(k) !== by);
  if (res.changedKeys.size === 0 && changedSets.size === 0 && !relabelled) return null;

  const title = typeof res.state.data.title === 'string' ? res.state.data.title : '';
  if (!(await writeRecord(tx, { ...rec, title, data: res.state.data }, rec.version))) {
    throw new Error(`record ${rec.id} changed while locked by the cascade`);
  }
  await writeSets(tx, rec.id, rec.sets, res.state.sets);

  const base = { workspaceId, recordId: rec.id, userId, source: 'cascade' as const };
  const entries = [...res.changedKeys].map((key): ChangeEntry => ({
    ...base, kind: 'value', fieldKey: key, old: prev.data[key] ?? null, new: res.state.data[key] ?? null,
  }));
  for (const key of new Set([...prev.sets.keys(), ...res.state.sets.keys()])) {
    const [was, is] = [prev.sets.get(key), res.state.sets.get(key)];
    if (was !== is) entries.push({ ...base, kind: 'set', fieldKey: key, old: was ?? null, new: is ?? null });
  }
  await appendChangeLog(tx, entries);
  return { recordId: rec.id, changedKeys: res.changedKeys, changedSets, changedLinks: [] };
}

/**
 * Propagates the seeds' changes to the rollups of other records, in the caller's transaction, in waves:
 * each wave's records are locked `FOR UPDATE` in ascending id order, recomputed, written and logged with
 * source `cascade`; what changed on them seeds the next wave. A record may be recomputed in several waves
 * (a tree is climbed one level per wave). Archived records, records of other workspaces and records
 * without the affected rollup in an enabled set are skipped.
 *
 * Log entries carry `userId`, the user whose save started the cascade.
 *
 * Returns the errors that must roll the save back: only exceeding `limit` recomputations.
 */
export async function runCascade(
  tx: Db, cfg: CompiledConfig, seeds: CascadeSeed[], now: Date, workspaceId: string, userId: string | null,
  limit = CASCADE_LIMIT,
): Promise<RecordError[]> {
  let pending = seeds;
  let recomputed = 0;
  while (pending.length > 0) {
    const wave = await affectedBy(tx, cfg, pending);
    pending = [];
    if (wave.size === 0) break;
    const records = await loadRecords(tx, [...wave.keys()], { forUpdate: true });
    for (const id of [...records.keys()].sort()) {
      const rec = records.get(id)!;
      if (rec.workspaceId !== workspaceId || rec.archivedAt !== null) continue;
      if (![...wave.get(id)!].some((key) => hasField(cfg, rec.sets, key))) continue;
      if (++recomputed > limit) return [{ code: 'validation', message: 'каскад превысил лимит' }];
      const seed = await recompute(tx, cfg, rec, now, workspaceId, userId);
      if (seed !== null) pending.push(seed);
    }
  }
  return [];
}

/**
 * Seeds for archiving `id`: for every link field with rollups over it, the records `id` links to
 * (their inverse rollups) and the records linking to `id` (their forward rollups) are affected.
 */
export async function archiveSeeds(tx: Db, cfg: CompiledConfig, id: string): Promise<CascadeSeed[]> {
  const seeds: CascadeSeed[] = [];
  const empty = (): Pick<CascadeSeed, 'changedKeys' | 'changedSets'> => ({ changedKeys: new Set(), changedSets: new Set() });
  for (const field of new Set(cfg.rollups.map((r) => r.via))) {
    const targets = await linksFrom(tx, id, field);
    if (targets.length > 0) seeds.push({ recordId: id, ...empty(), changedLinks: [{ field, otherIds: targets }] });
    for (const source of await linksTo(tx, id, field)) {
      seeds.push({ recordId: source, ...empty(), changedLinks: [{ field, otherIds: [id] }] });
    }
  }
  return seeds;
}
