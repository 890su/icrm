import { compileConfig, parseConfigFiles, type CompiledConfig, type Value } from '@icrm/core';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  ensureWorkspace, RecordService, recomputeFields, recomputingKeys, syncConfig, type DB, type RecordView, type SaveResult,
} from '../src/index.js';
import { freshDb } from './setup-pg.js';

const NOW = new Date('2026-10-30T10:00:00Z');
const now = (): Date => NOW;

let db: Kysely<DB>;
let userId: string;
let seq = 0;

beforeAll(async () => {
  ({ db, userId } = await freshDb());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Each test gets its own workspace, so records and config_state do not leak between tests. */
async function workspace(): Promise<string> {
  return (await ensureWorkspace(db, `sync_${++seq}`)).workspaceId;
}

const compile = (yaml: string): CompiledConfig => compileConfig(parseConfigFiles([{ name: 'config.yaml', content: yaml }]));

function ok(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}

function service(cfg: CompiledConfig, workspaceId: string): RecordService {
  return new RecordService({ db, cfg, workspaceId, now });
}

async function mk(
  svc: RecordService, sets: string[], data: Record<string, Value> = {}, links?: Record<string, string[]>,
): Promise<RecordView> {
  return ok(await svc.create({ userId, title: 'Запись', sets, data, links }));
}

async function get(svc: RecordService, id: string): Promise<RecordView> {
  const r = await svc.get(id);
  if (r === null) throw new Error(`record ${id} not found`);
  return r;
}

const changeLog = (id: string) => db.selectFrom('change_log').selectAll().where('record_id', '=', id).orderBy('id').execute();

const NOTHING = { renamed: [], orphanKeys: [], recomputed: [], indexes: [] };

const COST_V1 = `
fields:
  hours: {type: number, label: Часы}
  rate: {type: number, label: Ставка}
  cost: {type: formula, label: Стоимость, expr: '{hours} * {rate}'}
  conversation: {type: link, label: Разговор, target_sets: [conversation], cardinality: one}
  total: {type: rollup, label: Итого, via: conversation, direction: inverse, field: cost, agg: sum}
sets:
  task: {label: Задача, fields: [title, hours, rate, cost, conversation]}
  conversation: {label: Разговор, fields: [title, total]}
  contact: {label: Контакт, fields: [title]}
`;
const COST_V2 = COST_V1.replace("'{hours} * {rate}'", "'{hours} * {rate} * 2'");

describe('renames via was', () => {
  const V1 = `
fields:
  hours: {type: number, label: Часы}
  rate: {type: number, label: Ставка}
  cost: {type: formula, label: Стоимость, expr: '{hours} * {rate}'}
  boss: {type: link, label: Руководитель, target_sets: [contact]}
sets:
  task: {label: Задача, fields: [title, hours, rate, cost, boss]}
  contact: {label: Контакт, fields: [title]}
`;
  const V2 = `
fields:
  work_hours: {type: number, label: Часы, was: hours}
  rate: {type: number, label: Ставка}
  cost: {type: formula, label: Стоимость, expr: '{work_hours} * {rate}'}
  manager: {type: link, label: Руководитель, target_sets: [contact], was: boss}
sets:
  task: {label: Задача, fields: [title, work_hours, rate, cost, manager]}
  contact: {label: Контакт, fields: [title]}
`;

  test('rename via was moves data and links once', async () => {
    const ws = await workspace();
    const [v1, v2] = [compile(V1), compile(V2)];
    const contact = await mk(service(v1, ws), ['contact']);
    const task = await mk(service(v1, ws), ['task'], { hours: 3, rate: 10 }, { boss: [contact.id] });
    await syncConfig(db, v1, ws, now);

    const report = await syncConfig(db, v2, ws, now);
    expect([...report.renamed].sort((a, b) => a.from.localeCompare(b.from))).toEqual([
      { from: 'boss', to: 'manager' }, { from: 'hours', to: 'work_hours' },
    ]);
    expect(report.orphanKeys).toEqual([]);

    const moved = await get(service(v2, ws), task.id);
    expect(moved.data.work_hours).toBe(3);
    expect(moved.data).not.toHaveProperty('hours');
    expect(moved.data.cost).toBe(30);
    expect(moved.links.manager).toEqual([contact.id]);
    const linkRows = await db.selectFrom('links').select('field_key').where('from_id', '=', task.id).execute();
    expect(linkRows.map((l) => l.field_key)).toEqual(['manager']);
    // A system migration: no change-log entry for the moved key.
    expect((await changeLog(task.id)).filter((e) => e.field_key === 'work_hours')).toEqual([]);

    const markers = await db.selectFrom('config_state').select(['key', 'value', 'status'])
      .where('workspace_id', '=', ws).where('kind', '=', 'rename').orderBy('key').execute();
    expect(markers).toEqual([
      { key: 'boss→manager', value: 'manager', status: 'ok' },
      { key: 'hours→work_hours', value: 'work_hours', status: 'ok' },
    ]);

    expect(await syncConfig(db, v2, ws, now)).toEqual(NOTHING);
  });

  test('a rename is not repeated: data written under the old key afterwards is left alone', async () => {
    const ws = await workspace();
    const [v1, v2] = [compile(V1), compile(V2)];
    const task = await mk(service(v1, ws), ['task'], { hours: 3, rate: 10 });
    await syncConfig(db, v2, ws, now);
    await sql`update records set data = data || '{"hours": 7}'::jsonb where id = ${task.id}`.execute(db);

    const report = await syncConfig(db, v2, ws, now);
    expect(report.renamed).toEqual([]);
    expect(report.orphanKeys).toEqual(['hours']);
    const row = await db.selectFrom('records').select('data').where('id', '=', task.id).executeTakeFirstOrThrow();
    expect(row.data).toMatchObject({ hours: 7, work_hours: 3 });
  });

  test('a record that already has the new key keeps both values', async () => {
    const ws = await workspace();
    const [v1, v2] = [compile(V1), compile(V2)];
    const task = await mk(service(v1, ws), ['task'], { hours: 3, rate: 10 });
    await sql`update records set data = data || '{"work_hours": 5}'::jsonb where id = ${task.id}`.execute(db);

    const report = await syncConfig(db, v2, ws, now);
    expect(report.orphanKeys).toEqual(['hours']);
    const row = await db.selectFrom('records').select('data').where('id', '=', task.id).executeTakeFirstOrThrow();
    expect(row.data).toMatchObject({ hours: 3, work_hours: 5 });
  });

  test('other workspaces are not touched', async () => {
    const [ws, other] = [await workspace(), await workspace()];
    const [v1, v2] = [compile(V1), compile(V2)];
    const mine = await mk(service(v1, ws), ['task'], { hours: 3, rate: 10 });
    const theirs = await mk(service(v1, other), ['task'], { hours: 4, rate: 10 });
    await syncConfig(db, v2, ws, now);

    expect((await get(service(v2, ws), mine.id)).data.work_hours).toBe(3);
    const row = await db.selectFrom('records').select('data').where('id', '=', theirs.id).executeTakeFirstOrThrow();
    expect(row.data).toMatchObject({ hours: 4 });
    expect(row.data).not.toHaveProperty('work_hours');
  });
});

describe('orphan keys', () => {
  test('orphan keys reported, sorted, and the data stays', async () => {
    const ws = await workspace();
    const cfg = compile(COST_V1);
    const task = await mk(service(cfg, ws), ['task'], { hours: 1, rate: 10 });
    await sql`update records set data = data || '{"legacy_x": 1, "a_old": "q"}'::jsonb where id = ${task.id}`.execute(db);

    const report = await syncConfig(db, cfg, ws, now);
    expect(report.orphanKeys).toEqual(['a_old', 'legacy_x']);
    const row = await db.selectFrom('records').select('data').where('id', '=', task.id).executeTakeFirstOrThrow();
    expect(row.data).toMatchObject({ legacy_x: 1, a_old: 'q' });
  });

  test('keys of other workspaces are not reported', async () => {
    const [ws, other] = [await workspace(), await workspace()];
    const cfg = compile(COST_V1);
    const theirs = await mk(service(cfg, other), ['task'], { hours: 1, rate: 10 });
    await sql`update records set data = data || '{"legacy_y": 1}'::jsonb where id = ${theirs.id}`.execute(db);
    expect((await syncConfig(db, cfg, ws, now)).orphanKeys).toEqual([]);
  });
});

describe('recompute on a changed definition', () => {
  test('changed formula recomputed for affected records only', async () => {
    const ws = await workspace();
    const [v1, v2] = [compile(COST_V1), compile(COST_V2)];
    const s1 = service(v1, ws);
    const conv = await mk(s1, ['conversation']);
    const task = await mk(s1, ['task'], { hours: 1, rate: 10 }, { conversation: [conv.id] });
    const archivedTask = await mk(s1, ['task'], { hours: 1, rate: 10 });
    ok(await s1.archive({ id: archivedTask.id, userId }));
    const contact = await mk(s1, ['contact']);
    const before = {
      task: await get(s1, task.id), archived: await get(s1, archivedTask.id), contact: await get(s1, contact.id),
    };
    expect(before.task.data.cost).toBe(10);
    expect((await get(s1, conv.id)).data.total).toBe(10);

    const first = await syncConfig(db, v1, ws, now);
    expect(first.recomputed).toEqual(['cost', 'total']);

    const report = await syncConfig(db, v2, ws, now);
    expect(report.recomputed).toEqual(['cost']);

    const s2 = service(v2, ws);
    const after = await get(s2, task.id);
    expect(after.data.cost).toBe(20);
    expect(after.version).toBe(before.task.version + 1);
    // Archived records and records without the field's set are not touched.
    expect(await get(s2, archivedTask.id)).toEqual(before.archived);
    expect(await get(s2, contact.id)).toEqual(before.contact);

    const log = (await changeLog(task.id)).filter((e) => e.field_key === 'cost');
    expect(log.at(-1)).toMatchObject({ kind: 'value', old: 10, new: 20, source: 'system', user_id: null });

    // The conversation total follows through the cascade, logged as such.
    expect((await get(s2, conv.id)).data.total).toBe(20);
    expect((await changeLog(conv.id)).at(-1)).toMatchObject({ field_key: 'total', old: 10, new: 20, source: 'cascade' });

    expect(await syncConfig(db, v2, ws, now)).toEqual(NOTHING);
  });

  test('changed rollup recomputed', async () => {
    const ws = await workspace();
    const [v1, v2] = [compile(COST_V1), compile(COST_V1.replace('agg: sum', 'agg: max'))];
    const s1 = service(v1, ws);
    const conv = await mk(s1, ['conversation']);
    await mk(s1, ['task'], { hours: 1, rate: 10 }, { conversation: [conv.id] });
    await mk(s1, ['task'], { hours: 3, rate: 10 }, { conversation: [conv.id] });
    expect((await get(s1, conv.id)).data.total).toBe(40);
    await syncConfig(db, v1, ws, now);

    const report = await syncConfig(db, v2, ws, now);
    expect(report.recomputed).toEqual(['total']);
    expect((await get(service(v2, ws), conv.id)).data.total).toBe(30);
    expect((await changeLog(conv.id)).at(-1)).toMatchObject({ field_key: 'total', old: 40, new: 30, source: 'system' });
  });

  test('recomputing status visible during recompute and cleared after', async () => {
    const ws = await workspace();
    const [v1, v2] = [compile(COST_V1), compile(COST_V2)];
    await mk(service(v1, ws), ['task'], { hours: 1, rate: 10 });
    await syncConfig(db, v1, ws, now);
    expect(await recomputingKeys(db, ws)).toEqual([]);

    // Observe from inside the recomputation: the hook reads the status on another connection, after the
    // field was marked and before it is cleared, then lets the real recomputation run.
    const original = RecordService.prototype.recompute;
    const seen: string[][] = [];
    vi.spyOn(RecordService.prototype, 'recompute').mockImplementation(async function (this: RecordService, ...args) {
      seen.push(await recomputingKeys(db, ws));
      return original.apply(this, args);
    });
    await syncConfig(db, v2, ws, now);

    expect(seen).toEqual([['cost']]);
    expect(await recomputingKeys(db, ws)).toEqual([]);
    const row = await db.selectFrom('config_state').select(['value', 'status'])
      .where('workspace_id', '=', ws).where('key', '=', 'cost').where('kind', '=', 'signature').executeTakeFirstOrThrow();
    expect(row).toEqual({ value: v2.fields.get('cost')!.signature, status: 'ok' });
  });

  test('a failed recompute leaves the mark, and the next sync does it again', async () => {
    const ws = await workspace();
    const [v1, v2] = [compile(COST_V1), compile(COST_V2)];
    const task = await mk(service(v1, ws), ['task'], { hours: 1, rate: 10 });
    await syncConfig(db, v1, ws, now);

    vi.spyOn(RecordService.prototype, 'recompute').mockRejectedValueOnce(new Error('boom'));
    await expect(syncConfig(db, v2, ws, now)).rejects.toThrow('boom');
    expect(await recomputingKeys(db, ws)).toEqual(['cost']);
    expect((await get(service(v2, ws), task.id)).data.cost).toBe(10);

    const report = await syncConfig(db, v2, ws, now);
    expect(report.recomputed).toEqual(['cost']);
    expect(await recomputingKeys(db, ws)).toEqual([]);
    expect((await get(service(v2, ws), task.id)).data.cost).toBe(20);
  });

  test('recomputeFields works in batches of 500', async () => {
    const ws = await workspace();
    const [v1, v2] = [compile(COST_V1), compile(COST_V2)];
    const first = await mk(service(v1, ws), ['task'], { hours: 1, rate: 10 });
    // 522 more rows, inserted directly: far cheaper than 522 saves.
    await sql`
      insert into records (id, workspace_id, title, data, created_by)
      select gen_random_uuid(), ${ws}, 'bulk', '{"title": "bulk", "hours": 1, "rate": 10, "cost": 10}'::jsonb, ${userId}
      from generate_series(1, 522)`.execute(db);
    await sql`
      insert into record_sets (record_id, set_key, enabled_by)
      select id, 'task', 'manual' from records where workspace_id = ${ws} and title = 'bulk'`.execute(db);

    const batches: number[] = [];
    const original = RecordService.prototype.recompute;
    vi.spyOn(RecordService.prototype, 'recompute').mockImplementation(async function (this: RecordService, ids, ...rest) {
      batches.push(ids.length);
      return original.call(this, ids, ...rest);
    });
    await recomputeFields(db, v2, ws, ['cost'], now);

    expect(batches).toEqual([500, 23]);
    expect((await get(service(v2, ws), first.id)).data.cost).toBe(20);
    const notDone = await db.selectFrom('records').select('id').where('workspace_id', '=', ws)
      .where(sql<boolean>`data->>'cost' is distinct from '20'`).execute();
    expect(notDone).toEqual([]);
  });

  test('errors of single records are returned and do not roll the batch back', async () => {
    const ws = await workspace();
    const v1 = compile(COST_V1);
    const v2 = compile(`${COST_V2}
rules:
  - id: cost_cap
    when: 'HAS_SET("task")'
    validate: '{cost} <= 15'
    message: Слишком дорого
`);
    const task = await mk(service(v1, ws), ['task'], { hours: 1, rate: 10 });
    const fine = await mk(service(v1, ws), ['task'], { hours: 0, rate: 10 });

    const s2 = service(v2, ws);
    const errors = await s2.recompute([task.id, fine.id], null, 'system');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'validation', rule_id: 'cost_cap' });
    expect(errors[0]!.message).toContain(task.id);
    expect(errors[0]!.message).toContain('Слишком дорого');
    expect((await get(s2, task.id)).data.cost).toBe(20);
    expect((await get(s2, fine.id)).data.cost).toBe(0);
  });
});

describe('indexes', () => {
  const INDEXED = `
fields:
  due_date: {type: date, label: Срок, indexed: true}
  note: {type: text, label: Заметка}
sets:
  task: {label: Задача, fields: [title, due_date, note]}
`;

  test('indexed field gets expression index', async () => {
    const ws = await workspace();
    const cfg = compile(INDEXED);
    const report = await syncConfig(db, cfg, ws, now);
    expect(report.indexes).toEqual(['records_f_due_date']);

    const { rows } = await sql<{ indexname: string; indexdef: string }>`
      select indexname, indexdef from pg_indexes where tablename = 'records' and indexname like 'records_f_%'`.execute(db);
    expect(rows.map((r) => r.indexname)).toEqual(['records_f_due_date']);
    expect(rows[0]!.indexdef).toContain("(data ->> 'due_date'::text)");

    // Already there: nothing to create.
    expect((await syncConfig(db, cfg, ws, now)).indexes).toEqual([]);
  });
});
