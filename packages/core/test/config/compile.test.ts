import { describe, expect, test } from 'vitest';
import { ConfigError, ownedFieldsOf } from '../../src/index.js';
import { compile, compileIssues, fixture } from '../helpers.js';

const costYaml = (expr: string, label: string) =>
  `fields: {hours: {type: number, label: H}, rate: {type: number, label: R},
  cost: {type: formula, label: ${label}, expr: '${expr}'}}`;

/** Target set for link fields in the snippets below. */
const SET_T = 'sets: {t: {label: T, fields: []}}';

describe('compileConfig', () => {
  test('formula type inferred and deps collected', () => {
    const c = compile(`fields: {hours: {type: number, label: H}, rate: {type: number, label: R},
      cost: {type: formula, label: C, expr: '{hours} * {rate}'}}`);
    expect(c.fields.get('cost')).toMatchObject({ valueType: 'number', deps: new Set(['hours', 'rate']) });
    expect(c.formulaOrder).toEqual(['cost']);
  });

  test('formula cycle is an issue listing the cycle', () => {
    expect(() => compile(`fields: {a: {type: formula, label: A, expr: '{b}+1'}, b: {type: formula, label: B, expr: '{a}+1'}}`))
      .toThrow(/a → b → a/);
  });

  test('rollup over hierarchical link may reference itself', () => {
    const c = compile(fixture('hierTask'));
    expect(c.rollups.find((r) => r.key === 'children_total'))
      .toMatchObject({ via: 'parent_task', direction: 'inverse', field: 'total', agg: 'sum' });
    expect(c.fields.get('total')!.valueType).toBe('number');
    expect(c.fields.get('children_total')!.valueType).toBe('number');
    expect(c.formulaOrder).toEqual(['total']);
  });

  test('same self-reference over non-hierarchical link is an issue', () => {
    expect(() => compile(fixture('nonHierSelfRollup'))).toThrow(/цикл/);
  });

  test('rollup type by agg', () => {
    const c = compile(fixture('rollupTypes'));
    expect(c.fields.get('sum_cost')!.valueType).toBe('money');
    expect(c.fields.get('n')!.valueType).toBe('number');
    expect(c.fields.get('names')!.valueType).toEqual({ list: 'text' });
    expect(c.fields.get('org_addr')!.valueType).toBe('text'); // first
  });

  test('rollup sourceKeys cover field and filter refs', () => {
    const c = compile(`fields:
  st: {type: enum, label: S, options: [a, b]}
  h: {type: number, label: H}
  items: {type: link, label: I, target_sets: [t]}
  s: {type: rollup, label: S2, via: items, field: h, agg: sum, filter: '{st} = "a"'}
${SET_T}`);
    expect(c.rollups[0]!.sourceKeys).toEqual(new Set(['h', 'st']));
    expect(c.rollups[0]!.filterAst).toBeDefined();
    expect(c.fields.get('s')!.deps).toEqual(new Set(['h', 'st']));
  });

  test('plain field value types', () => {
    const c = compile(`fields:
  e: {type: enum, label: E, options: [a]}
  em: {type: enum, label: EM, options: [a], multiple: true}
  u: {type: user, label: U}
  f: {type: file, label: F, multiple: true}
  l: {type: link, label: L, target_sets: [t]}
  m: {type: money, label: M}
${SET_T}`);
    const t = (k: string) => c.fields.get(k)!.valueType;
    expect([t('title'), t('e'), t('em'), t('u'), t('f'), t('l'), t('m')])
      .toEqual(['text', 'text', { list: 'text' }, 'text', { list: 'text' }, 'link', 'money']);
  });

  test('link field cannot be used in an expression', () => {
    const issues = compileIssues(`fields: {l: {type: link, label: L, target_sets: [t]}, x: {type: formula, label: X, expr: '{l}'}}\n${SET_T}`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: 'fields.x.expr',
      message: expect.stringContaining('поле-ссылку нельзя использовать в выражении'),
    });
  });

  test('unknown references are all reported at once', () => {
    const issues = compileIssues(`sets: {t: {label: T, fields: [ghost], requires: [nope]}}\nrules: [{id: r, when: '{zzz}', enable_set: t}]`);
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['sets.t.fields', 'sets.t.requires', 'rules[0].when']));
  });

  test('thrown error is a ConfigError', () => {
    expect(() => compile(fixture('requiresCycle'))).toThrow(ConfigError);
  });

  test('rule enabling a manual-only set is an issue', () => {
    expect(() => compile(`fields: {k: {type: text, label: K}}\nsets: {m: {label: M, fields: [k]}}\nrules: [{id: r, when: '{k} = "x"', enable_set: m}]`))
      .toThrow(/activation/);
    expect(() => compile(`fields: {k: {type: text, label: K}}\nsets: {m: {label: M, fields: [k], activation: both}}\nrules: [{id: r, when: '{k} = "x"', enable_set: m}]`))
      .not.toThrow();
  });

  test('requires closure is transitive; requires cycle is an issue', () => {
    const c = compile(fixture('chain'));
    expect([...c.sets.get('c')!.closure].sort()).toEqual(['a', 'b', 'c']);
    expect(c.sets.get('a')!.closure).toEqual(['a']);
    expect(() => compile(fixture('requiresCycle'))).toThrow(/requires/);
  });

  test('signature changes when expr changes, not when label changes', () => {
    const s1 = compile(costYaml('{hours} * {rate}', 'C')).fields.get('cost')!.signature;
    expect(s1).toBeDefined();
    expect(compile(costYaml('{hours} * {rate}', 'Другая')).fields.get('cost')!.signature).toBe(s1);
    expect(compile(costYaml('{hours} * 2', 'C')).fields.get('cost')!.signature).not.toBe(s1);
  });

  test('rule when must be bool; default type must match field', () => {
    expect(() => compile(fixture('nonBoolWhen'))).toThrow(/bool/);
    expect(() => compile(fixture('badDefault'))).toThrow(/default/);
  });

  test('rule effects: fields must exist, options subset, validate bool', () => {
    const issues = compileIssues(`fields:
  k: {type: enum, label: K, options: [a, b]}
  n: {type: number, label: N}
rules:
  - id: r
    when: '{k} = "a"'
    show: [ghost1]
    hide: [ghost2]
    require: [ghost3]
    readonly: [ghost4]
    options: {k: [a, z], n: [x], ghost5: [a]}
    default: {ghost6: '1'}
    validate: '{n}'`);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'rules[0].default.ghost6', 'rules[0].hide', 'rules[0].options.ghost5', 'rules[0].options.k',
      'rules[0].options.n', 'rules[0].readonly', 'rules[0].require', 'rules[0].show', 'rules[0].validate',
    ]);
  });

  test('default on a computed field is an issue; require/readonly/show/hide on it are allowed', () => {
    const base = `fields:
  h: {type: number, label: H}
  f: {type: formula, label: F, expr: '{h} * 2'}
  items: {type: link, label: I, target_sets: [t]}
  r: {type: rollup, label: R, via: items, field: h, agg: sum}
${SET_T}
rules:
  - id: x
    when: 'TRUE'
`;
    const issues = compileIssues(`${base}    default: {f: '1', r: '2'}`);
    expect(issues.map((i) => i.path)).toEqual(['rules[0].default.f', 'rules[0].default.r']);
    expect(issues[0]!.message).toContain('нельзя задать вычисляемому полю');
    expect(() => compile(`${base}    require: [f, r]\n    readonly: [f]\n    show: [r]\n    hide: [f]`)).not.toThrow();
  });

  test('rollup structural and typing issues', () => {
    const issues = compileIssues(`fields:
  t: {type: text, label: T}
  d: {type: date, label: D}
  items: {type: link, label: I, target_sets: [x]}
  r1: {type: rollup, label: R1, via: t, field: d, agg: first}
  r2: {type: rollup, label: R2, via: items, field: t, agg: sum}
  r3: {type: rollup, label: R3, via: items, field: ghost, agg: first}
  r4: {type: rollup, label: R4, via: items, field: d, agg: all}
  r5: {type: rollup, label: R5, via: items, field: d, agg: count, filter: '{t}'}
  r6: {type: rollup, label: R6, via: items, field: items, agg: first}
  r7: {type: rollup, label: R7, via: items, field: d, agg: max}
sets: {x: {label: X, fields: []}}`);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'fields.r1.via', 'fields.r2.field', 'fields.r3.field', 'fields.r4.field', 'fields.r5.filter', 'fields.r6.field',
    ]);
  });

  test('link target_sets must exist', () => {
    const issues = compileIssues(`fields: {l: {type: link, label: L, target_sets: [nope]}}`);
    expect(issues.map((i) => i.path)).toEqual(['fields.l.target_sets']);
  });

  test('showTargets and setsOfField', () => {
    const c = compile(`fields: {a: {type: text, label: A}, b: {type: text, label: B}}
sets: {s1: {label: S1, fields: [a]}, s2: {label: S2, fields: [a, b]}}
rules: [{id: r, when: 'TRUE', show: [b]}]`);
    expect(c.showTargets).toEqual(new Set(['b']));
    expect(c.setsOfField.get('a')).toEqual(new Set(['s1', 's2']));
    expect(c.rules[0]!.whenAst).toBeDefined();
  });

  test('formulaOrder is topological over formulas and treats rollups as inputs', () => {
    const c = compile(`fields:
  c3: {type: formula, label: C3, expr: '{c2} + 1'}
  c2: {type: formula, label: C2, expr: '{c1} + 1'}
  c1: {type: formula, label: C1, expr: '{base} + 1'}
  base: {type: number, label: B}
  items: {type: link, label: I, target_sets: [t]}
  r: {type: rollup, label: R, via: items, field: c3, agg: sum}
  c4: {type: formula, label: C4, expr: '{r} + 1'}
${SET_T}`);
    expect(c.formulaOrder).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  test('clock flag', () => {
    const c = compile(`fields: {d: {type: date, label: D}, late: {type: formula, label: L, expr: 'DAYS_BETWEEN({d}, TODAY())'}}`);
    expect(c.fields.get('late')!.clock).toBe(true);
    expect(c.fields.get('d')!.clock).toBe(false);
  });

  test('expression syntax errors are issues with the field path', () => {
    const issues = compileIssues(`fields: {x: {type: formula, label: X, expr: '1 +'}}`);
    expect(issues[0]!.path).toBe('fields.x.expr');
  });
});

describe('was (renames)', () => {
  test('a rename from a key that is gone compiles', () => {
    expect(compile(`fields: {work_hours: {type: number, label: H, was: hours}}`).fields.get('work_hours')!.was).toBe('hours');
  });

  test('was equal to a live field key is an issue at the field, with its line', () => {
    const issues = compileIssues(`fields:
  hours: {type: number, label: H}
  work_hours: {type: number, label: WH, was: hours}
  t2: {type: text, label: T, was: title}
  self: {type: text, label: S, was: self}`);
    expect(issues.map((i) => [i.path, i.line])).toEqual([
      ['fields.work_hours.was', 3], ['fields.t2.was', 4], ['fields.self.was', 5],
    ]);
    expect(issues[0]!.message).toContain('"hours"');
    expect(issues.every((i) => i.file === 't.yaml')).toBe(true);
  });

  test('the same was on two fields is an issue at the second one', () => {
    const issues = compileIssues(`fields:
  a: {type: number, label: A, was: old}
  b: {type: number, label: B, was: old}`);
    expect(issues).toEqual([expect.objectContaining({ path: 'fields.b.was', line: 3, message: expect.stringContaining('fields.a') })]);
  });
  describe('owned link fields', () => {
    test('owned link compiles and is listed per set', () => {
      const cfg = compile(`fields: {expenses: {type: link, label: Расходы, target_sets: [expense], owned: true}, amount: {type: number, label: Сумма}}
sets: {task: {label: Задача, fields: [expenses]}, expense: {label: Расход, fields: [amount]}}`);
      expect(cfg.fields.get('expenses')!.owned).toBe(true);
      expect(ownedFieldsOf(cfg, ['task'])).toEqual(['expenses']);
      expect(ownedFieldsOf(cfg, ['expense'])).toEqual([]);
    });

    test('ownedFieldsOf de-duplicates and sorts by key', () => {
      const cfg = compile(`fields: {b_rows: {type: link, label: B, target_sets: [row], owned: true}, a_rows: {type: link, label: A, target_sets: [row], owned: true}, plain: {type: link, label: P, target_sets: [row]}}
sets: {s1: {label: S1, fields: [b_rows, a_rows, plain]}, s2: {label: S2, fields: [b_rows]}, row: {label: R, fields: []}}`);
      expect(ownedFieldsOf(cfg, ['s1', 's2'])).toEqual(['a_rows', 'b_rows']);
      expect(ownedFieldsOf(cfg, [])).toEqual([]);
    });

    test('owned + hierarchical is a config error', () => {
      expect(compileIssues(`fields: {sub: {type: link, label: S, target_sets: [t], owned: true, hierarchical: true}}
sets: {t: {label: T, fields: [sub]}}`)).toContainEqual(expect.objectContaining({
        path: 'fields.sub.owned', message: 'владеемая связь не может быть иерархической',
      }));
    });

    test('owned rows cannot carry a system set', () => {
      expect(compileIssues(`fields: {rows: {type: link, label: R, target_sets: [conv], owned: true}}
sets: {t: {label: T, fields: [rows]}, conv: {label: C, system: true, fields: []}}`)).toContainEqual(expect.objectContaining({
        path: 'fields.rows.target_sets', message: 'строки не могут иметь системный набор "conv"',
      }));
    });

    test('a non-owned link may target a system set', () => {
      expect(() => compile(`fields: {r: {type: link, label: R, target_sets: [conv]}}
sets: {t: {label: T, fields: [r]}, conv: {label: C, system: true, fields: []}}`)).not.toThrow();
    });
  });
});
