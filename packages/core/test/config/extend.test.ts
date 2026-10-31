import { describe, expect, test } from 'vitest';
import { compileConfig, ConfigError, parseConfigFiles, SYSTEM_FILE, withSystem } from '../../src/index.js';

const SYS = `fields:
  role: {type: enum, label: Роль, options: [a, b], multiple: true}
  notes: {type: text, label: Заметки}
  merged: {type: link, label: Слит, target_sets: [person], cardinality: one, managed: true}
sets:
  person: {label: Человек, fields: [notes, merged]}`;

const build = (...user: string[]) =>
  compileConfig(parseConfigFiles(withSystem(user.map((content, n) => ({ name: `u${n}.yaml`, content })), SYS)));

/** Issues of the ConfigError thrown by `fn`. */
function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.issues;
  }
  throw new Error('expected fn to throw');
}

describe('system config part', () => {
  test('system definitions are marked system, user ones are not', () => {
    const cfg = build('fields: {age: {type: number, label: Возраст}}\nsets: {task: {label: T, fields: [age]}}');
    expect(cfg.sets.get('person')!.system).toBe(true);
    expect(cfg.fields.get('notes')!.system).toBe(true);
    expect(cfg.fields.get('merged')!.managed).toBe(true);
    expect(cfg.sets.get('task')!.system).toBe(false);
    expect(cfg.fields.get('age')!.system).toBeUndefined();
  });

  test('extend appends fields to a system set and replaces label/options', () => {
    const cfg = build(`fields: {birthday: {type: date, label: ДР}}
extend:
  sets: {person: {fields: [birthday, notes]}}
  fields: {role: {label: Должность в семье, options: [муж, жена]}}`);
    expect(cfg.sets.get('person')!.fields).toEqual(['notes', 'merged', 'birthday']);
    expect(cfg.fields.get('role')).toMatchObject({ label: 'Должность в семье', options: ['муж', 'жена'] });
  });

  test('a rule may use options added by extend', () => {
    expect(() => build(`extend: {fields: {role: {options: [муж]}}}
rules: [{id: r, when: 'CONTAINS({role}, "муж")', require: [notes]}]`)).not.toThrow();
  });

  test.each([
    ['fields: {notes: {type: text, label: N}}', 'fields.notes', 'системное поле'],
    ['sets: {person: {label: P, fields: []}}', 'sets.person', 'системный набор'],
    ['fields: {x: {type: text, label: X, managed: true}}', 'fields.x.managed', 'только во встроенной части'],
    ['sets: {t: {label: T, system: true, fields: []}}', 'sets.t.system', 'Unrecognized key'],
    ['extend: {sets: {nope: {fields: []}}}', 'extend.sets.nope', 'набор "nope" не найден'],
    ['sets: {t: {label: T, fields: []}}\nextend: {sets: {t: {fields: []}}}', 'extend.sets.t', 'только системные наборы'],
    ['extend: {sets: {person: {fields: [zzz]}}}', 'extend.sets.person.fields', 'поле "zzz" не найдено'],
    ['fields: {age: {type: number, label: A}}\nextend: {fields: {age: {label: B}}}', 'extend.fields.age', 'только системные поля'],
    ['extend: {fields: {notes: {options: [a]}}}', 'extend.fields.notes.options', 'только у enum'],
  ])('config error: %s', (yaml, path, message) => {
    expect(issuesOf(() => build(yaml))).toContainEqual(expect.objectContaining({ path, message: expect.stringContaining(message) }));
  });

  test('extend of one field in two files is an error', () => {
    expect(issuesOf(() => build('extend: {fields: {role: {label: A}}}', 'extend: {fields: {role: {label: B}}}')))
      .toContainEqual(expect.objectContaining({ path: 'extend.fields.role', message: expect.stringContaining('уже есть в u0.yaml') }));
  });

  test('phone_region defaults to PL and is validated', () => {
    expect(build('').phoneRegion).toBe('PL');
    expect(build('workspace: {phone_region: DE}').phoneRegion).toBe('DE');
    expect(issuesOf(() => build('workspace: {phone_region: pl}'))).toContainEqual(expect.objectContaining({ path: 'workspace.phone_region' }));
  });

  test('a file named <system> among user files is rejected', () => {
    expect(() => withSystem([{ name: SYSTEM_FILE, content: '' }])).toThrow();
  });
});
