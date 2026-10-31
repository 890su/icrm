import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { evaluateRecord, type RecordState, type Value } from '../../src/index.js';
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
      expect.arrayContaining(['address', 'warranty_months', 'act_file', 'work_cost']));
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
