import { describe, expect, test } from 'vitest';
import { rollupsFedBy, rollupsVia } from '../../src/index.js';
import { compile, fixture } from '../helpers.js';

const cfg = compile(fixture('rollups'));
const keys = (rs: { key: string }[]): string[] => rs.map((r) => r.key).sort();

describe('rollupsFedBy', () => {
  test('matches aggregated field and filter refs', () => {
    expect(rollupsFedBy(cfg, new Set(['done'])).map((r) => r.key))
      .toEqual(expect.arrayContaining(['open_count', 'all_done', 'any_done']));
    expect(keys(rollupsFedBy(cfg, new Set(['hours']))))
      .toEqual(['avg_hours', 'min_hours', 'sum_hours', 'urgent_hours']);
    expect(rollupsFedBy(cfg, new Set(['done'])).map((r) => r.key)).not.toContain('sum_hours');
  });

  test('unrelated keys feed nothing', () => {
    expect(rollupsFedBy(cfg, new Set(['unrelated']))).toEqual([]);
    expect(rollupsFedBy(cfg, new Set())).toEqual([]);
  });

  test('enabling or disabling a set feeds rollups whose filter has HAS_SET of it', () => {
    expect(keys(rollupsFedBy(cfg, new Set(), new Set(['urgent'])))).toEqual(['urgent_hours']);
    expect(rollupsFedBy(cfg, new Set(), new Set(['org']))).toEqual([]);
  });

  test('keys and sets combine without duplicates', () => {
    const r = rollupsFedBy(cfg, new Set(['hours']), new Set(['urgent']));
    expect(r.filter((x) => x.key === 'urgent_hours')).toHaveLength(1);
  });
});

describe('rollupsVia', () => {
  test('returns every rollup over the link field', () => {
    expect(keys(rollupsVia(cfg, 'org'))).toEqual(['org_addr']);
    expect(rollupsVia(cfg, 'tasks')).toHaveLength(cfg.rollups.length - 1);
    expect(rollupsVia(cfg, 'tasks').map((r) => r.key)).toContain('open_count');
    expect(rollupsVia(cfg, 'nope')).toEqual([]);
  });
});
