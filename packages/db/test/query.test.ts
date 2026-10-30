import { compileConfig, evaluate, parse, parseConfigFiles, type CompiledConfig, type EvalCtx, type Value } from '@icrm/core';
import { sql, type Kysely } from 'kysely';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  ensureWorkspace, queryRecords, RecordService, type DB, type QueryInput, type SaveResult,
} from '../src/index.js';
import { freshDb } from './setup-pg.js';

const NOW = new Date('2026-10-30T10:00:00Z');

const CONFIG = `
workspace: {timezone: Europe/Warsaw}
fields:
  hours: {type: number, label: Часы}
  a: {type: number, label: А}
  done: {type: bool, label: Выполнена}
  notes: {type: text, label: Заметки}
  kind: {type: enum, label: Вид, options: [visit, montage, other]}
  tags: {type: enum, label: Метки, options: [x, y, montage], multiple: true}
  due_date: {type: date, label: Срок}
  seen_at: {type: datetime, label: Замечено}
  price: {type: money, label: Цена}
  extra: {type: money, label: Доп}
  related: {type: link, label: Связанные, target_sets: [task]}
  double_hours: {type: formula, label: Двойные часы, expr: '{hours} * 2'}
sets:
  task: {label: Задача, fields: [title, hours, a, done, notes, kind, tags, due_date, seen_at, price, extra, related, double_hours]}
  montage: {label: Монтаж, fields: [title]}
`;

let db: Kysely<DB>;
let ws: string;
let userId: string;
let cfg: CompiledConfig;
let svc: RecordService;

interface Seed {
  title: string;
  data?: Record<string, Value>;
  sets?: string[];
  archived?: boolean;
}

/** Stored-value oddities no validated save can produce: written straight into the JSON. */
const VARIETY: Seed[] = [
  { title: 'Камера склад', data: { hours: 2, a: 5, done: true, notes: 'камера', kind: 'visit', tags: ['x', 'y'], due_date: '2026-10-01', seen_at: '2026-10-01T08:00:00Z', price: { amount: '100', currency: 'PLN' }, extra: { amount: '50', currency: 'PLN' } }, sets: ['task', 'montage'] },
  { title: 'Пустая заметка', data: { hours: 0.5, a: 1, done: false, notes: '', kind: 'montage', due_date: '2026-12-31', seen_at: '2027-01-01T00:00:00Z', price: { amount: '50', currency: 'EUR' }, extra: { amount: '50', currency: 'PLN' } } },
  { title: 'Пробелы', data: { hours: null, done: null, notes: '   ' } },
  { title: 'Ничего' },
  { title: 'Ровно единица', data: { hours: 1, a: 1, kind: 'montage', price: { amount: '50', currency: 'PLN' }, extra: { amount: '50', currency: 'PLN' } }, sets: ['task', 'montage'] },
  { title: 'КАМЕРА', data: { notes: 'Камера СКЛАД', hours: 3, a: 3 } },
  { title: 'Скидка 50%', data: { notes: '100% готово', kind: 'other' } },
  { title: 'Неразрывный пробел', data: { notes: '  ', done: false } },
  { title: 'Пустые метки', data: { tags: [], notes: 'без меток' } },
  { title: 'Метка монтаж', data: { tags: ['montage'], kind: 'montage' } },
  { title: 'Сегодня', data: { due_date: '2026-10-30', seen_at: '2026-10-30T10:00:00.000Z', hours: 2, a: 1 } },
  { title: 'Пустая дата', data: { due_date: '', seen_at: ' ' } },
  { title: 'Вернулось', data: { price: { amount: '-3.50', currency: 'PLN' }, done: true, hours: -1 } },
  { title: 'Только доп', data: { price: null, extra: { amount: '50', currency: 'EUR' } } },
  { title: 'Много часов', data: { hours: 100, a: 7.25, kind: 'other', done: true } },
  { title: 'Не выполнена', data: { done: false, a: 2 } },
  { title: 'Монтаж камер', data: { notes: 'Монтаж камер', kind: 'montage', hours: 1.5, a: 0, tags: ['y'] }, sets: ['task', 'montage'] },
  { title: 'Under_score', data: { notes: 'a_b', hours: 4, a: 4 } },
  { title: 'Ä Ö ß', data: { notes: 'ÄÖ ß', hours: 1, a: 2, done: true } },
  { title: 'Архивная', data: { hours: 9, done: true }, archived: true },
];

function ok(r: SaveResult): string {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record.id;
}

async function seed(service: RecordService, seeds: Seed[]): Promise<string[]> {
  const ids: string[] = [];
  for (const s of seeds) {
    const id = ok(await service.create({ userId, title: s.title, sets: s.sets ?? ['task'] }));
    const patch = { ...s.data, title: s.title };
    await sql`update records set data = data || ${JSON.stringify(patch)}::jsonb where id = ${id}`.execute(db);
    if (s.archived === true) ok(await service.archive({ id, userId }));
    ids.push(id);
  }
  return ids;
}

interface Stored {
  id: string;
  data: Record<string, Value>;
  sets: Set<string>;
}

/** Live (non-archived) records of the workspace as `evaluate` sees them. */
async function storedRecords(workspaceId: string): Promise<Stored[]> {
  const rows = await db.selectFrom('records').select(['id', 'data']).where('workspace_id', '=', workspaceId)
    .where('archived_at', 'is', null).execute();
  const sets = await db.selectFrom('record_sets').select(['record_id', 'set_key']).execute();
  return rows.map((r) => ({
    id: r.id,
    data: r.data as Record<string, Value>,
    sets: new Set(sets.filter((s) => s.record_id === r.id).map((s) => s.set_key)),
  }));
}

const ctxOf = (r: Stored): EvalCtx => ({
  get: (k) => (Object.hasOwn(r.data, k) ? r.data[k] ?? null : null),
  hasSet: (k) => r.sets.has(k),
  now: NOW,
  timezone: cfg.timezone,
});

const run = (q: QueryInput) => queryRecords(db, cfg, ws, q, NOW);
const idsOf = async (q: QueryInput): Promise<string[]> => (await run(q)).items.map((i) => i.id);

beforeAll(async () => {
  ({ db, workspaceId: ws, userId } = await freshDb());
  cfg = compileConfig(parseConfigFiles([{ name: 'config.yaml', content: CONFIG }]));
  svc = new RecordService({ db, cfg, workspaceId: ws, now: () => NOW });
  await seed(svc, VARIETY);

  // The same data in another workspace must never leak into results.
  const other = await ensureWorkspace(db, 'other');
  const otherSvc = new RecordService({ db, cfg, workspaceId: other.workspaceId, now: () => NOW });
  await seed(otherSvc, VARIETY.slice(0, 3).map((s) => ({ ...s, archived: false })));
});

const FILTERS = [
  // the brief's set
  '{done}', 'NOT({done})', '{hours} > 1', 'IS_EMPTY({notes})', 'HAS_SET("montage")',
  'IN({kind}, "montage", "visit")', 'CONTAINS({title}, "кам")', '{due_date} < TODAY()', '{a} > 1 OR {done}',
  // numbers
  '{hours} <> 1', '{hours} = 1', '{hours} >= 1', '{hours} <= 1', '{hours} < 1', '{hours} > -1', '{hours} = NULL', '{hours} <> NULL',
  '{hours} < {a}', 'NOT({hours} > 1)', '{double_hours} > 3', 'IS_EMPTY({hours})',
  // bool
  '{done} = TRUE', '{done} = FALSE', '{done} <> TRUE', 'IS_EMPTY({done})', 'TRUE', 'FALSE', 'NULL = NULL',
  // text, dates, datetimes
  '{notes} = ""', '{notes} <> ""', '{notes} = "камера"', '{notes} > "б"', '{notes} <= "Камера СКЛАД"', 'IS_EMPTY({due_date})',
  '{due_date} >= TODAY()', '{due_date} = TODAY()', '{due_date} <> TODAY()', '{seen_at} < NOW()', '{seen_at} = NOW()',
  '{seen_at} >= NOW()', 'IS_EMPTY({seen_at})',
  // contains / in
  'CONTAINS({notes}, "%")', 'CONTAINS({notes}, "_")', 'CONTAINS({notes}, "КАМЕРА")', 'CONTAINS({notes}, "")',
  'CONTAINS({title}, "ä")', 'CONTAINS({tags}, "montage")', 'CONTAINS({tags}, "x")', 'CONTAINS({tags}, "")',
  'NOT(CONTAINS({tags}, "y"))', 'IS_EMPTY({tags})', 'NOT(IS_EMPTY({tags}))', '{tags} = {tags}', '{tags} <> {tags}',
  'IN({kind}, "montage", NULL)', 'IN({kind}, NULL)', 'IN({hours}, 1, 2, 3)', 'IN({notes}, "")', 'IN({price}, {extra})',
  // money
  '{price} > {extra}', '{price} >= {extra}', '{price} = {extra}', '{price} <> {extra}', 'IS_EMPTY({price})',
  // boolean structure
  'AND({done}, {a} > 1)', 'OR({done}, HAS_SET("montage"))', 'IS_EMPTY({notes}) AND NOT({done})',
  'NOT(HAS_SET("montage")) AND {hours} > 0', '({hours} > 1) = TRUE', 'IS_EMPTY({hours} > 1)',
] as const;

describe('SQL equals in-memory evaluate', () => {
  test.each(FILTERS)('%s', async (f) => {
    const all = await storedRecords(ws);
    expect(all).toHaveLength(VARIETY.length - 1);
    const expected = all.filter((r) => evaluate(parse(f), ctxOf(r)) === true).map((r) => r.id).sort();
    const got = (await run({ filter: f, limit: 500 })).items.map((i) => i.id).sort();
    expect(got).toEqual(expected);
  });

  test('the variety is not degenerate: filters select proper subsets', async () => {
    const all = (await run({ limit: 500 })).total;
    for (const f of ['{done}', '{hours} > 1', 'IS_EMPTY({notes})', 'CONTAINS({title}, "кам")', '{due_date} < TODAY()']) {
      const n = (await run({ filter: f })).total;
      expect(n, f).toBeGreaterThan(0);
      expect(n, f).toBeLessThan(all);
    }
  });
});

describe('semantics worth pinning', () => {
  test('comparison with an empty value is false, also for <>', async () => {
    const ids = await idsOf({ filter: '{hours} <> 1', limit: 500 });
    const titles = (await run({ filter: '{hours} <> 1', limit: 500 })).items.map((i) => i.title);
    expect(ids.length).toBeGreaterThan(0);
    expect(titles).not.toContain('Ничего');
    expect(titles).not.toContain('Пробелы');
  });

  test('whitespace-only text (including NBSP) is empty', async () => {
    const titles = (await run({ filter: 'IS_EMPTY({notes})', limit: 500 })).items.map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(['Пробелы', 'Неразрывный пробел', 'Пустая заметка', 'Ничего']));
  });

  test('CONTAINS is case-insensitive for Cyrillic and takes % and _ literally', async () => {
    const titles = async (f: string) => (await run({ filter: f, limit: 500 })).items.map((i) => i.title).sort();
    expect(await titles('CONTAINS({title}, "кам")')).toEqual(['КАМЕРА', 'Камера склад', 'Монтаж камер']);
    expect(await titles('CONTAINS({notes}, "%")')).toEqual(['Скидка 50%']);
    expect(await titles('CONTAINS({notes}, "_")')).toEqual(['Under_score']);
    expect(await titles('CONTAINS({title}, "%")')).toEqual(['Скидка 50%']);
  });

  test('list CONTAINS is exact element equality', async () => {
    expect((await run({ filter: 'CONTAINS({tags}, "mont")' })).total).toBe(0);
    expect((await run({ filter: 'CONTAINS({tags}, "montage")' })).total).toBe(1);
  });

  test('money values of different currencies never compare', async () => {
    const titles = (await run({ filter: '{price} = {extra}', limit: 500 })).items.map((i) => i.title).sort();
    expect(titles).toEqual(['Ровно единица']);
  });

  test('field values are bound, never interpolated', async () => {
    const evil = `x' or 1=1 --`;
    expect((await run({ filter: `{notes} = "${evil}"` })).total).toBe(0);
    expect((await run({ filter: `CONTAINS({notes}, "'); drop table records; --")` })).total).toBe(0);
    expect((await run({ limit: 500 })).total).toBe(VARIETY.length - 1);
  });
});

describe('errors', () => {
  const reject = (q: QueryInput) => expect(run(q)).rejects;

  test('unsupported function rejected with position', async () => {
    await reject({ filter: 'LEN({title}) > 3' }).toMatchObject({ code: 'unsupported_in_filter', pos: { start: 0, end: 12 } });
  });

  test.each([
    ['ROUND({hours}) > 1'], ['{hours} + 1 > 2'], ['{hours} * {a} > 1'], ['-{hours} < 0'], ['IF({done}, TRUE, FALSE)'],
    ['COALESCE({hours}, 0) > 1'], ['{notes} & "x" = "y"'], ['DAYS_BETWEEN({due_date}, TODAY()) > 1'],
  ])('unsupported: %s', async (filter) => {
    await reject({ filter }).toMatchObject({ code: 'unsupported_in_filter' });
  });

  test('the position points at the offending node', async () => {
    await reject({ filter: '{done} AND {hours} + 1 > 2' }).toMatchObject({ code: 'unsupported_in_filter', pos: { start: 11, end: 22 } });
  });

  test('syntax error carries the position', async () => {
    await reject({ filter: '{hours} >' }).toMatchObject({ code: 'syntax', pos: expect.objectContaining({ start: expect.any(Number) }) });
  });

  test('non-bool filter rejected', async () => {
    await reject({ filter: '{hours}' }).toMatchObject({ code: 'type' });
  });

  test.each([['{nope} > 1'], ['{hours} > "a"'], ['HAS_SET("nope")'], ['{related} = NULL'], ['NOT({hours})']])('type error: %s', async (filter) => {
    await reject({ filter }).toMatchObject({ code: 'type' });
  });

  test('negative limit or offset and unknown sort are type errors', async () => {
    await reject({ limit: -1 }).toMatchObject({ code: 'type' });
    await reject({ offset: -1 }).toMatchObject({ code: 'type' });
    await reject({ limit: 1.5 }).toMatchObject({ code: 'type' });
    await reject({ sort: [{ field: 'nope', dir: 'asc' }] }).toMatchObject({ code: 'type' });
  });

  test('sort by link or list field is a type error', async () => {
    await reject({ sort: [{ field: 'related', dir: 'asc' }] }).toMatchObject({ code: 'type' });
    await reject({ sort: [{ field: 'tags', dir: 'asc' }] }).toMatchObject({ code: 'type' });
  });
});

describe('paging, archive and sorting', () => {
  test('archived excluded by default; paging and total', async () => {
    const live = VARIETY.length - 1;
    const first = await run({ limit: 5, offset: 0 });
    const second = await run({ limit: 5, offset: 5 });
    expect(first.total).toBe(live);
    expect(second.total).toBe(live);
    expect(first.items).toHaveLength(5);
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(10);
    expect(first.items.map((i) => i.title)).not.toContain('Архивная');

    const all = await run({ includeArchived: true, limit: 500 });
    expect(all.total).toBe(VARIETY.length);
    expect(all.items.map((i) => i.title)).toContain('Архивная');
  });

  test('total ignores limit and offset but not the filter', async () => {
    const r = await run({ filter: '{done}', limit: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.total).toBe((await run({ filter: '{done}', limit: 500 })).items.length);
    expect(r.total).toBeGreaterThan(1);
  });

  test('default order is newest first; limit defaults to 50 and is clamped to 500', async () => {
    const ws2 = (await ensureWorkspace(db, 'many')).workspaceId;
    const many = new RecordService({ db, cfg, workspaceId: ws2, now: () => NOW });
    for (let i = 0; i < 3; i++) ok(await many.create({ userId, title: `n${i}`, sets: ['task'] }));
    const r = await queryRecords(db, cfg, ws2, {}, NOW);
    expect(r.items.map((x) => x.title)).toEqual(['n2', 'n1', 'n0']);
    await sql`
      insert into records (id, workspace_id, title, data)
      select gen_random_uuid(), ${ws2}::uuid, 'bulk', '{}'::jsonb from generate_series(1, 600)`.execute(db);
    expect((await queryRecords(db, cfg, ws2, {}, NOW)).items).toHaveLength(50);
    const big = await queryRecords(db, cfg, ws2, { limit: 100_000 }, NOW);
    expect(big.items).toHaveLength(500);
    expect(big.total).toBe(603);
  });

  test('output carries id, title, data without title, sets and version', async () => {
    const r = await run({ filter: '{title} = "Камера склад"' });
    expect(r.items).toHaveLength(1);
    const item = r.items[0]!;
    expect(Object.keys(item).sort()).toEqual(['data', 'id', 'sets', 'title', 'version']);
    expect(item.data).not.toHaveProperty('title');
    expect(item.data).toMatchObject({ hours: 2, kind: 'visit' });
    expect(item.sets.map((s) => s.key)).toEqual(['montage', 'task']);
    expect(item.version).toBeGreaterThanOrEqual(1);
  });

  test('sort by number desc puts nulls last, asc too', async () => {
    const desc = (await run({ sort: [{ field: 'hours', dir: 'desc' }], limit: 500 })).items.map((i) => i.data.hours ?? null);
    const asc = (await run({ sort: [{ field: 'hours', dir: 'asc' }], limit: 500 })).items.map((i) => i.data.hours ?? null);
    const present = (xs: Value[]) => xs.filter((x) => x !== null);
    expect(present(desc)).toEqual([...present(desc)].sort((x, y) => (y as number) - (x as number)));
    expect(present(asc)).toEqual([...present(asc)].sort((x, y) => (x as number) - (y as number)));
    const lastNonNull = (xs: Value[]) => xs.map((x) => x !== null).lastIndexOf(true);
    const firstNull = (xs: Value[]) => xs.findIndex((x) => x === null);
    expect(desc[0]).toBe(100);
    expect(firstNull(desc)).toBeGreaterThan(lastNonNull(desc));
    expect(firstNull(asc)).toBeGreaterThan(lastNonNull(asc));
  });

  test('sort by title uses the column; by date, money and a second key', async () => {
    const byTitle = (await run({ sort: [{ field: 'title', dir: 'asc' }], limit: 500 })).items.map((i) => i.title);
    expect(byTitle).toHaveLength(VARIETY.length - 1);
    const column = await db.selectFrom('records').select('title').where('workspace_id', '=', ws)
      .where('archived_at', 'is', null).orderBy('title').orderBy('id').execute();
    expect(byTitle).toEqual(column.map((r) => r.title));

    const byDate = (await run({ sort: [{ field: 'due_date', dir: 'asc' }, { field: 'title', dir: 'desc' }], limit: 500 }))
      .items.map((i) => (i.data.due_date as string | undefined) ?? null);
    const dates = byDate.filter((d): d is string => d !== null && d !== '');
    expect(dates).toEqual([...dates].sort());

    const byMoney = await run({ sort: [{ field: 'price', dir: 'desc' }], limit: 500 });
    expect((byMoney.items[0]!.data.price as { amount: string }).amount).toBe('100');
  });
});
