import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { evaluateRecord, ownedFieldsOf, type RecordState, type Value } from '../../src/index.js';
import { loadConfigDir } from '../../src/node.js';

const repoConfigDir = fileURLToPath(new URL('../../../../config', import.meta.url));
const cfg = await loadConfigDir(repoConfigDir);
const now = new Date('2026-10-31T10:00:00Z');

const run = (data: Record<string, Value>, sets: Record<string, string>) => {
  const state: RecordState = { data: { ...data }, sets: new Map(Object.entries(sets)) };
  return evaluateRecord(cfg, null, state, { now, userChangedKeys: new Set(Object.keys(data)) });
};

describe('starter config (config/)', () => {
  test('workspace and sets', () => {
    expect(cfg.timezone).toBe('Europe/Warsaw');
    expect(cfg.sets.get('task')!.activation).toBe('manual');
    expect(cfg.sets.get('montage')).toMatchObject({ activation: 'rule', requires: ['task'] });
    expect(cfg.sets.get('montage')!.closure).toEqual(expect.arrayContaining(['task', 'montage']));
    expect(cfg.sets.get('montage')!.fields).toEqual(
      expect.arrayContaining(['site_address', 'warranty_months', 'act_file', 'work_cost']));
    expect(cfg.fields.get('kind')).toMatchObject({ type: 'enum', options: ['visit', 'montage', 'supply', 'consult'] });
    expect(cfg.fields.get('work_cost')!.type).toBe('formula');
  });

  test('rules', () => {
    const ids = cfg.rules.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['montage_by_kind', 'act_required_on_done', 'warranty_default']));
    expect(cfg.rules.find((r) => r.id === 'montage_by_kind')!.enable_set).toBe('montage');
    expect(cfg.rules.find((r) => r.id === 'act_required_on_done')!.require).toEqual(['act_file']);
  });

  test('total_hours is a recursive rollup over the hierarchical parent_task', () => {
    expect(cfg.fields.get('parent_task')).toMatchObject({ type: 'link', hierarchical: true, cardinality: 'one' });
    expect(cfg.rollups.find((r) => r.key === 'total_hours')).toMatchObject({
      via: 'parent_task', direction: 'inverse', agg: 'sum',
    });
  });

  test('engine: kind=montage enables montage, default warranty fills in', () => {
    const r = run({ kind: 'montage' }, { task: 'manual' });
    expect(r.state.sets.get('montage')).toBe('rule:montage_by_kind');
    expect(r.state.data.warranty_months).toBe(12);
    expect(r.errors).toEqual([]);
  });

  test('engine: done montage without act_file is rejected, with it is fine', () => {
    expect(run({ kind: 'montage', done: true }, { task: 'manual' }).errors).toContainEqual(
      expect.objectContaining({ code: 'required', field: 'act_file', rule_id: 'act_required_on_done' }));
    const F = '0192f0c4-7a1e-7c3b-9f00-1234567890ab';
    expect(run({ kind: 'montage', done: true, act_file: F }, { task: 'manual' }).errors).toEqual([]);
  });

  test('engine: a visit needs no act', () => {
    expect(run({ kind: 'visit', done: true }, { task: 'manual' }).errors).toEqual([]);
  });

  test('engine: work_cost = hours * rate', () => {
    expect(run({ kind: 'montage', hours: 3, rate: 100 }, { task: 'manual' }).state.data.work_cost).toBe(300);
  });
});

describe('starter config: contacts (contacts.yaml)', () => {
  test('starter config extends roles and renames montage address', () => {
    expect(cfg.fields.get('role')!.options).toContain('жена');
    expect(cfg.sets.get('montage')!.fields).toContain('site_address');
    expect(cfg.sets.get('montage')!.fields).not.toContain('address');
    expect(cfg.fields.get('address')!.system).toBe(true);
  });
});

describe('starter config: rows (finance.yaml)', () => {
  test('task owns expenses and incomes as rows', () => {
    expect(ownedFieldsOf(cfg, ['task'])).toEqual(['expenses', 'incomes']);
    expect(cfg.fields.get('expenses')).toMatchObject({ type: 'link', owned: true, target_sets: ['expense'] });
    expect(cfg.fields.get('incomes')).toMatchObject({ type: 'link', owned: true, target_sets: ['income'] });
    expect(ownedFieldsOf(cfg, ['montage'])).toEqual([]);
  });

  test('row sets and totals', () => {
    expect(cfg.sets.get('expense')!.fields).toEqual(
      expect.arrayContaining(['expense_kind', 'amount', 'expense_date', 'note']));
    expect(cfg.sets.get('expense_transport')).toMatchObject({ activation: 'rule', requires: ['expense'] });
    expect(cfg.sets.get('expense_agent')).toMatchObject({ activation: 'rule', requires: ['expense'] });
    expect(cfg.sets.get('income')!.fields).toEqual(
      expect.arrayContaining(['amount', 'payer_account', 'received_date', 'note']));
    expect(cfg.fields.get('expense_kind')).toMatchObject({
      type: 'enum', options: ['транспортные', 'комплектующие', 'накладные', 'агентские', 'прочие'],
    });
    expect(cfg.rollups.find((r) => r.key === 'expenses_total')).toMatchObject({ via: 'expenses', agg: 'sum' });
    expect(cfg.rollups.find((r) => r.key === 'transport_total')!.filterAst).toBeDefined();
    expect(cfg.fields.get('margin')!.type).toBe('formula');
  });

  test('engine: a transport expense row enables expense_transport', () => {
    const r = run({ expense_kind: 'транспортные', amount: 40 }, { expense: 'manual' });
    expect(r.state.sets.get('expense_transport')).toBe('rule:expense_transport_by_kind');
    expect(r.state.sets.has('expense_agent')).toBe(false);
    expect(r.errors).toEqual([]);
  });

  test('engine: an agent expense row enables expense_agent', () => {
    const r = run({ expense_kind: 'агентские', amount: 10 }, { expense: 'manual' });
    expect(r.state.sets.get('expense_agent')).toBe('rule:expense_agent_by_kind');
    expect(r.state.sets.has('expense_transport')).toBe(false);
  });

  test('engine: margin is a number (incomes_total - expenses_total)', () => {
    const r = run({ incomes_total: 500, expenses_total: 120 }, { task: 'manual' });
    expect(r.state.data.margin).toBe(380);
    expect(typeof r.state.data.margin).toBe('number');
  });
});
