import type { CompiledConfig, CompiledRule } from '../config/compile.js';
import { evaluate, isEmpty } from '../expr/evaluate.js';
import type { EvalCtx, Value } from '../expr/types.js';
import { checkValue } from './values.js';

/** A record: values plus enabled sets, each with who enabled it (`'manual'` | `'rule:<id>'`). `title` lives in `data.title`. */
export interface RecordState {
  data: Record<string, Value>;
  sets: Map<string, string>;
}

export interface FieldState {
  visible: boolean;
  required: boolean;
  readonly: boolean;
  /** Allowed options; only for enum fields. */
  options?: string[];
}

export type ErrorCode = 'invalid_value' | 'invalid_option' | 'required' | 'validation' | 'readonly' | 'oscillation'
  | 'set_activation' | 'set_required_by' | 'unknown_set' | 'unknown_field' | 'link_target' | 'link_cardinality' | 'link_cycle'
  | 'link_owned' | 'version_conflict' | 'not_found' | 'archived'
  | 'managed_field' | 'invalid_address' | 'identity_taken' | 'invalid_owner' | 'nip_invalid' | 'nip_taken'
  | 'public_domain' | 'membership_active_exists' | 'primary_conflict' | 'membership_ended'
  | 'handover_target_invalid' | 'merge_kind_mismatch' | 'merge_self' | 'merge_archived';

export interface RecordError {
  field?: string;
  rule_id?: string;
  code: ErrorCode;
  message: string;
  /** Set when the error comes from a row of an owned link field (0-based index in that field). */
  row?: { field: string; index: number };
  /** The record the error is about, when it is another record than the one saved (e.g. the holder of an identity). */
  recordId?: string;
  /** The owner of `recordId`, when that record is owned by another one (e.g. a contact of an organization). */
  ownerId?: string;
  ownerTitle?: string;
}

export interface EvalResult {
  state: RecordState;
  fieldStates: Map<string, FieldState>;
  /** Ids of the rules active in `state`, in config order. */
  activeRules: string[];
  /** `data` keys whose value differs from `prev` (on create: every non-empty key), computed ones included. */
  changedKeys: Set<string>;
  errors: RecordError[];
}

export interface EvalOptions {
  now: Date;
  /** Keys the user wrote in this save; only these get type/option and readonly checks. */
  userChangedKeys: Set<string>;
  /**
   * Link field keys that currently have at least one link. Links live outside `data`, so this is how
   * `require` sees a link field as filled. Absent = no link field is filled.
   */
  linkedKeys?: Set<string>;
}

/** Spec §1.8: at most this many stabilization passes. */
const MAX_PASSES = 10;
const RULE_PREFIX = 'rule:';

const get = (data: Record<string, Value>, key: string): Value =>
  Object.hasOwn(data, key) ? data[key] ?? null : null;

function ctxOf(cfg: CompiledConfig, s: RecordState, now: Date): EvalCtx {
  return { get: (k) => get(s.data, k), hasSet: (k) => s.sets.has(k), now, timezone: cfg.timezone };
}

function activeRulesOf(cfg: CompiledConfig, s: RecordState, now: Date): CompiledRule[] {
  const ctx = ctxOf(cfg, s, now);
  return cfg.rules.filter((r) => evaluate(r.whenAst, ctx) === true);
}

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

function sameSets(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([k, by]) => b.get(k) === by);
}

/** Recomputes, in dependency order, the formulas that belong to at least one enabled set. Mutates `s.data`. */
function computeFormulas(cfg: CompiledConfig, s: RecordState, now: Date): void {
  const ctx = ctxOf(cfg, s, now);
  for (const key of cfg.formulaOrder) {
    const ast = cfg.fields.get(key)?.ast;
    const enabled = [...(cfg.setsOfField.get(key) ?? [])].some((set) => s.sets.has(set));
    if (ast !== undefined && enabled) s.data[key] = evaluate(ast, ctx);
  }
}

/**
 * Sets wanted by active rules (with their closures) → `'rule:<id>'`. Manual (non-`rule:`) enablings are never
 * touched. A rule enabling is dropped once no active rule wants it and no remaining set requires it.
 */
function applySetRules(cfg: CompiledConfig, sets: Map<string, string>, active: CompiledRule[]): Map<string, string> {
  const wantedBy = new Map<string, string[]>();
  for (const r of active) {
    if (r.enable_set === undefined) continue;
    for (const set of cfg.sets.get(r.enable_set)?.closure ?? []) {
      wantedBy.set(set, [...(wantedBy.get(set) ?? []), `${RULE_PREFIX}${r.id}`]);
    }
  }

  // Manual enablings and wanted sets stay. A wanted rule enabling keeps its label while its own
  // rule still wants it; otherwise it goes to the first rule that does.
  const kept = new Map<string, string>();
  for (const [set, by] of sets) {
    const wanters = wantedBy.get(set);
    if (!by.startsWith(RULE_PREFIX)) kept.set(set, by);
    else if (wanters !== undefined) kept.set(set, wanters.includes(by) ? by : wanters[0]!);
  }
  for (const [set, wanters] of wantedBy) if (!kept.has(set)) kept.set(set, wanters[0]!);

  // A rule enabling nobody wants any more survives only inside the closure of a set that stays
  // (closures are transitive, so one look is enough). Existing sets keep their order.
  const required = new Set([...kept.keys()].flatMap((set) => cfg.sets.get(set)?.closure ?? []));
  const result = new Map<string, string>();
  for (const [set, by] of sets) {
    const label = kept.get(set) ?? (required.has(set) ? by : undefined);
    if (label !== undefined) result.set(set, label);
  }
  for (const [set, by] of kept) if (!result.has(set)) result.set(set, by);
  return result;
}

/**
 * Spec §2.3: a default is set only into an empty field and only when its rule fires, i.e. for active
 * rules in `fired` (see `evaluateRecord`). A field the user clears while its rule stays active
 * therefore stays empty. First rule wins. Mutates `s.data`.
 */
function applyDefaults(
  cfg: CompiledConfig, s: RecordState, active: CompiledRule[], fired: Set<string>, now: Date,
): void {
  const ctx = ctxOf(cfg, s, now);
  for (const r of active) {
    if (!fired.has(r.id)) continue;
    for (const [key, ast] of Object.entries(r.defaultAsts)) {
      if (!isEmpty(get(s.data, key))) continue;
      const v = evaluate(ast, ctx);
      if (!isEmpty(v)) s.data[key] = v;
    }
  }
}

/**
 * Visibility, required, readonly and allowed options of `title` and every field of an enabled set,
 * as the rules active in `s` make them. `s` is taken as is (formulas are not recomputed).
 */
export function fieldStatesOf(cfg: CompiledConfig, s: RecordState, now: Date): Map<string, FieldState> {
  const active = activeRulesOf(cfg, s, now);
  const listed = (kind: 'show' | 'hide' | 'require' | 'readonly'): Set<string> =>
    new Set(active.flatMap((r) => r[kind] ?? []));
  const shown = listed('show');
  const hidden = listed('hide');
  const required = listed('require');
  const readonly = listed('readonly');

  const keys = new Set(['title']);
  for (const set of s.sets.keys()) for (const f of cfg.sets.get(set)?.fields ?? []) keys.add(f);

  const states = new Map<string, FieldState>();
  for (const key of keys) {
    const field = cfg.fields.get(key);
    if (field === undefined) continue;
    const state: FieldState = {
      visible: !(cfg.showTargets.has(key) && !shown.has(key)) && !hidden.has(key),
      required: required.has(key),
      readonly: readonly.has(key),
    };
    if (field.type === 'enum') {
      let options = field.options ?? [];
      for (const r of active) {
        const allowed = r.options?.[key];
        if (allowed !== undefined) options = options.filter((o) => allowed.includes(o));
      }
      state.options = options;
    }
    states.set(key, state);
  }
  return states;
}

function changedKeysOf(prev: RecordState | null, data: Record<string, Value>): Set<string> {
  if (prev === null) return new Set(Object.keys(data).filter((k) => !isEmpty(get(data, k))));
  const keys = new Set([...Object.keys(prev.data), ...Object.keys(data)]);
  return new Set([...keys].filter((k) => !sameValue(get(prev.data, k), get(data, k))));
}

/** One `oscillation` error per rule whose activity changed during the last two passes. */
function oscillationErrors(history: Set<string>[]): RecordError[] {
  const [a, b, c] = history.slice(-3);
  const flipped = (id: string, x?: Set<string>, y?: Set<string>): boolean =>
    x !== undefined && y !== undefined && x.has(id) !== y.has(id);
  const all = new Set(history.flatMap((h) => [...h]));
  const ids = [...all].filter((id) => flipped(id, a, b) || flipped(id, b, c));
  const message = `Правила раскачиваются, состояние записи не стабилизировалось за ${MAX_PASSES} проходов`
    + (ids.length > 0 ? `: ${ids.join(', ')}` : '');
  // Never report an unstable state without an error, even if no rule can be blamed.
  if (ids.length === 0) return [{ code: 'oscillation', message }];
  return ids.map((rule_id) => ({ code: 'oscillation', rule_id, message }));
}

function userValueErrors(
  cfg: CompiledConfig, data: Record<string, Value>, keys: Set<string>, states: Map<string, FieldState>,
): RecordError[] {
  const errors: RecordError[] = [];
  for (const key of keys) {
    const field = cfg.fields.get(key);
    if (field === undefined) {
      errors.push({ field: key, code: 'unknown_field', message: `Поле "${key}" не найдено` });
      continue;
    }
    if (field.type === 'formula' || field.type === 'rollup') {
      errors.push({ field: key, code: 'invalid_value', message: `Поле «${field.label}» вычисляемое, его нельзя изменить` });
      continue;
    }
    const v = get(data, key);
    const problem = checkValue(field, v);
    if (problem) {
      errors.push({ field: key, ...problem });
      continue;
    }
    const allowed = states.get(key)?.options;
    if (allowed === undefined || v === null) continue;
    const outside = (Array.isArray(v) ? v : [v]).filter((x) => !allowed.includes(x as string));
    if (outside.length > 0) {
      errors.push({
        field: key,
        code: 'invalid_option',
        message: `Поле «${field.label}»: сейчас допустимы только ${allowed.map((o) => `"${o}"`).join(', ')}`,
      });
    }
  }
  return errors;
}

/**
 * `readonly` errors for changing `keys` (values or link fields) of a record, judged by its previous
 * state `prev`, as the rules active in `prev` make them.
 */
export function readonlyErrors(cfg: CompiledConfig, prev: RecordState, keys: Set<string>, now: Date): RecordError[] {
  const states = fieldStatesOf(cfg, prev, now);
  const active = activeRulesOf(cfg, prev, now);
  return [...keys].filter((k) => states.get(k)?.readonly === true).map((key) => ({
    field: key,
    rule_id: active.find((r) => r.readonly?.includes(key))?.id,
    code: 'readonly',
    message: `Поле «${cfg.fields.get(key)!.label}» сейчас только для чтения`,
  }));
}

function ruleErrors(
  cfg: CompiledConfig, s: RecordState, active: CompiledRule[], states: Map<string, FieldState>, now: Date,
  linkedKeys: ReadonlySet<string>,
): RecordError[] {
  const errors: RecordError[] = [];
  const reported = new Set<string>();
  const filled = (key: string): boolean =>
    cfg.fields.get(key)?.type === 'link' ? linkedKeys.has(key) : !isEmpty(get(s.data, key));
  for (const r of active) {
    for (const key of r.require ?? []) {
      if (reported.has(key) || states.get(key)?.visible !== true || filled(key)) continue;
      reported.add(key);
      errors.push({ field: key, rule_id: r.id, code: 'required', message: `Поле «${cfg.fields.get(key)!.label}» обязательно` });
    }
  }
  const ctx = ctxOf(cfg, s, now);
  for (const r of active) {
    // Spec §2.3 "ложь → ошибка": only FALSE fails; null (empty or a runtime error) never fails a save.
    if (r.validateAst === undefined || evaluate(r.validateAst, ctx) !== false) continue;
    errors.push({ rule_id: r.id, code: 'validation', message: r.message ?? `Не выполнена проверка правила "${r.id}"` });
  }
  return errors;
}

/**
 * Stabilizes `next` (formulas → rules → defaults, up to 10 passes), then derives field states and errors.
 * `next` is the state after the user's edit with rollup values already current; neither input is mutated.
 * On oscillation the last state reached is returned with `oscillation` errors; the caller rolls back.
 */
export function evaluateRecord(
  cfg: CompiledConfig, prev: RecordState | null, next: RecordState, opts: EvalOptions,
): EvalResult {
  const { now, userChangedKeys } = opts;
  const linkedKeys = opts.linkedKeys ?? new Set<string>();
  const s: RecordState = { data: { ...next.data }, sets: new Map(next.sets) };
  const history: Set<string>[] = [];
  // A rule "fires" when it was inactive in `prev` (every rule on create) or in an earlier pass of this
  // fixpoint; once fired it stays fired for this save. Only fired rules apply their defaults.
  const activeInPrev = new Set(prev === null ? [] : activeRulesOf(cfg, prev, now).map((r) => r.id));
  const fired = new Set(cfg.rules.filter((r) => !activeInPrev.has(r.id)).map((r) => r.id));
  let stable = false;

  for (let pass = 0; pass < MAX_PASSES && !stable; pass++) {
    const before: RecordState = { data: { ...s.data }, sets: s.sets };
    computeFormulas(cfg, s, now);
    const active = activeRulesOf(cfg, s, now);
    const activeIds = new Set(active.map((r) => r.id));
    history.push(activeIds);
    s.sets = applySetRules(cfg, s.sets, active);
    applyDefaults(cfg, s, active, fired, now);
    for (const r of cfg.rules) if (!activeIds.has(r.id)) fired.add(r.id);
    const keys = new Set([...Object.keys(before.data), ...Object.keys(s.data)]);
    stable = sameSets(before.sets, s.sets)
      && [...keys].every((k) => sameValue(get(before.data, k), get(s.data, k)));
  }

  const active = activeRulesOf(cfg, s, now);
  const fieldStates = fieldStatesOf(cfg, s, now);
  const errors = [
    ...(stable ? [] : oscillationErrors(history)),
    ...userValueErrors(cfg, s.data, userChangedKeys, fieldStates),
    ...(prev === null ? [] : readonlyErrors(cfg, prev, userChangedKeys, now)),
    ...ruleErrors(cfg, s, active, fieldStates, now, linkedKeys),
  ];

  return {
    state: s,
    fieldStates,
    activeRules: active.map((r) => r.id),
    changedKeys: changedKeysOf(prev, s.data),
    errors,
  };
}
