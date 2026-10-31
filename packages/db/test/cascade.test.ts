import { fileURLToPath } from 'node:url';
import { loadConfigDir } from '@icrm/core/node';
import type { CompiledConfig, Value } from '@icrm/core';
import { sql, type Kysely } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, test } from 'vitest';
import { RecordService, type DB, type RecordView, type SaveResult } from '../src/index.js';
import { runCascade } from '../src/service/cascade.js';
import { freshDb } from './setup-pg.js';

const CONFIG_DIR = fileURLToPath(new URL('./fixtures/cascade/', import.meta.url));
const NOW = new Date('2026-10-30T10:00:00Z');

let db: Kysely<DB>;
let cfg: CompiledConfig;
let workspaceId: string;
let userId: string;
let svc: RecordService;

beforeAll(async () => {
  ({ db, workspaceId, userId } = await freshDb());
  cfg = await loadConfigDir(CONFIG_DIR);
  svc = new RecordService({ db, cfg, workspaceId, now: () => NOW });
});

function record(r: SaveResult): RecordView {
  if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.errors)}`);
  return r.record;
}

function errorCodes(r: SaveResult): string[] {
  if (r.ok) throw new Error('expected the save to fail');
  return r.errors.map((e) => e.code);
}

async function mk(
  sets: string[], data: Record<string, Value> = {}, links?: Record<string, string[]>, title = 'Запись',
): Promise<RecordView> {
  return record(await svc.create({ userId, title, sets, data, links }));
}

async function get(id: string): Promise<RecordView> {
  const r = await svc.get(id);
  if (r === null) throw new Error(`record ${id} not found`);
  return r;
}

async function link(id: string, field: string, targetIds: string[]): Promise<RecordView> {
  return record(await svc.setLinks({ id, userId, field, targetIds }));
}

/** chain[0] is the root; chain[i].parent_task = chain[i - 1]; own_hours = 1 everywhere. */
async function mkChain(n: number): Promise<RecordView[]> {
  const chain: RecordView[] = [];
  for (let i = 0; i < n; i++) {
    const links = i === 0 ? undefined : { parent_task: [chain[i - 1]!.id] };
    chain.push(await mk(['task'], { own_hours: 1 }, links, `Уровень ${i}`));
  }
  return chain;
}

async function changeLog(id: string) {
  return db.selectFrom('change_log').selectAll().where('record_id', '=', id).orderBy('id').execute();
}

const setKeys = (r: RecordView): string[] => r.sets.map((s) => s.key);

describe('rollups over links', () => {
  test('task cost rolls up to conversation', async () => {
    const conv = await mk(['conversation']);
    const t = await mk(['task'], { hours: 2, rate: 50 });
    const linked = await link(t.id, 'conversation', [conv.id]);
    expect(linked.links.conversation).toEqual([conv.id]);
    expect(linked.version).toBe(t.version + 1);
    expect((await get(conv.id)).data.tasks_cost_total).toBe(100);
  });

  test('changing child field updates parent in same transaction', async () => {
    const conv = await mk(['conversation']);
    const t = await mk(['task'], { hours: 2, rate: 50 }, { conversation: [conv.id] });
    expect((await get(conv.id)).data.tasks_cost_total).toBe(100);
    record(await svc.update({ id: t.id, userId, expectedVersion: t.version, data: { hours: 3 } }));
    expect((await get(conv.id)).data.tasks_cost_total).toBe(150);
  });

  test('relinking moves amount between parents', async () => {
    const conv1 = await mk(['conversation']);
    const conv2 = await mk(['conversation']);
    const t = await mk(['task'], { hours: 2, rate: 50 }, { conversation: [conv1.id] });
    expect((await get(conv1.id)).data.tasks_cost_total).toBe(100);
    expect((await get(conv2.id)).data.tasks_cost_total).toBe(0);

    await link(t.id, 'conversation', [conv2.id]);
    expect((await get(conv1.id)).data.tasks_cost_total).toBe(0);
    expect((await get(conv2.id)).data.tasks_cost_total).toBe(100);
  });

  test('unlinking drops the amount', async () => {
    const conv = await mk(['conversation']);
    const t = await mk(['task'], { hours: 1, rate: 40 }, { conversation: [conv.id] });
    await link(t.id, 'conversation', []);
    expect((await get(conv.id)).data.tasks_cost_total).toBe(0);
    expect((await get(t.id)).links.conversation).toEqual([]);
  });

  test('archived child drops out of parent rollup', async () => {
    const conv = await mk(['conversation']);
    const t = await mk(['task'], { hours: 2, rate: 50 }, { conversation: [conv.id] });
    const keep = await mk(['task'], { hours: 1, rate: 10 }, { conversation: [conv.id] });
    expect((await get(conv.id)).data.tasks_cost_total).toBe(110);

    const archivedTask = record(await svc.archive({ id: t.id, userId }));
    expect(archivedTask.archivedAt).toBe(NOW.toISOString());
    expect(archivedTask.version).toBe(t.version + 1);
    expect((await get(conv.id)).data.tasks_cost_total).toBe(10);

    await svc.archive({ id: keep.id, userId });
    expect((await get(conv.id)).data.tasks_cost_total).toBe(0);
  });

  test('archive is logged and cannot be repeated; an archived record rejects links', async () => {
    const conv = await mk(['conversation']);
    const t = await mk(['task']);
    record(await svc.archive({ id: t.id, userId }));
    expect(errorCodes(await svc.archive({ id: t.id, userId }))).toEqual(['archived']);
    expect(errorCodes(await svc.setLinks({ id: t.id, userId, field: 'conversation', targetIds: [conv.id] })))
      .toEqual(['archived']);
    expect(errorCodes(await svc.archive({ id: uuidv7(), userId }))).toEqual(['not_found']);

    const log = (await changeLog(t.id)).filter((e) => e.kind === 'archive');
    expect(log).toEqual([expect.objectContaining({ old: null, new: NOW.toISOString(), source: 'user', user_id: userId })]);
  });

  test('archiving a link target cascades to forward rollups of its sources', async () => {
    const conv = await mk(['conversation'], {}, undefined, 'Монтаж камер');
    const t = await mk(['task'], {}, { conversation: [conv.id] });
    expect(t.data.conversation_title).toBe('Монтаж камер');

    record(await svc.update({ id: conv.id, userId, expectedVersion: (await get(conv.id)).version, title: 'Камеры, склад' }));
    expect((await get(t.id)).data.conversation_title).toBe('Камеры, склад');

    await svc.archive({ id: conv.id, userId });
    expect((await get(t.id)).data.conversation_title ?? null).toBeNull();
  });

  test('recursive rollup propagates through 30 levels', async () => {
    const chain = await mkChain(30);
    expect((await get(chain[0]!.id)).data.total_hours).toBe(30);
    const leaf = await get(chain[29]!.id);
    record(await svc.update({ id: leaf.id, userId, expectedVersion: leaf.version, data: { own_hours: 5 } }));
    expect((await get(chain[0]!.id)).data.total_hours).toBe(34);
    expect((await get(chain[15]!.id)).data.total_hours).toBe(19);
  });

  test('rollup feeds rule on parent', async () => {
    const conv = await mk(['conversation']);
    const a = await mk(['task'], { done: false }, { conversation: [conv.id] });
    const b = await mk(['task'], { done: false }, { conversation: [conv.id] });
    let c = await get(conv.id);
    expect(c.data.open_tasks_count).toBe(2);
    expect(c.sets).toContainEqual({ key: 'has_work', enabledBy: 'rule:has_work_when_open' });

    record(await svc.update({ id: a.id, userId, expectedVersion: a.version, data: { done: true } }));
    c = await get(conv.id);
    expect(c.data.open_tasks_count).toBe(1);
    expect(setKeys(c)).toContain('has_work');

    record(await svc.update({ id: b.id, userId, expectedVersion: b.version, data: { done: true } }));
    c = await get(conv.id);
    expect(c.data.open_tasks_count).toBe(0);
    expect(setKeys(c)).not.toContain('has_work');
    const setLog = (await changeLog(conv.id)).filter((e) => e.kind === 'set' && e.field_key === 'has_work');
    expect(setLog.map((e) => [e.old, e.new, e.source])).toEqual([
      [null, 'rule:has_work_when_open', 'cascade'],
      ['rule:has_work_when_open', null, 'cascade'],
    ]);
  });

  test('a set enabled by a rule gets its rollups in the same save', async () => {
    const conv = await mk(['conversation']);
    await mk(['task'], { hours: 2 }, { conversation: [conv.id] });
    await mk(['task'], { hours: 3, done: true }, { conversation: [conv.id] });
    const before = await get(conv.id);
    expect(setKeys(before)).not.toContain('billing');
    expect(before.data.billed_hours ?? null).toBeNull();

    const after = record(await svc.update({ id: conv.id, userId, expectedVersion: before.version, data: { billable: true } }));
    expect(after.sets).toContainEqual({ key: 'billing', enabledBy: 'rule:billing_when_billable' });
    expect(after.data.billed_hours).toBe(5);
  });

  test('a rollup of a set the cascade disables keeps its stored value and is not logged', async () => {
    const conv = await mk(['conversation']);
    const t = await mk(['task'], { hours: 2, done: false }, { conversation: [conv.id] });
    expect((await get(conv.id)).data.open_hours).toBe(2);
    const openHoursLog = async () => (await changeLog(conv.id)).filter((e) => e.field_key === 'open_hours');
    expect((await openHoursLog()).map((e) => [e.kind, e.old, e.new])).toEqual([['value', null, 2]]);

    record(await svc.update({ id: t.id, userId, expectedVersion: t.version, data: { done: true } }));
    const c = await get(conv.id);
    expect(setKeys(c)).not.toContain('has_work');
    expect(c.data.open_tasks_count).toBe(0);
    expect(c.data.open_hours).toBe(2);
    expect((await openHoursLog()).map((e) => [e.kind, e.old, e.new])).toEqual([['value', null, 2]]);
  });

  test('a set enabled by a rule inside the cascade gets its rollups in the same cascade', async () => {
    const conv = await mk(['conversation']);
    expect(setKeys(conv)).not.toContain('has_work');
    await mk(['task'], { hours: 2, done: false }, { conversation: [conv.id] });
    const c = await get(conv.id);
    expect(setKeys(c)).toContain('has_work');
    expect(c.data.open_hours).toBe(2);
  });

  test('cascade entries logged with source cascade', async () => {
    const conv = await mk(['conversation']);
    const t = await mk(['task'], { hours: 2, rate: 50 }, { conversation: [conv.id] });
    record(await svc.update({ id: t.id, userId, expectedVersion: t.version, data: { hours: 4 } }));

    const log = (await changeLog(conv.id)).filter((e) => e.field_key === 'tasks_cost_total');
    expect(log.map((e) => [e.kind, e.old, e.new, e.source, e.user_id])).toEqual([
      ['value', null, 0, 'rule', userId],
      ['value', 0, 100, 'cascade', userId],
      ['value', 100, 200, 'cascade', userId],
    ]);
    const taskLog = (await changeLog(t.id)).filter((e) => e.kind === 'link');
    expect(taskLog).toEqual([
      expect.objectContaining({ field_key: 'conversation', old: [], new: [conv.id], source: 'user', user_id: userId }),
    ]);
  });

  test('a validation error on a cascaded record does not roll back the save', async () => {
    const conv = await mk(['conversation'], { cost_cap: 120 });
    const t = await mk(['task'], { hours: 2, rate: 50 }, { conversation: [conv.id] });
    const before = await get(conv.id);
    record(await svc.update({ id: t.id, userId, expectedVersion: t.version, data: { hours: 3 } }));
    const after = await get(conv.id);
    expect(after.data.tasks_cost_total).toBe(150);
    expect(after.version).toBe(before.version + 1);

    // The originating record's own error still rolls back.
    expect(errorCodes(await svc.update({ id: conv.id, userId, expectedVersion: after.version, data: { cost_cap: 140 } })))
      .toEqual(['validation']);
    expect((await get(conv.id)).data.cost_cap).toBe(120);
  });

  test('cascade over the limit is an error', async () => {
    const chain = await mkChain(6);
    const leaf = chain[5]!;
    /** Bumps the leaf's hours behind the service's back, then cascades with the given limit. */
    const cascadeWithLimit = (hours: number, limit: number) => db.transaction().execute(async (tx) => {
      await sql`update records set data = data || ${JSON.stringify({ own_hours: hours, total_hours: hours })}::jsonb
                 where id = ${leaf.id}`.execute(tx);
      const seed = { recordId: leaf.id, changedKeys: new Set(['total_hours']), changedSets: new Set<string>(), changedLinks: [] };
      return runCascade(tx, cfg, [seed], NOW, workspaceId, userId, limit);
    });
    // Five ancestors change one after another: four fit under the limit, the fifth exceeds it.
    await expect(cascadeWithLimit(2, 4)).resolves.toEqual([{ code: 'validation', message: 'каскад превысил лимит' }]);
    await expect(cascadeWithLimit(3, 5)).resolves.toEqual([]);
    expect((await get(chain[0]!.id)).data.total_hours).toBe(8);
  });
});

describe('link checks', () => {
  test('hierarchical cycle rejected', async () => {
    const a = await mk(['task']);
    const b = await mk(['task']);
    await link(a.id, 'parent_task', [b.id]);
    expect(errorCodes(await svc.setLinks({ id: b.id, userId, field: 'parent_task', targetIds: [a.id] })))
      .toEqual(['link_cycle']);
    expect(errorCodes(await svc.setLinks({ id: a.id, userId, field: 'parent_task', targetIds: [a.id] })))
      .toEqual(['link_cycle']);

    const c = await mk(['task'], {}, { parent_task: [a.id] });
    expect(errorCodes(await svc.setLinks({ id: b.id, userId, field: 'parent_task', targetIds: [c.id] })))
      .toEqual(['link_cycle']);
    expect((await get(b.id)).links.parent_task).toEqual([]);
  });

  test('concurrent opposite hierarchical links: one succeeds, the other is a cycle', async () => {
    for (let n = 0; n < 5; n++) {
      const a = await mk(['task']);
      const b = await mk(['task']);
      const results = await Promise.all([
        svc.setLinks({ id: a.id, userId, field: 'parent_task', targetIds: [b.id] }),
        svc.setLinks({ id: b.id, userId, field: 'parent_task', targetIds: [a.id] }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).flatMap((r) => errorCodes(r))).toEqual(['link_cycle']);
      const parents = [(await get(a.id)).links.parent_task, (await get(b.id)).links.parent_task];
      expect(parents.filter((p) => p!.length > 0)).toHaveLength(1);
    }
  });

  test('cardinality one and target sets enforced', async () => {
    const conv1 = await mk(['conversation']);
    const conv2 = await mk(['conversation']);
    const other = await mk(['task']);
    const t = await mk(['task']);

    const two = await svc.setLinks({ id: t.id, userId, field: 'conversation', targetIds: [conv1.id, conv2.id] });
    expect(two).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'link_cardinality', field: 'conversation' })] });
    const wrongSet = await svc.setLinks({ id: t.id, userId, field: 'conversation', targetIds: [other.id] });
    expect(wrongSet).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'link_target', field: 'conversation' })] });
    expect(errorCodes(await svc.setLinks({ id: t.id, userId, field: 'conversation', targetIds: [uuidv7()] })))
      .toEqual(['link_target']);

    const gone = await mk(['conversation']);
    await svc.archive({ id: gone.id, userId });
    expect(errorCodes(await svc.setLinks({ id: t.id, userId, field: 'conversation', targetIds: [gone.id] })))
      .toEqual(['link_target']);

    const after = await get(t.id);
    expect(after.links.conversation).toEqual([]);
    expect(after.version).toBe(t.version);
  });

  test('targets already on the field are not re-checked; new ones are', async () => {
    const w1 = await mk(['person']);
    const w2 = await mk(['person']);
    const gone = await mk(['person']);
    const p = await mk(['person'], {}, { watchers: [gone.id, w1.id] });
    record(await svc.archive({ id: gone.id, userId }));

    // reordering, keeping the archived target and adding a live one is fine
    expect((await link(p.id, 'watchers', [w1.id, gone.id, w2.id])).links.watchers).toEqual([w1.id, gone.id, w2.id]);

    // a new archived target is still rejected
    const goneToo = await mk(['person']);
    await svc.archive({ id: goneToo.id, userId });
    const r = await svc.setLinks({ id: p.id, userId, field: 'watchers', targetIds: [w1.id, gone.id, w2.id, goneToo.id] });
    expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'link_target', field: 'watchers' })] });
    expect(!r.ok && r.errors[0]!.message).toContain(goneToo.id);
    expect((await get(p.id)).links.watchers).toEqual([w1.id, gone.id, w2.id]);
  });

  test('only a link field of an enabled set can be linked', async () => {
    const conv = await mk(['conversation']);
    const t = await mk(['task']);
    for (const field of ['hours', 'watchers', 'nope']) {
      const r = await svc.setLinks({ id: t.id, userId, field, targetIds: [conv.id] });
      expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ code: 'unknown_field', field })] });
    }
    expect(errorCodes(await svc.setLinks({ id: uuidv7(), userId, field: 'conversation', targetIds: [conv.id] })))
      .toEqual(['not_found']);
  });

  test('create with links runs the same checks in its transaction', async () => {
    const other = await mk(['task']);
    const before = await db.selectFrom('records').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    const r = await svc.create({ userId, title: 'Плохая', sets: ['task'], links: { conversation: [other.id] } });
    expect(errorCodes(r)).toEqual(['link_target']);
    expect(errorCodes(await svc.create({ userId, title: 'X', sets: ['task'], links: { watchers: [other.id] } })))
      .toEqual(['unknown_field']);
    const after = await db.selectFrom('records').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);

    const conv = await mk(['conversation']);
    const t = await mk(['task'], { hours: 1, rate: 30 }, { conversation: [conv.id] });
    expect(t.version).toBe(1);
    expect(t.links.conversation).toEqual([conv.id]);
    expect((await get(conv.id)).data.tasks_cost_total).toBe(30);
  });
});
