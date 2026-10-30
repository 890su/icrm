import { Decimal } from 'decimal.js';
import type { BinOp } from './ast.js';
import type { Money, Value } from './types.js';

// Runtime value semantics shared by the evaluator and the function registry.
//
// Everything here treats bad data as a *runtime problem*, never as an exception for the caller to
// handle: helpers either return `null` / `false` or (for the few that can throw, e.g. `todayIn`
// with an unknown timezone) are called under the evaluator's per-node guard.

/** Money / number arithmetic always goes through decimal.js; the shared precision covers any realistic CRM amount. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const AMOUNT_RE = /^-?\d+(\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MS_PER_DAY = 86_400_000;

// --- emptiness ---------------------------------------------------------------

/** Empty value: null, "", whitespace-only string, []. */
export function isEmpty(v: Value): boolean {
  if (v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  return Array.isArray(v) && v.length === 0;
}

export function isMoney(v: Value): v is Money {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    typeof v.amount === 'string' && AMOUNT_RE.test(v.amount) && typeof v.currency === 'string'
  );
}

// --- numbers and money -------------------------------------------------------

function finiteNumber(v: Value): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Decimal -> JS number; null when it does not fit a finite double. Normalises -0 to 0. */
function toNumber(d: Decimal): number | null {
  const n = d.toNumber();
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n;
}

function toMoney(d: Decimal, currency: string): Money {
  return { amount: d.isZero() ? '0' : d.toFixed(), currency };
}

type ArithOp = '+' | '-' | '*' | '/';

function applyDecimal(op: ArithOp, a: Decimal, b: Decimal): Decimal | null {
  switch (op) {
    case '+': return a.plus(b);
    case '-': return a.minus(b);
    case '*': return a.times(b);
    case '/': return b.isZero() ? null : a.div(b);
  }
}

/** `+ - * /` on numbers and money. Empty operand, division by zero, currency mismatch, bad types -> null. */
export function arithmetic(op: ArithOp, l: Value, r: Value): Value {
  if (isEmpty(l) || isEmpty(r)) return null;
  if (finiteNumber(l) && finiteNumber(r)) {
    const d = applyDecimal(op, new D(l), new D(r));
    return d === null ? null : toNumber(d);
  }
  if (isMoney(l) && isMoney(r)) {
    if ((op !== '+' && op !== '-') || l.currency !== r.currency) return null;
    const d = applyDecimal(op, new D(l.amount), new D(r.amount));
    return d === null ? null : toMoney(d, l.currency);
  }
  if (isMoney(l) && finiteNumber(r) && (op === '*' || op === '/')) {
    const d = applyDecimal(op, new D(l.amount), new D(r));
    return d === null ? null : toMoney(d, l.currency);
  }
  if (finiteNumber(l) && isMoney(r) && op === '*') {
    const d = applyDecimal(op, new D(l), new D(r.amount));
    return d === null ? null : toMoney(d, r.currency);
  }
  return null;
}

export function negate(v: Value): Value {
  if (finiteNumber(v)) return toNumber(new D(v).neg());
  if (isMoney(v)) return toMoney(new D(v.amount).neg(), v.currency);
  return null;
}

/** Half away from zero; negative `digits` round to tens, hundreds, ... */
export function roundNumber(v: Value, digits: Value): Value {
  if (!finiteNumber(v) || !finiteNumber(digits)) return null;
  const n = Math.trunc(digits);
  if (Math.abs(n) > 1000) return null;
  const d = new D(v);
  if (n >= 0) return toNumber(d.toDecimalPlaces(n));
  const scale = new D(10).pow(-n);
  return toNumber(d.div(scale).toDecimalPlaces(0).times(scale));
}

// --- comparison --------------------------------------------------------------

const sign = <T extends number | string>(x: T, y: T): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Three-way comparison of two non-empty scalars of the same kind.
 * Returns null when they cannot be compared (currency mismatch, different kinds, lists).
 */
export function compareValues(a: Value, b: Value): number | null {
  if (finiteNumber(a) && finiteNumber(b)) return sign(a, b);
  if (typeof a === 'string' && typeof b === 'string') {
    // Datetimes compare by instant, so "…:00Z" equals "…:00.000Z".
    if (DATETIME_RE.test(a) && DATETIME_RE.test(b)) {
      const x = Date.parse(a);
      const y = Date.parse(b);
      if (!Number.isNaN(x) && !Number.isNaN(y)) return sign(x, y);
    }
    return sign(a, b);
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return sign(Number(a), Number(b));
  if (isMoney(a) && isMoney(b)) {
    return a.currency === b.currency ? new D(a.amount).cmp(new D(b.amount)) : null;
  }
  return null;
}

/** Equality used by IN / CONTAINS and list comparison: anything incomparable is simply "not equal". */
export function valuesEqual(a: Value, b: Value): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => valuesEqual(x, b[i] ?? null));
  }
  if (a === null || b === null) return a === b;
  return compareValues(a, b) === 0;
}

type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

/**
 * Comparison operators. An empty operand makes every comparison FALSE (including `<>`; use IS_EMPTY).
 * Incomparable non-empty operands (currency mismatch, wrong kinds) are a runtime problem -> null.
 */
export function compareOp(op: CompareOp, a: Value, b: Value): boolean | null {
  if (isEmpty(a) || isEmpty(b)) return false;
  if ((op === '=' || op === '<>') && Array.isArray(a) && Array.isArray(b)) {
    return valuesEqual(a, b) === (op === '=');
  }
  const c = compareValues(a, b);
  if (c === null) return null;
  switch (op) {
    case '=': return c === 0;
    case '<>': return c !== 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
  }
}

/** Binary operator dispatch for the evaluator. AND/OR treat anything but TRUE as false. */
export function binaryOp(op: BinOp, l: Value, r: Value): Value {
  switch (op) {
    case '+': case '-': case '*': case '/': return arithmetic(op, l, r);
    case '&': return toText(l) + toText(r);
    case 'AND': return l === true && r === true;
    case 'OR': return l === true || r === true;
    default: return compareOp(op, l, r);
  }
}

// --- text --------------------------------------------------------------------

/** String form used by `&` / CONCAT / LEN. Empty values become "". */
export function toText(v: Value): string {
  if (v === null || isEmpty(v)) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? new D(v).toFixed() : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v)) return v.map(toText).filter((s) => s !== '').join(', ');
  return `${v.amount} ${v.currency}`;
}

// --- dates -------------------------------------------------------------------

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar date "YYYY-MM-DD" of `now` in an IANA timezone. Throws RangeError for an unknown timezone. */
export function todayIn(now: Date, timezone: string): string {
  let fmt = dayFormatters.get(timezone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timezone, fmt);
  }
  const part = (type: string): string => fmt.formatToParts(now).find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Whole days since 1970-01-01 for a valid "YYYY-MM-DD", else null. */
function dateToDays(s: string): number | null {
  if (!DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return d.getTime() / MS_PER_DAY;
}

function daysToDate(days: number): string | null {
  const d = new Date(days * MS_PER_DAY);
  if (Number.isNaN(d.getTime())) return null;
  const s = d.toISOString().slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

/** Calendar day number of a date, or of a datetime in the workspace timezone. Anything else -> null. */
function toLocalDays(v: Value, timezone: string): number | null {
  if (typeof v !== 'string') return null;
  if (DATE_RE.test(v)) return dateToDays(v);
  if (DATETIME_RE.test(v)) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : dateToDays(todayIn(new Date(ms), timezone));
  }
  return null;
}

export function daysBetween(a: Value, b: Value, timezone: string): number | null {
  const x = toLocalDays(a, timezone);
  const y = toLocalDays(b, timezone);
  return x === null || y === null ? null : y - x;
}

export function addDays(date: Value, n: Value): string | null {
  if (typeof date !== 'string' || !finiteNumber(n)) return null;
  const days = dateToDays(date);
  return days === null ? null : daysToDate(days + Math.trunc(n));
}

/** The date itself when it is a valid "YYYY-MM-DD", else null. */
export function validDate(v: Value): string | null {
  return typeof v === 'string' && dateToDays(v) !== null ? v : null;
}
