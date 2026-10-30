import { describe, expect, test } from 'vitest';
import { validateValue, type Value } from '../../src/index.js';
import { compile } from '../helpers.js';

const cfg = compile(`fields:
  t: {type: text, label: T}
  tm: {type: text, label: TM, multiple: true}
  n: {type: number, label: N}
  m: {type: money, label: M}
  d: {type: date, label: D}
  dt: {type: datetime, label: DT}
  b: {type: bool, label: B}
  e: {type: enum, label: E, options: [x, y]}
  em: {type: enum, label: EM, options: [x, y], multiple: true}
  u: {type: user, label: U}
  fm: {type: file, label: FM, multiple: true}
  l: {type: link, label: L, target_sets: [s]}
  calc: {type: formula, label: C, expr: '{n} * 2'}
sets:
  s: {label: S, fields: []}`);

const UUID = '0192f0c4-7a1e-7c3b-9f00-1234567890ab';
const ok = (key: string, v: Value) => expect(validateValue(cfg.fields.get(key)!, v)).toBeNull();
const bad = (key: string, v: Value) => expect(validateValue(cfg.fields.get(key)!, v)).toEqual(expect.any(String));

describe('validateValue', () => {
  test('null is always valid', () => {
    for (const key of ['t', 'n', 'm', 'd', 'dt', 'b', 'e', 'em', 'u', 'fm', 'l', 'calc']) ok(key, null);
  });

  test('text', () => {
    ok('t', 'привет');
    bad('t', 1);
    ok('tm', ['a', 'b']);
    bad('tm', 'a');
  });

  test('number is finite', () => {
    ok('n', 1.5);
    bad('n', '1.5');
    bad('n', Number.NaN);
    bad('n', Number.POSITIVE_INFINITY);
  });

  test('money is {amount: decimal string, currency: 3 capitals}', () => {
    ok('m', { amount: '1.5', currency: 'PLN' });
    ok('m', { amount: '-10', currency: 'EUR' });
    bad('m', 1.5);
    bad('m', { amount: '1,5', currency: 'PLN' });
    bad('m', { amount: '1.5', currency: 'pln' });
  });

  test('date is a real calendar date', () => {
    ok('d', '2026-02-28');
    bad('d', '2026-02-30');
    bad('d', '2026-2-3');
    bad('d', '');
  });

  test('datetime is ISO-8601 UTC with Z', () => {
    ok('dt', '2026-10-30T10:00:00Z');
    ok('dt', '2026-10-30T10:00:00.123Z');
    bad('dt', '2026-10-30T10:00:00+01:00');
    bad('dt', '2026-10-30');
    bad('dt', '2026-02-30T10:00:00Z');
    bad('dt', '2026-10-30T25:00:00Z');
  });

  test('bool', () => {
    ok('b', false);
    bad('b', 'true');
  });

  test('enum: one of options; multiple expects an array of options', () => {
    ok('e', 'x');
    bad('e', 'z');
    bad('e', ['x']);
    ok('em', ['x', 'y']);
    ok('em', []);
    bad('em', 'x');
    bad('em', ['x', 'z']);
  });

  test('user and file are uuids', () => {
    ok('u', UUID);
    bad('u', 'ivan');
    ok('fm', [UUID]);
    bad('fm', UUID);
  });

  test('link values never live in data', () => {
    bad('l', UUID);
  });

  test('formula value must match the inferred type', () => {
    ok('calc', 2);
    bad('calc', 'two');
  });
});
