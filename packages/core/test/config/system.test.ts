import { describe, expect, test } from 'vitest';
import { compileConfig, evaluateRecord, parseConfigFiles, withSystem, type Value } from '../../src/index.js';

const NOW = new Date('2026-10-31T10:00:00Z');
const cfg = compileConfig(parseConfigFiles(withSystem([])));
const membership = (data: Record<string, Value>, linkedKeys: Set<string>) =>
  evaluateRecord(cfg, null, { data: { title: 'm', ...data }, sets: new Map([['membership', 'manual']]) },
    { now: NOW, userChangedKeys: new Set(Object.keys(data)), linkedKeys });

describe('built-in contact, organization and membership sets', () => {
  test('system sets and fields compile on their own', () => {
    expect([...cfg.sets.keys()]).toEqual(['contact', 'organization', 'membership']);
    expect(cfg.fields.get('is_active')!.clock).toBe(true);
    expect(cfg.fields.get('merged_into')).toMatchObject({
      managed: true, cardinality: 'one', target_sets: ['contact', 'organization'],
    });
  });

  test('membership requires contact and organization', () => {
    const res = membership({}, new Set());
    expect(res.errors.map((e) => [e.code, e.field])).toEqual([['required', 'contact'], ['required', 'organization']]);
  });

  test('membership with both links and no dates is valid', () => {
    expect(membership({}, new Set(['contact', 'organization'])).errors).toEqual([]);
  });

  test('membership end before start is a validation error', () => {
    const res = membership({ active_from: '2026-11-02', active_to: '2026-11-01' }, new Set(['contact', 'organization']));
    expect(res.errors).toContainEqual(expect.objectContaining({ code: 'validation', rule_id: 'membership_dates_order' }));
  });

  test('is_active: empty or future end is active, past end is not', () => {
    const links = new Set(['contact', 'organization']);
    expect(membership({}, links).state.data.is_active).toBe(true);
    expect(membership({ active_to: '2026-10-31' }, links).state.data.is_active).toBe(true);
    expect(membership({ active_to: '2026-10-30' }, links).state.data.is_active).toBe(false);
  });
});
