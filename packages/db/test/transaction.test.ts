import { compileConfig, parseConfigFiles, withSystem, type CompiledConfig } from '@icrm/core';
import { sql, type Kysely } from 'kysely';
import { beforeAll, expect, test } from 'vitest';
import { RecordService, UNIQUE_ERRORS, type DB, type RecordView, type SaveResult } from '../src/index.js';
import { freshDb } from './setup-pg.js';

const NOW = new Date('2026-10-31T10:00:00Z');

// Test system part: a person with a managed link field.
const SYS = `fields:
  memo: {type: text, label: Памятка}
  merged: {type: link, label: Слита с, target_sets: [person], cardinality: one, managed: true, inverse_label: Слитые}
sets:
  person: {label: Человек, fields: [memo, merged]}
`;

const USER = `fields:
  hours: {type: number, label: Часы}
  items: {type: link, label: Пункты, target_sets: [task], cardinality: many, inverse_label: Входит в}
  total: {type: rollup, label: Итого, via: items, field: hours, agg: sum}
sets:
  task: {label: Задача, fields: [title, hours, items, total]}
`;

let db: Kysely<DB>;
let userId: string;
let workspaceId: string;
let cfg: CompiledConfig;
let svc: RecordService;

beforeAll(async () => {
  ({ db, workspaceId, userId } = await freshDb());
  cfg = compileConfig(parseConfigFiles(withSystem([{ name: 'user.yaml', content: USER }], SYS)));
  svc = new RecordService({ db, cfg, workspaceId, now: () => NOW });
});

function must(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}

async function countRecords(): Promise<number> {
  const r = await db.selectFrom('records').select(db.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  return Number(r.n);
}

test('several saves in one transaction run one cascade and commit together', async () => {
  const res = await svc.transaction(userId, async (ops) => {
    const a = await ops.create({ userId, title: 'a', sets: ['task'], data: { hours: 2 } });
    const b = await ops.create({ userId, title: 'b', sets: ['task'], data: { hours: 3 } });
    const p = await ops.create({ userId, title: 'p', sets: ['task'], links: { items: [a.id, b.id] } });
    return p.id;
  });
  expect(res.ok).toBe(true);
  expect((await svc.get(res.ok ? res.value : ''))!.data.total).toBe(5);
});

test('ops return the stored state after their write; the cascade runs after work', async () => {
  const res = await svc.transaction(userId, async (ops) => {
    const a = await ops.create({ userId, title: 'a', sets: ['task'], data: { hours: 2 } });
    const p = await ops.create({ userId, title: 'p', sets: ['task'], links: { items: [a.id] } });
    const a2 = await ops.update({ id: a.id, userId, expectedVersion: a.version, data: { hours: 4 } });
    expect(a2).toMatchObject({ version: 2, data: { hours: 4 } });
    // Not cascaded yet: p's total still is the sum at its own write.
    expect((await ops.view(p.id)).data.total).toBe(2);
    return p.id;
  });
  expect((await svc.get(res.ok ? res.value : ''))!.data.total).toBe(4);
});

test('an error in a later op rolls back the earlier ones', async () => {
  const before = await countRecords();
  const res = await svc.transaction(userId, async (ops) => {
    await ops.create({ userId, title: 'x', sets: ['task'] });
    await ops.create({ userId, title: 'y', sets: ['nope'] });
  });
  expect(res).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'unknown_set' })] });
  expect(await countRecords()).toBe(before);
});

test('managed fields are rejected from users and accepted from the system', async () => {
  const p = must(await svc.create({ userId, title: 'p', sets: ['person'] }));
  const q = must(await svc.create({ userId, title: 'q', sets: ['person'] }));
  expect(await svc.setLinks({ id: p.id, userId, field: 'merged', targetIds: [q.id] }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'managed_field', field: 'merged' })] });
  expect((await svc.setLinks({ id: p.id, userId, field: 'merged', targetIds: [q.id], system: true })).ok).toBe(true);
  expect(await svc.create({ userId, title: 'r', sets: ['person'], links: { merged: [q.id] } }))
    .toEqual({ ok: false, errors: [expect.objectContaining({ code: 'managed_field' })] });
});

test('a managed key in update data is rejected, with the field label in the message', async () => {
  const p = must(await svc.create({ userId, title: 'p', sets: ['person'] }));
  expect(await svc.update({ id: p.id, userId, expectedVersion: p.version, data: { merged: null } })).toEqual({
    ok: false, errors: [{ code: 'managed_field', field: 'merged', message: 'Поле «Слита с» заполняется системой' }],
  });
  expect((await svc.update({ id: p.id, userId, expectedVersion: p.version, data: { merged: null }, system: true })).ok)
    .toBe(true);
});

test('behaviours run at their points, and their errors fail the save', async () => {
  const calls: string[] = [];
  const s = new RecordService({ db, cfg, workspaceId, now: () => NOW, behaviors: [{
    set: 'person',
    beforeEvaluate: async (_c, r) => { calls.push(`before:${r.prev === null}`); r.input.memo = String(r.input.memo ?? '').trim(); return []; },
    afterWrite: async (_c, r) => { calls.push('after'); return r.record.data.memo === 'bad' ? [{ code: 'validation', message: 'bad' }] : []; },
    archived: async (_c, recs) => { calls.push(`archived:${recs.length}`); },
    extendView: async (_tx, _rec, view) => { (view as RecordView & { extra?: number }).extra = 1; },
  }] });
  const p = must(await s.create({ userId, title: 'p', sets: ['person'], data: { memo: '  hi ' } }));
  expect(p.data.memo).toBe('hi');
  expect((p as RecordView & { extra?: number }).extra).toBe(1);
  expect((await s.update({ id: p.id, userId, expectedVersion: p.version, data: { memo: 'bad' } })).ok).toBe(false);
  await s.archive({ id: p.id, userId });
  expect(calls).toEqual(['before:true', 'after', 'before:false', 'after', 'archived:1']);
});

test('a unique violation with a known constraint becomes its error', async () => {
  await sql`create unique index t_unique_memo on records ((data->>'memo')) where data->>'memo' like 'uniq:%'`.execute(db);
  UNIQUE_ERRORS.t_unique_memo = (detail) => ({ code: 'identity_taken', message: `taken: ${detail ?? ''}` });
  try {
    must(await svc.create({ userId, title: 'a', sets: ['person'], data: { memo: 'uniq:1' } }));
    const res = await svc.create({ userId, title: 'b', sets: ['person'], data: { memo: 'uniq:1' } });
    expect(res).toEqual({
      ok: false, errors: [{ code: 'identity_taken', message: expect.stringContaining('uniq:1') }],
    });
    const tx = await svc.transaction(userId, (ops) => ops.create({ userId, title: 'c', sets: ['person'], data: { memo: 'uniq:1' } }));
    expect(tx).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'identity_taken' })] });
  } finally {
    delete UNIQUE_ERRORS.t_unique_memo;
    await sql`drop index t_unique_memo`.execute(db);
  }
});
