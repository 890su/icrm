import type { BinOp, Expr, Pos } from './ast.js';
import { FUNCTIONS, typeName, unify } from './functions.js';
import { ExprTypeError, type ExprType, type ScalarType, type TypeEnv } from './types.js';

export { ExprTypeError } from './types.js';
export type { ExprType, ScalarType, TypeEnv } from './types.js';

const ORDERED: ScalarType[] = ['number', 'money', 'date', 'datetime', 'text'];

function fail(message: string, pos: Pos): never {
  throw new ExprTypeError(message, pos);
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Infers the type of `e`; throws ExprTypeError (with the offending position) on any mismatch. */
export function typecheck(e: Expr, env: TypeEnv): ExprType {
  switch (e.k) {
    case 'num': return 'number';
    case 'str': return 'text';
    case 'bool': return 'bool';
    case 'null': return 'null';
    case 'field': {
      const t = env.fieldType(e.key);
      if (t === undefined) fail(`Неизвестное поле {${e.key}}`, e);
      return t;
    }
    case 'neg': {
      const t = typecheck(e.e, env);
      if (t === 'number' || t === 'money' || t === 'null') return t;
      return fail(`Унарный минус неприменим к типу ${typeName(t)}`, e);
    }
    case 'bin': return checkBinary(e, typecheck(e.l, env), typecheck(e.r, env));
    case 'call': return checkCall(e, env);
  }
}

function checkBinary(e: Expr & { k: 'bin' }, l: ExprType, r: ExprType): ExprType {
  const mismatch = (): never =>
    fail(`Оператор ${e.op} неприменим к типам ${typeName(l)} и ${typeName(r)}`, e);
  const op: BinOp = e.op;
  switch (op) {
    case '&':
      return 'text';
    case 'AND':
    case 'OR':
      if ((l === 'bool' || l === 'null') && (r === 'bool' || r === 'null')) return 'bool';
      return mismatch();
    case '=':
    case '<>':
      return unify(l, r) === undefined ? mismatch() : 'bool';
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const t = unify(l, r);
      if (t === undefined) return mismatch();
      if (t !== 'null' && !(typeof t === 'string' && ORDERED.includes(t))) return mismatch();
      return 'bool';
    }
    case '+':
    case '-': {
      const t = unify(l, r);
      if (t === 'number' || t === 'money' || t === 'null') return t;
      return mismatch();
    }
    case '*':
    case '/': {
      // null behaves as a number here: `NULL * money` is money, `NULL * NULL` stays null.
      if (l === 'null' && r === 'null') return 'null';
      const a = l === 'null' ? 'number' : l;
      const b = r === 'null' ? 'number' : r;
      if (a === 'number' && b === 'number') return 'number';
      if (a === 'money' && b === 'number') return 'money';
      if (op === '*' && a === 'number' && b === 'money') return 'money';
      return mismatch();
    }
  }
}

function checkCall(e: Expr & { k: 'call' }, env: TypeEnv): ExprType {
  const spec = FUNCTIONS.get(e.fn);
  if (spec === undefined) return fail(`Неизвестная функция ${e.fn}`, e);
  const args = e.args.map((a) => typecheck(a, env));

  if (e.fn === 'HAS_SET') {
    const a = e.args[0];
    if (a?.k !== 'str') return fail('HAS_SET принимает только строковый литерал с ключом набора', e);
    if (!env.hasSet(a.v)) return fail(`Неизвестный набор "${a.v}"`, a);
  } else if (e.fn === 'DATE') {
    const a = e.args[0];
    if (a?.k !== 'str') return fail('DATE принимает только строковый литерал "ГГГГ-ММ-ДД"', e);
    if (!isValidDate(a.v)) return fail(`DATE: "${a.v}" не является датой формата ГГГГ-ММ-ДД`, a);
  }
  return spec.check(args, e);
}
