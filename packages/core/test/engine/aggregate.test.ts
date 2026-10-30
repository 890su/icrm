import { describe, expect, test } from 'vitest';
import { computeRollup, type CompiledRollup, type Money, type RelatedRecord, type Value } from '../../src/index.js';
import { compile, fixture } from '../helpers.js';

const cfg = compile(fixture('rollups'));
const now = new Date('2026-10-30T10:00:00Z');

const roll = (key: string): CompiledRollup => {
  const r = cfg.rollups.find((x) => x.key === key);
  if (r === undefined) throw new Error(`no rollup ${key}`);
  return r;
};
const m = (amount: string, currency = 'PLN'): Money => ({ amount, currency });
const rec = (data: Record<string, Value>, sets: string[] = []): RelatedRecord =>
  ({ id: 'r', data, sets: new Set(sets) });
const calc = (key: string, related: RelatedRecord[]): Value => computeRollup(cfg, roll(key), related, now);

describe('computeRollup', () => {
  test('sum skips nulls; empty set gives 0', () => {
    expect(calc('sum_hours', [rec({ hours: 2 }), rec({ hours: null }), rec({ hours: 3 })])).toBe(5);
    expect(calc('sum_hours', [])).toBe(0);
    expect(calc('sum_hours', [rec({}), rec({ hours: null })])).toBe(0);
  });

  test('number sum is exact', () => {
    expect(calc('sum_hours', [rec({ hours: 0.1 }), rec({ hours: 0.2 })])).toBe(0.3);
  });

  test('money sum exact, mixed currency gives null', () => {
    expect(calc('sum_cost', [rec({ cost: m('0.1') }), rec({ cost: m('0.2') })])).toEqual(m('0.3'));
    expect(calc('sum_cost', [rec({ cost: m('1') }), rec({ cost: m('1', 'EUR') })])).toBeNull();
    expect(calc('sum_cost', [rec({ cost: m('5') })])).toEqual(m('5'));
    expect(calc('sum_cost', [rec({ cost: m('5') }), rec({})])).toEqual(m('5'));
  });

  test('money sum over nothing has no currency to report: null', () => {
    expect(calc('sum_cost', [])).toBeNull();
    expect(calc('sum_cost', [rec({})])).toBeNull();
  });

  test('filter applied to related record', () => {
    expect(calc('open_count', [rec({ done: true }), rec({ done: false }), rec({})])).toBe(2);
    expect(calc('open_count', [])).toBe(0);
  });

  test('filter reads the related record sets', () => {
    expect(calc('urgent_hours', [
      rec({ hours: 1 }, ['urgent']), rec({ hours: 10 }), rec({ hours: 2 }, ['urgent']),
    ])).toBe(3);
  });

  test('empty-set semantics', () => {
    expect(calc('all_done', [])).toBe(true);
    expect(calc('any_done', [])).toBe(false);
    expect(calc('names', [])).toEqual([]);
    expect(calc('org_addr', [])).toBeNull();
    expect(calc('min_hours', [])).toBeNull();
    expect(calc('max_done_at', [])).toBeNull();
    expect(calc('avg_hours', [])).toBeNull();
    expect(calc('avg_cost', [])).toBeNull();
  });

  test('all / any: only exactly true counts, null is not true', () => {
    expect(calc('all_done', [rec({ done: true }), rec({ done: true })])).toBe(true);
    expect(calc('all_done', [rec({ done: true }), rec({ done: null })])).toBe(false);
    expect(calc('all_done', [rec({ done: true }), rec({})])).toBe(false);
    expect(calc('any_done', [rec({ done: false }), rec({})])).toBe(false);
    expect(calc('any_done', [rec({ done: false }), rec({ done: true })])).toBe(true);
  });

  test('list and first skip empty values and keep order', () => {
    const related = [rec({ name: 'b' }), rec({ name: '  ' }), rec({ name: null }), rec({ name: 'a' }), rec({})];
    expect(calc('names', related)).toEqual(['b', 'a']);
    expect(calc('org_addr', [rec({ addr: null }), rec({ addr: '' }), rec({ addr: 'Kraków' }), rec({ addr: 'Łódź' })]))
      .toBe('Kraków');
  });

  test('min/max on numbers and datetimes', () => {
    expect(calc('min_hours', [rec({ hours: 4 }), rec({ hours: null }), rec({ hours: 1.5 }), rec({ hours: 3 })])).toBe(1.5);
    expect(calc('max_done_at', [
      rec({ done_at: '2026-10-01T10:00:00Z' }), rec({ done_at: '2026-10-05T10:00:00Z' }), rec({ done_at: null }),
    ])).toBe('2026-10-05T10:00:00Z');
  });

  test('avg is exact: number and money', () => {
    expect(calc('avg_hours', [rec({ hours: 1 }), rec({ hours: 2 }), rec({ hours: null })])).toBe(1.5);
    expect(calc('avg_hours', [rec({ hours: 0.1 }), rec({ hours: 0.2 })])).toBe(0.15);
    expect(calc('avg_cost', [rec({ cost: m('1') }), rec({ cost: m('2') }), rec({})])).toEqual(m('1.5'));
    expect(calc('avg_cost', [rec({ cost: m('1') }), rec({ cost: m('1', 'EUR') })])).toBeNull();
  });
});
