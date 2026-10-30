import { describe, expect, test } from 'vitest';
import { evaluate, isEmpty, parse, todayIn, type EvalCtx, type Value } from '../../src/index.js';

const ctx = (data: Record<string, Value>, sets: string[] = [], now = new Date('2026-10-30T10:00:00Z')) =>
  ({ get: (k: string) => data[k] ?? null, hasSet: (s: string) => sets.includes(s), now, timezone: 'Europe/Warsaw' });
const ev = (src: string, data: Record<string, Value> = {}, sets: string[] = []) =>
  evaluate(parse(src), ctx(data, sets));
const pln = (amount: string) => ({ amount, currency: 'PLN' });
const eur = (amount: string) => ({ amount, currency: 'EUR' });

describe('expression evaluator', () => {
  test('null propagates through arithmetic; comparison with null is FALSE', () => {
    expect(evaluate(parse('{a} + 1'), ctx({}))).toBeNull();
    expect(evaluate(parse('{a} > 1'), ctx({}))).toBe(false);
    expect(evaluate(parse('{a} = NULL'), ctx({}))).toBe(false);
  });

  test('IS_EMPTY treats whitespace and [] as empty', () => {
    expect(evaluate(parse('IS_EMPTY({a})'), ctx({ a: '  ' }))).toBe(true);
    expect(evaluate(parse('IS_EMPTY({a})'), ctx({ a: [] }))).toBe(true);
    expect(evaluate(parse('IS_EMPTY({a})'), ctx({ a: 0 }))).toBe(false);
  });

  test('money arithmetic is exact', () => {
    expect(evaluate(parse('{a} + {b}'), ctx({ a: { amount: '0.1', currency: 'PLN' }, b: { amount: '0.2', currency: 'PLN' } })))
      .toEqual({ amount: '0.3', currency: 'PLN' });
  });

  test('currency mismatch and division by zero give null', () => {
    expect(evaluate(parse('{a} + {b}'), ctx({ a: { amount: '1', currency: 'PLN' }, b: { amount: '1', currency: 'EUR' } }))).toBeNull();
    expect(evaluate(parse('1 / 0'), ctx({}))).toBeNull();
  });

  test('TODAY uses workspace timezone', () => {
    expect(evaluate(parse('TODAY()'), ctx({}, [], new Date('2026-10-30T23:30:00Z')))).toBe('2026-10-31');
  });

  test('DAYS_BETWEEN and ADD_DAYS', () => {
    expect(evaluate(parse('DAYS_BETWEEN(DATE("2026-10-01"), DATE("2026-10-30"))'), ctx({}))).toBe(29);
    expect(evaluate(parse('ADD_DAYS(DATE("2026-12-31"), 1)'), ctx({}))).toBe('2027-01-01');
  });

  test('AND/OR treat null as false; IF null condition takes else', () => {
    expect(evaluate(parse('{x} OR TRUE'), ctx({}))).toBe(true);
    expect(evaluate(parse('IF({x}, 1, 2)'), ctx({}))).toBe(2);
  });

  test('concat treats empty as ""', () => expect(evaluate(parse('{a} & "-" & {b}'), ctx({ a: 'x' }))).toBe('x-'));

  test('HAS_SET, IN, CONTAINS', () => {
    expect(evaluate(parse('HAS_SET("montage")'), ctx({}, ['montage']))).toBe(true);
    expect(evaluate(parse('IN({k}, "a", "b")'), ctx({ k: 'b' }))).toBe(true);
    expect(evaluate(parse('CONTAINS({t}, "vip")'), ctx({ t: ['vip', 'x'] }))).toBe(true);
  });

  // --- extra coverage beyond the brief ---------------------------------------

  test('isEmpty and todayIn helpers', () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty('')).toBe(true);
    expect(isEmpty(' \t\n')).toBe(true);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty(false)).toBe(false);
    expect(isEmpty([null])).toBe(false);
    expect(isEmpty(pln('0'))).toBe(false);
    expect(todayIn(new Date('2026-10-30T22:59:59Z'), 'Europe/Warsaw')).toBe('2026-10-30');
    expect(todayIn(new Date('2026-10-30T23:00:00Z'), 'Europe/Warsaw')).toBe('2026-10-31');
    expect(todayIn(new Date('2026-10-30T23:00:00Z'), 'UTC')).toBe('2026-10-30');
  });

  test('number arithmetic is decimal-exact', () => {
    expect(ev('0.1 + 0.2')).toBe(0.3);
    expect(ev('{h} * {r}', { h: 1.1, r: 3 })).toBe(3.3);
    expect(ev('7 / 2')).toBe(3.5);
    expect(ev('5 - 8')).toBe(-3);
    expect(ev('-{a}', { a: 4 })).toBe(-4);
    expect(Object.is(ev('-{a}', { a: 0 }), 0)).toBe(true);
    expect(ev('-{a}')).toBeNull();
    expect(ev('{a} * 2', { a: ' ' })).toBeNull();
    expect(ev('{a} * 2', { a: [] })).toBeNull();
  });

  test('non-finite results and wrongly typed data give null', () => {
    expect(ev('{a} * 2', { a: Infinity })).toBeNull();
    expect(ev('{a} + 1', { a: NaN })).toBeNull();
    expect(ev('{a} + 1', { a: 'abc' })).toBeNull();
    expect(ev('{a} + 1', { a: true })).toBeNull();
    expect(ev('{a} + {b}', { a: 1, b: pln('1') })).toBeNull();
    expect(ev('{a} * {a}', { a: 1e200 })).toBeNull(); // overflows a double
  });

  test('money: scaling, subtraction, negation, exponent-free output', () => {
    expect(ev('{a} * 3', { a: pln('10.5') })).toEqual(pln('31.5'));
    expect(ev('3 * {a}', { a: pln('10.5') })).toEqual(pln('31.5'));
    expect(ev('{a} / 4', { a: pln('10') })).toEqual(pln('2.5'));
    expect(ev('{a} / 0', { a: pln('10') })).toBeNull();
    expect(ev('{a} - {b}', { a: pln('0.3'), b: pln('0.1') })).toEqual(pln('0.2'));
    expect(ev('{a} - {a}', { a: pln('1.5') })).toEqual(pln('0'));
    expect(ev('-{a}', { a: pln('2') })).toEqual(pln('-2'));
    expect(ev('-{a}', { a: pln('0') })).toEqual(pln('0'));
    expect(ev('{a} * 1000000000000000000000000', { a: pln('1') })).toEqual(pln('1000000000000000000000000'));
    expect(ev('{a} / 1000000000000000000000000', { a: pln('1') })).toEqual(pln('0.000000000000000000000001'));
    expect(ev('{a} + 1', { a: pln('1') })).toBeNull(); // not type-correct; must not throw
    expect(ev('{a} + {b}', { a: pln('1'), b: null })).toBeNull();
    expect(ev('{a} + {b}', { a: pln('abc'), b: pln('1') })).toBeNull(); // bad amount in data
  });

  test('comparison rules', () => {
    expect(ev('{a} > 1', { a: 2 })).toBe(true);
    expect(ev('{a} <= 1', { a: 2 })).toBe(false);
    expect(ev('{a} = "x"', { a: 'x' })).toBe(true);
    expect(ev('{a} <> "x"', { a: 'y' })).toBe(true);
    expect(ev('{a} < "b"', { a: 'a' })).toBe(true);
    expect(ev('{a} = TRUE', { a: true })).toBe(true);
    expect(ev('{a} = {b}', { a: pln('1.0'), b: pln('1') })).toBe(true);
    expect(ev('{a} < {b}', { a: pln('1'), b: pln('2') })).toBe(true);
    expect(ev('{a} = {b}', { a: ['x'], b: ['x'] })).toBe(true);
    expect(ev('{a} = {b}', { a: ['x'], b: ['y'] })).toBe(false);
    // empty on either side: every comparison is FALSE, including <>
    expect(ev('{a} <> 1')).toBe(false);
    expect(ev('{a} = {b}', { a: '', b: '  ' })).toBe(false);
    expect(ev('{a} < 1', { a: [] })).toBe(false);
    // currency mismatch is a runtime problem -> null
    expect(ev('{a} < {b}', { a: pln('1'), b: eur('2') })).toBeNull();
    expect(ev('{a} = {b}', { a: pln('1'), b: eur('1') })).toBeNull();
  });

  test('date and datetime comparison', () => {
    expect(ev('{d} < TODAY()', { d: '2026-10-29' })).toBe(true);
    expect(ev('{d} < TODAY()', { d: '2026-10-30' })).toBe(false);
    expect(ev('{d} = DATE("2026-10-30")', { d: '2026-10-30' })).toBe(true);
    // datetimes compare by instant, regardless of fractional-seconds formatting
    expect(ev('{a} = {b}', { a: '2026-10-30T10:00:00Z', b: '2026-10-30T10:00:00.000Z' })).toBe(true);
    expect(ev('{a} < {b}', { a: '2026-10-30T10:00:00Z', b: '2026-10-30T10:00:00.500Z' })).toBe(true);
    expect(ev('{a} < NOW()', { a: '2026-10-30T09:59:59Z' })).toBe(true);
  });

  test('NOW is ISO UTC', () => {
    expect(ev('NOW()')).toBe('2026-10-30T10:00:00.000Z');
  });

  test('IF picks the right branch', () => {
    expect(ev('IF({x}, 1, 2)', { x: true })).toBe(1);
    expect(ev('IF({x} > 1, "big", "small")', { x: 5 })).toBe('big');
    expect(ev('IF(TRUE, NULL, 2)')).toBeNull();
  });

  test('AND / OR / NOT', () => {
    expect(ev('{x} AND TRUE')).toBe(false);
    expect(ev('TRUE AND TRUE')).toBe(true);
    expect(ev('FALSE OR {x}')).toBe(false);
    expect(ev('AND(TRUE, TRUE, {x})')).toBe(false);
    expect(ev('AND(TRUE, TRUE, TRUE)')).toBe(true);
    expect(ev('OR(FALSE, {x}, TRUE)')).toBe(true);
    expect(ev('NOT(TRUE)')).toBe(false);
    expect(ev('NOT({x})')).toBe(true);
    expect(ev('NOT({a} > 1)')).toBe(true);
  });

  test('& and CONCAT stringify values', () => {
    expect(ev('{a} & {b}', { a: '  ', b: 'x' })).toBe('x');
    expect(ev('"n=" & {n}', { n: 1.5 })).toBe('n=1.5');
    expect(ev('"n=" & {n}', { n: 1e21 })).toBe('n=1000000000000000000000');
    expect(ev('"n=" & {n}', { n: 1e-7 })).toBe('n=0.0000001');
    expect(ev('{p} & ""', { p: pln('10.50') })).toBe('10.50 PLN');
    expect(ev('{l} & ""', { l: ['a', 'b'] })).toBe('a, b');
    expect(ev('{b} & ""', { b: true })).toBe('TRUE');
    expect(ev('CONCAT({a}, "-", {b}, "-", 3)', { a: 'x' })).toBe('x--3');
  });

  test('IN', () => {
    expect(ev('IN({k}, "a", "b")', { k: 'c' })).toBe(false);
    expect(ev('IN({k}, "a", "b")')).toBe(false);
    expect(ev('IN({n}, 1, 2, 3)', { n: 3 })).toBe(true);
    expect(ev('IN({k}, "a", {z})', { k: '' })).toBe(false);
  });

  test('CONTAINS', () => {
    expect(ev('CONTAINS({t}, "mon")', { t: 'montage' })).toBe(true);
    expect(ev('CONTAINS({t}, "xyz")', { t: 'montage' })).toBe(false);
    // text containment is case-insensitive, including Cyrillic; list containment stays exact
    expect(ev('CONTAINS("Камера склад", "кам")')).toBe(true);
    expect(ev('CONTAINS({t}, "СКЛАД")', { t: 'Камера склад' })).toBe(true);
    expect(ev('CONTAINS({t}, "MON")', { t: 'montage' })).toBe(true);
    expect(ev('CONTAINS({t}, "VIP")', { t: ['vip'] })).toBe(false);
    expect(ev('CONTAINS({t}, "x")', { t: ['vip'] })).toBe(false);
    expect(ev('CONTAINS({t}, "x")')).toBe(false);
    expect(ev('CONTAINS({t}, {x})', { t: 'abc' })).toBe(false);
    expect(ev('CONTAINS({t}, 2)', { t: [1, 2] })).toBe(true);
  });

  test('HAS_SET false when absent', () => expect(ev('HAS_SET("montage")')).toBe(false));

  test('DAYS_BETWEEN: sign, datetimes, bad input', () => {
    expect(ev('DAYS_BETWEEN(DATE("2026-10-30"), DATE("2026-10-01"))')).toBe(-29);
    expect(ev('DAYS_BETWEEN({d}, TODAY())', { d: '2026-10-20' })).toBe(10);
    // datetimes are reduced to workspace-local dates: 23:30Z on the 30th is already the 31st in Warsaw
    expect(ev('DAYS_BETWEEN({a}, {b})', { a: '2026-10-30T10:00:00Z', b: '2026-10-30T23:30:00Z' })).toBe(1);
    expect(ev('DAYS_BETWEEN(DATE("2026-03-28"), DATE("2026-03-30"))')).toBe(2); // across DST change
    expect(ev('DAYS_BETWEEN({a}, TODAY())')).toBeNull();
    expect(ev('DAYS_BETWEEN({a}, TODAY())', { a: 'garbage' })).toBeNull();
    expect(ev('DAYS_BETWEEN({a}, TODAY())', { a: '2026-02-30' })).toBeNull();
  });

  test('ADD_DAYS: negative, month ends, leap day, bad input', () => {
    expect(ev('ADD_DAYS(DATE("2026-03-01"), -1)')).toBe('2026-02-28');
    expect(ev('ADD_DAYS(DATE("2028-02-28"), 1)')).toBe('2028-02-29');
    expect(ev('ADD_DAYS({d}, 1)')).toBeNull();
    expect(ev('ADD_DAYS({d}, {n})', { d: '2026-01-01' })).toBeNull();
    expect(ev('ADD_DAYS({d}, 1)', { d: 'nope' })).toBeNull();
    expect(ev('ADD_DAYS({d}, 1.9)', { d: '2026-01-01' })).toBe('2026-01-02');
    expect(ev('ADD_DAYS({d}, 99999999999)', { d: '2026-01-01' })).toBeNull(); // out of range
  });

  test('ROUND: half away from zero, digits, negative digits', () => {
    expect(ev('ROUND({n})', { n: 2.5 })).toBe(3);
    expect(ev('ROUND({n})', { n: -2.5 })).toBe(-3);
    expect(ev('ROUND({n}, 2)', { n: 1.005 })).toBe(1.01);
    expect(ev('ROUND({n}, 1)', { n: 1.25 })).toBe(1.3);
    expect(ev('ROUND({n}, -2)', { n: 1250 })).toBe(1300);
    expect(ev('ROUND({n}, 0)', { n: 0.4 })).toBe(0);
    expect(ev('ROUND({n})')).toBeNull();
    expect(ev('ROUND({n}, {d})', { n: 1.5 })).toBeNull();
  });

  test('MIN / MAX: skip empty, money, dates, datetimes', () => {
    expect(ev('MIN(3, 1, 2)')).toBe(1);
    expect(ev('MAX(3, 1, 2)')).toBe(3);
    expect(ev('MIN({a}, 5)')).toBe(5);
    expect(ev('MAX({a}, {b})')).toBeNull();
    expect(ev('MAX({a}, {b})', { a: pln('1'), b: pln('2.5') })).toEqual(pln('2.5'));
    expect(ev('MIN({a}, {b})', { a: pln('1'), b: eur('2') })).toBeNull();
    expect(ev('MAX({a}, TODAY())', { a: '2026-12-01' })).toBe('2026-12-01');
    expect(ev('MIN({a}, TODAY())', { a: '2026-12-01' })).toBe('2026-10-30');
    expect(ev('MAX({a}, {b})', { a: '2026-10-30T10:00:00Z', b: '2026-10-30T10:00:01Z' })).toBe('2026-10-30T10:00:01Z');
    expect(ev('MIN({a}, {b})', { a: '2026-10-30T10:00:00.500Z', b: '2026-10-30T10:00:00Z' })).toBe('2026-10-30T10:00:00Z');
  });

  test('LEN', () => {
    expect(ev('LEN({t})', { t: 'abc' })).toBe(3);
    expect(ev('LEN({t})', { t: ['a', 'b'] })).toBe(2);
    expect(ev('LEN({t})')).toBe(0);
    expect(ev('LEN({t})', { t: '   ' })).toBe(0);
  });

  test('COALESCE', () => {
    expect(ev('COALESCE({a}, {b}, 7)', { b: 3 })).toBe(3);
    expect(ev('COALESCE({a}, "", 7)')).toBe(7);
    expect(ev('COALESCE({a}, 0)')).toBe(0);
    expect(ev('COALESCE({a}, {b})')).toBeNull();
  });

  test('DATE', () => {
    expect(ev('DATE("2026-10-30")')).toBe('2026-10-30');
  });

  test('evaluate never throws on data', () => {
    const throwing: EvalCtx = {
      get: () => { throw new Error('boom'); },
      hasSet: () => { throw new Error('boom'); },
      now: new Date('2026-10-30T10:00:00Z'),
      timezone: 'Europe/Warsaw',
    };
    expect(evaluate(parse('{a} + 1'), throwing)).toBeNull();
    expect(evaluate(parse('HAS_SET("x")'), throwing)).toBeNull();
    expect(evaluate(parse('COALESCE({a}, 1)'), throwing)).toBe(1);
    const badTz = { ...throwing, get: () => null, timezone: 'Not/AZone' };
    expect(evaluate(parse('TODAY()'), badTz)).toBeNull();
    expect(evaluate(parse('1 + 1'), badTz)).toBe(2);
    expect(evaluate(parse('{a}'), { ...badTz, now: new Date(NaN) })).toBeNull();
    expect(evaluate(parse('NOW()'), { ...badTz, now: new Date(NaN) })).toBeNull();
    expect(ev('FROBNICATE(1)')).toBeNull(); // unknown function: not type-checked, still no throw
  });
});
