import { fileURLToPath } from 'node:url';
import { loadConfigDir } from '@icrm/core/node';
import type { CompiledConfig, Value } from '@icrm/core';
import { sql, type Kysely } from 'kysely';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureWorkspace, queryRecords, RecordService, type DB, type RecordView, type SaveResult } from '../src/index.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/rows/', import.meta.url));
const NOW = new Date('2026-10-31T10:00:00Z');

let db: Kysely<DB>;
let userId: string;
let svc: RecordService;
let cfg: CompiledConfig;
let workspaceId: string;

beforeAll(async () => {
  ({ db, workspaceId, userId } = await freshDb());
  cfg = await loadConfigDir(CONFIG_DIR);
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

describe('row deletion and owner lifecycle', () => {
  const archiveLog = async (id: string) => (await changeLog(id)).filter((e) => e.kind === 'archive');

  test('delete op archives the row and drops it from the owner', async () => {
    const { owner: o, a: { id: a }, b: { id: b } } = await taskWithRows();
    const res = record(await svc.update({ id: o.id, userId, expectedVersion: o.version, rows: { expenses: [{ id: a, delete: true }] } }));
    expect(res.links.expenses).toEqual([b]);
    expect(res.data.expenses_total).toBe(5);
    expect(res.data.transport_total).toBe(0);
    expect(res.version).toBe(o.version + 1);
    expect((await svc.get(a))!.archivedAt).not.toBeNull();
    expect(await archiveLog(a)).toEqual([expect.objectContaining({ source: 'user', user_id: userId })]);
    expect((await changeLog(o.id)).filter((e) => e.kind === 'link').at(-1)).toMatchObject({ old: [a, b], new: [b], source: 'user' });
    // owner columns stay: the archived row is still the owner's
    expect(await ownerOf(a)).toEqual({ ownerId: o.id, ownerField: 'expenses' });
  });

  test('delete and add in one batch; cardinality one counts the deletion', async () => {
    const one = record(await svc.create({ userId, title: 'T', sets: ['task'], data: { rate: 1 }, rows: { primary_expense: [expense({ amount: 1 })] } }));
    const old = one.links.primary_expense![0]!;
    const res = record(await svc.update({ id: one.id, userId, expectedVersion: one.version, rows: { primary_expense: [
      { id: old, delete: true }, expense({ amount: 2 }),
    ] } }));
    expect(res.links.primary_expense).toHaveLength(1);
    expect(res.links.primary_expense![0]).not.toBe(old);
    expect((await must(old)).archivedAt).not.toBeNull();
  });

  test('repeating a stale batch fails without partial changes', async () => {
    const { owner: o, a: { id: a }, b: { id: b } } = await taskWithRows();
    const batch = { expenses: [{ id: a, delete: true as const }, expense({ amount: 1 })] };
    const first = record(await svc.update({ id: o.id, userId, expectedVersion: o.version, rows: batch }));
    expect(first.links.expenses).toHaveLength(2);
    const again = await svc.update({ id: o.id, userId, expectedVersion: first.version, rows: batch });
    expect(again).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'archived', row: { field: 'expenses', index: 0 } })] });
    expect(again.ok === false && again.errors).toHaveLength(1);
    expect(await must(o.id)).toEqual(first);
    const live = await db.selectFrom('records').select('id').where('owner_id', '=', o.id).where('archived_at', 'is', null).execute();
    expect(live.map((r) => r.id).sort()).toEqual([b, first.links.expenses![1]!].sort());
  });

  test('a delete op of a foreign or standalone record → link_owned', async () => {
    const { owner: o } = await taskWithRows();
    const standalone = record(await svc.create({ userId, title: 'Сам по себе', sets: ['expense'], data: { amount: 1 } }));
    const other = await taskWithRows();
    const res = await svc.update({ id: o.id, userId, expectedVersion: o.version, rows: { expenses: [
      { id: standalone.id, delete: true }, { id: other.a.id, delete: true },
    ] } });
    expect(res.ok === false && res.errors.map((e) => [e.code, e.row?.index])).toEqual([['link_owned', 0], ['link_owned', 1]]);
    expect(await must(standalone.id)).toEqual(standalone);
    expect(await must(other.a.id)).toEqual(other.a);
  });

  /** A task with rows a and b, where a also owns a sub-row through its `budget_lines`. */
  async function nestedRows() {
    const { owner, a, b } = await taskWithRows();
    const a2 = record(await svc.update({ id: a.id, userId, expectedVersion: a.version, enableSets: ['budget'],
      rows: { budget_lines: [expense({ amount: 1 })] } }));
    const sub = a2.links.budget_lines![0]!;
    expect(await ownerOf(sub)).toEqual({ ownerId: a.id, ownerField: 'budget_lines' });
    return { owner: await must(owner.id), a: a2, b, sub };
  }

  test('archiving the owner archives its rows, recursively', async () => {
    const { owner, a, b, sub } = await nestedRows();
    const res = record(await svc.archive({ id: owner.id, userId }));
    expect(res.archivedAt).not.toBeNull();
    for (const id of [a.id, b.id, sub]) {
      expect((await must(id)).archivedAt).not.toBeNull();
      expect(await archiveLog(id)).toEqual([expect.objectContaining({ source: 'cascade', user_id: userId })]);
    }
    expect(await archiveLog(owner.id)).toEqual([expect.objectContaining({ source: 'user' })]);
    // links stay
    expect(res.links.expenses).toEqual([a.id, b.id]);
    expect((await must(a.id)).links.budget_lines).toEqual([sub]);

    // any mutation of a row of an archived owner → archived
    const aNow = await must(a.id);
    expect(await svc.update({ id: a.id, userId, expectedVersion: aNow.version, data: { amount: 2 } }))
      .toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'archived' })] });
    expect(await svc.setLinks({ id: a.id, userId, field: 'budget_lines', targetIds: [] }))
      .toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'archived' })] });
    expect(await svc.archive({ id: sub, userId })).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'archived' })] });
  });

  test('deleting a row archives its own rows too', async () => {
    const { owner, a, b, sub } = await nestedRows();
    const res = record(await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [{ id: a.id, delete: true }] } }));
    expect(res.links.expenses).toEqual([b.id]);
    expect(await archiveLog(a.id)).toEqual([expect.objectContaining({ source: 'user' })]);
    expect(await archiveLog(sub)).toEqual([expect.objectContaining({ source: 'cascade' })]);
  });

  test('archives of rows count against the cascade limit', async () => {
    const cfg = await loadConfigDir(CONFIG_DIR);
    const tight = new RecordService({ db, cfg, workspaceId, now: () => NOW, cascadeLimit: 2 });
    const { owner, a, sub } = await nestedRows();
    const res = await tight.archive({ id: owner.id, userId });
    expect(res).toMatchObject({ ok: false, errors: [{ code: 'validation', message: 'каскад превысил лимит' }] });
    expect(await must(owner.id)).toEqual(owner);
    expect((await must(a.id)).archivedAt).toBeNull();
    expect((await must(sub)).archivedAt).toBeNull();

    const enough = new RecordService({ db, cfg, workspaceId, now: () => NOW, cascadeLimit: 3 });
    record(await enough.archive({ id: owner.id, userId }));
    expect((await must(sub)).archivedAt).not.toBeNull();
  });

  test('direct archive of a row updates the owner', async () => {
    const { owner: o, a, b } = await taskWithRows();
    const res = record(await svc.archive({ id: a.id, userId }));
    expect(res.archivedAt).not.toBeNull();
    const after = await must(o.id);
    expect(after.version).toBe(o.version + 1);
    expect(after.links.expenses).toEqual([b.id]);
    expect(after.data).toMatchObject({ expenses_total: 5, transport_total: 0 });
    expect((await changeLog(o.id)).filter((e) => e.kind === 'link').at(-1)).toMatchObject({ old: [a.id, b.id], new: [b.id], source: 'user' });
    expect(await archiveLog(a.id)).toEqual([expect.objectContaining({ source: 'user' })]);
  });

  test('PUT links on an owned field reorders and deletes, never adopts', async () => {
    const { owner: o, a: { id: a }, b: { id: b } } = await taskWithRows();
    const standalone = record(await svc.create({ userId, title: 'Сам по себе', sets: ['expense'], data: { amount: 1 } }));
    expect(record(await svc.setLinks({ id: o.id, userId, field: 'expenses', targetIds: [b, a] })).links.expenses).toEqual([b, a]);
    const adopt = await svc.setLinks({ id: o.id, userId, field: 'expenses', targetIds: [b, a, standalone.id] });
    expect(adopt).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_owned', field: 'expenses' })] });
    expect(await ownerOf(standalone.id)).toEqual({ ownerId: null, ownerField: null });

    // a row of another owner cannot be adopted either
    const other = await taskWithRows();
    expect(await svc.setLinks({ id: o.id, userId, field: 'expenses', targetIds: [b, a, other.a.id] }))
      .toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_owned', field: 'expenses' })] });

    const before = await must(o.id);
    const dropped = record(await svc.setLinks({ id: o.id, userId, field: 'expenses', targetIds: [b] }));
    expect(dropped.links.expenses).toEqual([b]);
    expect(dropped.version).toBe(before.version + 1);
    expect(dropped.data).toMatchObject({ expenses_total: 5, transport_total: 0 });
    expect((await must(a)).archivedAt).not.toBeNull();
    expect(await archiveLog(a)).toEqual([expect.objectContaining({ source: 'user' })]);

    // a deleted row cannot come back
    expect(await svc.setLinks({ id: o.id, userId, field: 'expenses', targetIds: [b, a] }))
      .toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_owned', field: 'expenses' })] });
  });

  test('links on create cannot target an owned field', async () => {
    const standalone = record(await svc.create({ userId, title: 'Сам по себе', sets: ['expense'], data: { amount: 1 } }));
    const res = await svc.create({ userId, title: 'T', sets: ['task'], links: { expenses: [standalone.id] } });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_owned', field: 'expenses' })] });
    expect(await ownerOf(standalone.id)).toEqual({ ownerId: null, ownerField: null });
  });
});

describe('rows in reads', () => {
  /** A task with two expense rows marked with `note`; the first row also owns a sub-row (budget_lines). */
  async function markedRows(note: string) {
    const owner = record(await svc.create({ userId, title: 'T', sets: ['task'], data: { rate: 1 }, rows: { expenses: [
      expense({ amount: 1, note }), expense({ amount: 2, note }),
    ] } }));
    const [a, b] = owner.links.expenses!;
    const a1 = await must(a!);
    const a2 = record(await svc.update({ id: a!, userId, expectedVersion: a1.version, enableSets: ['budget'],
      rows: { budget_lines: [expense({ amount: 3 })] } }));
    return { owner: await must(owner.id), a: a2, b: b! };
  }

  test('get returns rows of owned fields, one level deep', async () => {
    const { owner, a, b } = await markedRows('rd-one');
    const v = (await svc.get(owner.id))!;
    expect(v.rows!.expenses!.map((r) => r.id)).toEqual(v.links.expenses);
    expect(v.rows!.expenses!.map((r) => r.id)).toEqual([a.id, b]);
    expect(v.rows!.primary_expense).toEqual([]);
    expect(v.rows!.expenses![0]).not.toHaveProperty('rows');
    expect(v.rows!.expenses![0]).toMatchObject({ data: { amount: 1, note: 'rd-one', task_rate: 1 }, version: a.version });
    expect(v.rows!.expenses![0]!.links.budget_lines).toEqual(a.links.budget_lines);
    // the row's own get expands its own rows
    const row = (await svc.get(a.id))!;
    expect(row.rows!.budget_lines!.map((r) => r.id)).toEqual(a.links.budget_lines);
    expect(row.rows!.budget_lines![0]).not.toHaveProperty('rows');
  });

  test('a save result carries rows; a record without owned fields has no rows key', async () => {
    const res = record(await svc.create({ userId, title: 'T', sets: ['task'], data: { rate: 1 }, rows: { expenses: [expense({ amount: 4 })] } }));
    expect(res.rows!.expenses!.map((r) => r.id)).toEqual(res.links.expenses);
    expect(res.rows!.expenses![0]).toMatchObject({ data: { amount: 4 } });
    const plain = record(await svc.create({ userId, title: 'Расход', sets: ['expense'], data: { amount: 1 } }));
    expect(plain).not.toHaveProperty('rows');
    expect(await must(plain.id)).not.toHaveProperty('rows');
  });

  test('deleted rows are not shown; rows of an archived owner are not shown either', async () => {
    const { owner: o, a, b } = await taskWithRows();
    const after = record(await svc.update({ id: o.id, userId, expectedVersion: o.version, rows: { expenses: [{ id: a.id, delete: true }] } }));
    expect(after.rows!.expenses!.map((r) => r.id)).toEqual([b.id]);
    const gone = record(await svc.archive({ id: o.id, userId }));
    expect(gone.links.expenses).toEqual([b.id]);
    expect(gone.rows!.expenses).toEqual([]);
    expect((await must(o.id)).rows!.expenses).toEqual([]);
  });

  test('query hides rows unless includeRows', async () => {
    await markedRows('q-mark');
    const f = { filter: 'HAS_SET("expense") AND {note} = "q-mark"' };
    expect((await queryRecords(db, cfg, workspaceId, f, NOW)).total).toBe(0);
    const withRows = await queryRecords(db, cfg, workspaceId, { ...f, includeRows: true }, NOW);
    expect(withRows.total).toBe(2);
    expect(withRows.items).toHaveLength(2);
    expect((await queryRecords(db, cfg, workspaceId, { ...f, includeRows: false }, NOW)).items).toEqual([]);
  });

  test('rows of an archived owner stay hidden from includeRows unless includeArchived', async () => {
    const { owner } = await markedRows('qa-mark');
    record(await svc.archive({ id: owner.id, userId }));
    const f = { filter: 'HAS_SET("expense") AND {note} = "qa-mark"', includeRows: true };
    expect((await queryRecords(db, cfg, workspaceId, f, NOW)).total).toBe(0);
    expect((await queryRecords(db, cfg, workspaceId, { ...f, includeArchived: true }, NOW)).total).toBe(2);
  });
});

describe('readonly owned field and target sets (spec §1.12 item 3)', () => {
  const frozen = { code: 'readonly', field: 'expenses', rule_id: 'closed_task_frozen' };

  /** A closed task (rule closed_task_frozen: `expenses` readonly) with rows a (transport 10) and b (parts 5). */
  async function closedTask() {
    const { owner, a, b } = await taskWithRows();
    const closed = record(await svc.update({ id: owner.id, userId, expectedVersion: owner.version, data: { closed: true } }));
    return { owner: closed, a, b };
  }

  test('batch new and delete ops on a readonly owned field fail with readonly and row; change ops pass', async () => {
    const { owner, a, b } = await closedTask();
    const res = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: a.id, version: a.version, data: { amount: 11 } }, expense({ amount: 1 }), { id: b.id, delete: true },
    ] } });
    expect(res).toMatchObject({ ok: false, errors: [
      expect.objectContaining({ ...frozen, row: { field: 'expenses', index: 1 } }),
      expect.objectContaining({ ...frozen, row: { field: 'expenses', index: 2 } }),
    ] });
    expect(res.ok === false && res.errors).toHaveLength(2);
    expect(await must(owner.id)).toEqual(owner);
    expect(await must(a.id)).toEqual(a);
    expect(await must(b.id)).toEqual(b);

    const changed = record(await svc.update({ id: owner.id, userId, expectedVersion: owner.version, rows: { expenses: [
      { id: a.id, version: a.version, data: { amount: 11 } },
    ] } }));
    expect(changed.data).toMatchObject({ expenses_total: 16 });
    expect(changed.links.expenses).toEqual([a.id, b.id]);
  });

  test('judged by the owner\'s stored state: reopening and adding in one save is rejected, closing and adding is not', async () => {
    const { owner } = await closedTask();
    const reopen = await svc.update({ id: owner.id, userId, expectedVersion: owner.version, data: { closed: false },
      rows: { expenses: [expense({ amount: 1 })] } });
    expect(reopen).toMatchObject({ ok: false, errors: [expect.objectContaining({ ...frozen, row: { field: 'expenses', index: 0 } })] });

    const open = await taskWithRows();
    const closing = record(await svc.update({ id: open.owner.id, userId, expectedVersion: open.owner.version, data: { closed: true },
      rows: { expenses: [expense({ amount: 1 })] } }));
    expect(closing.links.expenses).toHaveLength(3);
  });

  test('create is not checked: a closed task can be created with rows', async () => {
    const r = record(await svc.create({ userId, title: 'T', sets: ['task'], data: { closed: true, rate: 1 }, rows: { expenses: [
      expense({ amount: 1 }),
    ] } }));
    expect(r.links.expenses).toHaveLength(1);
  });

  test('PUT links excluding a row of a readonly owned field → readonly; the row stays', async () => {
    const { owner, a, b } = await closedTask();
    const res = await svc.setLinks({ id: owner.id, userId, field: 'expenses', targetIds: [b.id] });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining(frozen)] });
    expect(await must(a.id)).toEqual(a);
    expect(await must(owner.id)).toEqual(owner);
  });

  test('direct archive of a row of a readonly owned field → readonly; archiving the owner is allowed', async () => {
    const { owner, a, b } = await closedTask();
    const res = await svc.archive({ id: a.id, userId });
    expect(res).toEqual({ ok: false, errors: [expect.objectContaining(frozen)] });
    expect(res.ok === false && res.errors[0]!.row).toBeUndefined();
    expect(await must(a.id)).toEqual(a);
    expect(await must(owner.id)).toEqual(owner);

    record(await svc.archive({ id: owner.id, userId }));
    expect((await must(a.id)).archivedAt).not.toBeNull();
    expect((await must(b.id)).archivedAt).not.toBeNull();
  });

  test('a direct PATCH of a row of a readonly owned field follows the row\'s own rules', async () => {
    const { owner, a } = await closedTask();
    const res = record(await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { amount: 12 } }));
    expect(res.data).toMatchObject({ amount: 12 });
    expect((await must(owner.id)).data).toMatchObject({ expenses_total: 17 });
  });

  test('a direct PATCH of a live row must keep a target set → link_target on the owner field', async () => {
    const { b } = await taskWithRows();
    const res = await svc.update({ id: b.id, userId, expectedVersion: b.version, disableSets: ['expense'] });
    expect(res).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'link_target', field: 'expenses' })] });
    expect(res.ok === false && res.errors[0]!.row).toBeUndefined();
    expect(await must(b.id)).toEqual(b);

    // a standalone record is not a row: no target sets to keep
    const standalone = record(await svc.create({ userId, title: 'Сам по себе', sets: ['expense', 'memo'], data: { amount: 1 } }));
    const off = record(await svc.update({ id: standalone.id, userId, expectedVersion: standalone.version, disableSets: ['expense'] }));
    expect(off.sets.map((s) => s.key)).toEqual(['memo']);
  });

  test('a direct PATCH of a live row updates the owner\'s totals, version and log through the cascade', async () => {
    const { owner, a } = await taskWithRows();
    record(await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { amount: 11 } }));
    const after = await must(owner.id);
    expect(after.data).toMatchObject({ expenses_total: 16, transport_total: 11 });
    expect(after.version).toBe(owner.version + 1);
    const totals = (await changeLog(owner.id)).filter((e) => e.kind === 'value' && e.field_key === 'expenses_total').at(-1);
    expect(totals).toMatchObject({ old: 15, new: 16, source: 'cascade', user_id: userId });
  });
});

describe('lock order of direct saves of a row (owner before row)', () => {
  /** Waits until some backend of this database waits for a lock. */
  async function someoneWaits(): Promise<void> {
    for (let n = 0; n < 200; n++) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`.execute(db);
      if (rows[0]!.n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no backend waits for a lock');
  }

  /**
   * Holds a lock on `ownerId` in another transaction, starts `save`, waits until it blocks, then checks the
   * row `rowId` is not locked yet (NOWAIT succeeds): the save waits for the owner before it touches the row.
   */
  async function waitsForOwnerFirst(ownerId: string, rowId: string, save: () => Promise<SaveResult>): Promise<SaveResult> {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let lockedOwner!: () => void;
    const ready = new Promise<void>((r) => { lockedOwner = r; });
    const holder = db.transaction().execute(async (tx) => {
      await sql`select id from records where id = ${ownerId} for update`.execute(tx);
      lockedOwner();
      await held;
    });
    await ready;
    const pending = save();
    try {
      await someoneWaits();
      await db.transaction().execute(async (tx) => {
        await sql`select id from records where id = ${rowId} for update nowait`.execute(tx);
      });
    } finally {
      release();
      await holder;
    }
    return pending;
  }

  test('update of a row locks its owner first', async () => {
    const { owner, a } = await taskWithRows();
    const res = await waitsForOwnerFirst(owner.id, a.id,
      () => svc.update({ id: a.id, userId, expectedVersion: a.version, data: { amount: 11 } }));
    expect(res.ok).toBe(true);
    expect((await must(owner.id)).data).toMatchObject({ expenses_total: 16 });
  });

  test('setLinks of a row locks its owner first', async () => {
    const { owner, a } = await taskWithRows();
    const withBudget = record(await svc.update({ id: a.id, userId, expectedVersion: a.version, enableSets: ['budget'],
      rows: { budget_lines: [expense({ amount: 1 }), expense({ amount: 2 })] } }));
    const [x, y] = withBudget.links.budget_lines!;
    const res = await waitsForOwnerFirst(owner.id, a.id,
      () => svc.setLinks({ id: a.id, userId, field: 'budget_lines', targetIds: [y!, x!] }));
    expect(res.ok && res.record.links.budget_lines).toEqual([y, x]);
  });

  test('archive of a row locks its owner first', async () => {
    const { owner, a } = await taskWithRows();
    const res = await waitsForOwnerFirst(owner.id, a.id, () => svc.archive({ id: a.id, userId }));
    expect(res.ok).toBe(true);
  });
});
