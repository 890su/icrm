import type { Pos } from './ast.js';
import { ExprTypeError, type EvalCtx, type ExprType, type ScalarType, type Value } from './types.js';
import {
  addDays, compareValues, daysBetween, isEmpty, roundNumber, todayIn, toText, validDate, valuesEqual,
} from './value.js';

export interface FnSpec {
  name: string;
  /** Validates argument types and returns the result type; throws ExprTypeError. */
  check(args: ExprType[], pos: Pos): ExprType;
  /**
   * Evaluates the function on already-evaluated arguments (all arguments are evaluated eagerly:
   * evaluation is pure and never throws on data). Runtime problems return null. The evaluator also
   * guards each call, so an unexpected throw degrades to null rather than failing a save.
   */
  impl(args: Value[], ctx: EvalCtx): Value;
}

// --- type helpers (shared with typecheck.ts) ---------------------------------

export function typeName(t: ExprType): string {
  return typeof t === 'string' ? t : `list<${t.list}>`;
}

export function isList(t: ExprType): t is { list: ScalarType } {
  return typeof t === 'object';
}

export function sameType(a: ExprType, b: ExprType): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.list === b.list;
}

/** Common type of a and b; `null` unifies with anything. Undefined when incompatible. */
export function unify(a: ExprType, b: ExprType): ExprType | undefined {
  if (a === 'null') return b;
  if (b === 'null') return a;
  return sameType(a, b) ? a : undefined;
}

// --- registry ----------------------------------------------------------------

function fail(message: string, pos: Pos): never {
  throw new ExprTypeError(message, pos);
}

function arity(name: string, args: ExprType[], min: number, max: number, pos: Pos): void {
  if (args.length >= min && args.length <= max) return;
  const want = max === Infinity ? `не менее ${min}` : min === max ? `${min}` : `от ${min} до ${max}`;
  fail(`${name}: ожидается аргументов ${want}, получено ${args.length}`, pos);
}

/** Argument must be one of `allowed` (or null). */
function expectArg(name: string, i: number, t: ExprType, allowed: ScalarType[], pos: Pos): void {
  if (t === 'null') return;
  if (typeof t === 'string' && allowed.includes(t)) return;
  fail(`${name}: аргумент ${i + 1} должен быть ${allowed.join(' или ')}, получен ${typeName(t)}`, pos);
}

/** All args must unify to one type; returns it. */
function unifyAll(name: string, args: ExprType[], pos: Pos): ExprType {
  let acc: ExprType = 'null';
  args.forEach((a, i) => {
    const u = unify(acc, a);
    if (u === undefined) {
      fail(`${name}: аргумент ${i + 1} имеет тип ${typeName(a)}, ожидался ${typeName(acc)}`, pos);
    }
    acc = u;
  });
  return acc;
}

const ORDERED: ScalarType[] = ['number', 'money', 'date', 'datetime'];
const DATE_LIKE: ScalarType[] = ['date', 'datetime'];

function spec(name: string, check: FnSpec['check'], impl: FnSpec['impl']): FnSpec {
  return { name, check, impl };
}

/** Argument `i`, or null when absent (impls must tolerate calls that were never type-checked). */
const arg = (args: Value[], i: number): Value => args[i] ?? null;

/** MIN / MAX: empty arguments are skipped; incomparable ones (e.g. currency mismatch) give null. */
function extreme(args: Value[], direction: 1 | -1): Value {
  let best: Value = null;
  for (const a of args) {
    if (isEmpty(a)) continue;
    if (best === null) { best = a; continue; }
    const c = compareValues(a, best);
    if (c === null) return null;
    if (c * direction > 0) best = a;
  }
  return best;
}

const specs: FnSpec[] = [
  spec('IF', (args, pos) => {
    arity('IF', args, 3, 3, pos);
    expectArg('IF', 0, args[0]!, ['bool'], pos);
    const t = unify(args[1]!, args[2]!);
    if (t === undefined) {
      fail(`IF: ветки должны иметь одинаковый тип, получены ${typeName(args[1]!)} и ${typeName(args[2]!)}`, pos);
    }
    return t;
  }, (args) => (arg(args, 0) === true ? arg(args, 1) : arg(args, 2))),
  ...(['AND', 'OR'] as const).map((name) =>
    spec(name, (args, pos) => {
      arity(name, args, 1, Infinity, pos);
      args.forEach((a, i) => expectArg(name, i, a, ['bool'], pos));
      return 'bool';
    }, (args) => (name === 'AND' ? args.every((a) => a === true) : args.some((a) => a === true))),
  ),
  spec('NOT', (args, pos) => {
    arity('NOT', args, 1, 1, pos);
    expectArg('NOT', 0, args[0]!, ['bool'], pos);
    return 'bool';
  }, (args) => arg(args, 0) !== true),
  spec('IS_EMPTY', (args, pos) => {
    arity('IS_EMPTY', args, 1, 1, pos);
    return 'bool';
  }, (args) => isEmpty(arg(args, 0))),
  // The string-literal requirement and set existence are enforced by typecheck(), which sees the AST.
  spec('HAS_SET', (args, pos) => {
    arity('HAS_SET', args, 1, 1, pos);
    expectArg('HAS_SET', 0, args[0]!, ['text'], pos);
    return 'bool';
  }, (args, ctx) => {
    const key = arg(args, 0);
    return typeof key === 'string' && ctx.hasSet(key);
  }),
  spec('IN', (args, pos) => {
    arity('IN', args, 2, Infinity, pos);
    unifyAll('IN', args, pos);
    return 'bool';
  }, (args) => {
    const needle = arg(args, 0);
    if (isEmpty(needle)) return false;
    return args.slice(1).some((candidate) => !isEmpty(candidate) && valuesEqual(needle, candidate));
  }),
  spec('CONTAINS', (args, pos) => {
    arity('CONTAINS', args, 2, 2, pos);
    const [hay, needle] = args as [ExprType, ExprType];
    if (isList(hay)) {
      if (unify(hay.list, needle) === undefined) {
        fail(`CONTAINS: элемент типа ${typeName(needle)} не подходит к ${typeName(hay)}`, pos);
      }
    } else {
      expectArg('CONTAINS', 0, hay, ['text'], pos);
      expectArg('CONTAINS', 1, needle, ['text'], pos);
    }
    return 'bool';
  }, (args) => {
    const hay = arg(args, 0);
    const needle = arg(args, 1);
    if (isEmpty(hay) || isEmpty(needle)) return false;
    if (Array.isArray(hay)) return hay.some((item) => valuesEqual(item, needle));
    // Text containment is case-insensitive (Unicode-aware), matching SQL ILIKE.
    return typeof hay === 'string' && typeof needle === 'string' &&
      hay.toLowerCase().includes(needle.toLowerCase());
  }),
  spec('TODAY', (args, pos) => {
    arity('TODAY', args, 0, 0, pos);
    return 'date';
  }, (_args, ctx) => todayIn(ctx.now, ctx.timezone)),
  spec('NOW', (args, pos) => {
    arity('NOW', args, 0, 0, pos);
    return 'datetime';
  }, (_args, ctx) => ctx.now.toISOString()),
  spec('DAYS_BETWEEN', (args, pos) => {
    arity('DAYS_BETWEEN', args, 2, 2, pos);
    args.forEach((a, i) => expectArg('DAYS_BETWEEN', i, a, DATE_LIKE, pos));
    return 'number';
  }, (args, ctx) => daysBetween(arg(args, 0), arg(args, 1), ctx.timezone)),
  spec('ADD_DAYS', (args, pos) => {
    arity('ADD_DAYS', args, 2, 2, pos);
    expectArg('ADD_DAYS', 0, args[0]!, ['date'], pos);
    expectArg('ADD_DAYS', 1, args[1]!, ['number'], pos);
    return 'date';
  }, (args) => addDays(arg(args, 0), arg(args, 1))),
  spec('ROUND', (args, pos) => {
    arity('ROUND', args, 1, 2, pos);
    args.forEach((a, i) => expectArg('ROUND', i, a, ['number'], pos));
    return 'number';
  }, (args) => roundNumber(arg(args, 0), args.length > 1 ? arg(args, 1) : 0)),
  ...(['MIN', 'MAX'] as const).map((name) =>
    spec(name, (args, pos) => {
      arity(name, args, 1, Infinity, pos);
      const t = unifyAll(name, args, pos);
      if (t !== 'null' && !(typeof t === 'string' && ORDERED.includes(t))) {
        fail(`${name}: поддерживаются ${ORDERED.join(', ')}, получен ${typeName(t)}`, pos);
      }
      return t;
    }, (args) => extreme(args, name === 'MAX' ? 1 : -1)),
  ),
  spec('LEN', (args, pos) => {
    arity('LEN', args, 1, 1, pos);
    if (!isList(args[0]!)) expectArg('LEN', 0, args[0]!, ['text'], pos);
    return 'number';
  }, (args) => {
    const v = arg(args, 0);
    return Array.isArray(v) ? v.length : toText(v).length;
  }),
  spec('CONCAT', (args, pos) => {
    arity('CONCAT', args, 1, Infinity, pos);
    return 'text';
  }, (args) => args.map(toText).join('')),
  spec('COALESCE', (args, pos) => {
    arity('COALESCE', args, 1, Infinity, pos);
    return unifyAll('COALESCE', args, pos);
  }, (args) => args.find((a) => !isEmpty(a)) ?? null),
  // The literal's format is validated by typecheck(), which sees the AST.
  spec('DATE', (args, pos) => {
    arity('DATE', args, 1, 1, pos);
    expectArg('DATE', 0, args[0]!, ['text'], pos);
    return 'date';
  }, (args) => validDate(arg(args, 0))),
];

export const FUNCTIONS: Map<string, FnSpec> = new Map(specs.map((s) => [s.name, s]));
