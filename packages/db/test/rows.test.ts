import { fileURLToPath } from 'node:url';
import { loadConfigDir } from '@icrm/core/node';
import type { Value } from '@icrm/core';
import type { Kysely } from 'kysely';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureWorkspace, RecordService, type DB, type RecordView, type SaveResult } from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/rows/', import.meta.url));
const NOW = new Date('2026-10-31T10:00:00Z');

let db: Kysely<DB>;
let userId: string;
let svc: RecordService;

beforeAll(async () => {
  let workspaceId: string;
  ({ db, workspaceId, userId } = await freshDb());
  const cfg = await loadConfigDir(CONFIG_DIR);
  svc = new RecordService({ db, cfg, workspaceId, now: () => NOW });
});

function record(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}

async function must(id: string): Promise<RecordView> {
  const r = await svc.get(id);
  if (r === null) throw new Error(`record ${id} not found`);
  return r;
}

/** Owner columns straight from the `records` table. */
async function ownerOf(id: string): Promise<{ ownerId: string | null; ownerField: string | null }> {
  const r = await db.selectFrom('records').select(['owner_id', 'owner_field']).where('id', '=', id).executeTakeFirstOrThrow();
  return { ownerId: r.owner_id, ownerField: r.owner_field };
}

async function changeLog(id: string) {
  return db.selectFrom('change_log').selectAll().where('record_id', '=', id).orderBy('id').execute();
}

const expense = (data: Record<string, Value>) => ({ data, sets: ['expense'] });

/** A task with rate 2 and two expense rows: transport 10 and parts 5. */
async function taskWithRows(): Promise<{ owner: RecordView; a: RecordView; b: RecordView }> {
  const owner = record(await svc.create({ userId, title: 'T', sets: ['task'], data: { rate: 2 }, rows: { expenses: [
    expense({ expense_kind: 'транспортные', amount: 10 }),
    expense({ expense_kind: 'комплектующие', amount: 5 }),
  ] } }));
  const [a, b] = await Promise.all(owner.links.expenses!.map(must));
  return { owner, a: a!, b: b! };
}

describe('rows on create', () => {
  test('create owner with rows: rows owned, ordered, totals computed', async () => {
    const r = record(await svc.create({ userId, title: 'T', sets: ['task'], data: { rate: 2 }, rows: { expenses: [
      { data: { expense_kind: 'транспортные', amount: 10 }, sets: ['expense'] },
      { data: { expense_kind: 'комплектующие', amount: 5 }, sets: ['expense'] },
    ] } }));
    expect(r.data).toMatchObject({ expenses_total: 15, transport_total: 10 });
    expect(r.links.expenses).toHaveLength(2);
    const [a, b] = await Promise.all(r.links.expenses!.map((id) => svc.get(id)));
    expect(a).toMatchObject({ data: { amount: 10, task_rate: 2, cost: 20 } });
    expect(b).toMatchObject({ data: { amount: 5, task_rate: 2, cost: 10 } });
    expect(a!.sets.map((s) => s.key)).toContain('expense_transport');
    expect(b!.sets.map((s) => s.key)).not.toContain('expense_transport');
    expect(await ownerOf(a!.id)).toEqual({ ownerId: r.id, ownerField: 'expenses' });
    expect(await ownerOf(b!.id)).toEqual({ ownerId: r.id, ownerField: 'expenses' });
    expect(await ownerOf(r.id)).toEqual({ ownerId: null, ownerField: null });
  });

  test('the owner logs the owned link, each row logs its own values', async () => {
    const { owner, a } = await taskWithRows();
    const ownerLinks = (await changeLog(owner.id)).filter((e) => e.kind === 'link');
    expect(ownerLinks).toEqual([
      expect.objectContaining({ field_key: 'expenses', old: [], new: owner.links.expenses, source: 'user', user_id: userId }),
    ]);
    const rowValues = (await changeLog(a.id)).filter((e) => e.kind === 'value').map((e) => [e.field_key, e.source]);
    // task_rate is computed in the row's own save (the owner is linked by then), not by the cascade
    expect(rowValues).toEqual(expect.arrayContaining([['amount', 'user'], ['expense_kind', 'user'], ['task_rate', 'rule'], ['cost', 'rule']]));
    expect((await changeLog(owner.id)).some((e) => e.field_key === 'amount')).toBe(false);
  });

  test('new rows see the owner\'s stored values while they are evaluated', async () => {
    // big_expense_cost_known: a row of 1000+ needs `cost`, which needs `task_rate` from the owner
    const r = record(await svc.create({ userId, title: 'T', sets: ['task'], data: { rate: 2 }, rows: { expenses: [
      expense({ amount: 1000 }),
    ] } }));
    expect(await must(r.links.expenses![0]!)).toMatchObject({ data: { amount: 1000, task_rate: 2, cost: 2000 } });

    const added = record(await svc.update({ id: r.id, userId, expectedVersion: r.version, rows: { expenses: [
      expense({ amount: 1500 }),
    ] } }));
    expect(await must(added.links.expenses![1]!)).toMatchObject({ data: { task_rate: 2, cost: 3000 } });

    // the rule is real: without an owner rate the row has no cost
    const noRate = await svc.create({ userId, title: 'T', sets: ['task'], rows: { expenses: [expense({ amount: 1000 })] } });
    expect(noRate).toMatchObject({ ok: false, errors: [
      expect.objectContaining({ code: 'required', field: 'cost', row: { field: 'expenses', index: 0 } }),
    ] });
  });

  test('create without rows behaves as before', async () => {
    const r = record(await svc.create({ userId, title: 'Без строк', sets: ['task'], data: { rate: 1 } }));
    expect(r).toMatchObject({ version: 1, links: { expenses: [], primary_expense: [] } });
    expect(r.data).toMatchObject({ expenses_total: 0 });
  });
});

describe('rows on update', () => {
  test('update: add, change rows in one save; changed keep place, new go last', async () => {
    const { owner, a, b } = await taskWithRows();
    const res = record(await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: b.id, version: b.version, data: { amount: 7 } },
      { data: { amount: 1 }, sets: ['expense'] },
    ] } }));
    const c = res.links.expenses![2]!;
    expect(res.links.expenses).toEqual([a.id, b.id, c]);
    expect(res.data).toMatchObject({ expenses_total: 18, transport_total: 10 });
    expect(res.version).toBe(owner.version + 1);
    expect(await must(b.id)).toMatchObject({ data: { amount: 7, cost: 14 } });
    expect(await must(c)).toMatchObject({ data: { amount: 1, task_rate: 2, cost: 2 } });
    expect(await ownerOf(c)).toEqual({ ownerId: owner.id, ownerField: 'expenses' });
    expect((await must(a.id)).version).toBe(a.version);
    const lastLink = (await changeLog(owner.id)).filter((e) => e.kind === 'link').at(-1);
    expect(lastLink).toMatchObject({ old: [a.id, b.id], new: [a.id, b.id, c], source: 'user' });
  });

  test('a changed row goes through the update pipeline: rules switch its sets', async () => {
    const { owner, b } = await taskWithRows();
    record(await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: b.id, version: b.version, data: { expense_kind: 'транспортные' } },
    ] } }));
    expect((await must(b.id)).sets.map((s) => s.key)).toContain('expense_transport');
    expect((await must(owner.id)).data).toMatchObject({ expenses_total: 15, transport_total: 15 });
  });

  test('owner value used by rows is propagated in the same save', async () => {
    const { owner, a, b } = await taskWithRows();
    record(await svc.update({ id: owner.id, userId, expectedVersion: owner.version, data: { rate: 3 } }));
    expect(await must(a.id)).toMatchObject({ data: { task_rate: 3, cost: 30 } });
    expect(await must(b.id)).toMatchObject({ data: { task_rate: 3, cost: 15 } });
  });

  test('owner value and row values changed together: the row sees the new owner value', async () => {
    const { owner, a } = await taskWithRows();
    const res = record(await svc.update({ id: owner.id, userId, expectedVersion: owner.version, data: { rate: 4 }, rows: { expenses: [
      { id: a.id, version: a.version, data: { amount: 20 } },
      { data: { amount: 3 }, sets: ['expense'] },
    ] } }));
    expect(res.data).toMatchObject({ rate: 4, expenses_total: 28, transport_total: 20 });
    expect(await must(a.id)).toMatchObject({ data: { amount: 20, task_rate: 4, cost: 80 } });
    expect(await must(res.links.expenses![2]!)).toMatchObject({ data: { amount: 3, task_rate: 4, cost: 12 } });
  });

  test('update without rows behaves as before', async () => {
    const { owner, a, b } = await taskWithRows();
    const res = record(await svc.update({ id: owner.id, userId, expectedVersion: owner.version, title: 'Новое' }));
    expect(res).toMatchObject({ title: 'Новое', version: owner.version + 1, links: { expenses: [a.id, b.id] } });
    expect((await must(a.id)).version).toBe(a.version);
  });
});

describe('row errors', () => {
  test('row error rolls back the whole batch and points at the row', async () => {
    const { owner } = await taskWithRows();
    const before = await svc.get(owner.id);
    const res = await svc.update({ id: owner.id, userId, expectedVersion: before!.version, data: { rate: 9 }, rows: { expenses: [
      { data: { amount: 1 }, sets: ['expense'] }, { data: { amount: null }, sets: ['expense'] }, { data: { amount: 2 }, sets: ['expense'] } ] } });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'required', field: 'amount', row: { field: 'expenses', index: 1 } })] });
    expect(await svc.get(owner.id)).toEqual(before);
    const rows = await db.selectFrom('records').select('id').where('owner_id', '=', owner.id).execute();
    expect(rows).toHaveLength(2);
  });

  test('errors of every bad row are reported together', async () => {
    const { owner, a } = await taskWithRows();
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { data: { amount: null }, sets: ['expense'] },
      { id: a.id, version: a.version, data: { expense_kind: 'нет такого' } },
      { data: { amount: 2 }, sets: ['expense'] },
      { data: { amount: 3 }, sets: ['no_such_set'] },
    ] } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => [e.code, e.row])).toEqual([
      ['required', { field: 'expenses', index: 0 }],
      ['invalid_option', { field: 'expenses', index: 1 }],
      ['unknown_set', { field: 'expenses', index: 3 }],
    ]);
    expect(res.errors[1]).toMatchObject({ field: 'expense_kind' });
    expect((await must(owner.id)).version).toBe(owner.version);
  });

  test('an owner evaluation error after its rows were written rolls everything back', async () => {
    const { owner, a } = await taskWithRows();
    const before = await must(owner.id);
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: a.id, version: a.version, data: { amount: 3000 } }, expense({ amount: 3000 }),
    ] } });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'required', field: 'task_note', rule_id: 'big_total_needs_note' })] });
    expect(res.ok === false && res.errors[0]!.row).toBeUndefined();
    expect(await must(owner.id)).toEqual(before);
    expect(await must(a.id)).toEqual(a);
    expect(await db.selectFrom('records').select('id').where('owner_id', '=', owner.id).execute()).toHaveLength(2);

    const title = 'Владелец с ошибкой';
    const created = await svc.create({ userId, title, sets: ['task'], data: { rate: 1 }, rows: { expenses: [expense({ amount: 6000 })] } });
    expect(created).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'required', field: 'task_note' })] });
    expect(await db.selectFrom('records').select('id').where('title', '=', title).execute()).toEqual([]);
    expect(await db.selectFrom('records').select('id').where('owner_id', 'is not', null)
      .where('data', '@>', JSON.stringify({ amount: 6000 }) as never).execute()).toEqual([]);
  });

  test('an input error of the owner stops the save before its rows', async () => {
    const { owner, a } = await taskWithRows();
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, data: { no_such_field: 1 }, rows: { expenses: [
      { id: a.id, version: a.version, data: { amount: 99 } }, expense({ amount: 1 }),
    ] } });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'unknown_field', field: 'no_such_field' })] });
    expect(res.ok === false && res.errors[0]!.row).toBeUndefined();
    expect(await must(a.id)).toEqual(a);
    expect((await must(owner.id)).links.expenses).toHaveLength(2);
  });

  test('a row error on create leaves nothing behind', async () => {
    const title = 'Не сохранится';
    const res = await svc.create({ userId, title, sets: ['task'], rows: { expenses: [expense({ amount: 1 }), expense({})] } });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'required', row: { field: 'expenses', index: 1 } })] });
    expect(await db.selectFrom('records').select('id').where('title', '=', title).execute()).toEqual([]);
  });

  test('foreign or standalone record in a row op → link_owned', async () => {
    const { owner } = await taskWithRows();
    const standalone = record(await svc.create({ userId, title: 'Сам по себе', sets: ['expense'], data: { amount: 1 } }));
    const other = await taskWithRows();
    const secondary = record(await svc.update({ id: other.owner.id, userId, expectedVersion: (await must(other.owner.id)).version,
      rows: { primary_expense: [expense({ amount: 4 })] } }));
    const primary = await must(secondary.links.primary_expense![0]!);
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: standalone.id, version: standalone.version, data: { amount: 2 } },
      { id: other.a.id, version: other.a.version, data: { amount: 2 } },
      { id: '01900000-0000-7000-8000-000000000000', version: 1, data: { amount: 2 } },
    ] } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => [e.code, e.row?.index])).toEqual([['link_owned', 0], ['link_owned', 1], ['link_owned', 2]]);
    expect(res.errors.every((e) => e.row?.field === 'expenses')).toBe(true);

    // a row of the same owner under another owned field is not a row of this field
    const wrongField = await svc.update({ id: other.owner.id, userId, expectedVersion: secondary.version, rows: { expenses: [
      { id: primary.id, version: primary.version, data: { amount: 5 } },
    ] } });
    expect(wrongField).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_owned', row: { field: 'expenses', index: 0 } })] });
    expect(await must(standalone.id)).toEqual(standalone);
  });

  test('a changed row must keep a target set → link_target with row', async () => {
    const { owner, b } = await taskWithRows();
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: b.id, version: b.version, disableSets: ['expense'] },
    ] } });
    expect(res).toMatchObject({ ok: false, errors: [
      expect.objectContaining({ code: 'link_target', field: 'expenses', row: { field: 'expenses', index: 0 } }),
    ] });
    expect(await must(b.id)).toEqual(b);
  });

  test('a row of another workspace → link_owned', async () => {
    const { workspaceId: otherWs } = await ensureWorkspace(db, 'other');
    const otherSvc = new RecordService({ db, cfg: await loadConfigDir(CONFIG_DIR), workspaceId: otherWs, now: () => NOW });
    const theirs = record(await otherSvc.create({ userId, title: 'Чужой', sets: ['task'], rows: { expenses: [expense({ amount: 1 })] } }));
    const theirRow = (await otherSvc.get(theirs.links.expenses![0]!))!;
    const { owner } = await taskWithRows();
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: theirRow.id, version: theirRow.version, data: { amount: 2 } },
    ] } });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_owned', row: { field: 'expenses', index: 0 } })] });
    expect(await otherSvc.get(theirRow.id)).toEqual(theirRow);
  });

  test('stale row version → version_conflict with row', async () => {
    const { owner, a } = await taskWithRows();
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: a.id, version: a.version - 1, data: { amount: 11 } },
    ] } });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'version_conflict', row: { field: 'expenses', index: 0 } })] });
    expect(await must(a.id)).toEqual(a);
  });

  test('archived row → archived with row', async () => {
    const { owner, a } = await taskWithRows();
    const gone = record(await svc.archive({ id: a.id, userId }));
    const res = await svc.update({ id: owner.id, userId, expectedVersion: (await must(owner.id)).version, rows: { expenses: [
      { id: a.id, version: gone.version, data: { amount: 11 } },
    ] } });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'archived', row: { field: 'expenses', index: 0 } })] });
  });

  test('the same row twice in one batch is rejected', async () => {
    const { owner, a } = await taskWithRows();
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: a.id, version: a.version, data: { amount: 11 } },
      { id: a.id, version: a.version, data: { amount: 12 } },
    ] } });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'validation', row: { field: 'expenses', index: 1 } })] });
    expect(await must(a.id)).toEqual(a);
  });

  test('new row without a target set → link_target with row', async () => {
    const res = await svc.create({ userId, title: 'T', sets: ['task'], rows: { expenses: [
      expense({ amount: 1 }), { title: 'Памятка', sets: ['memo'], data: { memo: 'x' } }, { title: 'Пусто' },
    ] } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => [e.code, e.field, e.row])).toEqual([
      ['link_target', 'expenses', { field: 'expenses', index: 1 }],
      ['link_target', 'expenses', { field: 'expenses', index: 2 }],
    ]);
  });

  test('rows for a field outside the owner\'s enabled sets → unknown_field', async () => {
    const { owner } = await taskWithRows();
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: {
      budget_lines: [expense({ amount: 1 })], rate: [expense({ amount: 1 })],
    } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => [e.code, e.field, e.row])).toEqual([
      ['unknown_field', 'budget_lines', undefined],
      ['unknown_field', 'rate', undefined],
    ]);

    // a set enabled in the same save counts
    const withBudget = record(await svc.update({ id: owner.id, userId, expectedVersion: owner.version, enableSets: ['budget'],
      rows: { budget_lines: [expense({ amount: 1 })] } }));
    expect(withBudget.links.budget_lines).toHaveLength(1);
    expect(await ownerOf(withBudget.links.budget_lines![0]!)).toEqual({ ownerId: owner.id, ownerField: 'budget_lines' });
  });

  test('cardinality one allows one row', async () => {
    const two = await svc.create({ userId, title: 'T', sets: ['task'], rows: { primary_expense: [expense({ amount: 1 }), expense({ amount: 2 })] } });
    expect(two).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_cardinality', field: 'primary_expense' })] });
    expect(two.ok === false && two.errors[0]!.row).toBeUndefined();

    const one = record(await svc.create({ userId, title: 'T', sets: ['task'], rows: { primary_expense: [expense({ amount: 1 })] } }));
    expect(one.links.primary_expense).toHaveLength(1);
    const row = await must(one.links.primary_expense![0]!);
    const more = await svc.update({ id: one.id, userId, expectedVersion: one.version, rows: { primary_expense: [expense({ amount: 2 })] } });
    expect(more).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_cardinality', field: 'primary_expense' })] });

    const changed = record(await svc.update({ id: one.id, userId, expectedVersion: one.version, rows: { primary_expense: [
      { id: row.id, version: row.version, data: { amount: 3 } },
    ] } }));
    expect(changed.links.primary_expense).toEqual([row.id]);
    expect(await must(row.id)).toMatchObject({ data: { amount: 3 } });
  });
});
