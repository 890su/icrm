import { describe, expect, test } from 'vitest';
import { evaluateRecord, fieldStatesOf, type RecordState, type Value } from '../../src/index.js';
import { compile, fixture } from '../helpers.js';

const cfg = compile(fixture('montage'));
const oscCfg = compile(fixture('oscillation'));
const now = new Date('2026-10-30T10:00:00Z');
const F = '0192f0c4-7a1e-7c3b-9f00-1234567890ab';

type Data = Record<string, Value>;
type Sets = Record<string, string>;

const plain = (data: Data, sets: Sets): RecordState => ({ data: { ...data }, sets: new Map(Object.entries(sets)) });

/** A record as saved: `data` + `sets` stabilized under the montage config. */
const stateOf = (data: Data, sets: Sets = { task: 'manual' }): RecordState =>
  evaluateRecord(cfg, null, plain(data, sets), { now, userChangedKeys: new Set() }).state;

const withData = (s: RecordState, patch: Data): RecordState => ({ data: { ...s.data, ...patch }, sets: new Map(s.sets) });

/** Create: every given key counts as typed by the user. */
const run = (data: Data, sets: Sets) =>
  evaluateRecord(cfg, null, plain(data, sets), { now, userChangedKeys: new Set(Object.keys(data)) });

/** Update of a saved state with a user patch. */
const runFrom = (prev: RecordState, patch: Data) =>
  evaluateRecord(cfg, prev, withData(prev, patch), { now, userChangedKeys: new Set(Object.keys(patch)) });

describe('evaluateRecord: brief cases', () => {
  test('rule enables set with closure and marks enabledBy', () => {
    const r = run({ kind: 'montage' }, { task: 'manual' });
    expect(r.state.sets.get('montage')).toBe('rule:montage_by_kind');
  });

  test('rule-enabled set is disabled when condition flips; data kept', () => {
    const r1 = run({ kind: 'montage', address: 'Kraków' }, { task: 'manual' });
    const r2 = runFrom(r1.state, { kind: 'visit' });
    expect(r2.state.sets.has('montage')).toBe(false);
    expect(r2.state.data.address).toBe('Kraków');
  });

  test('manually enabled set survives false condition', () => {
    expect(run({ kind: 'visit' }, { task: 'manual', montage: 'manual' }).state.sets.get('montage')).toBe('manual');
  });

  test('default fills only empty field', () => {
    expect(run({ kind: 'montage' }, { task: 'manual' }).state.data.warranty_months).toBe(12);
    expect(run({ kind: 'montage', warranty_months: 24 }, { task: 'manual' }).state.data.warranty_months).toBe(24);
  });

  test('required on new state', () => {
    expect(run({ kind: 'montage', done: true }, { task: 'manual' }).errors).toContainEqual(
      expect.objectContaining({ code: 'required', field: 'act_file', rule_id: 'act_required_on_done' }));
  });

  test('whitespace does not satisfy required', () => {
    expect(run({ kind: 'montage', done: true, act_file: '   ' }, { task: 'manual' }).errors.map((e) => e.code))
      .toContain('required');
  });

  test('readonly judged by previous state', () => {
    const prev = stateOf({ kind: 'montage', done: true, act_file: F, work_cost: 1 });
    const r = evaluateRecord(cfg, prev, withData(prev, { work_cost: 2 }), { now, userChangedKeys: new Set(['work_cost']) });
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'readonly', field: 'work_cost' }));
    const prevOpen = stateOf({ kind: 'montage', done: false, work_cost: 1 });
    expect(evaluateRecord(cfg, prevOpen, withData(prevOpen, { done: true, act_file: F, work_cost: 2 }),
      { now, userChangedKeys: new Set(['done', 'act_file', 'work_cost']) }).errors).toEqual([]);
  });

  test('validate message', () => {
    expect(run({ start: '2026-10-30', end: '2026-10-01' }, { task: 'manual' }).errors).toContainEqual(
      expect.objectContaining({ code: 'validation', rule_id: 'dates_order', message: 'Конец раньше начала' }));
  });

  test('formulas only for fields of enabled sets', () => {
    const r = run({ hours: 2, rate: 10 }, { contact: 'manual' }); // work_cost/labor_cost в наборе montage, не включён
    expect(r.state.data.work_cost).toBeUndefined();
    expect(r.state.data.labor_cost).toBeUndefined();
  });

  test('show-target hidden until rule active', () => {
    expect(run({ payment: 'cash' }, { task: 'manual' }).fieldStates.get('invoice_no')!.visible).toBe(false);
    expect(run({ payment: 'transfer' }, { task: 'manual' }).fieldStates.get('invoice_no')!.visible).toBe(true);
  });

  test('oscillating rules rejected naming the rules', () => {
    const r = evaluateRecord(oscCfg, null, stateOf({}, { base: 'manual' }), { now, userChangedKeys: new Set() });
    expect(r.errors).toContainEqual(expect.objectContaining({
      code: 'oscillation', message: expect.stringMatching(/r_on.*r_off|r_off.*r_on/) }));
  });

  test('invalid value checked only for user-changed keys', () => {
    const prev = stateOf({ kind: 'removed_option', notes: 'a' });
    expect(evaluateRecord(cfg, prev, withData(prev, { notes: 'b' }), { now, userChangedKeys: new Set(['notes']) }).errors)
      .toEqual([]);
    expect(evaluateRecord(cfg, prev, withData(prev, { kind: 'bogus' }), { now, userChangedKeys: new Set(['kind']) }).errors
      .map((e) => e.code)).toContain('invalid_option');
  });
});

describe('evaluateRecord: stabilization', () => {
  test('formula of an enabled set is computed, also when its set is enabled by a rule in the same save', () => {
    const r = run({ kind: 'montage', hours: 2, rate: 10 }, { task: 'manual' });
    expect(r.state.data.labor_cost).toBe(20);
    expect(r.errors).toEqual([]);
  });

  test('closure of a rule-enabled set is enabled by the same rule; manual sets are not relabelled', () => {
    const r = run({ kind: 'montage' }, {});
    expect(Object.fromEntries(r.state.sets)).toEqual({ montage: 'rule:montage_by_kind', task: 'rule:montage_by_kind' });
    expect(run({ kind: 'montage' }, { task: 'manual' }).state.sets.get('task')).toBe('manual');
  });

  test('rule set stays while it is in the closure of a remaining set', () => {
    const saved = stateOf({ kind: 'montage' }, { montage: 'manual' });
    expect(saved.sets.get('task')).toBe('rule:montage_by_kind');
    const r = runFrom(saved, { kind: 'visit' });
    expect(Object.fromEntries(r.state.sets)).toEqual({ montage: 'manual', task: 'rule:montage_by_kind' });
  });

  test('oscillation returns the last state reached and names each rule', () => {
    const r = evaluateRecord(oscCfg, null, plain({}, { base: 'manual' }), { now, userChangedKeys: new Set() });
    expect(r.errors.filter((e) => e.code === 'oscillation').map((e) => e.rule_id)).toEqual(['r_on', 'r_off']);
    expect(r.state.sets.get('base')).toBe('manual');
  });

  test('stable result reports the active rules', () => {
    expect(run({ kind: 'montage', done: true, act_file: F }, { task: 'manual' }).activeRules)
      .toEqual(['montage_by_kind', 'act_required_on_done', 'warranty_default']);
  });

  test('inputs are not mutated', () => {
    const next = plain({ kind: 'montage' }, { task: 'manual' });
    evaluateRecord(cfg, null, next, { now, userChangedKeys: new Set(['kind']) });
    expect(next.data).toEqual({ kind: 'montage' });
    expect([...next.sets.keys()]).toEqual(['task']);
  });
});

describe('evaluateRecord: changedKeys', () => {
  test('create: every non-empty key of the final data, formulas and defaults included', () => {
    const r = run({ kind: 'montage', hours: 2, rate: 10, notes: '  ' }, { task: 'manual' });
    expect([...r.changedKeys].sort()).toEqual(['hours', 'kind', 'labor_cost', 'rate', 'warranty_months']);
  });

  test('update: keys whose value differs from prev, computed ones included', () => {
    const prev = stateOf({ kind: 'montage', hours: 2, rate: 10, payment: 'cash' });
    const r = runFrom(prev, { hours: 3, payment: 'cash', notes: null });
    expect([...r.changedKeys].sort()).toEqual(['hours', 'labor_cost']);
  });
});

describe('evaluateRecord: errors', () => {
  test('no readonly errors on create', () => {
    expect(run({ kind: 'montage', done: true, act_file: F, work_cost: 5 }, { task: 'manual' }).errors).toEqual([]);
  });

  test('unknown key and user-written computed field are rejected', () => {
    const r = run({ kind: 'montage', bogus_key: 1, labor_cost: 5 }, { task: 'manual' });
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'unknown_field', field: 'bogus_key' }));
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'invalid_value', field: 'labor_cost' }));
  });

  test('wrong format is invalid_value', () => {
    expect(run({ hours: 'два' }, { task: 'manual' }).errors)
      .toEqual([expect.objectContaining({ code: 'invalid_value', field: 'hours' })]);
  });

  test('rule options restrict the field options; a value outside them is invalid_option', () => {
    const r = run({ kind: 'visit', payment: 'transfer' }, { task: 'manual' });
    expect(r.fieldStates.get('payment')!.options).toEqual(['cash', 'card']);
    expect(r.errors).toEqual([expect.objectContaining({ code: 'invalid_option', field: 'payment' })]);
    expect(run({ kind: 'montage' }, { task: 'manual' }).fieldStates.get('payment')!.options)
      .toEqual(['cash', 'transfer', 'card']);
  });

  test('required skips hidden fields; validate fails unless TRUE', () => {
    const c = compile(`fields:
  a: {type: text, label: A}
  n: {type: number, label: N}
sets:
  s: {label: S, fields: [a, n]}
rules:
  - {id: need_a, when: 'TRUE', require: [a]}
  - {id: hide_a, when: '{n} = 1', hide: [a]}
  - {id: n_positive, when: 'TRUE', validate: '{n} > 0'}`);
    const ev = (data: Data) => evaluateRecord(c, null, plain(data, { s: 'manual' }), { now, userChangedKeys: new Set() });
    expect(ev({ n: 1 }).errors).toEqual([]);
    expect(ev({ n: 2 }).errors).toEqual([expect.objectContaining({ code: 'required', field: 'a', rule_id: 'need_a' })]);
    expect(ev({ a: 'x' }).errors).toEqual([expect.objectContaining({ code: 'validation', rule_id: 'n_positive' })]);
  });
});

describe('fieldStatesOf', () => {
  test('covers title and every field of enabled sets', () => {
    const s = fieldStatesOf(cfg, stateOf({}, { contact: 'manual' }), now);
    expect([...s.keys()].sort()).toEqual(['notes', 'title']);
    expect(s.get('notes')).toEqual({ visible: true, required: false, readonly: false });
  });

  test('flags from active rules; options only for enum fields', () => {
    const s = fieldStatesOf(cfg, stateOf({ kind: 'montage', done: true }), now);
    expect(s.get('act_file')).toEqual({ visible: true, required: true, readonly: false });
    expect(s.get('work_cost')).toEqual({ visible: true, required: false, readonly: true });
    expect(s.get('kind')!.options).toEqual(['visit', 'montage', 'consult']);
  });
});
