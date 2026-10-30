import { describe, expect, test } from 'vitest';
import {
  ExprTypeError, FUNCTIONS, fieldRefs, parse, setRefs, typecheck, usesClock,
  type ExprType, type TypeEnv,
} from '../../src/index.js';

function mkEnv(fields: Record<string, ExprType>, sets: string[] = []): TypeEnv {
  return {
    fieldType: (key) => fields[key],
    hasSet: (key) => sets.includes(key),
  };
}

const env = mkEnv(
  { hours: 'number', rate: 'number', due_date: 'date', done: 'bool', kind: 'text', cost: 'money', tags: { list: 'text' } },
  ['montage'],
);
const tc = (src: string) => typecheck(parse(src), env);

describe('expression typechecker', () => {
  test('arithmetic', () => expect(typecheck(parse('{hours} * {rate}'), env)).toBe('number'));
  test('money * number = money', () => expect(typecheck(parse('{cost} * 2'), env)).toBe('money'));
  test('money + number is error', () => expect(() => typecheck(parse('{cost} + 1'), env)).toThrow(ExprTypeError));

  test('IF branches unify; null unifies with anything', () => {
    expect(typecheck(parse('IF({done}, "a", "b")'), env)).toBe('text');
    expect(typecheck(parse('IF({done}, {hours}, NULL)'), env)).toBe('number');
    expect(() => typecheck(parse('IF({done}, 1, "b")'), env)).toThrow(/ветк/);
  });

  test('comparison yields bool; date vs text is error', () => {
    expect(typecheck(parse('{due_date} < TODAY()'), env)).toBe('bool');
    expect(() => typecheck(parse('{due_date} < "x"'), env)).toThrow(ExprTypeError);
  });

  test('unknown field and unknown set are errors with position', () => {
    expect(() => typecheck(parse('{nope} + 1'), env)).toThrow(/nope/);
    expect(() => typecheck(parse('HAS_SET("ghost")'), env)).toThrow(/ghost/);
    expect.assertions(4);
    try { tc('1 + {nope}'); } catch (e) {
      expect(e).toBeInstanceOf(ExprTypeError);
      expect((e as ExprTypeError).pos).toEqual({ start: 4, end: 10 });
    }
  });

  test('HAS_SET needs string literal', () => expect(() => typecheck(parse('HAS_SET({kind})'), env)).toThrow());

  test('CONTAINS on list and text', () => {
    expect(typecheck(parse('CONTAINS({tags}, "vip")'), env)).toBe('bool');
    expect(typecheck(parse('CONTAINS({kind}, "mon")'), env)).toBe('bool');
  });

  test('refs', () => {
    const e = parse('IF(HAS_SET("montage"), {hours} * {rate}, DAYS_BETWEEN({due_date}, TODAY()))');
    expect([...fieldRefs(e)].sort()).toEqual(['due_date', 'hours', 'rate']);
    expect([...setRefs(e)]).toEqual(['montage']);
    expect(usesClock(e)).toBe(true);
  });

  // Extra coverage beyond the brief.
  test('operators: arithmetic matrix', () => {
    expect(tc('{cost} + {cost}')).toBe('money');
    expect(tc('{cost} - {cost}')).toBe('money');
    expect(tc('{cost} / 2')).toBe('money');
    expect(tc('2 * {cost}')).toBe('money');
    expect(tc('-{cost}')).toBe('money');
    expect(tc('-{hours}')).toBe('number');
    expect(tc('{hours} / {rate}')).toBe('number');
    expect(() => tc('{cost} * {cost}')).toThrow(ExprTypeError);
    expect(() => tc('{cost} / {cost}')).toThrow(ExprTypeError);
    expect(() => tc('2 / {cost}')).toThrow(ExprTypeError);
    expect(() => tc('{kind} + 1')).toThrow(ExprTypeError);
    expect(() => tc('-{kind}')).toThrow(ExprTypeError);
  });

  test('date - date is forbidden, DAYS_BETWEEN is the way', () => {
    expect(() => tc('{due_date} - TODAY()')).toThrow(ExprTypeError);
    expect(() => tc('{due_date} + 1')).toThrow(ExprTypeError);
    expect(tc('DAYS_BETWEEN({due_date}, NOW())')).toBe('number');
    expect(tc('ADD_DAYS({due_date}, 3)')).toBe('date');
    expect(() => tc('ADD_DAYS(NOW(), 3)')).toThrow(ExprTypeError);
  });

  test('& accepts anything and yields text', () => {
    expect(tc('{hours} & {due_date} & {tags}')).toBe('text');
  });

  test('= and <> require equal types, ordering needs ordered types', () => {
    expect(tc('{kind} = "a"')).toBe('bool');
    expect(tc('{hours} <> NULL')).toBe('bool');
    expect(tc('{cost} >= {cost}')).toBe('bool');
    expect(() => tc('{hours} = "a"')).toThrow(ExprTypeError);
    expect(() => tc('{done} < {done}')).toThrow(ExprTypeError);
    expect(() => tc('{tags} < {tags}')).toThrow(ExprTypeError);
  });

  test('AND / OR: infix and function form need bool', () => {
    expect(tc('{done} AND {hours} > 1')).toBe('bool');
    expect(tc('AND({done}, {done}, {done})')).toBe('bool');
    expect(tc('OR({done}, TRUE)')).toBe('bool');
    expect(tc('NOT({done})')).toBe('bool');
    expect(() => tc('{done} AND {hours}')).toThrow(ExprTypeError);
    expect(() => tc('NOT({hours})')).toThrow(ExprTypeError);
    expect(() => tc('IF({hours}, 1, 2)')).toThrow(ExprTypeError);
  });

  test('IS_EMPTY, IN, LEN, CONCAT, COALESCE, ROUND, DATE', () => {
    expect(tc('IS_EMPTY({tags})')).toBe('bool');
    expect(tc('IN({kind}, "a", "b")')).toBe('bool');
    expect(() => tc('IN({kind}, "a", 1)')).toThrow(ExprTypeError);
    expect(tc('LEN({kind})')).toBe('number');
    expect(tc('LEN({tags})')).toBe('number');
    expect(() => tc('LEN({hours})')).toThrow(ExprTypeError);
    expect(tc('CONCAT({hours}, "x", {due_date})')).toBe('text');
    expect(tc('COALESCE({hours}, NULL, 0)')).toBe('number');
    expect(() => tc('COALESCE({hours}, "x")')).toThrow(ExprTypeError);
    expect(tc('ROUND({hours})')).toBe('number');
    expect(tc('ROUND({hours}, 2)')).toBe('number');
    expect(() => tc('ROUND({cost})')).toThrow(ExprTypeError);
    expect(tc('DATE("2026-10-30")')).toBe('date');
    expect(() => tc('DATE({kind})')).toThrow(ExprTypeError);
    expect(() => tc('DATE("2026-13-40")')).toThrow(ExprTypeError);
    expect(() => tc('DATE("tomorrow")')).toThrow(ExprTypeError);
  });

  test('MIN / MAX keep the operand type', () => {
    expect(tc('MIN({hours}, {rate}, 3)')).toBe('number');
    expect(tc('MAX({cost}, {cost})')).toBe('money');
    expect(tc('MAX({due_date}, TODAY())')).toBe('date');
    expect(() => tc('MIN({hours}, {cost})')).toThrow(ExprTypeError);
    expect(() => tc('MIN({kind}, "a")')).toThrow(ExprTypeError);
  });

  test('CONTAINS element type must match', () => {
    expect(() => tc('CONTAINS({tags}, 1)')).toThrow(ExprTypeError);
    expect(() => tc('CONTAINS({hours}, 1)')).toThrow(ExprTypeError);
    expect(() => tc('CONTAINS({kind}, 1)')).toThrow(ExprTypeError);
  });

  test('arity and unknown function', () => {
    expect(() => tc('IF({done}, 1)')).toThrow(ExprTypeError);
    expect(() => tc('TODAY(1)')).toThrow(ExprTypeError);
    expect(() => tc('NOT()')).toThrow(ExprTypeError);
    expect(() => tc('FROBNICATE(1)')).toThrow(/FROBNICATE/);
  });

  test('registry covers all functions of the spec and has impl', () => {
    expect([...FUNCTIONS.keys()].sort()).toEqual([
      'ADD_DAYS', 'AND', 'COALESCE', 'CONCAT', 'CONTAINS', 'DATE', 'DAYS_BETWEEN', 'HAS_SET', 'IF', 'IN',
      'IS_EMPTY', 'LEN', 'MAX', 'MIN', 'NOT', 'NOW', 'OR', 'ROUND', 'TODAY',
    ]);
    for (const [name, spec] of FUNCTIONS) {
      expect(spec.name).toBe(name);
      expect(typeof spec.impl).toBe('function');
    }
  });

  test('refs: no clock, nested, duplicates collapse', () => {
    const e = parse('{a} + {a} * IF(HAS_SET("x"), {b}, 0) + COALESCE({c}, 1)');
    expect([...fieldRefs(e)].sort()).toEqual(['a', 'b', 'c']);
    expect([...setRefs(e)]).toEqual(['x']);
    expect(usesClock(e)).toBe(false);
    expect(usesClock(parse('-NOW()'))).toBe(true);
  });
});
