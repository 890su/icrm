import { ExprSyntaxError, type Expr } from '../expr/ast.js';
import { sameType, typeName, unify } from '../expr/functions.js';
import { parse } from '../expr/parser.js';
import { fieldRefs, usesClock } from '../expr/refs.js';
import { ExprTypeError, typecheck } from '../expr/typecheck.js';
import type { ExprType, ScalarType, TypeEnv } from '../expr/types.js';
import { ConfigError, type ConfigIssue } from './errors.js';
import type { Agg, FieldDef, RawConfig, RuleDef, SetDef, SourceRef } from './schema.js';

export interface CompiledField extends FieldDef {
  valueType: ExprType | 'link';
  /** Parsed `expr` of a formula. */
  ast?: Expr;
  /** Parsed `filter` of a rollup. */
  filterAst?: Expr;
  /** Keys this field is computed from (formula: `{refs}`; rollup: field + filter refs). Empty for plain fields. */
  deps: Set<string>;
  /** Depends on TODAY()/NOW(), i.e. is not a pure function of the record. */
  clock: boolean;
  /** Hash-like identity of a computed field's definition (without label and src); undefined for plain fields. */
  signature?: string;
}

export interface CompiledSet extends SetDef {
  /** The set itself plus everything it requires, transitively. */
  closure: string[];
}

export interface CompiledRule extends RuleDef {
  whenAst: Expr;
  validateAst?: Expr;
  defaultAsts: Record<string, Expr>;
}

export interface CompiledRollup {
  key: string;
  via: string;
  direction: 'forward' | 'inverse';
  field?: string;
  agg: Agg;
  filterAst?: Expr;
  /** `field` plus the refs of `filter`. */
  sourceKeys: Set<string>;
}

export interface CompiledConfig {
  timezone: string;
  /** All fields, including the built-in `title`. */
  fields: Map<string, CompiledField>;
  sets: Map<string, CompiledSet>;
  rules: CompiledRule[];
  /** Topological order of formula fields; rollups count as already-computed inputs. */
  formulaOrder: string[];
  rollups: CompiledRollup[];
  setsOfField: Map<string, Set<string>>;
  /** Fields mentioned in some rule's `show`. */
  showTargets: Set<string>;
}

type Err = (message: string) => void;
type SubErr = (sub: string, message: string) => void;

const TITLE: FieldDef = {
  key: 'title',
  label: 'Название',
  type: 'text',
  src: { file: '<builtin>', path: 'fields.title' },
};

const isComputed = (d: FieldDef): boolean => d.type === 'formula' || d.type === 'rollup';

function plainType(d: FieldDef): ExprType | 'link' {
  if (d.type === 'link') return 'link';
  const scalar = (d.type === 'enum' || d.type === 'user' || d.type === 'file' ? 'text' : d.type) as ScalarType;
  return d.multiple === true ? { list: scalar } : scalar;
}

function tryParse(src: string, err: Err): Expr | undefined {
  try {
    return parse(src);
  } catch (e) {
    if (!(e instanceof ExprSyntaxError)) throw e;
    err(`${e.message} (позиция ${e.pos.start})`);
    return undefined;
  }
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, stable(x)]),
    );
  }
  return v;
}

function signatureOf(d: FieldDef): string {
  const { label: _label, src: _src, ...definition } = d;
  return JSON.stringify(stable(definition));
}

/** Every cycle reachable in the graph, each as `[a, b, a]`. DFS, nodes visited in the given order. */
function findCycles(nodes: Iterable<string>, edges: (k: string) => string[]): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (k: string): void => {
    state.set(k, 'open');
    stack.push(k);
    for (const dep of edges(k)) {
      const s = state.get(dep);
      if (s === 'open') cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      else if (s === undefined) visit(dep);
    }
    stack.pop();
    state.set(k, 'done');
  };
  for (const k of nodes) if (!state.has(k)) visit(k);
  return cycles;
}

/**
 * Resolves references, typechecks every expression, builds the dependency graph.
 * @throws ConfigError carrying every issue found.
 */
export function compileConfig(raw: RawConfig): CompiledConfig {
  const issues: ConfigIssue[] = [];
  const report = (src: SourceRef, sub: string, message: string): void => {
    issues.push({ file: src.file, path: sub === '' ? src.path : `${src.path}.${sub}`, line: src.line, message });
  };
  const errAt = (src: SourceRef): SubErr => (sub, message) => report(src, sub, message);

  const defs = new Map<string, FieldDef>([[TITLE.key, TITLE], ...raw.fields.map((f) => [f.key, f] as const)]);
  const setDefs = new Map(raw.sets.map((s) => [s.key, s]));
  const computed = [...defs.values()].filter(isComputed);

  // --- sets and link targets -----------------------------------------------------------------
  for (const s of raw.sets) {
    for (const f of s.fields) if (!defs.has(f)) report(s.src, 'fields', `поле "${f}" не найдено`);
    for (const r of s.requires) if (!setDefs.has(r)) report(s.src, 'requires', `набор "${r}" не найден`);
  }
  const requiresOf = (k: string): string[] => (setDefs.get(k)?.requires ?? []).filter((r) => setDefs.has(r));
  for (const cycle of findCycles(setDefs.keys(), requiresOf)) {
    report(setDefs.get(cycle[0]!)!.src, 'requires', `requires образуют цикл: ${cycle.join(' → ')}`);
  }
  for (const d of defs.values()) {
    if (d.type !== 'link') continue;
    for (const t of d.target_sets ?? []) {
      if (!setDefs.has(t)) report(d.src, 'target_sets', `набор "${t}" не найден`);
    }
  }

  // --- expressions and types -----------------------------------------------------------------
  const asts = new Map<string, Expr>();
  const filterAsts = new Map<string, Expr>();
  for (const d of computed) {
    const err = errAt(d.src);
    if (d.type === 'formula' && d.expr !== undefined) {
      const ast = tryParse(d.expr, (m) => err('expr', m));
      if (ast) asts.set(d.key, ast);
    }
    if (d.type === 'rollup' && d.filter !== undefined) {
      const ast = tryParse(d.filter, (m) => err('filter', m));
      if (ast) filterAsts.set(d.key, ast);
    }
  }

  /** Types of computed fields; a field not resolved (yet) reads as `null`, which unifies with anything. */
  const computedTypes = new Map<string, ExprType>();
  let linkHit: string | undefined;
  const env: TypeEnv = {
    fieldType(key) {
      const d = defs.get(key);
      if (d === undefined) return undefined;
      if (d.type === 'link') {
        linkHit = key;
        return undefined;
      }
      return isComputed(d) ? computedTypes.get(key) ?? 'null' : (plainType(d) as ExprType);
    },
    hasSet: (key) => setDefs.has(key),
  };

  function check(ast: Expr, err: Err): ExprType | undefined {
    linkHit = undefined;
    try {
      return typecheck(ast, env);
    } catch (e) {
      if (!(e instanceof ExprTypeError)) throw e;
      err(linkHit === undefined
        ? `${e.message} (позиция ${e.pos.start})`
        : `поле-ссылку нельзя использовать в выражении: {${linkHit}}`);
      return undefined;
    }
  }

  function expectBool(ast: Expr, what: string, err: Err): void {
    const t = check(ast, err);
    if (t !== undefined && t !== 'bool' && t !== 'null') err(`${what} должно быть bool, получено ${typeName(t)}`);
  }

  /** Type of a computed field given the current `computedTypes`; reports problems through `err`. */
  function computedType(d: FieldDef, err: SubErr): ExprType | undefined {
    if (d.type === 'formula') {
      const ast = asts.get(d.key);
      return ast && check(ast, (m) => err('expr', m));
    }

    const via = d.via === undefined ? undefined : defs.get(d.via);
    if (via === undefined) err('via', `поле "${d.via}" не найдено`);
    else if (via.type !== 'link') err('via', `via "${via.key}" должно быть полем типа link, а не ${via.type}`);

    const filterAst = filterAsts.get(d.key);
    if (filterAst) expectBool(filterAst, 'filter', (m) => err('filter', m));

    const target = d.field === undefined ? undefined : defs.get(d.field);
    if (d.field !== undefined && target === undefined) {
      err('field', `поле "${d.field}" не найдено`);
      return undefined;
    }
    if (d.agg === 'count') return 'number';
    if (target === undefined) return undefined;
    if (target.type === 'link') {
      err('field', `поле-ссылку "${target.key}" нельзя агрегировать`);
      return undefined;
    }

    const t = isComputed(target) ? computedTypes.get(target.key) ?? 'null' : (plainType(target) as ExprType);
    if (t === 'null') return 'null'; // not resolved yet (or broken: reported elsewhere)
    const bad = (): undefined => {
      err('field', `агрегат ${d.agg} неприменим к полю "${target.key}" типа ${typeName(t)}`);
      return undefined;
    };
    switch (d.agg) {
      case 'sum':
      case 'avg':
        return t === 'number' || t === 'money' ? t : bad();
      case 'min':
      case 'max':
        return t === 'number' || t === 'money' || t === 'date' || t === 'datetime' ? t : bad();
      case 'all':
      case 'any':
        return t === 'bool' ? 'bool' : bad();
      case 'list':
        return typeof t === 'string' ? { list: t } : bad();
      case 'first':
        return t;
      default:
        return undefined;
    }
  }

  // Types of computed fields can depend on each other in any order (and, through a hierarchical
  // rollup, on themselves), so iterate to a fixed point silently, then run once more to report.
  const noReport: SubErr = () => undefined;
  for (let pass = 0; pass <= computed.length; pass++) {
    let changed = false;
    for (const d of computed) {
      const t = computedType(d, noReport);
      const prev = computedTypes.get(d.key);
      if (t !== undefined && (prev === undefined || !sameType(prev, t))) {
        computedTypes.set(d.key, t);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const d of computed) computedType(d, errAt(d.src));

  // --- dependency graph ----------------------------------------------------------------------
  const depsOf = (d: FieldDef): Set<string> => {
    if (d.type === 'formula') {
      const ast = asts.get(d.key);
      return ast ? fieldRefs(ast) : new Set();
    }
    if (d.type === 'rollup') {
      const keys = new Set<string>(d.field === undefined ? [] : [d.field]);
      const filterAst = filterAsts.get(d.key);
      if (filterAst) for (const k of fieldRefs(filterAst)) keys.add(k);
      return keys;
    }
    return new Set();
  };

  const edgesOf = (k: string): string[] => {
    const d = defs.get(k)!;
    // A rollup over a hierarchical link reads the same field on *other* records (a tree), so
    // the edge rollup → its own `field` is not a cycle.
    const exempt = d.type === 'rollup' && d.via !== undefined && defs.get(d.via)?.hierarchical === true
      ? d.field : undefined;
    const deps = [...depsOf(d)].filter((x) => x !== exempt);
    if (exempt !== undefined) {
      // The exemption covers only the `field` edge, not a mention of the same key in `filter`.
      const filterAst = filterAsts.get(k);
      if (filterAst && fieldRefs(filterAst).has(exempt)) deps.push(exempt);
    }
    return deps.filter((x) => defs.has(x) && isComputed(defs.get(x)!));
  };
  for (const cycle of findCycles(computed.map((d) => d.key), edgesOf)) {
    report(defs.get(cycle[0]!)!.src, '', `зависимости образуют цикл: ${cycle.join(' → ')}`);
  }

  const formulaOrder: string[] = [];
  const emitted = new Set<string>();
  const emit = (k: string): void => {
    if (emitted.has(k)) return;
    emitted.add(k);
    for (const dep of depsOf(defs.get(k)!)) if (defs.get(dep)?.type === 'formula') emit(dep);
    formulaOrder.push(k);
  };
  for (const d of computed) if (d.type === 'formula') emit(d.key);

  // --- rules ---------------------------------------------------------------------------------
  const showTargets = new Set<string>();
  const rules: CompiledRule[] = [];
  for (const rule of raw.rules) {
    const err = errAt(rule.src);
    const asExpr = (sub: string, src: string): Expr | undefined => tryParse(src, (m) => err(sub, m));

    const whenAst = asExpr('when', rule.when);
    if (whenAst) expectBool(whenAst, 'when', (m) => err('when', m));

    let validateAst: Expr | undefined;
    if (rule.validate !== undefined) {
      validateAst = asExpr('validate', rule.validate);
      if (validateAst) expectBool(validateAst, 'validate', (m) => err('validate', m));
    }

    const defaultAsts: Record<string, Expr> = {};
    for (const [fk, src] of Object.entries(rule.default ?? {})) {
      const sub = `default.${fk}`;
      const ast = asExpr(sub, src);
      const field = defs.get(fk);
      if (field === undefined) {
        err(sub, `default: поле "${fk}" не найдено`);
        continue;
      }
      if (isComputed(field)) {
        err(sub, `default: значение по умолчанию нельзя задать вычисляемому полю "${fk}"`);
        continue;
      }
      if (ast === undefined) continue;
      defaultAsts[fk] = ast;
      const t = check(ast, (m) => err(sub, m));
      const vt = isComputed(field) ? computedTypes.get(fk) ?? 'null' : plainType(field);
      if (t === undefined) continue;
      if (vt === 'link') err(sub, `default: для поля-ссылки "${fk}" значение по умолчанию не поддерживается`);
      else if (unify(t, vt) === undefined) {
        err(sub, `default: тип выражения ${typeName(t)} не совпадает с типом поля "${fk}" (${typeName(vt)})`);
      }
    }

    for (const kind of ['show', 'hide', 'require', 'readonly'] as const) {
      for (const fk of rule[kind] ?? []) if (!defs.has(fk)) err(kind, `поле "${fk}" не найдено`);
    }
    for (const fk of rule.show ?? []) showTargets.add(fk);

    for (const [fk, values] of Object.entries(rule.options ?? {})) {
      const sub = `options.${fk}`;
      const field = defs.get(fk);
      if (field === undefined) err(sub, `поле "${fk}" не найдено`);
      else if (field.options === undefined) err(sub, `у поля "${fk}" нет options`);
      else {
        const outside = values.filter((v) => !field.options!.includes(v));
        if (outside.length > 0) err(sub, `значения вне options поля "${fk}": ${outside.join(', ')}`);
      }
    }

    if (rule.enable_set !== undefined) {
      const target = setDefs.get(rule.enable_set);
      if (target === undefined) err('enable_set', `набор "${rule.enable_set}" не найден`);
      else if (target.activation === 'manual') {
        err('enable_set', `набор "${target.key}" имеет activation: manual; правило может включать только rule или both`);
      }
    }

    if (whenAst) rules.push({ ...rule, whenAst, validateAst, defaultAsts });
  }

  if (issues.length > 0) throw new ConfigError(issues);

  // --- result --------------------------------------------------------------------------------
  const fields = new Map<string, CompiledField>();
  for (const d of defs.values()) {
    const isComp = isComputed(d);
    const filterAst = filterAsts.get(d.key);
    const ast = asts.get(d.key);
    const refs = [ast, filterAst].filter((e): e is Expr => e !== undefined);
    fields.set(d.key, {
      ...d,
      valueType: isComp ? computedTypes.get(d.key) ?? 'null' : plainType(d),
      ast,
      filterAst,
      deps: depsOf(d),
      clock: refs.some(usesClock),
      signature: isComp ? signatureOf(d) : undefined,
    });
  }

  const sets = new Map<string, CompiledSet>();
  const setsOfField = new Map<string, Set<string>>();
  for (const s of raw.sets) {
    const closure: string[] = [];
    const walk = (k: string): void => {
      if (closure.includes(k)) return;
      closure.push(k);
      for (const r of requiresOf(k)) walk(r);
    };
    walk(s.key);
    sets.set(s.key, { ...s, closure });
    for (const f of s.fields) {
      const of = setsOfField.get(f) ?? new Set<string>();
      of.add(s.key);
      setsOfField.set(f, of);
    }
  }

  const rollups: CompiledRollup[] = computed.filter((d) => d.type === 'rollup').map((d) => ({
    key: d.key,
    via: d.via!,
    direction: d.direction ?? 'forward',
    field: d.field,
    agg: d.agg!,
    filterAst: filterAsts.get(d.key),
    sourceKeys: depsOf(d),
  }));

  return { timezone: raw.timezone, fields, sets, rules, formulaOrder, rollups, setsOfField, showTargets };
}
