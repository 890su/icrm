import { describe, expect, test } from 'vitest';
import { ExprSyntaxError, parse } from '../../src/index.js';

describe('expression parser', () => {
  test('precedence', () => {
    expect(parse('1 + 2 * 3')).toMatchObject({ k: 'bin', op: '+', r: { k: 'bin', op: '*' } });
  });

  test('field refs and strings', () => {
    expect(parse('{kind} = "montage"')).toMatchObject({
      k: 'bin', op: '=', l: { k: 'field', key: 'kind' }, r: { k: 'str', v: 'montage' },
    });
  });

  test('infix AND binds weaker than comparison', () => {
    expect(parse('{done} AND HAS_SET("montage")')).toMatchObject({
      k: 'bin', op: 'AND', r: { k: 'call', fn: 'HAS_SET' },
    });
  });

  test('russian aliases are canonicalized, case-insensitive', () => {
    expect(parse('если({a} > 1; "x"; "y")')).toMatchObject({ k: 'call', fn: 'IF', args: [{}, {}, {}] });
    expect(parse('{a} И {b}')).toMatchObject({ k: 'bin', op: 'AND' });
  });

  test('function-form AND with many args', () => {
    expect(parse('AND({a}, {b}, {c})')).toMatchObject({ k: 'call', fn: 'AND', args: [{}, {}, {}] });
  });

  test('TRUE/FALSE/NULL literals; unary minus; & concat', () => {
    expect(parse('-{x}')).toMatchObject({ k: 'neg' });
    expect(parse('{a} & "b"')).toMatchObject({ k: 'bin', op: '&' });
    expect(parse('TRUE')).toMatchObject({ k: 'bool', v: true });
  });

  test('syntax error carries position', () => {
    expect(() => parse('1 + * 2')).toThrow(ExprSyntaxError);
    try { parse('1 + * 2'); } catch (e) { expect((e as ExprSyntaxError).pos.start).toBe(4); }
  });

  test('decimal comma is a syntax error with hint', () => {
    expect(() => parse('1,5 + 1')).toThrow(/десятичн/);
  });

  // Extra coverage beyond the brief: associativity, grouping, literals, errors.
  test('OR < AND < comparison < & < additive < multiplicative < unary minus', () => {
    expect(parse('{a} OR {b} AND {c} = 1')).toMatchObject({
      op: 'OR', r: { op: 'AND', r: { op: '=' } },
    });
    expect(parse('"a" & 1 + 2')).toMatchObject({ op: '&', r: { op: '+' } });
    expect(parse('-2 * 3')).toMatchObject({ k: 'bin', op: '*', l: { k: 'neg', e: { k: 'num', v: 2 } } });
  });

  test('binary operators are left-associative; parentheses override', () => {
    expect(parse('10 - 3 - 2')).toMatchObject({ op: '-', l: { op: '-' }, r: { v: 2 } });
    expect(parse('(1 + 2) * 3')).toMatchObject({ op: '*', l: { op: '+' } });
  });

  test('numbers, escaped quotes, empty call, semicolon separator, russian literals', () => {
    expect(parse('1.25')).toMatchObject({ k: 'num', v: 1.25 });
    expect(parse('"say ""hi"""')).toMatchObject({ k: 'str', v: 'say "hi"' });
    expect(parse('TODAY()')).toMatchObject({ k: 'call', fn: 'TODAY', args: [] });
    expect(parse('сегодня()')).toMatchObject({ k: 'call', fn: 'TODAY' });
    expect(parse('ЕСТЬ_НАБОР("x")')).toMatchObject({ k: 'call', fn: 'HAS_SET' });
    expect(parse('ИСТИНА')).toMatchObject({ k: 'bool', v: true });
    expect(parse('null')).toMatchObject({ k: 'null' });
    expect(parse('НЕ({a})')).toMatchObject({ k: 'call', fn: 'NOT', args: [{}] });
  });

  test('positions span the node', () => {
    expect(parse('{a} + 12')).toMatchObject({ start: 0, end: 8, l: { start: 0, end: 3 }, r: { start: 6, end: 8 } });
  });

  test('malformed input is rejected with a position', () => {
    for (const src of ['', '1 +', '(1', '1 2', 'foo', 'IF(1,)', '"abc', '{a', '{}', '1 # 2']) {
      expect(() => parse(src), src).toThrow(ExprSyntaxError);
    }
    try { parse('1,5'); } catch (e) { expect((e as ExprSyntaxError).pos).toEqual({ start: 1, end: 2 }); }
  });
});
