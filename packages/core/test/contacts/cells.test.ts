import { expect, test } from 'vitest';
import { coerceCell } from '../../src/index.js';
import { compile } from '../helpers.js';

const { fields } = compile(`
fields:
  num: {type: number, label: N}
  flag: {type: bool, label: F}
  day: {type: date, label: D}
  tags: {type: text, label: T, multiple: true}
  kind: {type: enum, label: K, options: [montage, visit]}
  kinds: {type: enum, label: Ks, options: [montage, visit], multiple: true}
  name: {type: text, label: Nm}
  stamp: {type: datetime, label: S}
  cost: {type: money, label: C}
sets:
  s: {label: S, fields: [num, flag, day, tags, kind, kinds, name, stamp, cost]}
`);
const [num, flag, day, tags, kind, kinds, name, stamp, cost] =
  ['num', 'flag', 'day', 'tags', 'kind', 'kinds', 'name', 'stamp', 'cost'].map((k) => fields.get(k)!);

test('number with comma, bool words, dates, multiple text, enum as is', () => {
  expect(coerceCell(num!, '12,5')).toEqual({ ok: true, value: 12.5 });
  expect(coerceCell(flag!, 'Tak')).toEqual({ ok: true, value: true });
  expect(coerceCell(flag!, 'nie')).toEqual({ ok: true, value: false });
  expect(coerceCell(day!, '31.10.2026')).toEqual({ ok: true, value: '2026-10-31' });
  expect(coerceCell(day!, '2026-10-31')).toEqual({ ok: true, value: '2026-10-31' });
  expect(coerceCell(tags!, 'a, b;c')).toEqual({ ok: true, value: ['a', 'b', 'c'] });
  expect(coerceCell(kind!, 'montage')).toEqual({ ok: true, value: 'montage' });
  expect(coerceCell(num!, '')).toEqual({ ok: true, value: null });
});
test.each([['num', 'abc'], ['flag', 'może'], ['day', '31/10/2026'], ['day', '2026-02-30'], ['day', '29.02.2027']])('%s %s is not coercible', (f, raw) => {
  const r = coerceCell(fields.get(f)!, raw);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain(raw);
});
test('more cases', () => {
  expect(coerceCell(num!, ' -3 ')).toEqual({ ok: true, value: -3 });
  expect(coerceCell(num!, '7.25')).toEqual({ ok: true, value: 7.25 });
  for (const w of ['TAK', 'yes', 'True', '1']) expect(coerceCell(flag!, w)).toEqual({ ok: true, value: true });
  for (const w of ['No', 'false', '0']) expect(coerceCell(flag!, w)).toEqual({ ok: true, value: false });
  expect(coerceCell(day!, '29.02.2028')).toEqual({ ok: true, value: '2028-02-29' });
  expect(coerceCell(day!, '1.2.2026')).toEqual({ ok: true, value: '2026-02-01' });
  expect(coerceCell(name!, '  Jan Kowalski ')).toEqual({ ok: true, value: 'Jan Kowalski' });
  expect(coerceCell(name!, '   ')).toEqual({ ok: true, value: null });
  expect(coerceCell(tags!, ' ; , ')).toEqual({ ok: true, value: null });
  expect(coerceCell(kinds!, 'montage; visit')).toEqual({ ok: true, value: ['montage', 'visit'] });
  expect(coerceCell(stamp!, '2026-10-31').ok).toBe(false);
  expect(coerceCell(cost!, '5').ok).toBe(false);
});
