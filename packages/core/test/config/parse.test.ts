import { describe, expect, test } from 'vitest';
import { ConfigError, parseConfigFiles } from '../../src/index.js';

const file = (name: string, content: string) => ({ name, content });

function issuesOf(files: { name: string; content: string }[]) {
  try {
    parseConfigFiles(files);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error('expected parseConfigFiles to throw');
}

describe('parseConfigFiles', () => {
  test('merges several files', () => {
    const raw = parseConfigFiles([
      file('a.yaml', 'fields:\n  hours: {type: number, label: Часы}'),
      file('b.yaml', 'sets:\n  task: {label: Задача, fields: [hours]}'),
    ]);
    expect(raw.fields[0]).toMatchObject({ key: 'hours', type: 'number' });
    expect(raw.sets[0]).toMatchObject({ key: 'task', activation: 'manual', requires: [], system: false });
    expect(raw.timezone).toBe('Europe/Warsaw');
  });

  test('records source file, path and line of definitions', () => {
    const raw = parseConfigFiles([
      file('a.yaml', 'fields:\n  hours: {type: number, label: Часы}\nrules:\n  - id: r1\n    when: "1 = 1"\n'),
    ]);
    expect(raw.fields[0]?.src).toEqual({ file: 'a.yaml', path: 'fields.hours', line: 2 });
    expect(raw.rules[0]?.src).toEqual({ file: 'a.yaml', path: 'rules[0]', line: 4 });
  });

  test('applies defaults for link and rollup', () => {
    const raw = parseConfigFiles([
      file('a.yaml', [
        'fields:',
        '  parent: {type: link, label: P, target_sets: [task]}',
        '  total: {type: rollup, label: T, via: parent, agg: sum, field: cost}',
        '  n: {type: rollup, label: N, via: parent, agg: count}',
      ].join('\n')),
    ]);
    expect(raw.fields[0]).toMatchObject({ cardinality: 'many' });
    expect(raw.fields[1]).toMatchObject({ direction: 'forward', agg: 'sum', field: 'cost' });
    expect(raw.fields[2]).toMatchObject({ agg: 'count' });
  });

  test('owned is rejected on non-link fields', () => {
    expect(issuesOf([file('a.yaml', 'fields:\n  note: {type: text, label: N, owned: true}')]))
      .toContainEqual(expect.objectContaining({ path: 'fields.note.owned' }));
  });

  test('owned is accepted on link fields', () => {
    const raw = parseConfigFiles([file('a.yaml', 'fields:\n  rows: {type: link, label: R, target_sets: [row], owned: true}')]);
    expect(raw.fields[0]).toMatchObject({ owned: true });
  });

  test('parses workspace timezone and rules', () => {
    const raw = parseConfigFiles([
      file('a.yaml', [
        'workspace: {timezone: Europe/Berlin}',
        'rules:',
        '  - id: dates_order',
        '    when: "{a} > 1"',
        '    validate: "{b} > {a}"',
        '    message: Конец раньше начала',
        '    options: {kind: [x, y]}',
        '    default: {kind: \'"x"\'}',
      ].join('\n')),
    ]);
    expect(raw.timezone).toBe('Europe/Berlin');
    expect(raw.rules[0]).toMatchObject({
      id: 'dates_order', options: { kind: ['x', 'y'] }, default: { kind: '"x"' },
    });
  });

  test('empty file contributes nothing', () => {
    const raw = parseConfigFiles([file('a.yaml', ''), file('b.yaml', '# only a comment\n')]);
    expect(raw).toEqual({
      timezone: 'Europe/Warsaw', phoneRegion: 'PL', fields: [], sets: [], rules: [], extendSets: [], extendFields: [],
    });
  });

  test('duplicate field key across files is an issue naming both files', () => {
    expect(() => parseConfigFiles([
      file('a.yaml', 'fields:\n  x: {type: text, label: X}'),
      file('b.yaml', 'fields:\n  x: {type: text, label: X}'),
    ])).toThrow(expect.objectContaining({
      issues: [expect.objectContaining({ file: 'b.yaml', path: 'fields.x', message: expect.stringContaining('a.yaml') })],
    }));
  });

  test('duplicate set key and duplicate rule id across files', () => {
    const set = 'sets:\n  s: {label: S, fields: []}';
    expect(issuesOf([file('a.yaml', set), file('b.yaml', set)]))
      .toMatchObject([{ file: 'b.yaml', path: 'sets.s' }]);
    const rule = 'rules:\n  - {id: r, when: "1 = 1"}';
    expect(issuesOf([file('a.yaml', rule), file('b.yaml', rule)]))
      .toMatchObject([{ file: 'b.yaml', path: 'rules[0].id', line: 2 }]);
  });

  test('schema violation reports file, path and line', () => {
    expect(issuesOf([file('a.yaml', 'fields:\n  x:\n    type: nope\n    label: X')])[0])
      .toMatchObject({ file: 'a.yaml', path: 'fields.x.type', line: 3 });
  });

  test('schema issues inside rules use bracket indices', () => {
    expect(issuesOf([file('a.yaml', 'rules:\n  - {id: a, when: x}\n  - {id: b}\n')])[0])
      .toMatchObject({ path: 'rules[1].when', line: 3 });
  });

  test('missing required property points at the definition', () => {
    expect(issuesOf([file('a.yaml', 'fields:\n  x:\n    type: formula\n    label: X')])[0])
      .toMatchObject({ path: 'fields.x.expr' });
    expect(issuesOf([file('a.yaml', 'fields:\n  x:\n    type: link\n    label: X')])[0])
      .toMatchObject({ path: 'fields.x.target_sets', line: 2 });
  });

  test('rollup requires field unless agg is count', () => {
    expect(issuesOf([file('a.yaml', 'fields:\n  x: {type: rollup, label: X, via: p, agg: sum}')]))
      .toMatchObject([{ path: 'fields.x.field' }]);
  });

  test('unknown properties are reported at the property', () => {
    expect(issuesOf([file('a.yaml', 'fields:\n  x:\n    type: text\n    label: X\n    precision: 2')])[0])
      .toMatchObject({ path: 'fields.x.precision', line: 5 });
    expect(issuesOf([file('a.yaml', 'colour: red')])[0]).toMatchObject({ path: 'colour' });
  });

  test('collects issues from every file', () => {
    const issues = issuesOf([
      file('a.yaml', 'fields:\n  x: {type: nope, label: X}'),
      file('b.yaml', 'fields:\n  y: {type: text}'),
    ]);
    expect(issues.map((i) => i.file)).toEqual(['a.yaml', 'b.yaml']);
  });

  test('invalid key format and reserved title', () => {
    expect(() => parseConfigFiles([file('a.yaml', 'fields:\n  Сумма: {type: number, label: S}')])).toThrow(/snake_case/);
    expect(() => parseConfigFiles([file('a.yaml', 'fields:\n  title: {type: text, label: T}')])).toThrow(/title/);
    expect(() => parseConfigFiles([file('a.yaml', 'sets:\n  Bad-Set: {label: S, fields: []}')])).toThrow(/snake_case/);
  });

  test('unknown timezone and conflicting timezones', () => {
    expect(issuesOf([file('a.yaml', 'workspace: {timezone: Mars/Base}')])[0])
      .toMatchObject({ path: 'workspace.timezone' });
    expect(issuesOf([
      file('a.yaml', 'workspace: {timezone: Europe/Berlin}'),
      file('b.yaml', 'workspace: {timezone: Europe/Paris}'),
    ])).toMatchObject([{ file: 'b.yaml', path: 'workspace.timezone' }]);
  });

  test('YAML syntax error is a ConfigError', () => {
    expect(() => parseConfigFiles([file('a.yaml', 'fields: [')])).toThrow(ConfigError);
    expect(issuesOf([file('a.yaml', 'fields: [')])[0]).toMatchObject({ file: 'a.yaml' });
  });

  test('duplicate key inside one file is a ConfigError', () => {
    expect(() => parseConfigFiles([
      file('a.yaml', 'fields:\n  x: {type: text, label: X}\n  x: {type: text, label: Y}'),
    ])).toThrow(ConfigError);
  });

  test('top-level non-mapping is a ConfigError', () => {
    expect(() => parseConfigFiles([file('a.yaml', '- 1\n- 2')])).toThrow(ConfigError);
  });
});
